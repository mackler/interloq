// Issue #162: what Claude Code is told to write about a step's check and what Codex checks are built from the same
// constants, so the writer and the reviewers cannot drift apart (Rules for changes: a prompt and its check together).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { checkTotals } from "../src/stepChecks.ts";
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

// The execution report's checks and the work review's criterion (S6): the field names the execution prompt asks for are
// the schema's, and the work review totals a step's checks across the calls of its phase (P1-R1-1).
const checkFields = Object.keys(S.StepCheckRun.fields);
const outcome = (checks: ReadonlyArray<S.StepCheckRun>): S.ExecOutcome => ({ status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks });

test("the execution prompt asks for the report's checks by the schema's field names", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, checks);
  assert.ok(Object.keys(S.ExecReport.fields).includes("checks"));
  assert.ok(prompt.includes(prompts.REPORT_CHECKS_SENTENCE));
  for (const field of checkFields) assert.ok(prompts.REPORT_CHECKS_SENTENCE.includes(`'${field}'`), field);
});

test("the work review's first round shows each step's reported checks with their total, and its criterion's limit", () => {
  const work = { outcome: outcome([{ step: "S1", command: "npm run test:unit", seconds: 90 }, { step: "S2", command: "npm run test:web", seconds: 20 }, { step: "S1", command: "npm run test:unit", seconds: 90 }]), plan: "the plan" };
  const review = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work);
  assert.ok(review.includes(prompts.WORK_CHECK_CRITERION));
  assert.ok(prompts.WORK_CHECK_CRITERION.includes(`${prompts.STEP_CHECK_LIMIT_MS / 60_000} minutes`));
  assert.ok(review.includes("S1: 180 seconds in all"), review.slice(-600));
  assert.ok(review.includes("S2: 20 seconds in all"));
  assert.ok(review.includes("`npm run test:unit` (90 seconds)"));
  const none = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, { outcome: outcome([]), plan: "p" });
  assert.match(none, /none reported/u);
  assert.ok(!prompts.workReviewPrompt(TEST_ROOT, 1, 2, false, work).includes(prompts.WORK_CHECK_CRITERION), "a later round repeats nothing");
});

test("checkTotals groups by step in first-seen order and sums each step's seconds", () => {
  assert.deepEqual(checkTotals([{ step: "S2", command: "a", seconds: 1 }, { step: "S1", command: "b", seconds: 2 }, { step: "S2", command: "c", seconds: 3 }]), [
    { step: "S2", commands: [{ command: "a", seconds: 1 }, { command: "c", seconds: 3 }], seconds: 4 },
    { step: "S1", commands: [{ command: "b", seconds: 2 }], seconds: 2 },
  ]);
});

test("property: the totals cover every step once and their seconds sum to the checks' seconds", () => {
  const run = fc.record({ step: fc.constantFrom("S1", "S2", "S3"), command: fc.string(), seconds: fc.integer({ min: 0, max: 600 }) });
  fc.assert(
    fc.property(fc.array(run, { maxLength: 12 }), (runs) => {
      const totals = checkTotals(runs);
      assert.deepEqual(totals.map((t) => t.step), [...new Set(runs.map((r) => r.step))]);
      assert.equal(totals.reduce((sum, t) => sum + t.seconds, 0), runs.reduce((sum, r) => sum + r.seconds, 0));
      for (const t of totals) assert.equal(t.commands.length, runs.filter((r) => r.step === t.step).length);
    }),
    { numRuns: 200 },
  );
});
