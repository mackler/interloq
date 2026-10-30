// Issue #162 (requirements G-R1-1, F1): after the review of the work finds nothing left to correct an implementation run runs the project's whole
// suite; a failure is corrected like an accepted work issue (a revision, its review, an execution, a work review) and
// the suite runs again, without limit; a project with no suite command finishes after the work review, as before.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import { attachedHeading, FULL_SUITE_PHASE, SUITE_OUTPUT_NAME, suitePassedLine, suiteRepeatLine, suiteStoppedText, TRANSPORT_ANSWERS } from "../src/prompts.ts";
import { recordPath, type RunRoot } from "../src/artifacts.ts";
import { blocksText, piecesText } from "../src/pieces.ts";
import type { SuiteResult } from "../src/suite.ts";
import type { OutputEvent } from "../src/liveOutput.ts";
import { fakeTrackerOf, finished, presentedQuestions, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const SUITE = "script/test --all";
const failing: SuiteResult = { _tag: "Failed", reason: { kind: "exit", code: 1 }, output: `${Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")}\nnot ok 7 the parser rejects a blank id\n`, ms: 5000 };
const one = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
const suitesBegan = (notified: readonly { _tag: string }[]): number[] =>
  notified.flatMap((e) => (e._tag === "PhaseBegan" && (e as unknown as { phase: { kind: string; n: number } }).phase.kind === "suite" ? [(e as unknown as { phase: { n: number } }).phase.n] : []));

test("(a) the suite passes: the run ends 0 after one suite run of the configured command in the project, its output in suite-1.log", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(tempRepo(), { ...one, tracker, config: { suiteCommand: SUITE } });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.suite.runs, [{ command: SUITE, cwd: probe.project, ceilingMs: 2_400_000 }]);
  assert.equal(fs.readFileSync(path.join(probe.dir, "suite-1.log"), "utf8"), "all passed\n");
  assert.equal((await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)?.state, "implemented");
  assert.deepEqual(suitesBegan(probe.ui.notified), [1]);
  assert.ok(probe.ui.said.some((line) => line.includes(suitePassedLine(FULL_SUITE_PHASE, SUITE))), probe.ui.said.join("\n"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(suitePassedLine(FULL_SUITE_PHASE, SUITE)));
});

test("(b) the suite fails, then passes: a revision with the failure's tail, its review, an execution, a work review and a second suite run", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    suite: [failing],
    config: { suiteCommand: SUITE },
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.equal(probe.suite.runs.length, 2);
  const revision = probe.planner.prompts.find((p) => p.includes("Interloq then ran the whole suite"));
  assert.ok(revision !== undefined, "no planning prompt names the failed suite");
  assert.ok(revision.includes("not ok 7 the parser rejects a blank id"));
  assert.ok(revision.includes("line 52\n") && !revision.includes("line 51\n"), "the prompt does not carry the last 200 lines alone");
  assert.match(revision, /plan-review\/runs\/[^/\s]+\/suite-1\.log/u);
  assert.match(revision, /exited with code 1/u);
  assert.equal(probe.planner.execPrompts.length, 2);
  assert.equal(probe.reviewer.prompts.length, 4, "two plan reviews and two work reviews");
  assert.ok(fs.readFileSync(path.join(probe.dir, "suite-1.log"), "utf8").startsWith("line 1\n"));
  assert.equal(fs.readFileSync(path.join(probe.dir, "suite-2.log"), "utf8"), "all passed\n");
  assert.deepEqual(suitesBegan(probe.ui.notified), [1, 2]);
  assert.ok(probe.ui.said.some((line) => line.includes("failed: script/test --all; it exited with code 1")), probe.ui.said.join("\n"));
  // The rail foresees the suite after the iteration that will run it: after the failure, after the second work review.
  const foreseen = probe.ui.notified.filter((e) => e._tag === "PhasesForeseen").at(-1) as unknown as { phases: { kind: string; n?: number }[] };
  assert.deepEqual(foreseen.phases.map((p) => `${p.kind}${p.n ?? ""}`), ["planning1", "execution1", "work1", "suite1", "planning2", "execution2", "work2", "suite2"]);
});

test("(c) no suite command: no suite run, and the run finishes after the work review as before", async () => {
  const { wiring, probe } = testWiring(tempRepo(), one);
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.suite.runs, []);
  assert.deepEqual(suitesBegan(probe.ui.notified), []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "suite-1.log")));
});

test("(d) Stop task during the suite ends the run with 130", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, suite: ["hang"], config: { suiteCommand: SUITE } });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  for (let i = 0; i < 600 && probe.suite.runs.length === 0; i++) await sleep(50);
  assert.equal(probe.suite.runs.length, 1, "the suite did not start");
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130);
  assert.ok(Exit.isSuccess(exit) || Exit.isFailure(exit));
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*\n$/u);
});

test("(e) the suite's limit is the configured suiteTimeoutMinutes, in milliseconds (issue #181, Q3, Q4)", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, config: { suiteCommand: SUITE, suiteTimeoutMinutes: 5 } });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.suite.runs, [{ command: SUITE, cwd: probe.project, ceilingMs: 300_000 }]);
});

// Issue #181 (requirements Q1, Q2): a suite stopped by its limit or unable to start is not the work's fault: it is run
// again once in the whole run without a question, then each further such stop asks Run the suite again or Stop.
const timedOut: SuiteResult = { _tag: "Failed", reason: { kind: "timedOut", ms: 2_400_000 }, output: "ok 1\n", ms: 2_400_000 };
const notStarted: SuiteResult = { _tag: "Failed", reason: { kind: "notStarted", message: "spawn /bin/sh ENOENT" }, output: "", ms: 1 };
const lastForeseen = (notified: readonly { _tag: string }[]): string[] =>
  (notified.filter((e) => e._tag === "PhasesForeseen").at(-1) as unknown as { phases: { kind: string; n?: number }[] }).phases.map((p) => `${p.kind}${p.n ?? ""}`);
const planningsBegan = (notified: readonly { _tag: string }[]): number =>
  notified.filter((e) => e._tag === "PhaseBegan" && (e as unknown as { phase: { kind: string } }).phase.kind === "planning").length;
/** The run's root as the store names it: the last two components of its records directory (runs/<root>). */
const rootOf = (dir: string): RunRoot => path.relative(path.join(dir, "..", ".."), dir) as RunRoot;
const suiteQuestions = (probe: { ui: Parameters<typeof presentedQuestions>[0] }) => presentedQuestions(probe.ui).filter((q) => q.origin.kind === "suiteStopped");

for (const [name, stop] of [["(f) a suite stopped by its limit", timedOut], ["(i) a suite that could not start", notStarted]] as const) {
  test(`${name}, then passed: run again once with no question and no revision, and the run finishes`, async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    const { wiring, probe } = testWiring(tempRepo(), { ...one, tracker, suite: [stop], config: { suiteCommand: SUITE } });
    assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
    assert.equal(probe.suite.runs.length, 2);
    assert.ok(fs.existsSync(path.join(probe.dir, "suite-1.log")));
    assert.equal(fs.readFileSync(path.join(probe.dir, "suite-2.log"), "utf8"), "all passed\n");
    assert.deepEqual(suitesBegan(probe.ui.notified), [1, 2]);
    assert.deepEqual(probe.ui.asked, []);
    assert.equal(planningsBegan(probe.ui.notified), 1, "the plan was revised");
    assert.ok(probe.ui.said.some((line) => line.includes(suiteRepeatLine(FULL_SUITE_PHASE + " 1", SUITE))), probe.ui.said.join("\n"));
    assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(suiteRepeatLine(FULL_SUITE_PHASE + " 1", SUITE)));
    assert.equal((await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)?.state, "implemented");
    assert.deepEqual(lastForeseen(probe.ui.notified), ["planning1", "execution1", "work1", "suite1", "suite2"]);
  });
}

test("(g) a suite stopped twice asks Run the suite again or Stop; Run the suite again, then passed, finishes", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, answers: [TRANSPORT_ANSWERS.retry], suite: [timedOut, timedOut], config: { suiteCommand: SUITE } });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.equal(suiteQuestions(probe).length, 1);
  assert.equal(probe.suite.runs.length, 3);
  assert.equal(planningsBegan(probe.ui.notified), 1, "the plan was revised");
  // W1-R1-2: the material is the suite's own kind, and the question names the heading the page shows it under.
  const [question] = suiteQuestions(probe);
  assert.ok(question.attached !== null);
  assert.equal(question.attached.kind, "suiteStop");
  assert.ok(piecesText(question.question).includes(attachedHeading(question.attached.kind)), piecesText(question.question));
  // W1-R1-1: both stops are named with their logs, and the history names suite run 1's automatic repeat.
  const attached = blocksText(question.attached.blocks).join("\n");
  for (const n of [1, 2]) assert.ok(attached.includes(recordPath(rootOf(probe.dir), { kind: "suiteLog", n })), attached);
  const history = blocksText(question.history).join("\n");
  assert.match(history, /[Ss]uite run 1\b/u);
  assert.match(history, /automatic repeat/u);
});

test("(h) a suite stopped twice, answered Stop: the run halts with 1 and SuiteStopped", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, answers: [TRANSPORT_ANSWERS.stop], suite: [timedOut, timedOut], config: { suiteCommand: SUITE } });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 1);
  assert.equal(suiteQuestions(probe).length, 1);
  assert.equal(probe.suite.runs.length, 2);
  const halt = suiteStoppedText(SUITE, 2, 2, "it ran longer than 40 minutes and was stopped");
  assert.ok(probe.ui.said.some((line) => line.includes(halt)), probe.ui.said.join("\n"));
});

test("(j) a suite ended by a signal is a fault of the work: the plan is revised from it", async () => {
  const signalled: SuiteResult = { _tag: "Failed", reason: { kind: "signal", signal: "SIGKILL" }, output: "killed\n", ms: 10 };
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    suite: [signalled],
    config: { suiteCommand: SUITE },
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.ui.asked, []);
  const revision = probe.planner.prompts.find((p) => p.includes("Interloq then ran the whole suite"));
  assert.ok(revision !== undefined && revision.includes("SIGKILL"));
});

test("(k) the automatic repeat is once per run: a later stop in another iteration asks at once", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    answers: [TRANSPORT_ANSWERS.retry],
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    suite: [timedOut, failing, timedOut],
    config: { suiteCommand: SUITE },
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.equal(probe.suite.runs.length, 4, "a repeat, a failure, a stop asked about, a pass");
  assert.equal(suiteQuestions(probe).length, 1);
  // W1-R1-1: the question's history names suite run 1, whose stop used the repeat in iteration 1, and its material that run's log.
  const [question] = suiteQuestions(probe);
  assert.ok(question.attached !== null);
  assert.ok(blocksText(question.attached.blocks).join("\n").includes(recordPath(rootOf(probe.dir), { kind: "suiteLog", n: 1 })));
  const history = blocksText(question.history).join("\n");
  assert.match(history, /[Ss]uite run 1\b/u);
  assert.match(history, /automatic repeat/u);
  assert.equal(planningsBegan(probe.ui.notified), 2);
});

// Issue #49: the suite's output reaches the live panel as it arrives, sanitized, and never the run's records.
const ESC = "\u001b";
const suiteOutputs = (outputs: readonly OutputEvent[]): OutputEvent[] => outputs.filter((e) => e._tag !== "Touched" && e.key.startsWith("suite:"));

test("(m) the suite's chunks reach the panel sanitized between its Started and its Finished, and none reaches conversation.md", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, config: { suiteCommand: SUITE } });
  probe.suite.printed.push(["ok 1 the first\n", `ok 2 ${ESC}[3`, "2mgreen", `${ESC}[0m\nunique-marker-49\n`]);
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  const events = suiteOutputs(probe.ui.outputs);
  assert.deepEqual(events[0], { _tag: "Started", key: "suite:1", name: SUITE_OUTPUT_NAME });
  assert.deepEqual(events.at(-1), { _tag: "Finished", key: "suite:1", name: SUITE_OUTPUT_NAME, status: { _tag: "Exited", code: 0 } });
  const printed = events.flatMap((e) => (e._tag === "Printed" ? [e.text] : []));
  assert.equal(printed.join(""), "ok 1 the first\nok 2 green\nunique-marker-49\n");
  assert.ok(!fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes("unique-marker-49"));
});

test("(n) a failing suite's Finished carries its exit code", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    suite: [failing],
    config: { suiteCommand: SUITE },
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  const ends = suiteOutputs(probe.ui.outputs).filter((e) => e._tag === "Finished");
  assert.deepEqual(ends.map((e) => (e._tag === "Finished" ? [e.key, e.status] : null)), [["suite:1", { _tag: "Exited", code: 1 }], ["suite:2", { _tag: "Exited", code: 0 }]]);
});

test("(o) Stop task during the suite leaves a Finished with Stopped as its last output event", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...one, suite: ["hang"], config: { suiteCommand: SUITE } });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  for (let i = 0; i < 600 && probe.suite.runs.length === 0; i++) await sleep(50);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  const events = suiteOutputs(probe.ui.outputs);
  assert.deepEqual(events.at(-1), { _tag: "Finished", key: "suite:1", name: SUITE_OUTPUT_NAME, status: { _tag: "Stopped" } });
});
