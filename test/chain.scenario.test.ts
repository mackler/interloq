// Issue #147 (S10): the chain over the run manager, the scripted wiring and the fake tracker, in temporary repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Layer, Result, Scope } from "effect";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { runRootOf } from "../src/artifacts.ts";
import type { ItemId } from "../src/tracker.ts";
import { type Broadcast, type ChainPersistence, type EventBroadcast, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
import { type ChainSettings, type ChainState, cutoffOf, DEFAULT_SETTINGS, OFF_SETTINGS, type ParkNote, runLimitOf } from "../src/chain.ts";
import { loadChain, removeChain, saveChain } from "../src/chainFile.ts";
import { parkHalted } from "../src/parking.ts";
import type { StoreShape } from "../src/services.ts";
import { chainParkingText } from "../src/prompts.ts";
import { Tracker, type TrackerShape } from "../src/services.ts";
import type { RunEvent } from "../src/protocol.ts";
import type { FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, finished, MANAGER_ITEMS, questionOf, startOf, type TestOptions, tempDir, tempRepo, testWiring } from "./helpers.ts";

const run = Effect.runPromise;
const noQuestions = { questions_for_user: [] };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
/** A run that halts at its first planning call, after its item was labeled implementing and its baseline written. */
const halting = (work: (repo: string) => void = () => {}): ((repo: string) => TestOptions) => (repo) => ({ steps: [{ sessionTooLong: "Prompt is too long", onCall: () => work(repo) }] });
/** A run that halts before its records exist: a malformed checkCommands refuses it before the item is labeled. */
const haltingEarly: TestOptions = { config: { checkCommands: "not a list" } as never };
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const committedWork = (repo: string) => {
  fs.writeFileSync(path.join(repo, "committed.txt"), "the run's commit\n");
  git(repo, "add", "committed.txt");
  git(repo, "commit", "-qm", "the run's own commit");
  fs.writeFileSync(path.join(repo, "left.txt"), "left uncommitted\n");
};

type Harness = { manager: RunManager; events: EventBroadcast[]; chains: ChainState[]; repo: string; tracker: FakeTracker };
type Script = TestOptions | ((repo: string) => TestOptions);
type Options = { park?: (store: StoreShape, item: ItemId) => Effect.Effect<ParkNote>; settings?: ChainSettings; tracker?: FakeTracker; trackerOf?: (fake: FakeTracker) => TrackerShape; persistence?: ChainPersistence; repo?: string; defaults?: ChainSettings };

const identified = (): string => {
  const repo = tempRepo();
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  return repo;
};
const harness = async (scripts: Script[], options: Options = {}): Promise<Harness> => {
  const repo = options.repo ?? identified();
  const tracker = options.tracker ?? fakeTrackerOf(MANAGER_ITEMS);
  const queue = [...scripts];
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  const shape = options.trackerOf?.(tracker) ?? tracker.tracker;
  const access = { sharedConfig: shared, tracker: () => Result.succeed(Layer.succeed(Tracker, shape)) };
  const wiringOf = () => {
    const next = queue.shift() ?? {};
    return testWiring(repo, { tracker, ...(typeof next === "function" ? next(repo) : next) }).wiring;
  };
  const manager = await run(makeRunManager((ui) => ({ ...wiringOf(), ui: Effect.succeed(ui) }), repo, [], "test", access, options.defaults ?? DEFAULT_SETTINGS, undefined, options.persistence, options.park).pipe(Effect.provide(platformLayer)));
  const events: EventBroadcast[] = [];
  const chains: ChainState[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b: Broadcast) => Effect.sync(() => void (b._tag === "event" ? events.push(b) : b._tag === "chain" ? chains.push(b.state) : undefined))).pipe(Scope.provide(scope)));
  if (options.settings !== undefined) await run(manager.setChain(options.settings));
  return { manager, events, chains, repo, tracker };
};
const until = async (what: string, condition: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const chainOf = (h: Harness) => run(h.manager.chain);
const startedRuns = (h: Harness) => h.events.filter((b) => b.event._tag === "Started").map((b) => ({ run: b.run, item: (b.event as Extract<RunEvent, { _tag: "Started" }>).item.id }));
const endCode = (h: Harness, id: number) => h.events.flatMap((b) => (b.run === id && b.event._tag === "Ended" ? [b.event.code] : []))[0];
const idle = (h: Harness) => until("the chain to end", async () => (await chainOf(h)).chain._tag === "Idle" && (await run(h.manager.current)).implementation === null);
const endedReason = async (h: Harness) => {
  const c = (await chainOf(h)).chain;
  return c._tag === "Idle" ? c.ended?._tag : `not idle: ${c._tag}`;
};
const begin = async (h: Harness, item: string): Promise<number> => {
  const id = await run(h.manager.start(startOf("implementation", item)));
  assert.equal(typeof id, "number", `refused: ${(id as Refusal).refused}`);
  return id as number;
};
const refinedOrder = async (tracker: FakeTracker) => (await run(tracker.tracker.list("refined"))).map((i) => i.id as string);
const settings = (runs: number | null, cutoff: string | null = null): ChainSettings => ({
  enabled: true,
  limits: { runs: runs === null ? null : Result.getOrThrow(runLimitOf(runs)), cutoff: cutoff === null ? null : Result.getOrThrow(cutoffOf(cutoff)) },
});

test("a finished run starts the next refined item, the first of the order the tracker's list returned", async () => {
  const h = await harness([converging, converging], { settings: settings(2) });
  const order = await refinedOrder(h.tracker);
  await begin(h, order[0]!);
  await idle(h);
  // The seam: the item the chain started is the first the listing returned after the first item left it.
  assert.deepEqual(startedRuns(h).map((r) => r.item), [order[0], order.filter((i) => i !== order[0])[0]]);
  assert.equal(await endedReason(h), "RunLimitReached");
});

test("a run that halted after implementing has its work committed on its branch, off the working branch, and the next item starts", async () => {
  const h = await harness([halting(committedWork), converging], { settings: settings(2) });
  const start = git(h.repo, "rev-parse", "HEAD");
  const [first] = await refinedOrder(h.tracker);
  const id = await begin(h, first!);
  await idle(h);
  assert.equal(endCode(h, id), 1);
  const branches = git(h.repo, "branch", "--list", `interloq/halted/${first}/*`, "--format=%(refname:short)").split("\n").filter((b) => b !== "");
  assert.equal(branches.length, 1);
  assert.match(git(h.repo, "show", "--name-only", "--format=", branches[0]!), /left\.txt/);
  assert.match(git(h.repo, "log", "--format=%s", branches[0]!), /the run's own commit/);
  assert.ok(git(h.repo, "merge-base", "--is-ancestor", start, "HEAD") === "");
  assert.ok(!fs.existsSync(path.join(h.repo, "committed.txt")) && !fs.existsSync(path.join(h.repo, "left.txt")));
  assert.equal(startedRuns(h).length, 2);
  const history = (await chainOf(h)).chain.history;
  assert.equal(history[0]?.outcome._tag === "Halted" && history[0].outcome.park._tag, "Parked");
});

test("a halted last item is parked before the chain ends with no item left", async () => {
  const only = MANAGER_ITEMS.filter((i) => i.id === "1");
  const h = await harness([halting(committedWork)], { tracker: fakeTrackerOf(only) });
  await begin(h, "1");
  await idle(h);
  assert.equal(await endedReason(h), "NoItems");
  assert.notEqual(git(h.repo, "branch", "--list", "interloq/halted/1/*"), "");
});

test("a run halted before its item was labeled is started again; halting twice ends the chain", async () => {
  const h = await harness([haltingEarly, haltingEarly, converging]);
  const [first] = await refinedOrder(h.tracker);
  await begin(h, first!);
  await idle(h);
  assert.deepEqual(startedRuns(h).map((r) => r.item), [first, first]);
  assert.equal(await endedReason(h), "HaltedTwice");
});

test("a run stopped with Stop task starts nothing", async () => {
  const h = await harness([{ steps: [{ output: noQuestions, plan: "v1", hang: true }] }, converging]);
  const id = await begin(h, "1");
  await until("the planning call", () => h.events.some((b) => b.run === id && b.event._tag === "Notified"));
  await run(h.manager.stop("test", id));
  await idle(h);
  assert.equal(endCode(h, id), 130);
  assert.equal(startedRuns(h).length, 1);
  assert.equal(await endedReason(h), "StoppedByDeveloper");
});

test("a question answered inside a run starts nothing until the run ends", async () => {
  const asking: TestOptions = {
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  };
  const h = await harness([asking, converging], { settings: settings(2) });
  const id = await begin(h, "1");
  await until("the question", () => h.events.some((b) => b.run === id && b.event._tag === "Asked"));
  await sleep(200);
  assert.equal(startedRuns(h).length, 1);
  const asked = h.events.find((b) => b.run === id && b.event._tag === "Asked")!.event as Extract<RunEvent, { _tag: "Asked" }>;
  await run(h.manager.answer("test", id, asked.prompt, "Postgres"));
  await idle(h);
  assert.equal(startedRuns(h).length, 2);
});

test("a run limit of 3 counts the developer's own run; a limit of 1 starts nothing", async () => {
  const three = await harness([converging, converging, converging, converging], { settings: settings(3) });
  await begin(three, "1");
  await idle(three);
  assert.equal(startedRuns(three).length, 3);
  assert.equal(await endedReason(three), "RunLimitReached");
  const one = await harness([converging, converging], { settings: settings(1) });
  await begin(one, "1");
  await idle(one);
  assert.equal(startedRuns(one).length, 1);
});

test("a passed cutoff ends the chain and says so, after a restart past it too", async () => {
  const h = await harness([converging, converging], { settings: settings(null, "2000-01-01T00:00:00.000Z") });
  await begin(h, "1");
  await idle(h);
  assert.equal(startedRuns(h).length, 1);
  assert.equal(await endedReason(h), "CutoffPassed");
  // A manager made from a saved Ready chain whose cutoff has passed starts nothing.
  const repo = identified();
  const ready: ChainState = { settings: settings(null, "2000-01-01T00:00:00.000Z"), generation: 1, chain: { _tag: "Ready", generation: 1, count: 1, halts: [], history: [] } };
  await run(saveChain(repo, ready).pipe(Effect.provide(platformLayer)));
  const restarted = await harness([converging], { repo });
  await idle(restarted);
  assert.equal(startedRuns(restarted).length, 0);
  assert.equal(await endedReason(restarted), "CutoffPassed");
});

test("turning the mode off while the listing is held starts nothing, and says no run was in progress", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let listings = 0;
  const h = await harness([converging, converging], {
    trackerOf: (fake) => ({ ...fake.tracker, list: (state) => Effect.suspend(() => (++listings >= 1 ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(fake.tracker.list(state))) }),
  });
  await begin(h, "1");
  await until("the chain's listing", async () => (await chainOf(h)).chain._tag === "Ready" && listings > 0);
  await run(h.manager.setChain(OFF_SETTINGS));
  release();
  await idle(h);
  await sleep(200);
  assert.equal(startedRuns(h).length, 1);
  const c = (await chainOf(h)).chain;
  assert.deepEqual(c._tag === "Idle" && c.ended, { _tag: "TurnedOff", running: null });
});

test("turning the mode off during a run leaves it running and starts nothing after it", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const h = await harness([{ ...converging, steps: [{ output: noQuestions, plan: "v1", gate: () => held }] }, converging]);
  const id = await begin(h, "1");
  await until("the planning call", () => h.events.some((b) => b.run === id && b.event._tag === "Notified"));
  const after = await run(h.manager.setChain(OFF_SETTINGS));
  assert.deepEqual(after.chain._tag === "Idle" && after.chain.ended, { _tag: "TurnedOff", running: "1" });
  assert.equal((await run(h.manager.current)).implementation, id);
  release();
  await idle(h);
  assert.equal(endCode(h, id), 0);
  assert.equal(startedRuns(h).length, 1);
});

test("a run started with the mode off starts nothing; a refinement runs beside the chain", async () => {
  const off = await harness([converging, converging], { defaults: OFF_SETTINGS });
  await begin(off, "1");
  await idle(off);
  assert.equal(startedRuns(off).length, 1);
  const refining: TestOptions = { mode: "refinement", steps: [{ output: { questions: [] } }] };
  const h = await harness([converging, refining, converging], { settings: settings(2) });
  await begin(h, "1");
  const refinement = await run(h.manager.start(startOf("refinement", "11")));
  assert.equal(typeof refinement, "number");
  await idle(h);
  assert.deepEqual(startedRuns(h).map((r) => r.item), ["1", "11", "2"]);
});

test("a restart: from Running or Starting nothing starts and the chain says the server ended; from Ready the item starts at once", async () => {
  for (const chain of [
    { _tag: "Running", run: 3, item: "4", title: "t", generation: 1, count: 1, halts: [], history: [] },
    { _tag: "Starting", item: "4", title: "t", generation: 1, count: 1, halts: [], history: [] },
  ] as const) {
    const repo = identified();
    await run(saveChain(repo, { settings: DEFAULT_SETTINGS, generation: 1, chain: chain as never }).pipe(Effect.provide(platformLayer)));
    const h = await harness([converging], { repo });
    await idle(h);
    assert.equal(startedRuns(h).length, 0);
    assert.deepEqual((await chainOf(h)).chain._tag === "Idle" && (await chainOf(h)).chain, { _tag: "Idle", ended: { _tag: "ServerEnded", item: "4" }, history: [] });
    await until("the restored chain on disk", async () => {
      const onDisk = await run(loadChain(repo, OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
      return onDisk.chain._tag === "Idle" && onDisk.chain.ended?._tag === "ServerEnded";
    });
  }
  const repo = identified();
  await run(saveChain(repo, { settings: settings(2), generation: 1, chain: { _tag: "Ready", generation: 1, count: 1, halts: [], history: [] } }).pipe(Effect.provide(platformLayer)));
  const h = await harness([converging], { repo });
  await idle(h);
  assert.equal(startedRuns(h).length, 1);
});

test("haltAll during a chained run leaves the file at Running, and the next manager starts nothing", async () => {
  const h = await harness([converging, { steps: [{ output: noQuestions, plan: "v1", hang: true }] }]);
  await begin(h, "1");
  await until("the chained run", () => startedRuns(h).length === 2);
  await run(h.manager.haltAll("write EPIPE"));
  const onDisk = await run(loadChain(h.repo, OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
  assert.equal(onDisk.chain._tag, "Running");
  const next = await harness([converging], { repo: h.repo });
  await idle(next);
  assert.equal(startedRuns(next).length, 0);
  assert.equal(await endedReason(next), "ServerEnded");
});

test("a manual start while a halted run's work is being parked is refused until it is on its branch", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let saves = 0;
  const live = (repo: string): ChainPersistence => ({
    save: (state) => Effect.suspend(() => (state.chain._tag === "Parking" && ++saves === 1 ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(saveChain(repo, state).pipe(Effect.provide(platformLayer), Effect.mapError(String)))),
    remove: Effect.void,
  });
  const repo = identified();
  const h = await harness([halting(committedWork), converging, converging], { repo, persistence: live(repo), settings: settings(2) });
  await begin(h, "1");
  await until("the parking", async () => (await chainOf(h)).chain._tag === "Parking");
  const refused = await run(h.manager.start(startOf("implementation", "3")));
  assert.deepEqual(refused, { refused: chainParkingText("1"), mode: "implementation" });
  release();
  await idle(h);
  assert.deepEqual(startedRuns(h).map((r) => r.item), ["1", "2"]);
});

test("persistence is ordered: a held save holds a start's Running, and the file ends at the newest state", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let saves = 0;
  const repo = identified();
  const persistence: ChainPersistence = {
    save: (state) => Effect.suspend(() => (++saves === 1 ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(saveChain(repo, state).pipe(Effect.provide(platformLayer), Effect.mapError(String)))),
    remove: Effect.void,
  };
  const h = await harness([{ ...converging, steps: [{ output: noQuestions, plan: "v1", hang: true }] }], { repo, persistence });
  // The first save, a change of the limits, is held.
  const configuring = Effect.runPromise(h.manager.setChain(settings(5)));
  await until("the held save", () => saves === 1);
  const starting = Effect.runPromise(h.manager.start(startOf("implementation", "1")));
  await sleep(300);
  assert.equal(startedRuns(h).length, 0, "the run's gate was released before its Running was saved");
  release();
  await Promise.all([configuring, starting]);
  await until("the run's start", () => startedRuns(h).length === 1);
  const onDisk = await run(loadChain(repo, OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
  assert.equal(onDisk.chain._tag, "Running");
  await run(h.manager.haltAll("end"));
  const next = await harness([converging], { repo });
  await idle(next);
  assert.equal(startedRuns(next).length, 0);
});

test("a failed save of Starting starts nothing and removes the file", async () => {
  const repo = identified();
  let removed = false;
  const persistence: ChainPersistence = {
    save: (state) => (state.chain._tag === "Starting" ? Effect.fail("disk full") : saveChain(repo, state).pipe(Effect.provide(platformLayer), Effect.mapError(String))),
    remove: Effect.sync(() => void (removed = true)),
  };
  const h = await harness([converging, converging], { repo, persistence });
  await begin(h, "1");
  await idle(h);
  assert.equal(startedRuns(h).length, 1);
  assert.equal(await endedReason(h), "SaveFailed");
  assert.ok(removed);
});

test("a failed save of a start's Running: with the file removed the run goes and the chain ends; with neither, the start is refused", async () => {
  const failing = (removal: Effect.Effect<void, string>): ChainPersistence => ({ save: (state) => (state.chain._tag === "Running" ? Effect.fail("disk full") : Effect.void), remove: removal });
  const goes = await harness([converging], { persistence: failing(Effect.void) });
  const id = await begin(goes, "1");
  await idle(goes);
  assert.equal(endCode(goes, id), 0);
  assert.equal(await endedReason(goes), "SaveFailed");
  const refusedH = await harness([converging], { persistence: failing(Effect.fail("read-only")) });
  const result = await run(refusedH.manager.start(startOf("implementation", "1")));
  assert.equal(typeof result, "object");
  assert.equal((await run(refusedH.manager.current)).implementation, null);
  assert.equal(startedRuns(refusedH).length, 0);
});


test("a restart from Parking finishes the parking and continues with the next item", async () => {
  const repo = identified();
  const root = runRootOf("implementation", "1", "2026-10-20T10:00:00.000Z");
  const store = await run(makeStore(repo, root, []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  await run(store.writeBaseline());
  committedWork(repo);
  const parking: ChainState = { settings: settings(2), generation: 1, chain: { _tag: "Parking", item: "1" as ItemId, root, then: null, generation: 1, count: 1, halts: [{ item: "1" as ItemId, times: 1 }], history: [] } };
  await run(saveChain(repo, parking).pipe(Effect.provide(platformLayer)));
  const tracker = fakeTrackerOf(MANAGER_ITEMS.map((i) => (i.id === "1" ? { ...i, state: "implementing" as const } : i)));
  const h = await harness([converging], { repo, tracker });
  await idle(h);
  assert.notEqual(git(repo, "branch", "--list", "interloq/halted/1/*"), "");
  assert.deepEqual(startedRuns(h).map((r) => r.item), ["2"]);
});

test("a cutoff that passes while the next item's read is held refuses that start with CutoffPassed", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let reads = 0;
  const cutoff = new Date(Date.now() + 60_000).toISOString();
  const h = await harness([converging, converging], {
    settings: settings(null, cutoff),
    trackerOf: (fake) => ({ ...fake.tracker, read: (id) => Effect.suspend(() => (++reads === 2 ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(fake.tracker.read(id))) }),
  });
  await begin(h, "1");
  await until("the chained start's read", () => reads === 2);
  // The limit moves into the past while the read waits; the reservation's guard reads the Clock and refuses.
  await run(h.manager.setChain(settings(null, "2000-01-01T00:00:00.000Z")));
  release();
  await idle(h);
  assert.equal(startedRuns(h).length, 1);
  assert.equal(await endedReason(h), "CutoffPassed");
});

// ---- work review 1 of issue #147, W1-R1-5: the continuation revalidated after its persist (S18) ----

/** A file left uncommitted by a halting run, and nothing committed. */
const leftOnly = (repo: string) => fs.writeFileSync(path.join(repo, "left.txt"), "left uncommitted\n");
/** A persistence over chain.json whose save fails while `failing()` is true; its removal removes the file. */
const flagged = (repo: string, failing: () => boolean): ChainPersistence => ({
  save: (state) => Effect.suspend(() => (failing() ? Effect.fail("disk full") : saveChain(repo, state).pipe(Effect.provide(platformLayer), Effect.mapError(String)))),
  remove: removeChain(repo).pipe(Effect.provide(platformLayer), Effect.mapError(String)),
});
const haltedBranches = (repo: string) => git(repo, "branch", "--list", "interloq/halted/*", "--format=%(refname:short)").split("\n").filter((b) => b !== "");

test("haltAll while the save of Parking is held: nothing is parked, and chain.json keeps Parking for the restart", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let holding = false;
  const repo = identified();
  const persistence: ChainPersistence = {
    save: (state) =>
      Effect.suspend(() => (state.chain._tag === "Parking" && !holding ? ((holding = true), Effect.promise(() => held)) : Effect.void)).pipe(
        Effect.andThen(saveChain(repo, state).pipe(Effect.provide(platformLayer), Effect.mapError(String))),
      ),
    remove: Effect.void,
  };
  const h = await harness([halting(leftOnly), converging], { repo, persistence });
  const start = git(repo, "rev-parse", "HEAD");
  await begin(h, "1");
  await until("the held save of Parking", () => holding);
  await run(h.manager.haltAll("write EPIPE"));
  release();
  await sleep(500);
  assert.deepEqual(haltedBranches(repo), []);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.match(git(repo, "status", "--porcelain"), /left\.txt/);
  const onDisk = await run(loadChain(repo, OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
  assert.equal(onDisk.chain._tag, "Parking");
});

test("a failed save during a running parking keeps starts refused until the work is on its branch, then ends SaveFailed", async () => {
  let entered = () => {};
  const inside = new Promise<void>((r) => (entered = r));
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let failing = false;
  const repo = identified();
  const park = (store: StoreShape, item: ItemId) => Effect.sync(entered).pipe(Effect.andThen(Effect.promise(() => held)), Effect.andThen(parkHalted(store, item)));
  const h = await harness([halting(leftOnly), converging], { repo, persistence: flagged(repo, () => failing), park });
  const start = git(repo, "rev-parse", "HEAD");
  await begin(h, "1");
  await inside;
  failing = true;
  await run(h.manager.setChain(settings(5)));
  assert.equal((await chainOf(h)).chain._tag, "Parking");
  assert.deepEqual(await run(h.manager.start(startOf("implementation", "3"))), { refused: chainParkingText("1"), mode: "implementation" });
  failing = false;
  release();
  await until("the chain to end", async () => (await chainOf(h)).chain._tag === "Idle");
  assert.equal(await endedReason(h), "SaveFailed");
  const branches = haltedBranches(repo);
  assert.equal(branches.length, 1);
  assert.match(branches[0]!, /^interloq\/halted\/1\//);
  assert.match(git(repo, "show", "--name-only", "--format=", branches[0]!), /left\.txt/);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.equal(typeof (await run(h.manager.start(startOf("implementation", "3")))), "number");
});

test("a failed save before the parking abandons it: nothing parked, the chain ends SaveFailed, and starts are accepted", async () => {
  let failing = false;
  const repo = identified();
  const h = await harness([halting((r) => (leftOnly(r), (failing = true))), converging], { repo, persistence: flagged(repo, () => failing) });
  const start = git(repo, "rev-parse", "HEAD");
  await begin(h, "1");
  await until("the chain to end", async () => (await chainOf(h)).chain._tag === "Idle" && (await run(h.manager.current)).implementation === null, 5_000);
  assert.equal(await endedReason(h), "SaveFailed");
  assert.deepEqual(haltedBranches(repo), []);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  failing = false;
  assert.equal(typeof (await run(h.manager.start(startOf("implementation", "3")))), "number");
});
