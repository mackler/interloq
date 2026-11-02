// Issue #199 (requirements: the developer's instruction of 30 Oct 2026 and decision Q1): a failing end-to-end command
// is a failure of the work. The run does not finish, its item is not set implemented and the chain does not start the
// next item until it passes; a test already failing when the run began sends the run back like any other failure,
// since nothing is run or recorded about tests at the start.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Layer, Result, Scope } from "effect";
import { platformLayer } from "../src/platform.ts";
import { program } from "../src/program.ts";
import { finalCommandsOf, stepChecksOf } from "../src/schema.ts";
import { Baseline } from "../src/records.ts";
import type { SuiteResult } from "../src/suite.ts";
import { type Broadcast, type EventBroadcast, makeRunManager, type Refusal } from "../src/runManager.ts";
import { DEFAULT_SETTINGS, runLimitOf } from "../src/chain.ts";
import { Tracker } from "../src/services.ts";
import type { RunEvent } from "../src/protocol.ts";
import { fakeTrackerOf, finished, MANAGER_ITEMS, scriptedItem, scriptedStart, startOf, type TestOptions, tempDir, tempRepo, testWiring } from "./helpers.ts";

const run = Effect.runPromise;
const noQuestions = { questions_for_user: [] };
const SUITE = "script/test --all";
const E2E = "script/e2e --all";
const passed: SuiteResult = { _tag: "Passed", output: "all passed\n", ms: 1 };
const failing: SuiteResult = { _tag: "Failed", reason: { kind: "exit", code: 1 }, output: "  1) [chromium] › e2e/layout.spec.ts:10:1 › L10\n    Error: the run scrolls\n  1 failed\n", ms: 5000 };
const until = async (what: string, condition: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("the chain does not start the next item while the end-to-end command fails, and starts it once it passes", async () => {
  const repo = tempRepo();
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]] as const) execFileSync("git", ["-C", repo, "config", k, v]);
  const tracker = fakeTrackerOf(MANAGER_ITEMS);
  let open = (): void => undefined;
  const held = new Promise<void>((resolve) => (open = resolve));
  let revising = false;
  const first: TestOptions = {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2", onCall: () => void (revising = true), gate: () => held }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    suite: [passed, failing],
    config: { suiteCommand: SUITE, endToEndCommand: E2E },
  };
  const later: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
  const queue = [first, later];
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  const access = { sharedConfig: shared, tracker: () => Result.succeed(Layer.succeed(Tracker, tracker.tracker)) };
  const manager = await run(makeRunManager((ui) => ({ ...testWiring(repo, { tracker, ...(queue.shift() ?? {}) }).wiring, ui: Effect.succeed(ui) }), repo, [], "test", access, DEFAULT_SETTINGS).pipe(Effect.provide(platformLayer)));
  await run(manager.setChain({ enabled: true, limits: { runs: Result.getOrThrow(runLimitOf(2)), cutoff: null } }));
  const events: EventBroadcast[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b: Broadcast) => Effect.sync(() => void (b._tag === "event" ? events.push(b) : undefined))).pipe(Scope.provide(scope)));
  const started = () => events.filter((b) => b.event._tag === "Started").map((b) => (b.event as Extract<RunEvent, { _tag: "Started" }>).item.id as string);
  const stateOf = async (id: string) => (await run(tracker.items)).find((i) => i.id === id)?.state;
  const order = (await run(tracker.tracker.list("refined"))).map((i) => i.id as string);
  const id = await run(manager.start(startOf("implementation", order[0]!)));
  assert.equal(typeof id, "number", `refused: ${(id as Refusal).refused}`);

  await until("the revision after the end-to-end failure", () => revising);
  assert.equal(await stateOf(order[0]!), "implementing");
  assert.equal(await stateOf(order[1]!), "refined");
  assert.deepEqual(started(), [order[0]], "the chain started another run while the end-to-end command failed");

  open();
  await until("the next item's run", () => started().length === 2);
  assert.equal(events.flatMap((b) => (b.run === id && b.event._tag === "Ended" ? [b.event.code] : []))[0], 0);
  assert.equal(await stateOf(order[0]!), "implemented");
  assert.deepEqual(started(), [order[0], order[1]]);
  await until("the chain to end", async () => (await run(manager.current)).implementation === null);
});

test("decision Q1: a test failing when the run began sends the run back like any other failure; nothing runs or is recorded at the start", async () => {
  let suiteRunsAtFirstExecution = -1;
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    execScripts: [{ onCall: () => void (suiteRunsAtFirstExecution = probe.suite.runs.length) }, {}],
    suite: [failing],
    config: { endToEndCommand: E2E },
  });
  assert.equal(await run(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.equal(suiteRunsAtFirstExecution, 0, "a final command ran before the first work review");
  const baseline = JSON.parse(fs.readFileSync(path.join(probe.dir, "baseline.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(baseline).sort(), Object.keys(Baseline.fields).sort(), "baseline.json records something beyond its existing keys");
  const revision = probe.planner.prompts.find((p) => p.includes("Interloq then ran the whole suite"));
  assert.ok(revision !== undefined && revision.includes("the run scrolls"), "the revision does not carry the failure");
  assert.deepEqual(probe.suite.runs.map((r) => r.command), [E2E, E2E]);
});

test("the seam: the runner is given the final commands the configuration decodes to, in order", async () => {
  for (const config of [{ suiteCommand: SUITE, endToEndCommand: E2E }, { suiteCommand: null, endToEndCommand: E2E }, { suiteCommand: SUITE, endToEndCommand: null }]) {
    const expected = finalCommandsOf(Result.getOrThrow(stepChecksOf({ checkCommands: [], ...config }))).map((f) => f.command);
    const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], config });
    assert.equal(await run(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
    assert.deepEqual(probe.suite.runs.map((r) => r.command), expected, JSON.stringify(config));
  }
});

test("the first command fails: the end-to-end command does not run in that iteration", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    execScripts: [{}, { onCall: () => assert.deepEqual(probe.suite.runs.map((r) => r.command), [SUITE], "the end-to-end command ran after the suite failed") }],
    suite: [failing],
    tracker,
    config: { suiteCommand: SUITE, endToEndCommand: E2E },
  });
  assert.equal(await run(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.suite.runs.map((r) => r.command), [SUITE, SUITE, E2E]);
});
