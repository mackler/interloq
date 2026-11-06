// Issue #228: Interloq states the types-first, test-first sequence itself in every implementation run, from one source
// given to the plan writer, the execution and both reviews. The prompts and the checks they rely on are tested together
// (Rules for changes). No scripted agent can show that a real agent obeys the rule; these tests establish what each
// agent is given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import fc from "fast-check";
import { execReport, interpretExecution } from "../src/claudeEvents.ts";
import { UiEventSchema } from "../src/protocol.ts";
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

// ---- S2: the execution report's test-first record --------------------------------------------------------------------

const record: S.StepTestFirst = { step: "S1", tests: [{ test: "node --test test/a.test.ts", observed: "AssertionError: expected 2, got 1" }], refactor: "nothing needed it" };
const rawReport = (testFirst: unknown) => ({ status: "finished", summary: "s", question: "", remaining_work: "", missing: "", checks: [], test_first: testFirst });

test("issue #228: the sentence names the schema's fields, and the execution prompt carries it", () => {
  assert.ok(Object.keys(S.ExecReport.fields).includes("test_first"));
  assert.ok(prompts.REPORT_TEST_FIRST_SENTENCE.includes("'test_first'"));
  for (const key of [...Object.keys(S.StepTestFirst.fields), ...Object.keys(S.TestFailureObserved.fields)]) assert.ok(prompts.REPORT_TEST_FIRST_SENTENCE.includes(`'${key}'`), key);
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true, checks).includes(prompts.REPORT_TEST_FIRST_SENTENCE));
});

test("issue #228: the report's record is kept on the report path and the stop path", () => {
  assert.deepEqual(execReport(rawReport([record]))?.test_first, [record]);
  const complete = { sessionId: "s", costUsd: 1, structured: rawReport([record]), resultText: "", error: null, partial: false, failure: null };
  assert.deepEqual(interpretExecution(complete, null).testFirst, [record]);
  assert.deepEqual(interpretExecution(complete, { question: "q?", input: "a" }).testFirst, [record]);
});

test("issue #228: an outcome and an ExecutionEnded recorded before the field decode with none", () => {
  const old = { status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks: [] };
  assert.deepEqual(Schema.decodeUnknownSync(S.ExecOutcome)(old).testFirst, []);
  const event = Schema.decodeUnknownSync(UiEventSchema)({ _tag: "ExecutionEnded", phase: 1, outcome: old });
  assert.ok(event._tag === "ExecutionEnded");
  assert.deepEqual(event.outcome.testFirst, []);
});

// ---- S3: the code review's criterion and a step's record -------------------------------------------------------------

const workOf = (testFirst: ReadonlyArray<S.StepTestFirst>) => ({ outcome: { status: "finished" as const, summary: "s", question: "", remainingWork: "", userInput: null, checks: [], testFirst }, plan: "p" });
const stepPart = (id: string) => ({ _tag: "Step" as const, id, label: "l", text: "t" });

test("issue #228: a step's part of the code review carries the criterion and that step's record alone, in its first round", () => {
  const other: S.StepTestFirst = { step: "S2", tests: [{ test: "test/other.test.ts", observed: "OTHER-FAILURE" }], refactor: "OTHER-REFACTOR" };
  const work = workOf([record, other]);
  assert.ok(prompts.TEST_FIRST_WORK_CRITERION.length > 0 && prompts.NO_TEST_FIRST_REPORTED.length > 0);
  const first = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued", stepPart("S1"), null);
  assert.ok(first.includes(prompts.TEST_FIRST_WORK_CRITERION));
  assert.ok(first.includes(prompts.testFirstText(work.outcome, "S1")) && first.includes(record.tests[0]!.observed));
  assert.ok(!first.includes("OTHER-FAILURE") && !first.includes("OTHER-REFACTOR"), "another step's record");
  const whole = prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued", { _tag: "Whole" }, null);
  assert.ok(!whole.includes(prompts.TEST_FIRST_WORK_CRITERION));
  assert.ok(!prompts.workReviewPrompt(TEST_ROOT, 1, 2, false, work, "continued", stepPart("S1"), null).includes(prompts.TEST_FIRST_WORK_CRITERION), "a later round in the thread");
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 3, false, work, "new", stepPart("S1"), null).includes(prompts.TEST_FIRST_WORK_CRITERION), "a new thread's first round");
  assert.ok(prompts.workReviewPrompt(TEST_ROOT, 1, 1, false, work, "continued", stepPart("S3"), null).includes(prompts.NO_TEST_FIRST_REPORTED));
});

test("issue #228: the writer and both reviewers judge by the same sentences", () => {
  for (const s of [prompts.CODE_STEP_SENTENCE, prompts.COUNTED_FAILURES_SENTENCE]) assert.ok(s.length > 0);
  for (const text of [prompts.TEST_FIRST_RULE, prompts.TEST_FIRST_REVIEW_CRITERION, prompts.TEST_FIRST_WORK_CRITERION]) assert.ok(text.includes(prompts.CODE_STEP_SENTENCE));
  for (const text of [prompts.TESTS_FIRST_SENTENCE, prompts.TEST_FIRST_RULE, prompts.TEST_FIRST_WORK_CRITERION]) assert.ok(text.includes(prompts.COUNTED_FAILURES_SENTENCE));
  assert.match(prompts.TEST_FIRST_WORK_CRITERION, /step's id, not a file path, in the location field/u);
});

test("issue #228: testFirstText shows a step's every test and failure in order, and nothing of another step's", () => {
  const marker = fc.uuid().map((u) => `m-${u}`);
  const entry = fc.record({ step: fc.constantFrom("S1", "S2", "S3"), tests: fc.array(fc.record({ test: marker, observed: marker }), { maxLength: 3 }), refactor: marker });
  fc.assert(
    fc.property(fc.uniqueArray(entry, { maxLength: 6, selector: (e) => e.refactor }), fc.constantFrom("S1", "S2", "S3"), (records, step) => {
      const text = prompts.testFirstText(workOf(records).outcome, step);
      const own = records.filter((r) => r.step === step);
      const markers = own.flatMap((r) => [...r.tests.flatMap((t) => [t.test, t.observed]), r.refactor]);
      let at = -1;
      for (const m of own.flatMap((r) => r.tests.flatMap((t) => [t.test, t.observed]))) {
        const i = text.indexOf(m, at + 1);
        if (i < 0) return false;
        at = i;
      }
      const foreign = records.filter((r) => r.step !== step).flatMap((r) => [...r.tests.flatMap((t) => [t.test, t.observed]), r.refactor]).filter((m) => !markers.includes(m));
      return markers.every((m) => text.includes(m)) && foreign.every((m) => !text.includes(m)) && (own.length > 0 || text === prompts.NO_TEST_FIRST_REPORTED);
    }),
    { numRuns: 200 },
  );
});
