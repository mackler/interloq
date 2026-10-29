import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { EMPTY_SLOT, endedIn, refusalOf, reserved, runsOf, type Slot } from "../src/runSlots.ts";
import { refinementInProgressText, runInProgressText } from "../src/prompts.ts";
import type { RunMode } from "../src/runMode.ts";

// Issue #191: any number of refinement runs, each of a different item; one implementation run at a time.
type R = Readonly<{ id: number; item: string; ended: boolean }>;
type Op = Readonly<{ _tag: "start"; item: string }> | Readonly<{ _tag: "end"; pick: number }>;
const ITEMS = ["1", "2", "3", "4", "5"];
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.constantFrom(...ITEMS).map((item): Op => ({ _tag: "start", item })),
  fc.nat().map((pick): Op => ({ _tag: "end", pick })),
);
const mode = fc.constantFrom<RunMode>("refinement", "implementation");

/** Applies the operations as the manager does: a start refused or reserved, an end of one run in progress. */
const apply = (m: RunMode, ops: readonly Op[], check: (before: Slot<R>, o: Op, after: Slot<R>, refusal: string | null) => void): Slot<R> => {
  let slot: Slot<R> = EMPTY_SLOT;
  let next = 1;
  for (const o of ops) {
    const before = slot;
    let refusal: string | null = null;
    if (o._tag === "start") {
      refusal = refusalOf(m, slot, o.item);
      if (refusal === null) slot = reserved(m, slot, { id: next++, item: o.item, ended: false });
    } else if (slot.current.length > 0) {
      const run = slot.current[o.pick % slot.current.length]!;
      slot = endedIn(m, slot, run.id, (r) => ({ ...r, ended: true }));
    }
    check(before, o, slot, refusal);
  }
  return slot;
};

test("refinement: a start is refused exactly when a run in progress has its item, whatever the count", () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
      apply("refinement", ops, (before, o, _after, refusal) => {
        if (o._tag !== "start") return;
        const busy = before.current.some((r) => r.item === o.item);
        assert.equal(refusal, busy ? refinementInProgressText(o.item) : null);
      });
    }),
  );
});

test("implementation: a start is refused exactly when a run is in progress, and each list holds at most one run", () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
      apply("implementation", ops, (before, o, after, refusal) => {
        if (o._tag === "start") assert.equal(refusal, before.current.length > 0 ? runInProgressText("implementation") : null);
        assert.ok(after.current.length <= 1 && after.last.length <= 1);
      });
    }),
  );
});

test("refinement: the ended runs hold one run per item, and none of an item just reserved", () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
      apply("refinement", ops, (_before, o, after, refusal) => {
        const items = after.last.map((r) => r.item);
        assert.equal(new Set(items).size, items.length);
        if (o._tag === "start" && refusal === null) assert.ok(!items.includes(o.item));
      });
    }),
  );
});

test("an ended run leaves the runs in progress for the ended ones; an unknown id changes nothing", () => {
  fc.assert(
    fc.property(mode, fc.array(op, { maxLength: 40 }), fc.integer({ min: 1000 }), (m, ops, unknown) => {
      const slot = apply(m, ops, (before, o, after) => {
        if (o._tag !== "end" || before.current.length === 0) return;
        const id = before.current[o.pick % before.current.length]!.id;
        assert.ok(!after.current.some((r) => r.id === id));
        assert.ok(after.last.some((r) => r.id === id && r.ended));
      });
      assert.equal(endedIn(m, slot, unknown, (r) => r), slot);
    }),
  );
});

test("the runs in progress keep their start order, and runsOf holds every run", () => {
  fc.assert(
    fc.property(mode, fc.array(op, { maxLength: 40 }), (m, ops) => {
      const slot = apply(m, ops, () => undefined);
      const ids = slot.current.map((r) => r.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      assert.deepEqual(runsOf(slot).map((r) => r.id).sort((a, b) => a - b), [...slot.last, ...slot.current].map((r) => r.id).sort((a, b) => a - b));
      assert.equal(runsOf(slot).length, slot.last.length + slot.current.length);
    }),
  );
});

test("the task's case: refining item A, a start of B is admitted and a second start of A refused", () => {
  const a = reserved<R>("refinement", EMPTY_SLOT, { id: 1, item: "A", ended: false });
  assert.equal(refusalOf("refinement", a, "B"), null);
  const ab = reserved<R>("refinement", a, { id: 2, item: "B", ended: false });
  assert.deepEqual(ab.current.map((r) => r.id), [1, 2]);
  assert.equal(refusalOf("refinement", ab, "A"), refinementInProgressText("A"));
});

test("an implementation run that ends replaces the previous ended one", () => {
  const first = endedIn<R>("implementation", reserved("implementation", EMPTY_SLOT, { id: 1, item: "A", ended: false }), 1, (r) => ({ ...r, ended: true }));
  const second = endedIn("implementation", reserved("implementation", first, { id: 2, item: "B", ended: false }), 2, (r) => ({ ...r, ended: true }));
  assert.deepEqual(second, { current: [], last: [{ id: 2, item: "B", ended: true }] });
});
