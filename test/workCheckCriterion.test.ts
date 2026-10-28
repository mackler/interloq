// Issue #183, decision Q1: Codex's work-review criterion on a step's checks accepts a test or command that the project's
// own instruction files or the step's own selection rule required, and the writer's rule and the plan review's
// criterion stay as they were.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const outcome: S.ExecOutcome = { status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks: [{ step: "S1", command: "npm run test:unit", seconds: 30 }] };
const work = { outcome, plan: "the plan" };

test("the work review's criterion carries both exemptions", () => {
  assert.ok(prompts.WORK_CHECK_CRITERION.includes(prompts.PROJECT_RULE_EXEMPTION));
  assert.ok(prompts.WORK_CHECK_CRITERION.includes(prompts.STEP_RULE_EXEMPTION));
  assert.ok(prompts.WORK_CHECK_CRITERION.includes(`${prompts.STEP_CHECK_LIMIT_MS / 60_000} minutes`), "the time clause stays");
});

test("the work review's first round and a new thread carry the widened criterion", () => {
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued").includes(prompts.WORK_CHECK_CRITERION));
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 3, false, work, "new").includes(prompts.WORK_CHECK_CRITERION));
});

test("an exempted check still counts toward the two-minute total (W1-R1-1)", () => {
  const criterion = prompts.WORK_CHECK_CRITERION;
  const timed = criterion.indexOf(prompts.EXEMPTED_CHECKS_TIMED);
  assert.ok(timed >= 0, "the criterion carries EXEMPTED_CHECKS_TIMED");
  assert.ok(timed > criterion.indexOf(prompts.PROJECT_RULE_EXEMPTION) && timed > criterion.indexOf(prompts.STEP_RULE_EXEMPTION), "after both exemptions");
  assert.ok(prompts.EXEMPTED_CHECKS_TIMED.includes(`${prompts.STEP_CHECK_LIMIT_MS / 60_000} minutes`));
  for (const exemption of [prompts.PROJECT_RULE_EXEMPTION, prompts.STEP_RULE_EXEMPTION]) {
    assert.ok(!exemption.includes("under this criterion"), `no exemption lifts the whole criterion: ${exemption}`);
  }
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued").includes(prompts.EXEMPTED_CHECKS_TIMED));
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 3, false, work, "new").includes(prompts.EXEMPTED_CHECKS_TIMED));
});

test("the writer's rule and the plan review's criterion are not tightened", () => {
  assert.equal(
    prompts.STEP_CHECK_TOUCHED_ONLY,
    "A step's check runs only the tests its change touches, and all of its check commands together finish within 2 minutes; where the touched tests would take longer, the step runs the part that fits and leaves the rest unrun.",
  );
  assert.equal(
    prompts.STEP_CHECK_REVIEW_CRITERION,
    "Raise an issue for a remaining step whose text names no check command, whose named checks run tests the step's change does not touch or are expected to take more than 2 minutes together, or that runs the whole test suite.",
  );
});
