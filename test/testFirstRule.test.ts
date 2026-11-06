// Issue #228: Interloq states the types-first, test-first sequence itself in every implementation run, from one source
// given to the plan writer, the execution and both reviews. The prompts and the checks they rely on are tested together
// (Rules for changes). No scripted agent can show that a real agent obeys the rule; these tests establish what each
// agent is given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { EARLIER_ROOT, TEST_ROOT } from "./helpers.ts";

const checks: S.StepChecks = Result.getOrThrow(S.stepChecksOf({ checkCommands: [], suiteCommand: "npm test", endToEndCommand: null }));

const SENTENCES = {
  CODE_STEP_SENTENCE: prompts.CODE_STEP_SENTENCE,
  TYPE_CHECKER_SENTENCE: prompts.TYPE_CHECKER_SENTENCE,
  COUNTED_FAILURES_SENTENCE: prompts.COUNTED_FAILURES_SENTENCE,
  TYPES_FIRST_SENTENCE: prompts.TYPES_FIRST_SENTENCE,
  TESTS_FIRST_SENTENCE: prompts.TESTS_FIRST_SENTENCE,
  LEAST_CODE_SENTENCE: prompts.LEAST_CODE_SENTENCE,
  REFACTOR_SENTENCE: prompts.REFACTOR_SENTENCE,
  END_TO_END_SENTENCE: prompts.END_TO_END_SENTENCE,
  TEST_FIRST_RULE: prompts.TEST_FIRST_RULE,
  TEST_FIRST_REVIEW_CRITERION: prompts.TEST_FIRST_REVIEW_CRITERION,
};

test("issue #228: every sentence of the rule is written", () => {
  for (const [name, text] of Object.entries(SENTENCES)) assert.ok(text.trim().length > 0, name);
});

test("issue #228: the six plan prompts and the execution prompt carry the rule, which carries every sentence", () => {
  const plans = {
    initialPlanPrompt: prompts.initialPlanPrompt(TEST_ROOT, "t", true, checks),
    planApplyDecisionsPrompt: prompts.planApplyDecisionsPrompt(TEST_ROOT, checks),
    planRespondPrompt: prompts.planRespondPrompt(TEST_ROOT, 1, 1, checks),
    revisePlanAfterExecutionPrompt: prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", true, 1, { _tag: "ExecutionEnded", stop: null, workReview: "converged" }, checks),
    earlierPlanPrompt: prompts.earlierPlanPrompt(TEST_ROOT, "t", true, EARLIER_ROOT, checks),
    planAfterVerdictPrompt: prompts.planAfterVerdictPrompt(TEST_ROOT, "t", false, 1, { _tag: "FirstPlan" }, checks),
    executePrompt: prompts.executePrompt(TEST_ROOT, "t", true, checks),
  };
  assert.ok(prompts.TEST_FIRST_RULE.length > 0);
  for (const [name, text] of Object.entries(plans)) assert.ok(text.includes(prompts.TEST_FIRST_RULE), name);
  for (const name of ["CODE_STEP_SENTENCE", "TYPE_CHECKER_SENTENCE", "TYPES_FIRST_SENTENCE", "TESTS_FIRST_SENTENCE", "LEAST_CODE_SENTENCE", "REFACTOR_SENTENCE", "END_TO_END_SENTENCE"] as const) {
    assert.ok(SENTENCES[name].length > 0 && prompts.TEST_FIRST_RULE.includes(SENTENCES[name]), name);
  }
  assert.ok(prompts.COUNTED_FAILURES_SENTENCE.length > 0 && prompts.TESTS_FIRST_SENTENCE.includes(prompts.COUNTED_FAILURES_SENTENCE));
  assert.ok(prompts.END_TO_END_SENTENCE.length > 0 && !prompts.END_TO_END_SENTENCE.includes("npm"), "the rule reaches projects with any build system");
});

test("issue #228: the plan review's first round gives Codex the rule and the criterion; a later round in the thread neither", () => {
  const first = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, checks, "continued");
  assert.ok(prompts.TEST_FIRST_REVIEW_CRITERION.length > 0);
  assert.ok(first.includes(prompts.TEST_FIRST_RULE) && first.includes(prompts.TEST_FIRST_REVIEW_CRITERION));
  const fresh = prompts.planReviewPrompt(TEST_ROOT, 1, 3, false, checks, "new");
  assert.ok(fresh.includes(prompts.TEST_FIRST_REVIEW_CRITERION), "a new thread's first round");
  const later = prompts.planReviewPrompt(TEST_ROOT, 1, 2, false, checks, "continued");
  assert.ok(!later.includes(prompts.TEST_FIRST_RULE) && !later.includes(prompts.TEST_FIRST_REVIEW_CRITERION));
  assert.ok(prompts.CODE_STEP_SENTENCE.length > 0 && prompts.TEST_FIRST_REVIEW_CRITERION.includes(prompts.CODE_STEP_SENTENCE));
  assert.ok(prompts.TYPE_CHECKER_SENTENCE.length > 0 && prompts.TEST_FIRST_REVIEW_CRITERION.includes(prompts.TYPE_CHECKER_SENTENCE));
});

test("issue #228: the rule states its parts in order: types, tests, least code, refactor", () => {
  const at = (s: string): number => {
    assert.ok(s.length > 0);
    const i = prompts.TEST_FIRST_RULE.indexOf(s);
    assert.ok(i >= 0);
    return i;
  };
  const order = [prompts.TYPES_FIRST_SENTENCE, prompts.TESTS_FIRST_SENTENCE, prompts.LEAST_CODE_SENTENCE, prompts.REFACTOR_SENTENCE].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

// A project with no type checker on a step's code: the writer's rule and the review's criterion carry the same statement
// of when the types-first part applies, and the criterion raises a types part stated where it does not apply. The
// scripted agents cannot show a real agent judging a project by it.
test("issue #228: a step of code no type checker covers carries no types-first part and is not raised for it", () => {
  assert.ok(prompts.TYPE_CHECKER_SENTENCE.length > 0);
  assert.ok(prompts.TEST_FIRST_RULE.includes(prompts.TYPE_CHECKER_SENTENCE));
  assert.ok(prompts.TEST_FIRST_REVIEW_CRITERION.includes(prompts.TYPE_CHECKER_SENTENCE));
  assert.match(prompts.TEST_FIRST_REVIEW_CRITERION, /types-first part where it does not apply/);
  assert.match(prompts.TYPE_CHECKER_SENTENCE, /starts at the tests/);
});
