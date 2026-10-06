import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { platformLayer } from "../src/platform.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { makeRunManager } from "../src/runManager.ts";
import { Planner, Reviewer, type StepReporter, Ui } from "../src/services.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { makeWebServer } from "../src/webServer.ts";
import { finished, issue, type TestOptions, tempDir, tempRepo, testWiring } from "./helpers.ts";

// Finding 13 of docs/gui-review.md, decision Q4: a long scripted run of about 10,000 events typical of a run (tool
// activity, program lines, reviews with issues), published through the manager, then replayed to one client over
// the real server. The criterion of Q4: a replay over 1 s, or more than 50 MB retained, calls for chunked storage.
const EVENTS = 10_000;
const REPLAY_LIMIT_MS = 1000;
const RETAINED_LIMIT_BYTES = 50 * 1024 * 1024;

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const heap = (): number => {
  gc();
  return process.memoryUsage().heapUsed;
};
const review = { issues: [issue("P1-R1-1", "The plan does not say which file holds the parser, so the step cannot be implemented without guessing."), issue("P1-R1-2", "Step 3 and step 5 contradict each other on the error format."), issue("P1-R1-3", "The test of step 4 names no failing input.")] };
const eventOf = (i: number): UiEvent =>
  i % 10 === 0
    ? { _tag: "ReviewReceived", subject: { plan: 1 }, round: 1 + Math.floor(i / 10), review, counted: 3 }
    : { _tag: "ToolUsed", agent: i % 3 === 0 ? "codex" : "claude", tool: i % 2 === 0 ? "Read" : "command", target: `src/module-${i % 97}/file-${i}.ts` };

test("measurement: a run of 10,000 events, its retained size, and the time to replay it to one client", async (t) => {
  const repo = tempRepo();
  const options: TestOptions = { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
  let publishMs = 0;
  const wiringOf = (ui: Parameters<Parameters<typeof makeRunManager>[0]>[0]) => {
    const { wiring, probe } = testWiring(repo, options);
    // The planner's first call publishes the events, as an agent's activity would, before its scripted output.
    const planner = Layer.effect(
      Planner,
      Effect.gen(function* () {
        const runUi = yield* Ui;
        let first = true;
        return {
          ...probe.planner,
          sessionId: probe.planner.sessionId,
          executing: (prompt: string, reporter: StepReporter) => probe.planner.executing(prompt, reporter),
          planning: (prompt: string, schema: Parameters<typeof probe.planner.planning>[1]) =>
            Effect.suspend(() => {
              if (!first) return probe.planner.planning(prompt, schema);
              first = false;
              const began = performance.now();
              return Effect.forEach(Array.from({ length: EVENTS }, (_, i) => i), (i) => (i % 5 === 4 ? runUi.say(`Planning phase 1, round ${i}: Claude Code response ...`) : runUi.notify(eventOf(i))), { discard: true }).pipe(
                Effect.tap(() => Effect.sync(() => void (publishMs = performance.now() - began))),
                Effect.andThen(probe.planner.planning(prompt, schema)),
              );
            }),
        };
      }),
    );
    return { ...wiring, ui: Effect.succeed(ui), agents: Layer.mergeAll(planner, Layer.succeed(Reviewer, probe.reviewer)) };
  };
  const dist = tempDir("pr-dist-");
  const before = heap();
  const manager = await Effect.runPromise(makeRunManager(wiringOf, repo, "measure").pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(manager.start(repo, "a long task"));
  for (let i = 0; i < 6000 && (await Effect.runPromise(manager.current)) !== null; i++) await sleep(10);
  assert.equal(await Effect.runPromise(manager.current), null, "the run did not end");
  const { runs } = await Effect.runPromise(manager.replay);
  const count = runs.reduce((n, r) => n + r.events.length, 0);
  const retained = heap() - before;
  const size = JSON.stringify({ type: "replay", runs }).length;

  // Five replays to one client each: a regression in the code slows every sample, a burst of load on the machine only
  // some, so the best of five measures the code and the bound holds on a loaded machine (a shared CI runner).
  const samples: number[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const web = yield* makeWebServer(manager, dist);
        yield* HttpServer.serveEffect(web.handler);
        yield* Effect.addFinalizer(() => web.closeAll);
        const address = (yield* HttpServer.HttpServer).address;
        const port = address._tag === "UnixPathAddress" ? 0 : address.port;
        for (let sample = 0; sample < 5; sample++) {
          samples.push(
            yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const began = performance.now();
                  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
                  ws.onmessage = (e) => {
                    const m = JSON.parse(String(e.data)) as ServerMessage;
                    if (m.type !== "replay") return;
                    ws.close();
                    resolve(performance.now() - began);
                  };
                  ws.onerror = () => reject(new Error("the WebSocket failed"));
                }),
            ),
          );
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  const replayMs = Math.min(...samples);

  const figures = { events: count, replayBytes: size, replayMs: Math.round(replayMs), replaySamplesMs: samples.map(Math.round), retainedBytes: retained, publishMs: Math.round(publishMs) };
  t.diagnostic(`replay capacity: ${JSON.stringify(figures)}`);
  console.log(`replay capacity: ${JSON.stringify(figures)}`);
  assert.ok(count >= EVENTS, `only ${count} events`);
  // Measured 26 Sep 2026 (E5): about 10,030 events, a 1.55 MB replay delivered in about 50 ms, about 4 MB retained,
  // about 230 ms to publish them all, copying included: well within the criterion, so chunked storage was not built
  // (E6). The criterion stays as the regression bound, on the best of five replays (27 Sep 2026: tolerant of load).
  assert.ok(replayMs < REPLAY_LIMIT_MS, `the best of five replays took ${replayMs} ms (samples: ${samples.map(Math.round).join(", ")})`);
  assert.ok(retained < RETAINED_LIMIT_BYTES, `${retained} bytes retained`);
});
