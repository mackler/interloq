// Issue #162: what Claude Code is told to write about a step's check and what Codex checks are built from the same
// constants, so the writer and the reviewers cannot drift apart (Rules for changes: a prompt and its check together).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const checks: S.StepChecks = Result.getOrThrow(
  S.stepChecksOf({ checkCommands: [{ change: "the program's modules", command: "npm run test:unit" }, { change: "the page", command: "npm run test:web" }], suiteCommand: "npm test" }),
);

test("the plan writer's rule and the plan review's first round carry the same criteria, commands and suite", () => {
  const rule = prompts.planStepCheckRule(checks);
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, checks);
  for (const text of [rule, review]) {
    for (const sentence of [prompts.STEP_CHECK_NAMED, prompts.STEP_CHECK_TOUCHED_ONLY, prompts.STEP_CHECK_NO_SUITE]) assert.ok(text.includes(sentence), sentence);
    for (const entry of checks.commands) assert.ok(text.includes(entry.command), entry.command);
    assert.ok(text.includes(`\`${checks.suite}\``));
  }
  assert.ok(review.includes(prompts.STEP_CHECK_REVIEW_CRITERION), "the plan review raises a step against the rule");
});

test("the plan review's criterion names no command where the project lists none", () => {
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, S.NO_STEP_CHECKS);
  assert.ok(review.includes(prompts.STEP_CHECK_REVIEW_CRITERION));
  for (const entry of checks.commands) assert.ok(!review.includes(entry.command));
});
