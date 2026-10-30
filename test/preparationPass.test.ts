// Issue #131 (S15): the loop that prepares the marked unrefined items one after another, over fake dependencies: its
// choice of the next item, its wake, and stopItem, stop and shutdown, none of which waits for a preparation's cleanup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Ref, Result, type Scope } from "effect";
import { runCommentKey } from "../src/itemComments.ts";
import { type PreparationOutcome } from "../src/preparation.ts";
import { type Candidate, candidateEligible, makePreparationPass, type PassDeps, type PreparationPass } from "../src/preparationPass.ts";
import { digestOf, type PreparationRecord, preparedComments } from "../src/preparedComments.ts";
import { PREPARATION_KEPT_OFF, type PreparationFailure, type PreparationKept, type PreparationStatus, switched, withFailure, withRelease } from "../src/preparationSwitch.ts";
import type { ItemComment, ItemId, TrackerItem } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const itemOf = (id: string, title = `item ${id}`): TrackerItem => ({ id: id as ItemId, title, body: "", state: "unrefined", url: Option.none() });
const ON: PreparationKept = switched(PREPARATION_KEPT_OFF, true);
const commentsOf = (record: PreparationRecord): ItemComment[] => Result.getOrThrow(preparedComments(runCommentKey(record.key), [], record)).map((c, i) => ({ id: seededId(`${record.key}-${i}`), body: c.text, created: "t" }));
const setAside = (item: TrackerItem, generation: number, key = `k-${item.id}`): ItemComment[] => commentsOf({ _tag: "SetAside", key, digest: digestOf(item), generation, date: "d", cause: { _tag: "Paused", question: "?" } });
const preparedFor = (item: TrackerItem): ItemComment[] => commentsOf({ _tag: "Prepared", key: `p-${item.id}`, digest: digestOf(item), count: 0, generation: 1, date: "d" });
const until = async (what: string, check: () => boolean | Promise<boolean>) => {
  for (let waited = 0; !(await check()); waited += 5) {
    if (waited > 10_000) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 50));

type Script = Readonly<{ outcome?: PreparationOutcome; gate?: Promise<void>; cleanup?: Promise<void> }>;
const harness = async (initial: readonly Candidate[], kept: PreparationKept = ON, scripts: Readonly<Record<string, Script>> = {}) => {
  let candidates = [...initial];
  let listings = 0;
  let refining: ItemId[] = [];
  let closing = false;
  let onPublish: (s: PreparationStatus) => Promise<void> = async () => {};
  const keptRef = Effect.runSync(Ref.make(kept));
  const prepared: string[] = [];
  const failures: PreparationFailure[] = [];
  const dropped: string[][] = [];
  const statuses: PreparationStatus[] = [];
  const deps: PassDeps = {
    kept: Ref.get(keptRef),
    closing: Effect.sync(() => closing),
    candidates: Effect.sync(() => {
      listings += 1;
      return Result.succeed(candidates);
    }),
    refining: Effect.sync(() => refining),
    prepare: (item: TrackerItem): Effect.Effect<PreparationOutcome, never, Scope.Scope> => {
      const script = scripts[item.id] ?? {};
      return Effect.gen(function* () {
        prepared.push(item.id);
        if (script.gate !== undefined) yield* Effect.promise(() => script.gate!);
        const outcome: PreparationOutcome = script.outcome ?? { _tag: "Prepared", count: 1 };
        // What the tracker's comments then say of the item.
        if (outcome._tag === "Prepared") candidates = candidates.map((c) => (c.item.id === item.id ? { ...c, comments: preparedFor(c.item) } : c));
        return outcome;
      }).pipe(Effect.onInterrupt(() => (script.cleanup === undefined ? Effect.void : Effect.promise(() => script.cleanup!))));
    },
    recordFailure: (f) => Effect.andThen(Ref.update(keptRef, (k) => withFailure(k, f)), Effect.sync(() => void failures.push(f))),
    dropReleases: (items) => Effect.sync(() => void dropped.push([...items])),
    publish: (s) => Effect.andThen(Effect.sync(() => void statuses.push(s)), Effect.promise(() => onPublish(s))),
  };
  const pass: PreparationPass = await run(makePreparationPass(deps));
  return {
    pass,
    prepared,
    failures,
    dropped,
    statuses,
    listings: () => listings,
    setCandidates: (c: readonly Candidate[]) => void (candidates = [...c]),
    setRefining: (r: readonly string[]) => void (refining = r as ItemId[]),
    setClosing: (c: boolean) => void (closing = c),
    setKept: (k: PreparationKept) => run(Ref.set(keptRef, k)),
    onPublish: (f: (s: PreparationStatus) => Promise<void>) => void (onPublish = f),
    last: () => statuses.at(-1),
  };
};
const gated = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

test("candidateEligible: each reading of the comments, a released set-aside, and a failure that counts or not", () => {
  const a = itemOf("1");
  assert.equal(candidateEligible(ON, a, []), true);
  assert.equal(candidateEligible(ON, a, preparedFor(a)), false);
  assert.equal(candidateEligible(ON, a, setAside(a, ON.settings.generation)), false);
  assert.equal(candidateEligible(ON, a, setAside(a, ON.settings.generation + 5)), true);
  assert.equal(candidateEligible(withRelease(ON, { item: "1", key: "k-1" }), a, setAside(a, ON.settings.generation)), true);
  assert.equal(candidateEligible(withRelease(ON, { item: "1", key: "other" }), a, setAside(a, ON.settings.generation)), false);
  const failing = withFailure(ON, { item: "1", digest: digestOf(a), generation: ON.settings.generation, reason: "r" });
  assert.equal(candidateEligible(failing, a, []), false);
  assert.equal(candidateEligible(withFailure(ON, { item: "1", digest: "old", generation: ON.settings.generation, reason: "r" }), a, []), true);
});

test("three eligible items are prepared in the order listed (newest first); a prepared, a set-aside and a refining one are skipped", async () => {
  const [a, b, c, d, e, f] = ["6", "5", "4", "3", "2", "1"].map((id) => itemOf(id));
  const h = await harness([
    { item: a!, comments: [] },
    { item: b!, comments: preparedFor(b!) },
    { item: c!, comments: [] },
    { item: d!, comments: setAside(d!, ON.settings.generation) },
    { item: e!, comments: [] },
    { item: f!, comments: [] },
  ]);
  h.setRefining(["2"]);
  await run(h.pass.wake);
  await until("Idle", () => h.last()?._tag === "Idle");
  assert.deepEqual(h.prepared, ["6", "4", "1"]);
  await run(h.pass.shutdown);
});

test("with nothing eligible the pass publishes Idle and prepares nothing until woken", async () => {
  const a = itemOf("1");
  const h = await harness([{ item: a, comments: preparedFor(a) }]);
  await run(h.pass.wake);
  await until("Idle", () => h.last()?._tag === "Idle");
  h.setCandidates([{ item: a, comments: [] }]);
  await settle();
  assert.deepEqual(h.prepared, []);
  await run(h.pass.wake);
  await until("the preparation", () => h.prepared.length === 1);
  await run(h.pass.shutdown);
});

test("a wake during a held preparation leads to one more look after it, and ten wakes to at most one", async () => {
  const a = itemOf("1");
  const g = gated();
  const h = await harness([{ item: a, comments: [] }], ON, { "1": { gate: g.promise } });
  await run(h.pass.wake);
  await until("the preparation", () => h.prepared.length === 1);
  h.setCandidates([{ item: a, comments: preparedFor(a) }]);
  const before = h.listings();
  for (let i = 0; i < 10; i += 1) await run(h.pass.wake);
  g.open();
  await until("Idle", () => h.last()?._tag === "Idle");
  await settle();
  assert.ok(h.listings() - before <= 2, `looked ${h.listings() - before} times`);
  await run(h.pass.shutdown);
});

test("a release whose key no comment carries any more is dropped; a released set-aside is prepared again", async () => {
  const a = itemOf("1");
  const b = itemOf("2");
  const kept = withRelease(withRelease(ON, { item: "1", key: "k-1" }), { item: "2", key: "gone" });
  const h = await harness([{ item: a, comments: setAside(a, ON.settings.generation) }, { item: b, comments: [] }], kept);
  await run(h.pass.wake);
  await until("both preparations", () => h.prepared.length === 2);
  assert.ok(h.dropped.some((items) => items.includes("2") && !items.includes("1")));
  await run(h.pass.shutdown);
});

test("stopItem during a preparation whose cleanup never ends returns at once, and the next item is prepared meanwhile", async () => {
  const a = itemOf("2");
  const b = itemOf("1");
  const never = new Promise<void>(() => {});
  const h = await harness([{ item: a, comments: [] }, { item: b, comments: [] }], ON, { "2": { gate: never, cleanup: never } });
  await run(h.pass.wake);
  await until("the first preparation", () => h.prepared.length === 1);
  h.setRefining(["2"]);
  await run(h.pass.stopItem("2" as ItemId));
  await until("the next preparation", () => h.prepared.includes("1"));
  await run(h.pass.shutdown);
});

test("stop with the switch off interrupts, publishes Off, and wakes prepare nothing until it is on again", async () => {
  const a = itemOf("1");
  const g = gated();
  const h = await harness([{ item: a, comments: [] }], ON, { "1": { gate: g.promise } });
  await run(h.pass.wake);
  await until("the preparation", () => h.prepared.length === 1);
  await h.setKept(switched(ON, false));
  await run(h.pass.stop);
  await run(h.pass.wake);
  await until("Off", () => h.last()?._tag === "Off");
  await run(h.pass.wake);
  await settle();
  assert.equal(h.prepared.length, 1);
  await h.setKept(switched(switched(ON, false), true));
  await run(h.pass.wake);
  await until("a new preparation", () => h.prepared.length === 2);
  await run(h.pass.shutdown);
});

test("shutdown during a preparation whose cleanup never ends returns at once, and nothing is prepared again", async () => {
  const a = itemOf("2");
  const b = itemOf("1");
  const never = new Promise<void>(() => {});
  const h = await harness([{ item: a, comments: [] }, { item: b, comments: [] }], ON, { "2": { gate: never, cleanup: never } });
  await run(h.pass.wake);
  await until("the first preparation", () => h.prepared.length === 1);
  await run(h.pass.wake);
  await run(h.pass.shutdown);
  await run(h.pass.wake);
  await settle();
  assert.deepEqual(h.prepared, ["2"]);
});

test("stopItem whose cleanup never ends, then shutdown: shutdown returns at once and nothing new is prepared", async () => {
  const a = itemOf("2");
  const never = new Promise<void>(() => {});
  const h = await harness([{ item: a, comments: [] }], ON, { "2": { gate: never, cleanup: never } });
  await run(h.pass.wake);
  await until("the preparation", () => h.prepared.length === 1);
  h.setRefining(["2"]);
  await run(h.pass.stopItem("2" as ItemId));
  await run(h.pass.shutdown);
  h.setRefining([]);
  await run(h.pass.wake);
  await settle();
  assert.deepEqual(h.prepared, ["2"]);
});

test("a selection racing shutdown: the selected preparation never runs past its gate", async () => {
  const a = itemOf("1");
  const h = await harness([{ item: a, comments: [] }]);
  const held = gated();
  let started = false;
  h.onPublish(async (s) => {
    if (s._tag === "Preparing" && !started) {
      started = true;
      await run(h.pass.shutdown);
      held.open();
    }
  });
  await run(h.pass.wake);
  await held.promise;
  await settle();
  assert.deepEqual(h.prepared, []);
});

test("with the server closing, a wake prepares nothing", async () => {
  const h = await harness([{ item: itemOf("1"), comments: [] }]);
  h.setClosing(true);
  await run(h.pass.wake);
  await settle();
  assert.deepEqual(h.prepared, []);
  await run(h.pass.shutdown);
});

test("a NotWritten item is recorded, skipped while its failure counts, and prepared again once its digest changes", async () => {
  const a = itemOf("1");
  const h = await harness([{ item: a, comments: [] }], ON, { "1": { outcome: { _tag: "NotWritten", reason: "refused" } } });
  await run(h.pass.wake);
  await until("the failure", () => h.failures.length === 1);
  assert.deepEqual(h.failures[0], { item: "1", digest: digestOf(a), generation: ON.settings.generation, reason: "refused" });
  await until("Idle", () => h.last()?._tag === "Idle");
  assert.equal(h.prepared.length, 1);
  h.setCandidates([{ item: { ...a, title: "edited" }, comments: [] }]);
  await run(h.pass.wake);
  await until("a second preparation", () => h.prepared.length === 2);
  await run(h.pass.shutdown);
});

test("an item that becomes refining before its selection is skipped, or stopped once selected", async () => {
  const a = itemOf("1");
  const g = gated();
  const h = await harness([{ item: a, comments: [] }], ON, { "1": { gate: g.promise } });
  h.onPublish(async (s) => {
    if (s._tag === "Preparing") {
      h.setRefining(["1"]);
      await run(h.pass.stopItem("1" as ItemId));
    }
  });
  await run(h.pass.wake);
  await settle();
  assert.equal(await run(h.pass.current), null);
  await run(h.pass.shutdown);
});


// Work review 1 (W1-R1-1): a candidate judged at one generation and selected after the switch was turned off and on.
const heldListing = async (kept: PreparationKept) => {
  const keptRef = Effect.runSync(Ref.make(kept));
  const item = itemOf("1");
  let comments: ItemComment[] = [];
  let first = true;
  const listing = gated();
  const listed = gated();
  const generations: number[] = [];
  const statuses: PreparationStatus[] = [];
  const deps: PassDeps = {
    kept: Ref.get(keptRef),
    closing: Effect.succeed(false),
    candidates: Effect.gen(function* () {
      if (first) {
        first = false;
        listed.open();
        yield* Effect.promise(() => listing.promise);
      }
      return Result.succeed([{ item, comments }] as readonly Candidate[]);
    }),
    refining: Effect.succeed([]),
    prepare: (_item, _comments, generation) =>
      Effect.sync(() => {
        generations.push(generation);
        comments = setAside(item, generation);
        return { _tag: "SetAside", cause: { _tag: "Paused", question: "?" } } as PreparationOutcome;
      }),
    recordFailure: () => Effect.void,
    dropReleases: () => Effect.void,
    publish: (s) => Effect.sync(() => void statuses.push(s)),
  };
  const pass = await run(makePreparationPass(deps));
  await run(pass.wake);
  await listed.promise;
  return { pass, keptRef, listing, generations, statuses, setKept: (k: PreparationKept) => run(Ref.set(keptRef, k)) };
};

test("W1-R1-1: the switch turned off and on while the listing is held prepares at the new generation, once", async () => {
  const h = await heldListing(ON);
  const cycled = switched(switched(ON, false), true);
  await h.setKept(cycled);
  await run(h.pass.wake);
  h.listing.open();
  await until("Idle", () => h.statuses.at(-1)?._tag === "Idle");
  for (let i = 0; i < 3; i += 1) await run(h.pass.wake);
  await settle();
  assert.deepEqual(h.generations, [cycled.settings.generation]);
  const again = switched(switched(cycled, false), true);
  await h.setKept(again);
  await run(h.pass.wake);
  await until("a preparation at the next generation", () => h.generations.length === 2);
  assert.deepEqual(h.generations, [cycled.settings.generation, again.settings.generation]);
  await run(h.pass.shutdown);
});

test("W1-R1-1: a failure that counts, added while the listing is held, leads to no preparation", async () => {
  const h = await heldListing(ON);
  await h.setKept(withFailure(ON, { item: "1", digest: digestOf(itemOf("1")), generation: ON.settings.generation, reason: "r" }));
  h.listing.open();
  await settle();
  await settle();
  assert.deepEqual(h.generations, []);
  await run(h.pass.shutdown);
});
