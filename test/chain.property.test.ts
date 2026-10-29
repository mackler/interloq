// Issue #147 (S1): properties of the chain's transitions (src/chain.ts) over arbitrary sequences of run ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import fc from "fast-check";
import { begun, claimParking, type ChainCommand, type ChainState, ChainFileSchema, configured, due, ended, initialState, listed, OFF_SETTINGS, parked, restored, runLimitOf, saveFailed, started } from "../src/chain.ts";
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
    let c = record("ended", ended(state, run, { code: end.code, root: end.rooted ? (`runs/r${run}` as RunRoot) : null }));
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
          c = record("listed", listed(state, g, { item: firstGiven as ItemId, title: "t" }));
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
        const file = { version: 2 as const, state: s };
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
            : op === "listed" ? listed(s, g, { item: "1" as ItemId, title: "t" })[0]
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
        } else if (op === "end0") [s, command] = ended(s, run, { code: 0, root: null });
        else if (op === "end1") [s, command] = ended(s, run, { code: 1, root: null });
        else if (op === "end1root") [s, command] = ended(s, run, { code: 1, root: `runs/r${run}` as RunRoot });
        else if (op === "parked") [s, command] = parked(s, g, { _tag: "NothingParked" });
        else if (op === "due") [s, command] = due(s, g, 0);
        else [s, command] = listed(s, g, { item: "2" as ItemId, title: "t" });
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
