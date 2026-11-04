// Issue #245 (the developer's instruction of 3 Nov 2026): Codex's work-review criterion on a step's checks raises no
// point about how long they took, a time already spent that no answer can change, and raises a step only for a named
// or selected check that did not run; the writer's rule and the plan review's criterion keep the two-minute limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const outcome: S.ExecOutcome = { status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks: [{ step: "S1", command: "npm run test:unit", seconds: 30, selection: false, counts: null }] };
const work = { outcome, plan: "the plan" };

test("the work review's criterion names no duration or limit (issue #245)", () => {
  assert.ok(!prompts.WORK_CHECK_CRITERION.includes(`${prompts.STEP_CHECK_LIMIT_MS / 60_000} minutes`));
  assert.doesNotMatch(prompts.WORK_CHECK_CRITERION, /minute|second|took longer|total/iu);
});

test("the work review's criterion raises a step for each named or selected check that did not run (P1-R1-1)", () => {
  const prompted = prompts as Record<string, unknown>;
  const sentence = prompted.NAMED_CHECK_NOT_RUN;
  assert.equal(typeof sentence, "string", "NAMED_CHECK_NOT_RUN is exported");
  assert.ok(prompts.WORK_CHECK_CRITERION.includes(sentence as string));
  assert.match(sentence as string, /for each check command/u);
  assert.match(sentence as string, /do not include/u);
  assert.match(prompts.WORK_CHECK_CRITERION, /step's id, not a file path, in the location field/u);
});

test("the work review's criterion no longer raises tests the change does not touch or extra commands", () => {
  assert.doesNotMatch(prompts.WORK_CHECK_CRITERION, /does not touch/u);
});

test("the work review's first round and a new thread carry the criterion", () => {
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued").includes(prompts.WORK_CHECK_CRITERION));
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 3, false, work, "new").includes(prompts.WORK_CHECK_CRITERION));
});

test("the issue #183 exemptions, which qualified the removed clauses, are gone", () => {
  for (const name of ["PROJECT_RULE_EXEMPTION", "STEP_RULE_EXEMPTION", "EXEMPTED_CHECKS_TIMED"]) {
    assert.equal((prompts as Record<string, unknown>)[name], undefined, name);
  }
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
  assert.ok(prompts.STEP_CHECK_REVIEW_CRITERION.includes(`${prompts.STEP_CHECK_LIMIT_MS / 60_000} minutes`));
});
