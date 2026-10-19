// Issue #181 (requirements Q5): in an implementation run Claude Code settles every question about how to build the work
// itself, stating its assumption in the plan, and asks the developer only about what the work should achieve; Codex's
// plan review holds the plan to the same rule. A judgment of prose, so the rule and the criterion are tested from one
// source, as the commit step's are (test/commitCheckPrompts.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { EARLIER_ROOT, TEST_ROOT } from "./helpers.ts";

test("every prompt that asks for the whole plan or amends it in response to a review carries the rule on questions", () => {
  const plans = {
    initialPlanPrompt: prompts.initialPlanPrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS),
    planRespondPrompt: prompts.planRespondPrompt(TEST_ROOT, 1, 1, NO_STEP_CHECKS),
    revisePlanAfterExecutionPrompt: prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", true, 1, { _tag: "ExecutionEnded", stop: null, workReview: "converged" }, NO_STEP_CHECKS),
    earlierPlanPrompt: prompts.earlierPlanPrompt(TEST_ROOT, "t", true, EARLIER_ROOT, NO_STEP_CHECKS),
  };
  for (const [name, text] of Object.entries(plans)) assert.ok(text.includes(prompts.PLAN_QUESTIONS_RULE), name);
});

test("the plan review's first round gives Codex the rule and the criterion; a later round in the continued thread neither", () => {
  const first = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, NO_STEP_CHECKS, "continued");
  assert.ok(first.includes(prompts.PLAN_QUESTIONS_RULE));
  assert.ok(first.includes(prompts.PLAN_QUESTIONS_REVIEW_CRITERION));
  const later = prompts.planReviewPrompt(TEST_ROOT, 1, 2, false, NO_STEP_CHECKS, "continued");
  assert.ok(!later.includes(prompts.PLAN_QUESTIONS_RULE));
  assert.ok(!later.includes(prompts.PLAN_QUESTIONS_REVIEW_CRITERION));
  const restarted = prompts.planReviewPrompt(TEST_ROOT, 1, 2, false, NO_STEP_CHECKS, "new");
  assert.ok(restarted.includes(prompts.PLAN_QUESTIONS_REVIEW_CRITERION), "a new thread gets the first round's instructions");
});

test("the question list's and the terms' response prompts do not carry the rule", () => {
  assert.ok(!prompts.questionRespondPrompt(TEST_ROOT, 1).includes(prompts.PLAN_QUESTIONS_RULE));
  assert.ok(!prompts.termsRespondPrompt(TEST_ROOT, 1).includes(prompts.PLAN_QUESTIONS_RULE));
});

test("the rule names the field the plan writer's questions go in", () => {
  assert.match(prompts.PLAN_QUESTIONS_RULE, /questions_for_user/u);
});
