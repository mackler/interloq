// Issue #44 (S10): the seam from the program to the page. A run the real manager starts concludes its ending; the
// replay the real web server sends carries it in its Ended frame, which the page decodes and folds into RunView.ended.
// The three are one value, the frame's code is the one derived from it, and the page's line is the one src/prompts.ts
// computes from the concluded ending.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as fs from "node:fs";
import * as path from "node:path";
import { exitCodeOfEnding } from "../src/ending.ts";
import { TrackerAuthRefused } from "../src/errors.ts";
import type { Conclusion, Wiring } from "../src/program.ts";
import { platformLayer } from "../src/platform.ts";
import { endingLine } from "../src/prompts.ts";
import { decodeServer, type RunEvent, type ServerMessage } from "../src/protocol.ts";
import { makeRunManager, type RunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { OFF_SETTINGS } from "../src/chain.ts";
import { initialState, reduce } from "../web/src/state.ts";
import { fakeTrackerOf, finished, MANAGER_ITEMS, notRefined, startOf, type TestOptions, tempDir, tempRepo, testWiring, trackerAccessOf } from "./helpers.ts";
import type { FakeTracker } from "./fakeTracker.ts";

const until = async (what: string, condition: () => Promise<boolean>, ms = 30_000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const dist = (): string => {
  const d = tempDir("pr-dist-");
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>Interloq</title>");
  return d;
};

/** Runs one implementation run of item 1 through the real manager, observing its conclusion, and reads the replay a tab gets. */
const throughThePage = async (options: TestOptions, tracker: FakeTracker) => {
  const repo = tempRepo();
  const observed: Conclusion[] = [];
  const wiringOf = (ui: Parameters<Parameters<typeof makeRunManager>[0]>[0]): Wiring => ({
    ...testWiring(repo, { tracker, ...options }).wiring,
    ui: Effect.succeed(ui),
    observeConclusion: (c) => Effect.sync(() => void observed.push(c)),
  });
  const manager: RunManager = await Effect.runPromise(
    makeRunManager(wiringOf, repo, [], "test", trackerAccessOf(tracker), OFF_SETTINGS).pipe(Effect.provide(platformLayer)),
  );
  const id = await Effect.runPromise(manager.start(startOf("implementation", MANAGER_ITEMS[0]!.id)));
  assert.equal(typeof id, "number");
  await until("the run's end", async () => (await Effect.runPromise(manager.replay)).runs.some((r) => r.events.some((e) => e.event._tag === "Ended")));
  const frames = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const web = yield* makeWebServer(manager, dist());
        yield* HttpServer.serveEffect(web.handler);
        const address = (yield* HttpServer.HttpServer).address;
        const port = address._tag === "UnixPathAddress" ? 0 : address.port;
        return yield* Effect.promise(
          () =>
            new Promise<string[]>((resolve, reject) => {
              const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
              const raw: string[] = [];
              ws.onerror = () => reject(new Error("the WebSocket failed"));
              ws.onmessage = (e) => {
                raw.push(String(e.data));
                if (raw.length === 2) {
                  ws.close();
                  resolve(raw);
                }
              };
            }),
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  const decoded: ServerMessage[] = frames.map((f) => {
    const message = decodeServer(f);
    assert.ok(Result.isSuccess(message), `a frame did not decode: ${f.slice(0, 200)}`);
    return message.success;
  });
  const replay = decoded.find((m): m is Extract<ServerMessage, { type: "replay" }> => m.type === "replay");
  const frame = replay?.runs.find((r) => r.id === id)?.events.map((e) => e.event).find((e): e is Extract<RunEvent, { _tag: "Ended" }> => e._tag === "Ended");
  assert.ok(frame !== undefined, "the replay holds no Ended");
  const view = decoded.reduce(reduce, initialState).modes.implementation.runs.find((r) => r.id === id);
  assert.equal(observed.length, 1);
  return { conclusion: observed[0]!, frame, shown: view?.ended ?? null };
};

const agree = (r: Awaited<ReturnType<typeof throughThePage>>) => {
  assert.deepEqual(r.frame.ending, r.conclusion.ending);
  assert.deepEqual(r.shown, r.conclusion.ending);
  assert.equal(r.frame.code, exitCodeOfEnding(r.conclusion.ending));
  assert.ok(r.shown !== null);
  assert.equal(endingLine(r.shown), endingLine(r.conclusion.ending));
};

test("seam: a send-back with nothing parked reaches the page as the ending concluded", async () => {
  const r = await throughThePage({ steps: [{ output: notRefined("the retention period") }], reviews: [{ issues: [] }] }, fakeTrackerOf(MANAGER_ITEMS));
  assert.equal(r.conclusion.ending._tag, "SentBack");
  assert.equal(r.frame.code, 0);
  agree(r);
});

test("seam: a run that halts at its final tracker step reaches the page halted, with its reason", async () => {
  const tracker = fakeTrackerOf(MANAGER_ITEMS);
  // A refusal is permanent, so the step halts with no question (inside the manager the page's Ui would ask one).
  Effect.runSync(tracker.failNext("setState", new TrackerAuthRefused({ tracker: "fake", status: 403 }), "implemented"));
  const r = await throughThePage({ steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] }, tracker);
  assert.equal(r.conclusion.ending._tag, "Halted");
  assert.equal(r.frame.code, 1);
  agree(r);
});
