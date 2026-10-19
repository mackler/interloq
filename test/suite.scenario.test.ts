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
import { FULL_SUITE_PHASE, suitePassedLine } from "../src/prompts.ts";
import type { SuiteResult } from "../src/suite.ts";
import { fakeTrackerOf, finished, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

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
