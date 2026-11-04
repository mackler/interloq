// Issue #162: what Claude Code is told to write about a step's check and what Codex checks are built from the same
// constants, so the writer and the reviewers cannot drift apart (Rules for changes: a prompt and its check together).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { execReport, interpretExecution } from "../src/claudeEvents.ts";
import { checksByStep } from "../src/stepChecks.ts";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const checks: S.StepChecks = Result.getOrThrow(
  S.stepChecksOf({ checkCommands: [{ change: "the program's modules", command: "npm run test:unit" }, { change: "the page", command: "npm run test:web" }], suiteCommand: "npm test", endToEndCommand: null }),
);

test("the plan writer's rule and the plan review's first round carry the same criteria, commands and suite", () => {
  const rule = prompts.planStepCheckRule(checks);
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, checks, "continued");
  for (const text of [rule, review]) {
    for (const sentence of [prompts.STEP_CHECK_NAMED, prompts.STEP_CHECK_TOUCHED_ONLY, prompts.STEP_CHECK_NO_SUITE]) assert.ok(text.includes(sentence), sentence);
    for (const entry of checks.commands) assert.ok(text.includes(entry.command), entry.command);
    assert.ok(text.includes(`\`${checks.suite}\``));
  }
  assert.ok(review.includes(prompts.STEP_CHECK_REVIEW_CRITERION), "the plan review raises a step against the rule");
});

// Issue #199: the rule names the end-to-end command beside the suite command, so that no step runs it.
test("the plan writer's rule names every final command Interloq runs itself", () => {
  for (const [suiteCommand, endToEndCommand] of [["npm test", "npm run test:e2e"], [null, "npm run test:e2e"]] as const) {
    const both = Result.getOrThrow(S.stepChecksOf({ checkCommands: [], suiteCommand, endToEndCommand }));
    const rule = prompts.planStepCheckRule(both);
    for (const final of S.finalCommandsOf(both)) assert.ok(rule.includes(`\`${final.command}\``), final.command);
  }
});

test("the plan review's criterion names no command where the project lists none", () => {
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, S.NO_STEP_CHECKS, "continued");
  assert.ok(review.includes(prompts.STEP_CHECK_REVIEW_CRITERION));
  for (const entry of checks.commands) assert.ok(!review.includes(entry.command));
});

// The execution report's checks and the work review's criterion (S6): the field names the execution prompt asks for are
// the schema's, and the work review groups a step's checks across the calls of its phase (P1-R1-1), without their seconds (issue #245).
const checkFields = Object.keys(S.StepCheckRun.fields);
const outcome = (checks: ReadonlyArray<S.StepCheckRun>): S.ExecOutcome => ({ status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks });

test("the execution prompt asks for the report's checks by the schema's field names", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, checks);
  assert.ok(Object.keys(S.ExecReport.fields).includes("checks"));
  assert.ok(prompt.includes(prompts.REPORT_CHECKS_SENTENCE));
  for (const field of checkFields) assert.ok(prompts.REPORT_CHECKS_SENTENCE.includes(`'${field}'`), field);
});

test("the work review's first round shows each step's reported checks without their seconds (issue #245)", () => {
  const work = { outcome: outcome([{ step: "S1", command: "npm run test:unit", seconds: 90, selection: false, counts: null }, { step: "S2", command: "npm run test:web", seconds: 20, selection: false, counts: null }, { step: "S1", command: "npm run test:unit", seconds: 90, selection: false, counts: null }]), plan: "the plan" };
  const review = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued");
  assert.ok(review.includes(prompts.WORK_CHECK_CRITERION));
  assert.ok(review.includes("- S1: `npm run test:unit`, `npm run test:unit`"), review.slice(-600));
  assert.ok(review.includes("- S2: `npm run test:web`"));
  const shown = review.slice(review.indexOf("per step:"));
  assert.ok(!/seconds/u.test(shown), shown);
  const none = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, { outcome: outcome([]), plan: "p" }, "continued");
  assert.match(none, /none reported/u);
  assert.ok(!prompts.workReviewPrompt(TEST_ROOT, 1, 2, false, work, "continued").includes(prompts.WORK_CHECK_CRITERION), "a later round repeats nothing");
});

test("checksByStep groups by step in first-seen order, without seconds", () => {
  assert.deepEqual(checksByStep([{ step: "S2", command: "a", seconds: 1, selection: false, counts: null }, { step: "S1", command: "b", seconds: 2, selection: false, counts: null }, { step: "S2", command: "c", seconds: 3, selection: false, counts: null }]), [
    { step: "S2", commands: [{ command: "a", selection: false, counts: null }, { command: "c", selection: false, counts: null }] },
    { step: "S1", commands: [{ command: "b", selection: false, counts: null }] },
  ]);
});

test("property: the groups cover every step once, each with that step's runs in order less their step and seconds", () => {
  const run = fc.record({ step: fc.constantFrom("S1", "S2", "S3"), command: fc.string(), seconds: fc.integer({ min: 0, max: 600 }), selection: fc.boolean(), counts: fc.constant(null) });
  fc.assert(
    fc.property(fc.array(run, { maxLength: 12 }), (runs) => {
      const groups = checksByStep(runs);
      assert.deepEqual(groups.map((g) => g.step), [...new Set(runs.map((r) => r.step))]);
      for (const g of groups) {
        const own = runs.filter((r) => r.step === g.step);
        assert.equal(g.commands.length, own.length);
        assert.deepEqual(g.commands, own.map(({ command, selection, counts }) => ({ command, selection, counts })));
      }
    }),
    { numRuns: 200 },
  );
});

// Issue #39 (S11): a step check's report carries whether it ran a selection and its counts, taken only from a runner's
// structured report; the prompt that asks for them and the normalization that keeps no impossible number are tested
// together.
const counted = { step: "S3", command: "node --test test/a.test.ts", seconds: 12, selection: true, counts: { passed: 40, failed: 0, skipped: 1 } };
const build = { step: "S3", command: "npm run build", seconds: 30, selection: false, counts: null };

test("the sentence asks for a selection and for counts from a structured report, never from the printed summary", () => {
  assert.deepEqual(checkFields, ["step", "command", "seconds", "selection", "counts"]);
  assert.match(prompts.REPORT_CHECKS_SENTENCE, /structured report/u);
  assert.match(prompts.REPORT_CHECKS_SENTENCE, /never from its printed summary/u);
  assert.match(prompts.REPORT_CHECKS_SENTENCE, /'null'/u);
});

test("the report's counts are kept, and a negative count becomes null on the report path and the stop path", () => {
  const report = (checks: unknown) => ({ status: "finished", summary: "s", question: "", remaining_work: "", missing: "", checks });
  const negative = { ...counted, counts: { passed: 4, failed: -1, skipped: 0 } };
  assert.deepEqual(execReport(report([counted, build]))?.checks, [counted, build]);
  assert.deepEqual(execReport(report([negative]))?.checks, [{ ...negative, counts: null }]);
  const complete = { sessionId: "s", costUsd: 1, structured: report([negative]), resultText: "", error: null, partial: false, failure: null };
  assert.deepEqual(interpretExecution(complete, null).checks, [{ ...negative, counts: null }]);
  assert.deepEqual(interpretExecution(complete, { question: "q?", input: "a" }).checks, [{ ...negative, counts: null }]);
});

test("the work review shows a check's counts and selection, and nothing of counts it does not have", () => {
  const review = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, { outcome: outcome([counted, build]), plan: "p" }, "continued");
  assert.ok(review.includes("`node --test test/a.test.ts` (40 passed, 0 failed, 1 skipped; a selection)"), review.slice(-600));
  assert.ok(review.includes("`npm run build`") && !review.includes("`npm run build` ("), "a check with no counts and no selection shows its command alone");
});
