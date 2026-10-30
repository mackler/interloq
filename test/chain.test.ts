// Issue #147 (S1): the chain's pure transitions (src/chain.ts), case by case of the requirements.
import { PREPARATION_KEPT_OFF } from "../src/preparationSwitch.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import {
  begun, blocksImplementationStart, type ChainSettings, type ChainState, ChainFileSchema, configured, cutoffOf, DEFAULT_SETTINGS, due, ended, initialState,
  listed, OFF_SETTINGS, abandonedItems, parked, refused, restored, runLimitOf, saveFailed, started, startGuard, parkingAbandoned, commandApplies, type ChainCommand, claimParking, itemReturned,
} from "../src/chain.ts";
import type { ItemId } from "../src/tracker.ts";
import type { RunRoot } from "../src/artifacts.ts";

const id = (s: string) => s as ItemId;
const root = (s: string) => `runs/2026-10-20T00-00-00-000Z-implementation-${s}` as RunRoot;
const limit = (n: number) => Result.getOrThrow(runLimitOf(n));
const cutoff = (iso: string) => Result.getOrThrow(cutoffOf(iso));
const withRuns = (n: number | null): ChainSettings => ({ enabled: true, limits: { runs: n === null ? null : limit(n), cutoff: null } });
const gen = (s: ChainState) => (s.chain._tag === "Idle" ? -1 : s.chain.generation);

/** The developer starts item 1 as run 1. */
const startedChain = (settings: ChainSettings = DEFAULT_SETTINGS): ChainState => begun(initialState(settings), 1, id("1"), "one");
/** Ready → listed → started as run `run` of `item`. */
const chainStart = (s: ChainState, run: number, item: string): ChainState => {
  const [l] = listed(s, gen(s), [{ item: id(item), title: item }]);
  return started(l, gen(s), run, id(item), item);
};

test("a start with the mode on begins a chain counting the developer's own run; with it off, nothing", () => {
  const s = startedChain();
  assert.equal(s.chain._tag, "Running");
  assert.equal(s.chain._tag === "Running" && s.chain.count, 1);
  assert.deepEqual(begun(initialState(OFF_SETTINGS), 1, id("1"), "one"), initialState(OFF_SETTINGS));
});

test("a finished run makes the next start due; due lists; listed starts the first item given", () => {
  const [r, c] = ended(startedChain(), 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(c?.command, { _tag: "Due" });
  const [d, dc] = due(r, gen(r), 0);
  assert.deepEqual(dc?.command, { _tag: "List" });
  const [l, lc] = listed(d, gen(d), [{ item: id("7"), title: "seven" }]);
  assert.equal(l.chain._tag, "Starting");
  assert.deepEqual(lc?.command, { _tag: "Start", item: "7" });
  const s = started(l, gen(l), 2, id("7"), "seven");
  assert.equal(s.chain._tag === "Running" && s.chain.count, 2);
});

test("an empty listing ends the chain with NoItems; the mode stays on", () => {
  const [r] = ended(startedChain(), 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  const [l, c] = listed(r, gen(r), []);
  assert.deepEqual(l.chain._tag === "Idle" && l.chain.ended, { _tag: "NoItems" });
  assert.equal(c, null);
  assert.equal(l.settings.enabled, true);
});

test("Stop task (130) ends the chain", () => {
  const [s, c] = ended(startedChain(), 1, { code: 130, root: root("1"), parked: null, abandoned: null });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "StoppedByDeveloper", item: "1" });
  assert.equal(c, null);
});

test("a halt with a records directory parks, then continues", () => {
  const [p, c] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  assert.equal(p.chain._tag, "Parking");
  assert.deepEqual(c?.command, { _tag: "Park", item: "1", root: root("1") });
  assert.equal(blocksImplementationStart(p), true);
  const [r, rc] = parked(p, gen(p), { _tag: "Parked", branch: "b", commit: "c" });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(rc?.command, { _tag: "Due" });
  assert.equal(blocksImplementationStart(r), false);
  assert.deepEqual(r.chain._tag === "Ready" && r.chain.history[0]?.outcome, { _tag: "Halted", park: { _tag: "Parked", branch: "b", commit: "c" } });
});

test("a failed parking ends the chain", () => {
  const [p] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const [s] = parked(p, gen(p), { _tag: "ParkFailed", message: "m" });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "ParkFailed", item: "1", message: "m" });
});

test("a halt before the records existed starts the item again; the second halt ends the chain", () => {
  const [r, c] = ended(startedChain(), 1, { code: 1, root: null, parked: null, abandoned: null });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(c?.command, { _tag: "Due" });
  const again = chainStart(r, 2, "1");
  const [s] = ended(again, 2, { code: 1, root: null, parked: null, abandoned: null });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "HaltedTwice", item: "1" });
});

test("the same item halting twice with records is still parked before the chain ends", () => {
  const [p1] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const [r] = parked(p1, gen(p1), { _tag: "Parked", branch: "b", commit: "c" });
  const [p2, c] = ended(chainStart(r, 2, "1"), 2, { code: 1, root: root("1b"), parked: null, abandoned: null });
  assert.equal(p2.chain._tag, "Parking");
  assert.deepEqual(c?.command._tag, "Park");
  const [s] = parked(p2, gen(p2), { _tag: "Parked", branch: "b2", commit: "c2" });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "HaltedTwice", item: "1" });
});

test("a run limit of 1 starts nothing after the developer's run; of 3, two more", () => {
  const [r1] = ended(startedChain(withRuns(1)), 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  const [s1] = due(r1, gen(r1), 0);
  assert.deepEqual(s1.chain._tag === "Idle" && s1.chain.ended, { _tag: "RunLimitReached", limit: 1 });
  let s = startedChain(withRuns(3));
  let starts = 0;
  for (let run = 1; ; run++) {
    const [r] = ended(s, run, { code: 0, root: root(String(run)), parked: null, abandoned: null });
    const [d, c] = due(r, gen(r), 0);
    if (c === null) {
      assert.deepEqual(d.chain._tag === "Idle" && d.chain.ended, { _tag: "RunLimitReached", limit: 3 });
      break;
    }
    s = chainStart(d, run + 1, String(run + 1));
    starts++;
  }
  assert.equal(starts, 2);
});

test("a halt at the run limit is parked before the limit ends the chain", () => {
  const [p, c] = ended(startedChain(withRuns(1)), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  assert.equal(c?.command._tag, "Park");
  const [r] = parked(p, gen(p), { _tag: "Parked", branch: "b", commit: "c" });
  const [s] = due(r, gen(r), 0);
  assert.equal(s.chain._tag === "Idle" && s.chain.ended?._tag, "RunLimitReached");
});

test("a passed cutoff ends the chain at due and refuses a start in flight", () => {
  const settings: ChainSettings = { enabled: true, limits: { runs: null, cutoff: cutoff("2026-10-20T07:00:00.000Z") } };
  const [r] = ended(startedChain(settings), 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  const at = Date.parse("2026-10-20T07:00:00.000Z");
  const [s] = due(r, gen(r), at);
  assert.equal(s.chain._tag === "Idle" && s.chain.ended?._tag, "CutoffPassed");
  const [d] = due(r, gen(r), at - 1);
  const [l] = listed(d, gen(d), [{ item: id("2"), title: "two" }]);
  assert.equal(startGuard(l, gen(l), id("2"), at - 1), null);
  assert.equal(startGuard(l, gen(l), id("2"), at)?._tag, "CutoffPassed");
});

test("startGuard refuses at the limit, after the mode was turned off, and for another generation", () => {
  const [r] = ended(startedChain(withRuns(2)), 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  const [l] = listed(r, gen(r), [{ item: id("2"), title: "two" }]);
  assert.equal(startGuard(l, gen(l), id("2"), 0), null);
  const atLimit = configured(l, withRuns(1), null);
  assert.equal(startGuard(atLimit, gen(l), id("2"), 0)?._tag, "RunLimitReached");
  const off = configured(l, { ...withRuns(2), enabled: false }, null);
  assert.equal(startGuard(off, gen(l), id("2"), 0)?._tag, "ChainChanged");
  assert.equal(startGuard(l, gen(l) + 1, id("2"), 0)?._tag, "ChainChanged");
  const refusedState = refused(l, gen(l), { _tag: "StartRefused", item: id("2"), reason: "r" });
  assert.equal(refusedState.chain._tag === "Idle" && refusedState.chain.ended?._tag, "StartRefused");
});

test("turning the mode off ends a going chain saying which run goes on; during parking the parking finishes first", () => {
  const off = (s: ChainState, running: string | null) => configured(s, OFF_SETTINGS, running === null ? null : id(running));
  const s = off(startedChain(), "1");
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "TurnedOff", running: "1" });
  const [p] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const po = off(p, null);
  assert.equal(po.chain._tag, "Parking");
  const [after, c] = parked(po, gen(po), { _tag: "NothingParked" });
  assert.deepEqual(after.chain._tag === "Idle" && after.chain.ended, { _tag: "TurnedOff", running: null });
  assert.equal(c, null);
  const back = configured(after, DEFAULT_SETTINGS, null);
  assert.equal(back.chain._tag === "Idle" && back.chain.ended, null);
  assert.equal(back.chain.history.length, 1);
});

test("an end of another run, and a stale generation, do nothing", () => {
  const s = startedChain();
  assert.deepEqual(ended(s, 2, { code: 0, root: null, parked: null, abandoned: null }), [s, null]);
  const [r] = ended(s, 1, { code: 0, root: null, parked: null, abandoned: null });
  assert.deepEqual(due(r, gen(r) + 1, 0), [r, null]);
  assert.deepEqual(listed(r, gen(r) - 1, []), [r, null]);
  assert.deepEqual(parked(r, gen(r), { _tag: "NothingParked" }), [r, null]);
});

test("a restart: running and starting end with ServerEnded, parking parks again, ready is due, idle waits", () => {
  const run = startedChain();
  const [rr, rc] = restored(run);
  assert.deepEqual(rr.chain._tag === "Idle" && rr.chain.ended, { _tag: "ServerEnded", item: "1" });
  assert.equal(rc, null);
  const [r] = ended(run, 1, { code: 0, root: null, parked: null, abandoned: null });
  const [l] = listed(r, gen(r), [{ item: id("2"), title: "two" }]);
  assert.deepEqual(restored(l)[0].chain._tag === "Idle" && restored(l)[0].chain, { _tag: "Idle", ended: { _tag: "ServerEnded", item: "2" }, history: r.chain.history });
  assert.deepEqual(restored(r)[1]?.command, { _tag: "Due" });
  const [p] = ended(run, 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  assert.deepEqual(restored(p)[1]?.command, { _tag: "Park", item: "1", root: root("1") });
  assert.deepEqual(restored(initialState(DEFAULT_SETTINGS)), [initialState(DEFAULT_SETTINGS), null]);
});

test("a failed save ends the chain keeping the settings and the history", () => {
  const [r] = ended(startedChain(withRuns(3)), 1, { code: 0, root: null, parked: null, abandoned: null });
  const s = saveFailed(r, "disk full");
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "SaveFailed", message: "disk full" });
  assert.equal(s.settings.limits.runs, 3);
  assert.equal(s.chain.history.length, 1);
});

test("a manual start after a chain ended begins a new chain with a new generation and fresh halts", () => {
  const [h] = ended(startedChain(), 1, { code: 1, root: null, parked: null, abandoned: null });
  const [, c] = due(h, gen(h), 0);
  assert.notEqual(c, null);
  const again = begun(h, 5, id("9"), "nine");
  assert.equal(gen(again), gen(h) + 1);
  assert.equal(again.chain._tag === "Running" && again.chain.halts.length, 0);
});

test("the limits and the cutoff are constructed only from valid values", () => {
  assert.equal(Result.isFailure(runLimitOf(0)), true);
  assert.equal(Result.isFailure(runLimitOf(1.5)), true);
  assert.equal(Result.isFailure(cutoffOf("07:00")), true);
  assert.equal(Result.isFailure(cutoffOf("2026-10-20T07:00:00")), true);
  assert.equal(Result.getOrThrow(cutoffOf("2026-10-20T07:00:00.000Z")), Date.parse("2026-10-20T07:00:00.000Z"));
});

test("a saved state round-trips through the file's schema", () => {
  const [p] = ended(startedChain(withRuns(2)), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const file = { version: 2 as const, state: p, preparation: PREPARATION_KEPT_OFF };
  const decode = Schema.decodeUnknownSync(ChainFileSchema);
  assert.deepEqual(decode(JSON.parse(JSON.stringify(file))), file);
});


test("a failed save during parking keeps Parking, its exclusion, and ends the chain SaveFailed once parked (W1-R1-5)", () => {
  const notes = [{ _tag: "Parked", branch: "b", commit: "c" }, { _tag: "NothingParked" }] as const;
  const [p] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  for (const before of [p, configured(p, OFF_SETTINGS, null)]) {
    const f = saveFailed(before, "disk full");
    assert.equal(f.chain._tag, "Parking");
    assert.deepEqual(f.chain._tag === "Parking" && f.chain.then, { _tag: "SaveFailed", message: "disk full" });
    assert.equal(blocksImplementationStart(f), true);
    for (const note of notes) {
      const [after, c] = parked(f, gen(f), note);
      assert.deepEqual(after.chain._tag === "Idle" && after.chain.ended, { _tag: "SaveFailed", message: "disk full" });
      assert.equal(c, null);
      assert.equal(blocksImplementationStart(after), false);
    }
    const [pf] = parked(f, gen(f), { _tag: "ParkFailed", message: "m" });
    assert.deepEqual(pf.chain._tag === "Idle" && pf.chain.ended, { _tag: "ParkFailed", item: "1", message: "m" });
  }
  const [h1] = ended(startedChain(), 1, { code: 1, root: null, parked: null, abandoned: null });
  const twice = chainStart(h1, 2, "1");
  const [p2] = ended(twice, 2, { code: 1, root: root("2"), parked: null, abandoned: null });
  assert.deepEqual(p2.chain._tag === "Parking" && p2.chain.then, { _tag: "HaltedTwice", item: "1" });
  const f2 = saveFailed(p2, "x");
  assert.deepEqual(f2.chain._tag === "Parking" && f2.chain.then, { _tag: "SaveFailed", message: "x" });
});

test("a failed save outside parking ends the chain as before", () => {
  const run = startedChain();
  const [r] = ended(run, 1, { code: 0, root: null, parked: null, abandoned: null });
  const [l] = listed(r, gen(r), [{ item: id("2"), title: "two" }]);
  for (const s of [run, r, l]) {
    const f = saveFailed(s, "m");
    assert.deepEqual(f.chain, { _tag: "Idle", ended: { _tag: "SaveFailed", message: "m" }, history: s.chain.history });
  }
});

test("parkingAbandoned ends a Parking of its generation with its end, else SaveFailed; another generation unchanged", () => {
  const [p] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const a = parkingAbandoned(p, gen(p));
  assert.deepEqual(a.chain._tag === "Idle" && a.chain.ended, { _tag: "SaveFailed", message: "" });
  assert.deepEqual(a.chain.history, p.chain.history);
  assert.deepEqual(a.chain.history[0]?.outcome, { _tag: "Halted", park: { _tag: "Pending" } });
  assert.equal(blocksImplementationStart(a), false);
  const f = parkingAbandoned(saveFailed(p, "disk full"), gen(p));
  assert.deepEqual(f.chain._tag === "Idle" && f.chain.ended, { _tag: "SaveFailed", message: "disk full" });
  assert.deepEqual(parkingAbandoned(p, gen(p) + 1), p);
  const [r] = ended(startedChain(), 1, { code: 0, root: null, parked: null, abandoned: null });
  assert.deepEqual(parkingAbandoned(r, gen(r)), r);
});

test("commandApplies: each command in its own state and generation, never another", () => {
  const [p, park] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const [r, dueC] = ended(startedChain(), 1, { code: 0, root: null, parked: null, abandoned: null });
  const [, list] = due(r, gen(r), 0);
  const [l, start] = listed(r, gen(r), [{ item: id("2"), title: "two" }]);
  const cases: readonly [ChainState, ChainCommand][] = [[p, park!], [r, dueC!], [r, list!], [l, start!]];
  for (const [s, c] of cases) {
    assert.equal(commandApplies(s, c), true, c.command._tag);
    assert.equal(commandApplies(s, { ...c, generation: c.generation + 1 }), false, `${c.command._tag} other generation`);
    for (const [other] of cases) if (other.chain._tag !== s.chain._tag) assert.equal(commandApplies(other, c), false, `${c.command._tag} in ${other.chain._tag}`);
    assert.equal(commandApplies(initialState(DEFAULT_SETTINGS), c), false);
  }
  assert.equal(commandApplies(p, { generation: gen(p), command: { _tag: "Park", item: id("9"), root: root("1") } }), false);
  assert.equal(commandApplies(p, { generation: gen(p), command: { _tag: "Park", item: id("1"), root: root("9") } }), false);
  assert.equal(commandApplies(l, { generation: gen(l), command: { _tag: "Start", item: id("9") } }), false);
});

// Issue #192: a halted run's claim on the parking of its leftovers, which turning the mode off no longer cancels.
test("claimParking grants and records the claim exactly for the chain's running run", () => {
  const s = startedChain();
  const [claimed, granted] = claimParking(s, 1);
  assert.equal(granted, true);
  assert.deepEqual(claimed.chain._tag === "Running" && claimed.chain.claim, { _tag: "Claimed", then: null });
  assert.deepEqual(claimParking(s, 2), [s, false]);
  const idle = initialState(DEFAULT_SETTINGS);
  assert.deepEqual(claimParking(idle, 1), [idle, false]);
  const [ready] = ended(s, 1, { code: 0, root: root("1"), parked: null, abandoned: null });
  assert.deepEqual(claimParking(ready, 1), [ready, false]);
});

test("the mode turned off after a claim keeps the run's chain until its parking, which ends it TurnedOff; without a claim, Idle", () => {
  const [claimed] = claimParking(startedChain(), 1);
  const off = configured(claimed, OFF_SETTINGS, id("1"));
  assert.equal(off.chain._tag, "Running");
  assert.deepEqual(off.chain._tag === "Running" && off.chain.claim, { _tag: "Claimed", then: { _tag: "TurnedOff", running: id("1") } });
  const [parking, command] = ended(off, 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  assert.equal(parking.chain._tag, "Parking");
  assert.deepEqual(parking.chain._tag === "Parking" && parking.chain.then, { _tag: "TurnedOff", running: id("1") });
  assert.equal(command?.command._tag, "Park");
  const [after, next] = parked(parking, gen(parking), { _tag: "NothingParked" });
  assert.deepEqual(after.chain._tag === "Idle" && after.chain.ended, { _tag: "TurnedOff", running: id("1") });
  assert.equal(next, null);
  assert.equal(configured(startedChain(), OFF_SETTINGS, id("1")).chain._tag, "Idle");
});

test("a claimed run halted the second time parks and then ends HaltedTwice", () => {
  const [p1] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const [r1] = parked(p1, gen(p1), { _tag: "NothingParked" });
  const again = chainStart(r1, 2, "1");
  const [claimed] = claimParking(configured(again, again.settings, null), 2);
  const [p2] = ended(configured(claimed, OFF_SETTINGS, id("1")), 2, { code: 1, root: root("2"), parked: null, abandoned: null });
  assert.deepEqual(p2.chain._tag === "Parking" && p2.chain.then, { _tag: "HaltedTwice", item: id("1") });
});

test("a restored Running chain with a claim ends ServerEnded; a chain.json without the claim decodes Unclaimed", () => {
  const [claimed] = claimParking(startedChain(), 1);
  const [r] = restored(claimed);
  assert.deepEqual(r.chain._tag === "Idle" && r.chain.ended, { _tag: "ServerEnded", item: id("1") });
  const file = JSON.parse(JSON.stringify({ version: 2, state: startedChain() }));
  delete file.state.chain.claim;
  const decoded = Schema.decodeUnknownSync(ChainFileSchema)(file);
  assert.deepEqual(decoded.state.chain._tag === "Running" && decoded.state.chain.claim, { _tag: "Unclaimed" });
});

test("itemReturned sets the outcome on the item's newest halted entry of its generation, and nothing else", () => {
  const [p1] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  const g = gen(p1);
  const returned = itemReturned(p1, g, id("1"), { _tag: "Returned" });
  assert.deepEqual(returned.chain.history.map((e) => e.returned), [{ _tag: "Returned" }]);
  assert.deepEqual({ ...returned, chain: { ...returned.chain, history: [] } }, { ...p1, chain: { ...p1.chain, history: [] } });
  assert.deepEqual(itemReturned(p1, g + 1, id("1"), { _tag: "Returned" }), p1);
  assert.deepEqual(itemReturned(p1, g, id("2"), { _tag: "Returned" }), p1);
  const [after] = parked(returned, g, { _tag: "ParkFailed", message: "m" });
  assert.deepEqual(after.chain.history[0]?.returned, { _tag: "Returned" });
  const file = JSON.parse(JSON.stringify({ version: 2, state: p1 }));
  delete file.state.chain.history[0].returned;
  assert.equal(Schema.decodeUnknownSync(ChainFileSchema)(file).state.chain.history[0]?.returned, null);
});

// Work review 1 of issue #192 (W1-R1-1): a failed save after the claim keeps the claim, so the parking still runs.
test("W1-R1-1 saveFailed keeps a claimed Running chain with its claim ending SaveFailed", () => {
  const claimed = claimParking(startedChain(), 1)[0];
  const off = configured(claimed, OFF_SETTINGS, id("1"));
  for (const before of [claimed, off]) {
    const s = saveFailed(before, "disk full");
    assert.equal(s.chain._tag, "Running");
    if (s.chain._tag !== "Running" || before.chain._tag !== "Running") return;
    assert.equal(s.chain.run, before.chain.run);
    assert.equal(s.chain.item, before.chain.item);
    assert.equal(s.chain.count, before.chain.count);
    assert.deepEqual(s.chain.history, before.chain.history);
    assert.deepEqual(s.chain.claim, { _tag: "Claimed", then: { _tag: "SaveFailed", message: "disk full" } });
  }
});

test("W1-R1-1 saveFailed still ends an unclaimed Running chain", () => {
  const s = saveFailed(startedChain(), "disk full");
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "SaveFailed", message: "disk full" });
});

test("W1-R1-1 after a failed save of a claimed chain, the halt is parked and the chain ends SaveFailed", () => {
  const f = saveFailed(claimParking(startedChain(), 1)[0], "disk full");
  const [p, c] = ended(f, 1, { code: 1, root: root("1"), parked: null, abandoned: null });
  assert.equal(p.chain._tag, "Parking");
  assert.deepEqual(p.chain._tag === "Parking" && p.chain.then, { _tag: "SaveFailed", message: "disk full" });
  assert.deepEqual(c?.command, { _tag: "Park", item: "1", root: root("1") });
  const [done, none] = parked(p, gen(p), { _tag: "NothingParked" });
  assert.equal(none, null);
  assert.deepEqual(done.chain._tag === "Idle" && done.chain.ended, { _tag: "SaveFailed", message: "disk full" });
  const [noRoot] = ended(f, 1, { code: 1, root: null, parked: null, abandoned: null });
  assert.deepEqual(noRoot.chain._tag === "Idle" && noRoot.chain.ended, { _tag: "SaveFailed", message: "disk full" });
});

// Issue #186: a send-back (0 with the run's own parking) continues as a finished run and counts no halt; a halt or a
// stop the run parked itself is never parked again; a parking that failed ends the chain.
const ownParking = { _tag: "Parked" as const, branch: "interloq/halted/1/r", commit: "c" };
test("a send-back is recorded with its parking, makes the next start due and counts no halt", () => {
  const [r, c] = ended(startedChain(), 1, { code: 0, root: root("1"), parked: ownParking, abandoned: null });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(c?.command, { _tag: "Due" });
  assert.deepEqual(r.chain._tag === "Ready" && r.chain.history[0]?.outcome, { _tag: "SentBack", park: ownParking });
  assert.deepEqual(r.chain._tag === "Ready" && r.chain.halts, []);
  // Sent back however many times (requirements Q5): the same item sent back again does not end the chain.
  const [again] = ended(chainStart(r, 2, "1"), 2, { code: 0, root: root("1b"), parked: ownParking, abandoned: null });
  assert.equal(again.chain._tag, "Ready");
});

test("a halt that parked its own work issues no Park command and counts toward HaltedTwice", () => {
  const [r, c] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: { _tag: "NothingParked" }, abandoned: null });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(c?.command, { _tag: "Due" });
  assert.deepEqual(r.chain._tag === "Ready" && r.chain.history[0]?.outcome, { _tag: "Halted", park: { _tag: "NothingParked" } });
  const [s, sc] = ended(chainStart(r, 2, "1"), 2, { code: 1, root: root("1b"), parked: ownParking, abandoned: null });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "HaltedTwice", item: "1" });
  assert.equal(sc, null);
});

test("a halt whose own parking failed ends the chain with ParkFailed and parks nothing", () => {
  const [s, c] = ended(startedChain(), 1, { code: 1, root: root("1"), parked: { _tag: "ParkFailed", message: "m" }, abandoned: null });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "ParkFailed", item: "1", message: "m" });
  assert.equal(c, null);
});

test("a stop after the run's own parking ends the chain, the entry recording the parking", () => {
  const [s, c] = ended(startedChain(), 1, { code: 130, root: root("1"), parked: ownParking, abandoned: null });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "StoppedByDeveloper", item: "1" });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.history[0]?.outcome, { _tag: "Stopped", park: ownParking });
  assert.equal(c, null);
});

// ---- Issue #185: a run abandoned for want of an answer ----

test("an abandoned run continues the chain like a finished one, with its entry, and counts no halt", () => {
  const park = { _tag: "Parked", branch: "interloq/halted/1/r", commit: "c" } as const;
  const [r, c] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: park, abandoned: { _tag: "SetRefined" } });
  assert.equal(r.chain._tag, "Ready");
  assert.deepEqual(c?.command, { _tag: "Due" });
  assert.equal(r.chain._tag === "Ready" && r.chain.halts.length, 0);
  assert.deepEqual(r.chain.history.at(-1)?.outcome, { _tag: "Abandoned", park, label: { _tag: "SetRefined" } });
});

test("an abandoned run whose parking failed ends the chain ParkFailed, its entry keeping the label implementing", () => {
  const park = { _tag: "ParkFailed", message: "git commit failed: index.lock" } as const;
  const [s, c] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: park, abandoned: { _tag: "KeptImplementing" } });
  assert.deepEqual(s.chain._tag === "Idle" && s.chain.ended, { _tag: "ParkFailed", item: "1", message: park.message });
  assert.equal(c, null);
  assert.deepEqual(s.chain.history.at(-1)?.outcome, { _tag: "Abandoned", park, label: { _tag: "KeptImplementing" } });
  assert.equal(s.settings.enabled, true);
});

test("an abandonment before any records (the first read) records the label unchanged", () => {
  const [r] = ended(startedChain(), 1, { code: 2, root: null, parked: null, abandoned: null });
  assert.deepEqual(r.chain.history.at(-1)?.outcome, { _tag: "Abandoned", park: null, label: { _tag: "Unchanged" } });
});

test("a code-2 end with records and no label never claims the label refined", () => {
  const [a] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: { _tag: "ParkFailed", message: "m" }, abandoned: null });
  assert.deepEqual(a.chain.history.at(-1)?.outcome, { _tag: "Abandoned", park: { _tag: "ParkFailed", message: "m" }, label: { _tag: "KeptImplementing" } });
  const [b] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: null, abandoned: null });
  assert.deepEqual(b.chain.history.at(-1)?.outcome, { _tag: "Abandoned", park: null, label: { _tag: "Unconfirmed", cause: "" } });
});

test("the listing skips an item abandoned in the chain and takes the next; only abandoned items left ends NoItems", () => {
  const [r] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: { _tag: "NothingParked" }, abandoned: { _tag: "SetRefined" } });
  assert.deepEqual([...abandonedItems(r)], ["1"]);
  const [d] = due(r, gen(r), 0);
  const [l, lc] = listed(d, gen(d), [{ item: id("1"), title: "one" }, { item: id("2"), title: "two" }]);
  assert.deepEqual(lc?.command, { _tag: "Start", item: "2" });
  assert.equal(l.chain._tag, "Starting");
  const [e] = listed(d, gen(d), [{ item: id("1"), title: "one" }]);
  assert.deepEqual(e.chain._tag === "Idle" && e.chain.ended, { _tag: "NoItems" });
  // The mark stays with the ended chain's history.
  assert.deepEqual([...abandonedItems(e)], ["1"]);
});

test("a chain.json written before issue #185 decodes, and one holding a KeptImplementing entry round-trips", () => {
  const decode = Schema.decodeUnknownSync(ChainFileSchema);
  const old = { version: 2, state: { settings: DEFAULT_SETTINGS, generation: 1, chain: { _tag: "Idle", ended: null, history: [{ item: "1", title: "one", root: null, outcome: { _tag: "Finished" } }] } } };
  assert.equal(decode(old).state.chain.history.length, 1);
  const [s] = ended(startedChain(), 1, { code: 2, root: root("1"), parked: { _tag: "ParkFailed", message: "m" }, abandoned: { _tag: "KeptImplementing" } });
  const file = { version: 2 as const, state: s, preparation: PREPARATION_KEPT_OFF };
  assert.deepEqual(decode(JSON.parse(JSON.stringify(file))), file);
});
