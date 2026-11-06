// Issue #18: every ending's closing lines say how long the run took, measured on the Clock from the run's start (the
// read that names its records directory) to its closing lines; said only, never written to conversation.md.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect } from "effect";
import { program } from "../src/program.ts";
import { runTimeText } from "../src/prompts.ts";
import { askedInPlanReview, finished, questionOf, scriptedStart, steppingClock, tempRepo, testWiring, type ReviewStep, type TestOptions } from "./helpers.ts";

const START = Date.UTC(2026, 10, 6, 10, 0);
const noQuestions = { questions_for_user: [] };
const atCapacity: ReviewStep = { issues: [], failure: "Selected model is at capacity. Please try a different model. (Codex Exec exited with code 1: Reading prompt from stdin...)" };

const runIt = async (options: TestOptions) => {
  const { wiring, probe } = testWiring(tempRepo(), options);
  const { clock, now } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  const runTimes = lines.filter((l) => l.startsWith("Run time: "));
  return { code, probe, lines, runTimes, elapsed: now() - START };
};
const indexOf = (lines: readonly string[], pattern: RegExp): number => lines.findIndex((l) => pattern.test(l));

test("(1) a finished run says its run time exactly once, before the usage line, and writes it nowhere", async () => {
  const { code, probe, lines, runTimes, elapsed } = await runIt({ steps: [{ output: noQuestions, plan: "v1" }], reviews: [atCapacity, atCapacity, { issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(code, 0);
  assert.ok(elapsed > 0);
  assert.deepEqual(runTimes, [runTimeText(elapsed)]);
  assert.ok(lines.indexOf(runTimes[0]!) < indexOf(lines, /^Usage: /));
  assert.doesNotMatch(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /Run time:/);
});

test("(2) a halted run says its run time after the halt", async () => {
  const { code, lines, runTimes } = await runIt({ steps: [{ sessionTooLong: "Prompt is too long" }] });
  assert.equal(code, 1);
  assert.equal(runTimes.length, 1);
  assert.ok(indexOf(lines, /^HALTED: /) < lines.indexOf(runTimes[0]!));
});

test("(3) a run ended at a question says its run time after the interruption", async () => {
  const withQuestion = askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }], reviews: [{ issues: [] }] });
  const { code, lines, runTimes } = await runIt({ ...withQuestion, answers: ["q", "y"], confirmEnds: true });
  assert.equal(code, 130);
  assert.equal(runTimes.length, 1);
  assert.ok(indexOf(lines, /INTERRUPTED by the user/) < lines.indexOf(runTimes[0]!));
});

test("(4) a run halted before its records says its run time", async () => {
  const { code, runTimes } = await runIt({ steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execs: [finished], tracker: null });
  assert.equal(code, 1);
  assert.deepEqual(runTimes, [runTimeText(0)]);
});
