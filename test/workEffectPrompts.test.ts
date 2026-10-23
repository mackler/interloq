// Issue #183: what both agents are told to state of a disputed point's effect on the work, and the validation that checks
// what they return, written and tested together (Rules for changes: a prompt and its check together).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import * as prompts from "../src/prompts.ts";
import { correctiveValidation, validateReview, validateRound } from "../src/round.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT, workExecution, issue } from "./helpers.ts";

const KINDS = S.WorkEffectReply.members.map((m) => m.fields.kind.literal);
const work = (round: number, thread: "continued" | "new") => prompts.workReviewPrompt(TEST_ROOT, 1, round, false, workExecution, thread);
const plan = (round: number, thread: "continued" | "new") => prompts.planReviewPrompt(TEST_ROOT, 1, round, false, S.NO_STEP_CHECKS, thread);

test("the rules name the field and both kinds as the schema has them", () => {
  assert.deepEqual(KINDS, ["none", "differs"]);
  for (const rule of [prompts.workEffectReviewRule("plan"), prompts.workEffectReviewRule("work"), prompts.WORK_EFFECT_RESPONSE_RULE]) {
    assert.ok(rule.includes(S.WORK_EFFECT_FIELD), rule);
    for (const kind of KINDS) assert.ok(rule.includes(`"${kind}"`), `${kind}: ${rule}`);
  }
  assert.match(prompts.workEffectReviewRule("plan"), /the work the plan would produce/);
  assert.match(prompts.WORK_EFFECT_RESPONSE_RULE, /not put to the user/);
  assert.match(prompts.WORK_EFFECT_RESPONSE_RULE, /stops the run/);
});

test("the plan's and the work's reviews carry Codex's rule in round 1 and in a new thread; their responses carry Claude Code's", () => {
  for (const text of [plan(1, "continued"), plan(3, "new")]) assert.ok(text.includes(prompts.workEffectReviewRule("plan")));
  for (const text of [work(1, "continued"), work(3, "new")]) assert.ok(text.includes(prompts.workEffectReviewRule("work")));
  assert.ok(prompts.planRespondPrompt(TEST_ROOT, 1, 1, S.NO_STEP_CHECKS).includes(prompts.WORK_EFFECT_RESPONSE_RULE));
  const context = { review: { issues: [] }, log: [], records: { changes: "", requirements: null, decisions: "" } };
  assert.ok(prompts.workRespondPrompt(TEST_ROOT, 1, 1, context, workExecution, "t").includes(prompts.WORK_EFFECT_RESPONSE_RULE));
});

test("the question list's and the terms' prompts carry neither rule", () => {
  for (const text of [prompts.questionReviewPrompt(TEST_ROOT, 1, "continued"), prompts.questionRespondPrompt(TEST_ROOT, 1), prompts.termsReviewPrompt(TEST_ROOT, 1, "continued"), prompts.termsRespondPrompt(TEST_ROOT, 1)]) {
    assert.ok(!text.includes(prompts.WORK_EFFECT_RESPONSE_RULE));
    assert.ok(!text.includes(prompts.workEffectReviewRule("plan")) && !text.includes(prompts.workEffectReviewRule("work")));
  }
});

test("prompt and validation together: a reply that follows the rule passes; a blank difference is repaired by a prompt naming the field", () => {
  const review = Schema.decodeUnknownSync(S.EffectReview)({ issues: [{ ...issue("W1-R1-1"), [S.WORK_EFFECT_FIELD]: { kind: "none" } }] });
  const validated = validateReview(review);
  assert.ok(Result.isSuccess(validated));
  const reply = (effect: unknown) => Schema.decodeUnknownSync(S.WorkResponse)({ dispositions: [{ id: "W1-R1-1", action: "rejected", rationale: "r", duplicate_of: "", reverses: "", [S.WORK_EFFECT_FIELD]: effect }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] });
  assert.ok(Result.isSuccess(validateRound(validated.success, reply({ kind: "none" }), [], 1, 1, "W")));
  const refused = validateRound(validated.success, reply({ kind: "differs", difference: "" }), [], 1, 1, "W");
  assert.ok(Result.isFailure(refused));
  assert.deepEqual(refused.failure.blankEffects, ["W1-R1-1"]);
  assert.ok(prompts.roundRepairPrompt(refused.failure, ["W1-R1-1"]).includes(S.WORK_EFFECT_FIELD));
});

test("the corrective prompt names the field, and the corrective validation lets an accepted disposition move to rejected with a statement", () => {
  for (const text of [prompts.correctivePrompt(TEST_ROOT, "plan.json", 1, ["P1-R1-1"]), prompts.correctionRepairPrompt({ changedIds: [], other: [] }, ["P1-R1-1"])]) assert.ok(text.includes(S.WORK_EFFECT_FIELD), text);
  const base = { self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
  const previous: S.WorkResponse = { ...base, dispositions: [{ id: "P1-R1-1", action: "accepted", rationale: "r", duplicate_of: "", reverses: "", work_effect: { kind: "none" } }] };
  const corrected: S.WorkResponse = { ...base, dispositions: [{ id: "P1-R1-1", action: "rejected", rationale: "no change is needed", duplicate_of: "", reverses: "", work_effect: { kind: "differs", difference: "the test runs twice" } }] };
  assert.ok(Result.isSuccess(correctiveValidation<S.WorkResponse>(previous, ["P1-R1-1"])(corrected)));
});
