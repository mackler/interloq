import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import * as prompts from "../src/prompts.ts";
import { partCollisionValidation } from "../src/round.ts";
import type { Review, StepCheckRun } from "../src/schema.ts";
import { issue, TEST_ROOT, workExecution } from "./helpers.ts";

// Issue #252, S2: the prompts of a code review's parts, their id forms, and the validation that keeps a cycle's new ids
// unique across its parts, from one source.

const WHOLE: prompts.ReviewPart = { _tag: "Whole" };
const step = (id: string, text = `the text of ${id}`): prompts.ReviewPart => ({ _tag: "Step", id, label: `label of ${id}`, text });
const check = (s: string, command: string): StepCheckRun => ({ step: s, command, seconds: 1, selection: true, counts: null });
const execution = { ...workExecution, outcome: { ...workExecution.outcome, checks: [check("S1", "npm run one"), check("S2", "npm run two")] } };
const prompt = (part: prompts.ReviewPart, round = 1, thread: "continued" | "new" = "continued", since: prompts.SinceReview = null): string =>
  prompts.workReviewPrompt(TEST_ROOT, 2, round, false, execution, thread, part, since);

test("S2: every part's prompt opens with its marker and states its own id form, in every round and thread", () => {
  for (const part of [WHOLE, step("S1")]) {
    for (const [round, thread] of [[1, "continued"], [2, "continued"], [2, "new"]] as const) {
      const text = prompt(part, round, thread);
      assert.ok(text.startsWith(prompts.reviewPartLine(part)), `${prompts.reviewPartKey(part)} ${round} ${thread}`);
      assert.ok(text.includes(`${prompts.idForm("W2", round, part)}1`), `${prompts.reviewPartKey(part)} ${round} ${thread}`);
    }
  }
});

test("S2: the whole work's id form is the code review's form before issue #252", () => {
  assert.equal(prompts.idForm("W2", 3, WHOLE), "W2-R3-");
  assert.equal(prompts.idForm("W2", 3, step("S4")), "W2-R3-S4-");
});

test("S2: a step's part carries its text, its own checks, the named-tests and lifecycle checks, and not another step's checks", () => {
  const text = prompt(step("S1", "Write test/x.test.ts first."));
  assert.ok(text.includes("Write test/x.test.ts first."));
  assert.ok(text.includes("npm run one"));
  assert.ok(!text.includes("npm run two"));
  assert.ok(text.includes(prompts.NAMED_TESTS_CHECK));
  assert.ok(text.includes(prompts.LIFECYCLE_CHECK));
  assert.ok(text.includes(prompts.NAMED_CHECK_NOT_RUN));
  assert.ok(text.includes(prompts.completenessDemand("work")));
});

test("S2: the whole part carries no step's check criterion, but the lifecycle check, the demand and every step's checks", () => {
  const text = prompt(WHOLE);
  assert.ok(!text.includes(prompts.WORK_CHECK_CRITERION));
  assert.ok(!text.includes(prompts.NAMED_TESTS_CHECK));
  assert.ok(text.includes(prompts.LIFECYCLE_CHECK));
  assert.ok(text.includes(prompts.completenessDemand("work")));
  assert.ok(text.includes("npm run one") && text.includes("npm run two"));
});

test("S2: the change since the last code review is named for {review: 1} and absent for null", () => {
  const named = prompts.sincePreviousText(TEST_ROOT, 2, { review: 1 });
  assert.ok(named.includes("work-review-2/since-previous.diff"));
  assert.ok(named.includes("code review 1"));
  assert.equal(prompts.sincePreviousText(TEST_ROOT, 2, null), "");
  for (const part of [WHOLE, step("S1")]) {
    assert.ok(prompt(part, 1, "continued", { review: 1 }).includes(named));
    assert.ok(!prompt(part).includes("since-previous.diff"));
  }
});

const review = (...ids: string[]): Review => ({ issues: ids.map((id) => issue(id)) });

test("S2: partCollisionValidation passes ids no earlier part raised, and refuses a shared one with its repair prompt", () => {
  const form = prompts.idForm("W2", 1, step("S1"));
  const validation = partCollisionValidation(new Set(["W2-R1-1"]), form);
  assert.ok(Result.isSuccess(validation(review("W2-R1-S1-1"))));
  const failed = validation(review("W2-R1-1", "W2-R1-S1-1"));
  assert.ok(Result.isFailure(failed));
  if (Result.isFailure(failed)) {
    assert.equal(failed.failure.error._tag, "RoundInvalid");
    assert.equal(failed.failure.repair, prompts.partCollisionRepairPrompt(["W2-R1-1"], form));
    assert.ok(failed.failure.repair.includes("W2-R1-1"));
    assert.ok(failed.failure.repair.includes(`${form}1`));
  }
});

test("S2 (property): distinct step ids have distinct part keys, each of safe characters", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      fc.pre(a !== b);
      const ka = prompts.reviewPartKey(step(a));
      const kb = prompts.reviewPartKey(step(b));
      return ka !== kb && /^[A-Za-z0-9_-]+$/.test(ka) && /^[A-Za-z0-9_-]+$/.test(kb) && ka !== prompts.reviewPartKey(WHOLE);
    }),
    { numRuns: 500 },
  );
  assert.equal(prompts.reviewPartKey(step("a/b")), "step-a_2f_b");
  assert.equal(prompts.reviewPartKey(step("a_b")), "step-a_5f_b");
});

test("S2 (property): a step's id form never equals a generated self-correction id's prefix", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), fc.stringMatching(/^[A-Za-z0-9]{1,6}$/), (phase, round, id) => {
      const form = prompts.idForm(`W${phase}`, round, step(id));
      return !form.startsWith(`W${phase}-S`);
    }),
    { numRuns: 300 },
  );
});
