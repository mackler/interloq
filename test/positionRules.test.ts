// Issue #38: what both agents are told to state of their positions and of a resolution of both concerns, and the
// validation that checks what they return, written and tested together (Rules for changes: a prompt and its check together).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as log from "../src/issueLog.ts";
import * as prompts from "../src/prompts.ts";
import { correctiveValidation, validateReview, validateRound, type ValidatedReview } from "../src/round.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT, issue, respond } from "./helpers.ts";

const FIELDS = [S.CONCERN_FIELD, S.REMEDY_FIELD, S.RESOLUTION_FIELD];
const ok = <A, E>(r: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(r), JSON.stringify(Result.isFailure(r) ? r.failure : null));
  return r.success;
};
const reviewed = (...ids: string[]): ValidatedReview => ok(validateReview({ issues: ids.map((i) => issue(i)) }));
const disposition = (id: string, action: S.Action, extra: Partial<S.Disposition> = {}): S.Disposition => ({ id, action, rationale: "r", duplicate_of: "", reverses: "", concern: "", remedy: "", resolution: null, ...extra });
const self = (id: string, new_action: "accepted" | "rejected" | "plan_error", extra: Partial<S.SelfCorrection> = {}): S.SelfCorrection => ({ id, new_action, explanation: "x", concern: "", remedy: "", resolution: null, ...extra });
const response = (dispositions: S.Disposition[], self_corrections: S.SelfCorrection[] = []): S.PlannerResponse => ({ dispositions, self_corrections, reviewer_feedback: "", questions_for_user: [] });
const both = { concern: "the step must stay small", remedy: "keep the step as it is" };

test("both rules name the three fields as the schema has them, and reach every review and every response", () => {
  for (const field of FIELDS) assert.ok(prompts.POSITION_RESPONSE_RULE.includes(field), field);
  for (const field of [S.CONCERN_FIELD, S.REMEDY_FIELD, S.RESOLUTION_FIELD, "reviewer_position", "planner_position", "investigations"]) assert.ok(prompts.POSITION_REVIEW_RULE.includes(field), field);
  for (const text of [prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, S.NO_STEP_CHECKS, "continued"), prompts.questionReviewPrompt(TEST_ROOT, 1, "continued"), prompts.termsReviewPrompt(TEST_ROOT, 1, "continued")]) assert.ok(text.includes(prompts.POSITION_REVIEW_RULE));
  for (const text of [prompts.planRespondPrompt(TEST_ROOT, 1, 1, S.NO_STEP_CHECKS), prompts.questionRespondPrompt(TEST_ROOT, 1), prompts.termsRespondPrompt(TEST_ROOT, 1)]) assert.ok(text.includes(prompts.POSITION_RESPONSE_RULE));
});

test("a review whose issue has a blank concern is refused, and its repair prompt names the id and the field", () => {
  const refused = validateReview({ issues: [{ ...issue("P1-R1-1"), concern: " " }] });
  assert.ok(Result.isFailure(refused));
  assert.deepEqual(refused.failure.blankPositions, ["P1-R1-1"]);
  const repair = prompts.reviewRepairPrompt(refused.failure);
  assert.ok(repair.includes("P1-R1-1") && repair.includes(S.CONCERN_FIELD), repair);
  assert.deepEqual(ok(validateReview({ issues: [issue("P1-R1-1")] })).issues[0].position, { concern: "scripted concern", remedy: "scripted remedy" });
});

test("a response is refused where a position or a resolution is blank where it is required, and its repair prompt names the id", () => {
  const r = reviewed("A");
  const cases: [string, S.PlannerResponse][] = [
    ["a resolution with a blank text", response([disposition("A", "partially_accepted", { ...both, resolution: { text: " ", changes: [] } })])],
    ["a resolution with a blank change", response([disposition("A", "rejected", { ...both, resolution: { text: "t", changes: [""] } })])],
    ["a disposition not accepted in full with a blank remedy", response([disposition("A", "rejected", { concern: "c" })])],
    ["a rejected self-correction with a blank concern", response([disposition("A", "accepted")], [self("B", "rejected", { remedy: "r" })])],
    ["an accepted self-correction with a resolution and a blank concern", response([disposition("A", "accepted")], [self("B", "accepted", { remedy: "r", resolution: { text: "t", changes: [] } })])],
    ["an accepted disposition with a resolution and a blank concern", response([disposition("A", "accepted", { remedy: "r", resolution: { text: "t", changes: [] } })])],
  ];
  for (const [what, reply] of cases) {
    const refused = validateRound(r, reply, [], 1, 1, "P");
    assert.ok(Result.isFailure(refused), what);
    assert.equal(refused.failure.blankPositions.length, 1, what);
    const repair = prompts.roundRepairPrompt(refused.failure, ["A"]);
    assert.ok(repair.includes(refused.failure.blankPositions[0]) && repair.includes(S.CONCERN_FIELD), `${what}: ${repair}`);
  }
});

test("an accepted disposition with no resolution needs no position; a repaired self-correction is recorded with its position and resolution", () => {
  const r = reviewed("A");
  const accepted = ok(validateRound(r, response([disposition("A", "accepted")]), [], 1, 1, "P"));
  assert.equal(accepted.dispositions[0].position, null);
  assert.equal(accepted.dispositions[0].resolution, null);
  const repaired = ok(validateRound(r, response([disposition("A", "rejected", both)], [self("B", "accepted", { ...both, resolution: { text: "meets both", changes: [] } })]), [], 1, 1, "P"));
  assert.deepEqual(repaired.dispositions[0].position, both);
  const appended = log.appendRound([], repaired, null);
  const a = appended.find((e) => e.id === "A")!;
  const b = appended.find((e) => e.id === "B")!;
  assert.ok(a.source === "review" && b.source === "self_correction");
  assert.deepEqual(a.planner_position, both);
  assert.deepEqual(a.reviewer_position, { concern: "scripted concern", remedy: "scripted remedy" });
  assert.deepEqual(b.planner_position, both);
  assert.deepEqual(b.resolution, { text: "meets both", changes: [] });
});

test("a corrective reply may turn an accepted disposition rejected with a position and a resolution, and its prompts name those fields", () => {
  const previous = response([disposition("A", "accepted")]);
  const corrected = response([disposition("A", "rejected", { ...both, resolution: { text: "t", changes: ["requirement 2"] } })]);
  assert.ok(Result.isSuccess(correctiveValidation<S.PlannerResponse>(previous, ["A"])(corrected)));
  assert.ok(Result.isSuccess(validateRound(reviewed("A"), corrected, [], 1, 1, "P")));
  for (const text of [prompts.correctivePrompt(TEST_ROOT, "plan.json", 1, ["A"]), prompts.correctionRepairPrompt({ changedIds: [], other: [] }, ["A"])]) for (const field of FIELDS) assert.ok(text.includes(field), `${field}: ${text}`);
});

test("appendRound records the investigations it is given, replaces a list where one is given and carries it forward otherwise", () => {
  const first = ok(validateRound(reviewed("A", "B"), respond([["A", "rejected"], ["B", "rejected"]]), [], 1, 1, "P"));
  const investigated: S.Investigation[] = [{ pause: "reraised", other: null }];
  const after1 = log.appendRound([], first, null, new Map([["A", investigated]]));
  const current = (l: readonly S.LogEntry[], i: string) => l.filter((e) => e.id === i && !e.superseded).at(-1)!;
  const inv = (e: S.LogEntry) => (e.source === "user" ? null : e.investigations);
  assert.deepEqual(inv(current(after1, "A")), investigated);
  assert.deepEqual(inv(current(after1, "B")), []);
  const second = ok(validateRound(reviewed("A", "B"), respond([["A", "rejected"], ["B", "rejected"]]), after1, 1, 2, "P"));
  const carried = log.appendRound(after1, second, null);
  assert.deepEqual(inv(current(carried, "A")), investigated);
  const replaced = log.appendRound(after1, second, null, new Map([["A", []]]));
  assert.deepEqual(inv(current(replaced, "A")), []);
});
