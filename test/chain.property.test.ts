// Issue #147 (S1): properties of the chain's transitions (src/chain.ts) over arbitrary sequences of run ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import fc from "fast-check";
import { begun, type ChainCommand, type ChainState, ChainFileSchema, due, ended, initialState, listed, parked, restored, runLimitOf, started } from "../src/chain.ts";
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
