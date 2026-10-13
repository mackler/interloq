// Issue #151: the validation repair turn of a review and of a response (RoundInvalid). Every expectation is derived from
// the failure value, so the halt's text, the repair prompts and the validation are tested for their agreement.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { describe, RoundInvalid } from "../src/errors.ts";
import { cycleInvalidText, reviewRepairPrompt, roundInvalidParts, roundRepairPrompt, ROUND_REPAIR } from "../src/prompts.ts";
import { reviewValidation, roundValidation, validateReview, validateRound, type ValidatedReview } from "../src/round.ts";
import type { PlannerResponse } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

type Fields = ConstructorParameters<typeof RoundInvalid>[0];
const EMPTY: Fields = { duplicateIssues: [], missing: [], duplicateDispositions: [], unknownDispositions: [], emptyIds: [], collidingIds: [] };
const invalidOf = (fields: Partial<Fields>): RoundInvalid => new RoundInvalid({ ...EMPTY, ...fields });
const REVIEW_IDS = ["Q-R1-1", "Q-R1-2"] as const;

/** Each field of RoundInvalid set alone, the agent whose reply it refuses, and the instruction its prompt must carry. */
const CASES: readonly Readonly<{ field: keyof Fields; error: RoundInvalid; agent: "codex" | "claude"; instruction: string }>[] = [
  { field: "duplicateIssues", error: invalidOf({ duplicateIssues: ["Q-R1-1"] }), agent: "codex", instruction: ROUND_REPAIR.duplicateIssues(["Q-R1-1"]) },
  { field: "emptyIds", error: invalidOf({ emptyIds: ["an issue of the review"] }), agent: "codex", instruction: ROUND_REPAIR.emptyIssueId },
  { field: "missing", error: invalidOf({ missing: ["Q-R1-1"] }), agent: "claude", instruction: ROUND_REPAIR.missing(["Q-R1-1"]) },
  { field: "duplicateDispositions", error: invalidOf({ duplicateDispositions: ["Q-R1-2"] }), agent: "claude", instruction: ROUND_REPAIR.duplicateDispositions(["Q-R1-2"]) },
  { field: "unknownDispositions", error: invalidOf({ unknownDispositions: ["Q-R1-9"] }), agent: "claude", instruction: ROUND_REPAIR.unknownDispositions(["Q-R1-9"], REVIEW_IDS) },
  { field: "emptyIds", error: invalidOf({ emptyIds: ["a disposition of the response"] }), agent: "claude", instruction: ROUND_REPAIR.emptyDispositionId },
  { field: "collidingIds", error: invalidOf({ collidingIds: ["P1-S1-1"] }), agent: "claude", instruction: ROUND_REPAIR.collidingIds(["P1-S1-1"]) },
];
const promptOf = (c: (typeof CASES)[number]): string => (c.agent === "codex" ? reviewRepairPrompt(c.error) : roundRepairPrompt(c.error, REVIEW_IDS));

test("the repair prompt of each field of RoundInvalid states what the validation refused, with its ids", () => {
  for (const c of CASES) {
    const prompt = promptOf(c);
    const parts = roundInvalidParts(c.error);
    assert.ok(parts.length > 0, c.field);
    for (const part of parts) assert.ok(prompt.includes(part), `${c.field}: ${part}\n${prompt}`);
    for (const id of c.error[c.field]) assert.ok(prompt.includes(id), `${c.field}: ${id}`);
  }
});

test("the motivating case: a missing disposition is named as the halt names it", () => {
  const error = invalidOf({ missing: ["Q-R1-1"] });
  assert.ok(roundRepairPrompt(error, ["Q-R1-1"]).includes("Claude Code returned no disposition for: Q-R1-1"));
});

test("each field has its own instruction of what to return instead, and no prompt carries another field's", () => {
  for (const c of CASES) {
    const prompt = promptOf(c);
    assert.ok(c.instruction.length > 0, c.field);
    assert.ok(prompt.includes(c.instruction), `${c.field}\n${prompt}`);
    for (const other of CASES) if (other !== c) assert.ok(!prompt.includes(other.instruction), `${c.field} carries ${other.field}'s instruction`);
  }
});

test("the repair prompt of an unknown disposition names the review's own issue ids", () => {
  const prompt = roundRepairPrompt(invalidOf({ unknownDispositions: ["Q-R1-9"] }), REVIEW_IDS);
  for (const id of REVIEW_IDS) assert.ok(prompt.includes(id), id);
});

test("the halt and the repair prompts state the problem from one source", () => {
  const error = invalidOf({ duplicateIssues: ["A"], missing: ["B"], duplicateDispositions: ["C"], unknownDispositions: ["D"], emptyIds: ["a disposition of the response"], collidingIds: ["P1-S1-1"] });
  assert.equal(describe(error), cycleInvalidText(roundInvalidParts(error)));
});

test("the validations refuse what validateReview and validateRound refuse, with the prompt derived from the failure", () => {
  const review = { issues: [issue("Q-R1-1"), issue("Q-R1-1")] };
  const refused = validateReview(review);
  assert.ok(Result.isFailure(refused));
  const viaReview = reviewValidation(review);
  assert.ok(Result.isFailure(viaReview));
  assert.equal(viaReview.failure.repair, reviewRepairPrompt(refused.failure));
  assert.deepEqual(viaReview.failure.error, refused.failure);

  const validated = validateReview({ issues: [issue("Q-R1-1")] });
  assert.ok(Result.isSuccess(validated));
  const check = (r: PlannerResponse) => validateRound(validated.success as ValidatedReview, r, [], 1, 1, "Q");
  const response = respond([]);
  const failure = check(response);
  assert.ok(Result.isFailure(failure));
  const viaRound = roundValidation(check, ["Q-R1-1"])(response);
  assert.ok(Result.isFailure(viaRound));
  assert.equal(viaRound.failure.repair, roundRepairPrompt(failure.failure, ["Q-R1-1"]));
  const good = respond([["Q-R1-1", "accepted"]]);
  const passed = roundValidation(check, ["Q-R1-1"])(good);
  assert.ok(Result.isSuccess(passed));
  assert.equal(passed.success.value, good);
});

test("property: each prompt names every id of every field it covers", () => {
  const id = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/[\r\n]/.test(s));
  const ids = fc.array(id, { maxLength: 3 });
  fc.assert(
    fc.property(ids, ids, ids, ids, ids, fc.boolean(), (duplicateIssues, missing, duplicateDispositions, unknownDispositions, collidingIds, empty) => {
      const review = invalidOf({ duplicateIssues, emptyIds: empty ? ["an issue of the review"] : [] });
      const response = invalidOf({ missing, duplicateDispositions, unknownDispositions, collidingIds, emptyIds: empty ? ["a disposition of the response"] : [] });
      const reviewPrompt = reviewRepairPrompt(review);
      const responsePrompt = roundRepairPrompt(response, REVIEW_IDS);
      for (const x of duplicateIssues) assert.ok(reviewPrompt.includes(x));
      for (const x of [...missing, ...duplicateDispositions, ...unknownDispositions, ...collidingIds]) assert.ok(responsePrompt.includes(x));
      for (const part of roundInvalidParts(review)) assert.ok(reviewPrompt.includes(part));
      for (const part of roundInvalidParts(response)) assert.ok(responsePrompt.includes(part));
    }),
    { numRuns: 200 },
  );
});
