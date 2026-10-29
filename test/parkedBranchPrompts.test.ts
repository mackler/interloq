// Issue #186 (requirements Q6, S19): a plan that starts from a parked earlier run's branch. The writer's rule, in the
// first plan's prompt and in the prompt after a withdrawn verdict, and the plan review's first round come from one
// source, parkedBranchFirstStepRule, each naming the branch, with the review's criterion beside the rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { EARLIER_ROOT, TEST_ROOT } from "./helpers.ts";

const BRANCH = "interloq/halted/1/runs/earlier";
const rule = prompts.parkedBranchFirstStepRule(BRANCH);
const cause = { _tag: "ParkedBranch" as const, root: EARLIER_ROOT, branch: BRANCH };

test("the rule names the branch, and reaches the first plan's writer, the writer after a withdrawn verdict and the reviewer", () => {
  assert.ok(rule.includes(BRANCH));
  assert.ok(prompts.initialPlanPrompt(TEST_ROOT, "t", false, NO_STEP_CHECKS, rule).includes(rule));
  assert.ok(prompts.planAfterVerdictPrompt(TEST_ROOT, "t", false, 1, cause, NO_STEP_CHECKS).includes(rule));
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, NO_STEP_CHECKS, "continued", BRANCH);
  assert.ok(review.includes(rule));
  assert.ok(review.includes(prompts.PARKED_BRANCH_REVIEW_CRITERION));
});

test("without a parked branch the plan review carries neither the rule nor its criterion", () => {
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, NO_STEP_CHECKS, "continued");
  assert.ok(!review.includes(prompts.PARKED_BRANCH_REVIEW_CRITERION));
  assert.ok(!review.includes("parked its work on the branch"));
});

test("the incomplete parking's line names the earlier run and its branch and says the plan starts from the working branch", () => {
  const line = prompts.earlierParkingIncompleteLine(EARLIER_ROOT, BRANCH);
  assert.ok(line.includes(EARLIER_ROOT) && line.includes(BRANCH));
  assert.match(line, /working branch/);
  assert.match(prompts.earlierRunParkedLine(EARLIER_ROOT, BRANCH), /starts from/);
});
