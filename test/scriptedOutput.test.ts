// Issue #221: the scripted execution's live output, which the end-to-end servers of the live panel use: events sent at
// the call's start, and a tick printed on the Clock while the call runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Effect, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import type { OutputEvent, ProcessKey } from "../src/liveOutput.ts";
import { finished, heldClock, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const K = "claude:t1" as ProcessKey;
const timeout = { timeout: 120_000 };

test("an execution's scripted output reaches the run's Ui in order", timeout, async () => {
  const output: OutputEvent[] = [{ _tag: "Started", key: K, name: "npm test" }, { _tag: "Printed", key: K, name: "npm test", text: "ok 1\n" }];
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], execScripts: [{ output }] });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.deepEqual(probe.ui.outputs.filter((e) => e._tag !== "Touched" && e.key === K), output);
});

test("ticks are printed on the Clock while the call runs, until the run is stopped", timeout, async () => {
  const every = 300;
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execScripts: [{ ticks: { key: K, name: "npm test", everyMs: every }, hang: true }],
  });
  const held = heldClock(Date.UTC(2026, 10, 2));
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const ticks = () => probe.ui.outputs.flatMap((e) => (e._tag === "Printed" && e.key === K ? [e.text] : []));
  for (let i = 0; i < 3; i++) {
    await held.sleepRegistered(every);
    held.advance(every);
  }
  await held.sleepRegistered(every);
  assert.deepEqual(ticks(), ["tick 1\n", "tick 2\n", "tick 3\n"]);
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.notEqual(exitCodeOf(exit), 0);
});
