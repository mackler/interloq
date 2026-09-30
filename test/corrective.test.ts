import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { correctivePrompt, correctionRepairPrompt } from "../src/prompts.ts";
import { correctiveValidation } from "../src/round.ts";
import type { PlannerResponse } from "../src/schema.ts";
import { respond, questionOf } from "./helpers.ts";

// Issue #30 (plan step S9): the corrective turn's prompt tells Claude Code which dispositions it may change, and the
// validation accepts exactly those changes. One source (the previous response and its accepted ids) feeds both.
const previous: PlannerResponse = respond([["P1-R2-1", "accepted"], ["P1-R2-2", "partially_accepted"], ["P1-R2-3", "rejected"]], {
  self_corrections: [{ id: "", new_action: "plan_error", explanation: "a slip" }],
  reviewer_feedback: "thanks",
  questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })],
});
const acceptedIds = previous.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);

const withDisposition = (id: string, change: Partial<PlannerResponse["dispositions"][number]>): PlannerResponse => ({
  ...previous,
  dispositions: previous.dispositions.map((d) => (d.id === id ? { ...d, ...change } : d)),
});

test("the corrective prompt names the ids it allows to change, and the validation accepts changes of exactly those", () => {
  const prompt = correctivePrompt("plan.json", 2, acceptedIds);
  const validate = correctiveValidation<PlannerResponse>(previous, acceptedIds);
  assert.match(prompt, /plan-review\/plan\.json/);
  for (const d of previous.dispositions) {
    const allowed = acceptedIds.includes(d.id);
    assert.equal(prompt.includes(d.id), allowed, `the prompt ${allowed ? "omits" : "names"} ${d.id}`);
    const changed = withDisposition(d.id, { action: "rejected", rationale: "on reflection, no" });
    const result = validate(changed);
    if (allowed) {
      assert.ok(Result.isSuccess(result), `a change of ${d.id} was refused`);
      assert.deepEqual(result.success.value, changed);
    } else {
      assert.ok(Result.isFailure(result), `a change of ${d.id} was accepted`);
      assert.equal(result.failure.error._tag, "CorrectionInvalid");
      assert.deepEqual((result.failure.error as { changedIds: readonly string[] }).changedIds, [d.id]);
      assert.equal(result.failure.repair, correctionRepairPrompt(result.failure.error as never, acceptedIds));
      for (const id of acceptedIds) assert.ok(result.failure.repair.includes(id));
    }
  }
  // The unchanged response is valid: the amendment is in the file, not in the dispositions.
  assert.ok(Result.isSuccess(validate(previous)));
});

test("a corrective reply may not change a reference, the self-corrections, the feedback, the questions or the set of ids", () => {
  const validate = correctiveValidation<PlannerResponse>(previous, acceptedIds);
  const others = (r: PlannerResponse): readonly string[] => {
    const result = validate(r);
    assert.ok(Result.isFailure(result));
    return (result.failure.error as { other: readonly string[] }).other;
  };
  const changedIds = (r: PlannerResponse): readonly string[] => {
    const result = validate(r);
    assert.ok(Result.isFailure(result));
    return (result.failure.error as { changedIds: readonly string[] }).changedIds;
  };
  assert.deepEqual(changedIds(withDisposition("P1-R2-1", { duplicate_of: "P1-R1-1" })), ["P1-R2-1"]);
  assert.deepEqual(others({ ...previous, self_corrections: [] }), ["self_corrections"]);
  assert.deepEqual(others({ ...previous, reviewer_feedback: "" }), ["reviewer_feedback"]);
  assert.deepEqual(others({ ...previous, questions_for_user: [] }), ["questions_for_user"]);
  assert.deepEqual(others({ ...previous, dispositions: previous.dispositions.slice(1) }), ["dispositions"]);
});
