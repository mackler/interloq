import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { describe, VerdictInvalid } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { pathOf } from "../src/artifacts.ts";
import { noQuestionsValidation, verdictValidation } from "../src/verdictValidation.ts";
import { TEST_ROOT } from "./helpers.ts";

// Issue #186: the verdict's prompts and its validations, written and tested together.
const NO_CHECKS = S.NO_STEP_CHECKS;
const EARLIER = "runs/2026-10-01T00-00-00-000Z-implementation-1" as typeof TEST_ROOT;

test("the first plan's prompts name both kinds of its reply, from the schema's literals", () => {
  const kinds = S.FirstPlanReply.fields.reply.members.map((m) => m.fields.kind.literal);
  assert.deepEqual(kinds, [...S.FIRST_PLAN_KINDS]);
  for (const text of [prompts.initialPlanPrompt(TEST_ROOT, "t", false, NO_CHECKS), prompts.earlierPlanPrompt(TEST_ROOT, "t", false, EARLIER, NO_CHECKS)]) {
    assert.ok(text.includes(prompts.FIRST_PLAN_REPLY_SHAPE) && text.includes(prompts.NOT_REFINED_RULE));
    for (const kind of kinds) assert.ok(text.includes(`"kind": "${kind}"`) || text.includes(`'${kind}'`), kind);
  }
});

test("the verdict's review prompt names the reviewed file and log of the catalog, and the ids V<n>-R<r>-<i>", () => {
  const first = prompts.verdictReviewPrompt(TEST_ROOT, 2, 1, true, "continued");
  assert.ok(first.includes(pathOf({ kind: "verdict", verdict: 2 })));
  assert.ok(first.includes(pathOf({ kind: "log", subject: { verdict: 2 } })));
  assert.ok(first.includes("V2-R1-1"));
  assert.ok(prompts.verdictReviewPrompt(TEST_ROOT, 2, 3, true, "continued").includes("V2-R3-1"));
  assert.ok(prompts.verdictReviewPrompt(TEST_ROOT, 2, 3, true, "new").includes(prompts.newThreadSentence(TEST_ROOT, pathOf({ kind: "log", subject: { verdict: 2 } }), 3)));
});

test("a blank verdict is refused, and its repair prompt names the field the prompts ask for", () => {
  const refused = verdictValidation<S.VerdictResponse>()({ dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], missing: "  \n" });
  assert.ok(Result.isFailure(refused));
  assert.equal(refused.failure.error._tag, "VerdictInvalid");
  assert.ok(refused.failure.repair.includes("'missing'"));
  assert.ok(prompts.NOT_REFINED_RULE.includes("'missing'") && prompts.verdictRespondPrompt(TEST_ROOT, 1, 1, { _tag: "FirstPlan" }).includes("'missing'"));
  assert.ok(Result.isSuccess(verdictValidation<S.NotRefinedVerdict>()({ kind: "notRefined", missing: "The retention period." })));
  assert.match(describe(new VerdictInvalid({ problem: "blankMissing" })), /missing/);
});

test("a response to a review of the verdict that asks the developer something is refused", () => {
  const question = { context: [], history: [], question: [], explanations: [], options: [] };
  const refused = noQuestionsValidation<S.VerdictResponse>()({ dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [question], missing: "m" });
  assert.ok(Result.isFailure(refused) && refused.failure.error._tag === "VerdictInvalid");
  assert.ok(!prompts.verdictRespondPrompt(TEST_ROOT, 1, 1, { _tag: "FirstPlan" }).includes(prompts.QUESTION_OPTIONS_RULE));
});

test("a verdict given in an execution embeds the task and that execution's report", () => {
  const text = prompts.verdictRespondPrompt(TEST_ROOT, 1, 1, { _tag: "Execution", phase: 2, task: "THE TASK", summary: "did S1", remainingWork: "S2" });
  assert.ok(text.includes("THE TASK") && text.includes("did S1") && text.includes("execution phase 2"));
});

test("the plan after a withdrawn verdict follows its phase's cause: a parked branch's rule, an earlier run's plan", () => {
  const parked = prompts.planAfterVerdictPrompt(TEST_ROOT, "t", false, 1, { _tag: "ParkedBranch", root: EARLIER, branch: "interloq/halted/1/run" }, NO_CHECKS);
  assert.ok(parked.includes(prompts.parkedBranchFirstStepRule("interloq/halted/1/run")));
  const earlier = prompts.planAfterVerdictPrompt(TEST_ROOT, "t", false, 1, { _tag: "EarlierPlan", root: EARLIER }, NO_CHECKS);
  assert.ok(earlier.includes(EARLIER));
  const fresh = prompts.planAfterVerdictPrompt(TEST_ROOT, "t", false, 1, { _tag: "FirstPlan" }, NO_CHECKS);
  for (const rule of [prompts.planFormat(TEST_ROOT), prompts.planStepCheckRule(NO_CHECKS), prompts.PLAN_COMMIT_STEP_RULE, prompts.planIdRule(TEST_ROOT), prompts.PLAN_BUILD_RULE]) assert.ok(fresh.includes(rule));
  assert.ok(!fresh.includes("questions_for_user") && !fresh.includes(prompts.NOT_REFINED_RULE));
});

test("a revision after a withdrawn verdict names the verdict and its log", () => {
  const text = prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 1, { _tag: "VerdictWithdrawn", verdict: 3 }, NO_CHECKS);
  assert.ok(text.includes(pathOf({ kind: "verdict", verdict: 3 })) && text.includes(pathOf({ kind: "log", subject: { verdict: 3 } })));
  // The text of a revision after an execution's end is unchanged by the verdict.
  assert.ok(prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 1, { _tag: "ExecutionEnded", stop: null, workReview: "converged" }, NO_CHECKS).includes(prompts.PLAN_QUESTIONS_RULE));
});

test("the execution prompt's verdict status is for what the work should achieve, never a failure", () => {
  assert.match(prompts.NOT_REFINED_STATUS_SENTENCE, /'not_refined'/);
  assert.match(prompts.NOT_REFINED_STATUS_SENTENCE, /Never use 'not_refined' for a failure/);
});
