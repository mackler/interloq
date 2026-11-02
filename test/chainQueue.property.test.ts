// Issue #196 (S1): properties of the chain's queue (src/chainQueue.ts): edits by item, idempotent by id, composing
// across tabs, and the keyboard and drag helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import {
  applyQueueEdit,
  type ChainQueue,
  type EditId,
  editIdOf,
  EMPTY_QUEUE,
  moveDownChange,
  moveToChange,
  moveUpChange,
  QUEUE_APPLIED_KEPT,
  type QueueChange,
  type QueueEdit,
  type QueueEntry,
  withoutItem,
} from "../src/chainQueue.ts";
import type { ItemId } from "../src/tracker.ts";

const RUNS = { numRuns: 100, seed: 20261102 };
const ITEMS = ["1", "2", "3", "4", "5"] as const;
const id = (text: string): EditId => Result.getOrThrow(editIdOf(text));
const item = (text: string): ItemId => text as ItemId;
const arbItem = fc.constantFrom(...ITEMS).map(item);
const arbChange: fc.Arbitrary<QueueChange> = fc.oneof(
  arbItem.map((i): QueueChange => ({ _tag: "Add", item: i, title: `title ${i}` })),
  arbItem.map((i): QueueChange => ({ _tag: "Remove", item: i })),
  fc.tuple(arbItem, fc.option(arbItem, { nil: null })).map(([i, before]): QueueChange => ({ _tag: "Move", item: i, before })),
  fc.constantFrom("backlog" as const, "queue" as const).map((source): QueueChange => ({ _tag: "Source", source })),
);
/** Edits with distinct ids, each change arbitrary. */
const arbEdits = (max: number) => fc.array(arbChange, { maxLength: max }).map((changes) => changes.map((change, n): QueueEdit => ({ id: id(`e${n}`), change })));
const applyAll = (queue: ChainQueue, edits: readonly QueueEdit[]) => edits.reduce(applyQueueEdit, queue);
const order = (queue: ChainQueue) => queue.entries.map((e) => e.item);
const entriesOf = (items: readonly string[]): readonly QueueEntry[] => items.map((i) => ({ item: item(i), title: `title ${i}` }));
const queueOf = (items: readonly string[]): ChainQueue => ({ ...EMPTY_QUEUE, source: "queue", entries: entriesOf(items) });
const arbOrder = fc.shuffledSubarray([...ITEMS], { minLength: 1 });

test("an edit applied twice in a row is applied once", () =>
  fc.assert(
    fc.property(arbEdits(12), arbChange, (edits, change) => {
      const before = applyAll(EMPTY_QUEUE, edits);
      const edit: QueueEdit = { id: id("again"), change };
      const once = applyQueueEdit(before, edit);
      assert.deepEqual(applyQueueEdit(once, edit), once);
    }),
    RUNS,
  ));

test("an edit applied again after other edits, while its id is kept, changes nothing", () =>
  fc.assert(
    fc.property(arbEdits(8), arbChange, arbEdits(8), fc.option(arbItem, { nil: null }), (first, change, later, consumed) => {
      const edit: QueueEdit = { id: id("again"), change };
      const others = later.map((e) => ({ ...e, id: id(`later-${e.id}`) }));
      const after = applyAll(applyQueueEdit(applyAll(EMPTY_QUEUE, first), edit), others);
      const between = consumed === null ? after : withoutItem(after, consumed);
      assert.deepEqual(applyQueueEdit(between, edit), between);
    }),
    RUNS,
  ));

test("no sequence of edits queues an item twice", () =>
  fc.assert(
    fc.property(arbEdits(30), (edits) => {
      const items = order(applyAll(EMPTY_QUEUE, edits));
      assert.equal(new Set(items).size, items.length);
    }),
    RUNS,
  ));

test("an item added that was not queued is last", () =>
  fc.assert(
    fc.property(arbEdits(12), arbItem, (edits, i) => {
      const before = applyAll(EMPTY_QUEUE, edits);
      fc.pre(!order(before).includes(i));
      const after = applyQueueEdit(before, { id: id("add"), change: { _tag: "Add", item: i, title: "t" } });
      assert.deepEqual(order(after), [...order(before), i]);
    }),
    RUNS,
  ));

test("two tabs' Adds of distinct items both end in the queue, in either order", () =>
  fc.assert(
    fc.property(arbEdits(10), fc.uniqueArray(arbItem, { minLength: 2, maxLength: 2 }), (edits, [a, b]) => {
      const before = applyAll(EMPTY_QUEUE, edits);
      const ea: QueueEdit = { id: id("tab-a:1"), change: { _tag: "Add", item: a as ItemId, title: "a" } };
      const eb: QueueEdit = { id: id("tab-b:1"), change: { _tag: "Add", item: b as ItemId, title: "b" } };
      for (const q of [applyAll(before, [ea, eb]), applyAll(before, [eb, ea])]) {
        assert.ok(order(q).includes(a as ItemId));
        assert.ok(order(q).includes(b as ItemId));
      }
    }),
    RUNS,
  ));

test("one tab's Remove and another tab's Move of another item both take effect, in either order", () =>
  fc.assert(
    fc.property(arbOrder, fc.nat(), fc.nat(), (items, r, m) => {
      fc.pre(items.length >= 2);
      const removed = item(items[r % items.length] as string);
      const rest = items.filter((i) => i !== removed);
      const moved = item(rest[m % rest.length] as string);
      const start = queueOf(items);
      const er: QueueEdit = { id: id("tab-a:1"), change: { _tag: "Remove", item: removed } };
      const em: QueueEdit = { id: id("tab-b:1"), change: { _tag: "Move", item: moved, before: null } };
      for (const q of [applyAll(start, [er, em]), applyAll(start, [em, er])]) {
        assert.ok(!order(q).includes(removed));
        assert.equal(order(q).at(-1), moved);
        assert.equal(q.entries.length, items.length - 1);
      }
    }),
    RUNS,
  ));

test("applied keeps at most the last ids and ends with the last new edit's id", () =>
  fc.assert(
    fc.property(arbEdits(150), (edits) => {
      fc.pre(edits.length > 0);
      const q = applyAll(EMPTY_QUEUE, edits);
      assert.ok(q.applied.length <= QUEUE_APPLIED_KEPT);
      assert.equal(q.applied.at(-1), edits.at(-1)?.id);
    }),
    RUNS,
  ));

test("withoutItem removes the item and records no id", () =>
  fc.assert(
    fc.property(arbOrder, arbItem, (items, i) => {
      const q = applyQueueEdit(queueOf(items), { id: id("x"), change: { _tag: "Source", source: "queue" } });
      const after = withoutItem(q, i);
      assert.deepEqual(order(after), order(q).filter((x) => x !== i));
      assert.deepEqual(after.applied, q.applied);
    }),
    RUNS,
  ));

const swapped = (items: readonly string[], a: number, b: number) => items.map((x, n) => (n === a ? items[b] : n === b ? items[a] : x));
const apply = (items: readonly string[], change: QueueChange | null) => (change === null ? null : order(applyQueueEdit(queueOf(items), { id: id("m"), change })));

test("Move up and Move down swap an item with its neighbor, and are null at the ends", () =>
  fc.assert(
    fc.property(arbOrder, fc.nat(), (items, n) => {
      const at = n % items.length;
      const it = item(items[at] as string);
      const up = moveUpChange(entriesOf(items), it);
      const down = moveDownChange(entriesOf(items), it);
      assert.deepEqual(apply(items, up), at === 0 ? null : swapped(items, at, at - 1));
      assert.deepEqual(apply(items, down), at === items.length - 1 ? null : swapped(items, at, at + 1));
    }),
    RUNS,
  ));

test("moveToChange puts an item at the index it is dropped at, and is null where it would not move", () =>
  fc.assert(
    fc.property(arbOrder, fc.nat(), fc.nat(), (items, n, t) => {
      const at = n % items.length;
      const to = t % items.length;
      const it = items[at] as string;
      const expected: string[] = items.filter((x) => x !== it);
      expected.splice(to, 0, it);
      assert.deepEqual(apply(items, moveToChange(entriesOf(items), item(it), to)), to === at ? null : expected);
    }),
    RUNS,
  ));

test("an absent item moves nowhere and a Move before itself or an absent item changes nothing", () => {
  const q = queueOf(["1", "2", "3"]);
  for (const change of [
    { _tag: "Move", item: item("9"), before: null },
    { _tag: "Move", item: item("2"), before: item("2") },
    { _tag: "Move", item: item("2"), before: item("9") },
    { _tag: "Remove", item: item("9") },
  ] as const) assert.deepEqual(order(applyQueueEdit(q, { id: id("c"), change })), ["1", "2", "3"]);
  assert.equal(moveUpChange(entriesOf(["1"]), item("9")), null);
});

test("editIdOf refuses a blank id", () => {
  assert.ok(Result.isFailure(editIdOf("")));
  assert.ok(Result.isFailure(editIdOf(" \t")));
  assert.ok(Result.isSuccess(editIdOf("page:1")));
});
