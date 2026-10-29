// Issue #192 (decision Q5): an implementation run that ended without finishing returns its item to refined exactly when
// it has a baseline, made no commit, and the chain does not park its leftovers.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { itemReturnOf, type ReturnFacts } from "../src/itemReturn.ts";

const commit = fc.option(fc.constantFrom("c1", "c2", "c3"), { nil: null });
const facts: fc.Arbitrary<ReturnFacts> = fc.oneof(
  fc.constant({ _tag: "NoBaseline" as const }),
  fc.record({
    _tag: fc.constant("Baseline" as const),
    startCommit: commit,
    head: commit,
    parking: fc.constantFrom({ _tag: "NotParked" as const }, { _tag: "ParkingClaimed" as const }, { _tag: "ParkedByRun" as const }),
  }),
);

test("property: the item returns exactly when there is a baseline, HEAD is the start commit and nothing is parked", () => {
  fc.assert(
    fc.property(facts, (f) => {
      const shouldReturn = f._tag === "Baseline" && f.head === f.startCommit && f.parking._tag === "NotParked";
      const decided = itemReturnOf(f);
      assert.equal(decided._tag === "Return", shouldReturn);
      if (decided._tag === "Keep") {
        // Issue #186: a run that parked its own work keeps its item, whatever HEAD names.
        const reason = f._tag === "NoBaseline" ? "noBaseline" : f.parking._tag === "ParkedByRun" ? "parkedWork" : f.head !== f.startCommit ? "committed" : "parkedWork";
        assert.equal(decided.reason, reason);
      }
    }),
    { numRuns: 200, seed: 20261029 },
  );
});

test("the cases by example", () => {
  assert.deepEqual(itemReturnOf({ _tag: "NoBaseline" }), { _tag: "Keep", reason: "noBaseline" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: "a", head: "b", parking: { _tag: "NotParked" } }), { _tag: "Keep", reason: "committed" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: null, head: null, parking: { _tag: "NotParked" } }), { _tag: "Return" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: null, head: "b", parking: { _tag: "NotParked" } }), { _tag: "Keep", reason: "committed" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: "a", head: "a", parking: { _tag: "ParkingClaimed" } }), { _tag: "Keep", reason: "parkedWork" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: "a", head: "a", parking: { _tag: "NotParked" } }), { _tag: "Return" });
  // Issue #186: parked.json exists (the run's own send-back or guard stop), whatever was parked.
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: "a", head: "a", parking: { _tag: "ParkedByRun" } }), { _tag: "Keep", reason: "parkedWork" });
  assert.deepEqual(itemReturnOf({ _tag: "Baseline", startCommit: "a", head: "b", parking: { _tag: "ParkedByRun" } }), { _tag: "Keep", reason: "parkedWork" });
});
