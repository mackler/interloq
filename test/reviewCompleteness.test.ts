import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { TEST_ROOT, workExecution } from "./helpers.ts";

// Issue #252, S1: the plan review and the code review demand every defect in one review, in their first and later
// cycles, from one source; no other review carries the demand.

const plan = (round: number, thread: "continued" | "new"): string => prompts.planReviewPrompt(TEST_ROOT, 1, round, false, NO_STEP_CHECKS, thread);
const work = (round: number, thread: "continued" | "new"): string => prompts.workReviewPrompt(TEST_ROOT, 1, round, false, workExecution, thread, { _tag: "Whole" }, null);

test("S1: the plan review's first round and a new thread carry the plan's completeness demand", () => {
  for (const text of [plan(1, "continued"), plan(2, "new")]) assert.ok(text.includes(prompts.completenessDemand("plan")));
});

test("S1: the plan review's later round in its thread carries the later-cycle text", () => {
  assert.ok(plan(2, "continued").includes(prompts.laterCycleCompleteness("plan")));
});

test("S1: the code review's first round and a new thread carry the work's demand and the accepted-not-repeated rule", () => {
  for (const text of [work(1, "continued"), work(2, "new")]) {
    assert.ok(text.includes(prompts.completenessDemand("work")));
    assert.ok(text.includes(prompts.WORK_ACCEPTED_NOT_REPEATED));
  }
});

test("S1: the code review's later round carries the later-cycle text, which names the accepted-not-repeated rule", () => {
  const later = work(2, "continued");
  assert.ok(later.includes(prompts.laterCycleCompleteness("work")));
  assert.ok(prompts.laterCycleCompleteness("work").includes(prompts.WORK_ACCEPTED_NOT_REPEATED));
  assert.ok(!prompts.laterCycleCompleteness("plan").includes(prompts.WORK_ACCEPTED_NOT_REPEATED));
});

test("S1: both kinds state the same cost of a defect left for later", () => {
  for (const kind of ["plan", "work"] as const) assert.ok(prompts.completenessDemand(kind).includes(prompts.DEFECT_LEFT_COST));
  assert.notEqual(prompts.completenessDemand("plan"), prompts.completenessDemand("work"));
});

test("S1: the later-cycle text names the two re-raises the log rules allow", () => {
  for (const kind of ["plan", "work"] as const) {
    const text = prompts.laterCycleCompleteness(kind);
    assert.match(text, /clarification/);
    assert.match(text, /specific error/);
  }
});

test("S1: the question list's, the terms' and the verdict's reviews carry none of it", () => {
  const texts = [
    prompts.questionReviewPrompt(TEST_ROOT, 1, "continued"),
    prompts.questionReviewPrompt(TEST_ROOT, 2, "continued"),
    prompts.termsReviewPrompt(TEST_ROOT, 1, "continued"),
    prompts.termsReviewPrompt(TEST_ROOT, 2, "continued"),
    prompts.verdictReviewPrompt(TEST_ROOT, 1, 1, false, "continued"),
    prompts.verdictReviewPrompt(TEST_ROOT, 1, 2, false, "continued"),
  ];
  for (const text of texts) {
    assert.ok(!text.includes(prompts.DEFECT_LEFT_COST));
    assert.ok(!text.includes(prompts.laterCycleCompleteness("plan")));
    assert.ok(!text.includes(prompts.WORK_ACCEPTED_NOT_REPEATED));
  }
});
