import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { EMPTY_SLOT, endedIn, refusalOf, reserved, runsOf, type Slot } from "../src/runSlots.ts";
import { refinementInProgressText, runInProgressText } from "../src/prompts.ts";
import type { RunMode } from "../src/runMode.ts";

// Issue #191: any number of refinement runs, each of a different item; one implementation run at a time.
// The properties compare the slot with a reference model built from those rules alone, with no call into
// src/runSlots.ts, so a reservation or an end that does nothing fails the comparison (W1-R1-2).
type R = Readonly<{ id: number; item: string; ended: boolean }>;
type Entry = Readonly<{ id: number; item: string }>;
type Model = Readonly<{ inProgress: readonly Entry[]; ended: readonly Entry[] }>;
type Op =
  | Readonly<{ _tag: "start"; item: string }>
  | Readonly<{ _tag: "end"; pick: number }>
  | Readonly<{ _tag: "endUnknown" }>;
const ITEMS = ["0", "1", "2", "3"];
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.constantFrom(...ITEMS).map((item): Op => ({ _tag: "start", item })),
  fc.nat().map((pick): Op => ({ _tag: "end", pick })),
  fc.constant<Op>({ _tag: "endUnknown" }),
);
const mode = fc.constantFrom<RunMode>("refinement", "implementation");
const EMPTY_MODEL: Model = { inProgress: [], ended: [] };

const modelRefusal = (m: RunMode, model: Model, item: string): string | null => {
  switch (m) {
    case "implementation":
      return model.inProgress.length > 0 ? runInProgressText("implementation") : null;
    case "refinement":
      return model.inProgress.some((e) => e.item === item) ? refinementInProgressText(item) : null;
  }
};

const modelStarted = (m: RunMode, model: Model, entry: Entry): Model => {
  switch (m) {
    case "implementation":
      return { inProgress: [entry], ended: model.ended };
    case "refinement":
      return { inProgress: [...model.inProgress, entry], ended: model.ended.filter((e) => e.item !== entry.item) };
  }
};

const modelEnded = (m: RunMode, model: Model, entry: Entry): Model => {
  const inProgress = model.inProgress.filter((e) => e.id !== entry.id);
  switch (m) {
    case "implementation":
      return { inProgress, ended: [entry] };
    case "refinement":
      return { inProgress, ended: [...model.ended.filter((e) => e.item !== entry.item), entry] };
  }
};

const entries = (runs: readonly R[]): readonly Entry[] => runs.map((r) => ({ id: r.id, item: r.item }));
const UNKNOWN_ID = 1_000_000;

/** Applies the operations to the slot and the model alike, comparing them after every operation. */
const drive = (m: RunMode, ops: readonly Op[]): Slot<R> => {
  let slot: Slot<R> = EMPTY_SLOT;
  let model = EMPTY_MODEL;
  let next = 1;
  for (const o of ops) {
    switch (o._tag) {
      case "start": {
        const expected = modelRefusal(m, model, o.item);
        assert.equal(refusalOf(m, slot, o.item), expected);
        if (expected === null) {
          const id = next++;
          slot = reserved(m, slot, { id, item: o.item, ended: false });
          model = modelStarted(m, model, { id, item: o.item });
        }
        break;
      }
      case "end": {
        if (model.inProgress.length === 0) break;
        const entry = model.inProgress[o.pick % model.inProgress.length]!;
        slot = endedIn(m, slot, entry.id, (r) => ({ ...r, ended: true }));
        model = modelEnded(m, model, entry);
        break;
      }
      case "endUnknown": {
        const before = slot;
        slot = endedIn(m, slot, UNKNOWN_ID, (r) => ({ ...r, ended: true }));
        assert.equal(slot, before);
        break;
      }
    }
    assert.deepEqual(entries(slot.current), model.inProgress);
    assert.deepEqual(entries(slot.last), model.ended);
    assert.ok(slot.current.every((r) => !r.ended) && slot.last.every((r) => r.ended));
    assert.deepEqual(entries(runsOf(slot)), [...model.ended, ...model.inProgress]);
  }
  return slot;
};

test("the slot follows the reference model after every start, end and end of an unknown id, in both modes", () => {
  fc.assert(fc.property(mode, fc.array(op, { maxLength: 40 }), (m, ops) => void drive(m, ops)));
});

test("refinement: starts of distinct items are never refused, whatever their number", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
      let slot: Slot<R> = EMPTY_SLOT;
      for (let i = 0; i < count; i++) {
        assert.equal(refusalOf("refinement", slot, `item-${i}`), null);
        slot = reserved("refinement", slot, { id: i + 1, item: `item-${i}`, ended: false });
      }
      assert.equal(slot.current.length, count);
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
