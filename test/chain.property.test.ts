// Issue #147 (S1): properties of the chain's transitions (src/chain.ts) over arbitrary sequences of run ends.
import { PREPARATION_KEPT_OFF } from "../src/preparationSwitch.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import fc from "fast-check";
import { abandonedItems, begun, claimParking, type ChainCommand, type ChainState, ChainFileSchema, configured, due, ended, initialState, listed, OFF_SETTINGS, type ParkClaim, parked, restored, runLimitOf, saveFailed, started } from "../src/chain.ts";
import type { ItemId } from "../src/tracker.ts";
import type { RunRoot } from "../src/artifacts.ts";

const RUNS = { numRuns: 300, seed: 20261020 };
const arbEnd = fc.record({ code: fc.constantFrom(0, 0, 1, 130, 2), rooted: fc.boolean() });
const arbItems = fc.array(fc.constantFrom("1", "2", "3"), { minLength: 1, maxLength: 4 });

/** Drives a chain from the developer's first run through the given ends, as the manager would; returns every state seen. */
const drive = (limit: number | null, ends: readonly { code: number; rooted: boolean }[], items: readonly string[]) => {
  const runs = limit === null ? null : Result.getOrThrow(runLimitOf(limit));
  let state: ChainState = begun(initialState({ enabled: true, limits: { runs, cutoff: null } }), 1, items[0] as ItemId, "t");
  const seen: { state: ChainState; command: ChainCommand | null; via: string }[] = [];
  let run = 1;
  let starts = 1;
  let firstGiven: string | null = null;
  const record = (via: string, [s, c]: readonly [ChainState, ChainCommand | null]) => {
    state = s;
    seen.push({ state: s, command: c, via });
    return c;
  };
  for (const end of ends) {
    if (state.chain._tag !== "Running") break;
    let c = record("ended", ended(state, run, { code: end.code, root: end.rooted ? (`runs/r${run}` as RunRoot) : null, parked: null, abandoned: end.code === 2 && end.rooted ? { _tag: "SetRefined" } : null }));
    while (c !== null) {
      const g = c.generation;
      switch (c.command._tag) {
        case "Park":
          c = record("parked", parked(state, g, { _tag: "NothingParked" }));
          break;
        case "Due":
          c = record("due", due(state, g, 0));
          break;
        case "List":
          firstGiven = items[run % items.length] ?? "1";
          c = record("listed", listed(state, g, [{ item: firstGiven as ItemId, title: "t" }]));
          break;
        case "Start":
          assert.equal(c.command.item, firstGiven);
          run++;
          starts++;
          state = started(state, g, run, c.command.item, "t");
          c = null;
          break;
      }
    }
  }
  return { seen, starts, state };
};

test("no sequence of ends yields more runs than the limit", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), fc.array(arbEnd, { maxLength: 12 }), arbItems, (limit, ends, items) => {
      assert.ok(drive(limit, ends, items).starts <= limit);
    }),
    RUNS,
  );
});

test("every halt with a records directory passes through Parking; every transition into Ready comes with Due; 130 ends the chain", () => {
  fc.assert(
    fc.property(fc.array(arbEnd, { maxLength: 12 }), arbItems, (ends, items) => {
      const { seen } = drive(null, ends, items);
      seen.forEach(({ state, command, via }, i) => {
        if (state.chain._tag === "Ready" && via !== "due") assert.equal(command?.command._tag, "Due");
        if (via === "ended" && state.chain._tag !== "Running") {
          const last = state.chain.history.at(-1);
          if (last?.outcome._tag === "Halted" && last.root !== null) assert.equal(state.chain._tag, "Parking", `step ${i}`);
          if (last?.outcome._tag === "Stopped") assert.equal(state.chain._tag, "Idle");
        }
      });
    }),
    RUNS,
  );
});

test("a restore of Running or Starting always ends the chain; every state round-trips through the file's schema", () => {
  const decode = Schema.decodeUnknownSync(ChainFileSchema);
  fc.assert(
    fc.property(fc.array(arbEnd, { maxLength: 8 }), arbItems, (ends, items) => {
      const { seen, state } = drive(3, ends, items);
      for (const s of [state, ...seen.map((x) => x.state)]) {
        if (s.chain._tag === "Running" || s.chain._tag === "Starting") {
          const [r, c] = restored(s);
          assert.equal(r.chain._tag, "Idle");
          assert.equal(c, null);
        }
        const file = { version: 2 as const, state: s, preparation: PREPARATION_KEPT_OFF };
        assert.deepEqual(decode(JSON.parse(JSON.stringify(file))), file);
      }
    }),
    RUNS,
  );
});

test("a Parking chain never leaves Parking through saveFailed or a change of settings (W1-R1-5)", () => {
  const arbOp = fc.constantFrom("saveFailed", "off", "on", "due", "listed", "stale");
  fc.assert(
    fc.property(fc.array(arbEnd, { maxLength: 8 }), arbItems, fc.array(arbOp, { maxLength: 10 }), (ends, items, ops) => {
      const { seen } = drive(null, ends, items);
      for (const { state: start } of seen) {
        if (start.chain._tag !== "Parking") continue;
        let s: ChainState = start;
        const g = start.chain.generation;
        for (const op of ops) {
          s =
            op === "saveFailed" ? saveFailed(s, "m")
            : op === "off" ? configured(s, OFF_SETTINGS, null)
            : op === "on" ? configured(s, { enabled: true, limits: { runs: null, cutoff: null } }, null)
            : op === "due" ? due(s, g, 0)[0]
            : op === "listed" ? listed(s, g, [{ item: "1" as ItemId, title: "t" }])[0]
            : parked(s, g + 1, { _tag: "NothingParked" })[0];
          assert.equal(s.chain._tag, "Parking", op);
        }
      }
    }),
    RUNS,
  );
});

// Issue #192: whatever the claims, nothing is started once the mode is turned off.
test("property: no run starts after the mode is turned off, whatever the claims", () => {
  const arbOp = fc.constantFrom("claim", "off", "end0", "end1", "end1root", "parked", "due", "listed");
  fc.assert(
    fc.property(fc.array(arbOp, { maxLength: 14 }), (ops) => {
      let s: ChainState = begun(initialState({ enabled: true, limits: { runs: null, cutoff: null } }), 1, "1" as ItemId, "t");
      let run = 1;
      let turnedOff = false;
      for (const op of ops) {
        const g = s.chain._tag === "Idle" ? -1 : s.chain.generation;
        let command: ChainCommand | null = null;
        if (op === "claim") s = claimParking(s, run)[0];
        else if (op === "off") {
          s = configured(s, OFF_SETTINGS, null);
          turnedOff = true;
        } else if (op === "end0") [s, command] = ended(s, run, { code: 0, root: null, parked: null, abandoned: null });
        else if (op === "end1") [s, command] = ended(s, run, { code: 1, root: null, parked: null, abandoned: null });
        else if (op === "end1root") [s, command] = ended(s, run, { code: 1, root: `runs/r${run}` as RunRoot, parked: null, abandoned: null });
        else if (op === "parked") [s, command] = parked(s, g, { _tag: "NothingParked" });
        else if (op === "due") [s, command] = due(s, g, 0);
        else [s, command] = listed(s, g, [{ item: "2" as ItemId, title: "t" }]);
        if (command?.command._tag === "Start") {
          assert.ok(!turnedOff, "a start after the mode was turned off");
          run++;
          s = started(s, command.generation, run, command.command.item, "t");
        }
      }
    }),
    RUNS,
  );
});

// Work review 1 of issue #192 (W1-R1-1): a failed save keeps a granted parking claim.
const arbItemId = fc.constantFrom("1", "2", "3", "41").map((s) => s as ItemId);
const arbReason = fc.oneof(
  fc.constant({ _tag: "NoItems" as const }),
  arbItemId.map((item) => ({ _tag: "HaltedTwice" as const, item })),
  fc.option(arbItemId, { nil: null }).map((running) => ({ _tag: "TurnedOff" as const, running })),
  fc.string().map((message) => ({ _tag: "SaveFailed" as const, message })),
  arbItemId.map((item) => ({ _tag: "StoppedByDeveloper" as const, item })),
);
const arbEntry = fc.record({
  item: arbItemId,
  title: fc.string(),
  root: fc.constant(null),
  outcome: fc.constantFrom({ _tag: "Finished" as const }, { _tag: "Stopped" as const, park: null }, { _tag: "Halted" as const, park: { _tag: "NothingParked" as const } }),
  returned: fc.constant(null),
});
const arbSettings = fc.record({
  enabled: fc.boolean(),
  limits: fc.record({ runs: fc.option(fc.integer({ min: 1, max: 9 }).map((n) => Result.getOrThrow(runLimitOf(n))), { nil: null }), cutoff: fc.constant(null) }),
});
const arbRunning = (claim: fc.Arbitrary<ParkClaim>) =>
  fc.record({
    settings: arbSettings,
    generation: fc.nat(50),
    chain: fc.record({
      _tag: fc.constant("Running" as const),
      run: fc.nat(100),
      item: arbItemId,
      title: fc.string(),
      claim,
      generation: fc.nat(50),
      count: fc.nat(20),
      halts: fc.array(fc.record({ item: arbItemId, times: fc.nat(3) }), { maxLength: 3 }),
      history: fc.array(arbEntry, { maxLength: 4 }),
    }),
  }) as fc.Arbitrary<ChainState>;
const arbClaimed = arbRunning(fc.option(arbReason, { nil: null }).map((then) => ({ _tag: "Claimed" as const, then })));

test("W1-R1-1 property: saveFailed keeps a claimed Running chain, its claim ending with SaveFailed", () => {
  fc.assert(
    fc.property(arbClaimed, fc.string(), (state, message) => {
      const s = saveFailed(state, message);
      assert.deepEqual(s.settings, state.settings);
      assert.equal(s.chain._tag, "Running");
      const { claim: _before, ...rest } = state.chain as Extract<ChainState["chain"], { _tag: "Running" }>;
      const { claim, ...after } = s.chain as Extract<ChainState["chain"], { _tag: "Running" }>;
      assert.deepEqual(after, rest);
      assert.deepEqual(claim, { _tag: "Claimed", then: { _tag: "SaveFailed", message } });
    }),
    RUNS,
  );
});

test("W1-R1-1 property: saveFailed ends every chain that is neither Parking nor a claimed Running chain", () => {
  const arbOther = fc.oneof(
    arbRunning(fc.constant({ _tag: "Unclaimed" as const })),
    fc.tuple(fc.array(arbEnd, { maxLength: 8 }), arbItems).chain(([ends, items]) => {
      const states = [drive(null, ends, items).state, ...drive(null, ends, items).seen.map((x) => x.state)].filter(
        (s) => s.chain._tag !== "Parking" && !(s.chain._tag === "Running" && s.chain.claim._tag === "Claimed"),
      );
      return fc.constantFrom(...states);
    }),
  );
  fc.assert(
    fc.property(arbOther, fc.string(), (state, message) => {
      const s = saveFailed(state, message);
      assert.deepEqual(s.chain, { _tag: "Idle", ended: { _tag: "SaveFailed", message }, history: state.chain.history });
      assert.deepEqual(s.settings, state.settings);
    }),
    RUNS,
  );
});

// Issue #186: an end with the run's own parking never yields a Park command, and a ParkFailed note always ends the chain.
const arbOwnNote = fc.oneof(
  fc.constant({ _tag: "NothingParked" as const }),
  fc.record({ _tag: fc.constant("Parked" as const), branch: fc.constant("interloq/halted/1/r"), commit: fc.constant("c") }),
  fc.string().map((message) => ({ _tag: "ParkFailed" as const, message })),
);
test("property: an end with its own parking never yields a Park command, and a ParkFailed note ends the chain", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ code: fc.constantFrom(0, 1, 130), note: arbOwnNote, rooted: fc.boolean() }), { minLength: 1, maxLength: 6 }), (ends) => {
      let s: ChainState = begun(initialState({ enabled: true, limits: { runs: null, cutoff: null } }), 1, "1" as ItemId, "t");
      let run = 1;
      for (const end of ends) {
        if (s.chain._tag !== "Running") return;
        const [next, command] = ended(s, run, { code: end.code, root: end.rooted ? (`runs/r${run}` as RunRoot) : null, parked: end.note, abandoned: null });
        assert.notEqual(command?.command._tag, "Park");
        if (end.code === 1 && end.note._tag === "ParkFailed") assert.deepEqual(next.chain._tag === "Idle" && next.chain.ended?._tag, "ParkFailed");
        s = next;
        if (s.chain._tag === "Ready") {
          run += 1;
          s = started(s, s.chain.generation, run, "1" as ItemId, "t");
        }
      }
    }),
    RUNS,
  );
});

// Issue #185 (requirements Q1, Q6): an item abandoned in a chain is never started again in it, and abandonments alone
// never end a chain.
test("an abandoned item is never the item of a later start of its chain, and abandonments alone never end it", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(0, 1, 2, 130), { maxLength: 12 }), fc.array(fc.constantFrom("1", "2", "3", "4"), { minLength: 1, maxLength: 4 }), (codes, listing) => {
      let state: ChainState = begun(initialState({ enabled: true, limits: { runs: null, cutoff: null } }), 1, "1" as ItemId, "t");
      let run = 1;
      const abandoned = new Set<string>();
      for (const code of codes) {
        if (state.chain._tag !== "Running") break;
        const item = state.chain.item;
        let [s, c] = ended(state, run, { code, root: `runs/r${run}` as RunRoot, parked: null, abandoned: code === 2 ? { _tag: "SetRefined" } : null });
        state = s;
        if (code === 2) abandoned.add(item);
        while (c !== null) {
          const g = c.generation;
          if (c.command._tag === "Park") [state, c] = parked(state, g, { _tag: "NothingParked" });
          else if (c.command._tag === "Due") [state, c] = due(state, g, 0);
          else if (c.command._tag === "List") [state, c] = listed(state, g, listing.map((i) => ({ item: i as ItemId, title: "t" })));
          else {
            assert.ok(!abandoned.has(c.command.item), `item ${c.command.item} started again after its abandonment`);
            run++;
            state = started(state, g, run, c.command.item, "t");
            c = null;
          }
        }
        assert.deepEqual([...abandonedItems(state)].sort(), [...abandoned].sort());
        if (codes.slice(0, codes.indexOf(code) + 1).every((x) => x === 2 || x === 0) && state.chain._tag === "Idle")
          assert.deepEqual(state.chain.ended, { _tag: "NoItems" });
      }
    }),
    RUNS,
  );
});
