// Issue #196 (S7): the queue edits a page sent and the server has not acknowledged.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { applyQueueEdit, type ChainQueue, EMPTY_QUEUE, type QueueChange, type QueueEdit } from "../../src/chainQueue.ts";
import type { ItemId } from "../../src/tracker.ts";
import { afterServer, newEdit, NO_PENDING_EDITS, shownQueue } from "./queuePending.ts";

const RUNS = { numRuns: 100, seed: 20261102 };
const arbItem = fc.constantFrom("1", "2", "3", "4").map((i) => i as ItemId);
const arbChange: fc.Arbitrary<QueueChange> = fc.oneof(
  arbItem.map((item): QueueChange => ({ _tag: "Add", item, title: `t${item}` })),
  arbItem.map((item): QueueChange => ({ _tag: "Remove", item })),
  fc.tuple(arbItem, fc.option(arbItem, { nil: null })).map(([item, before]): QueueChange => ({ _tag: "Move", item, before })),
  fc.constantFrom("backlog" as const, "queue" as const).map((source): QueueChange => ({ _tag: "Source", source })),
);
const edits = (page: string) => fc.array(arbChange, { maxLength: 8 }).map((changes) => changes.map((c, n) => newEdit(page, n + 1, c)));
const applyAll = (queue: ChainQueue, list: readonly QueueEdit[]) => list.reduce(applyQueueEdit, queue);

describe("queue pending", () => {
  test("once the server applied every edit, the page shows the server's queue and nothing is pending", () =>
    fc.assert(
      fc.property(edits("a"), edits("b"), (mine, theirs) => {
        const server = applyAll(applyAll(EMPTY_QUEUE, theirs), mine);
        const pending = afterServer(mine, server);
        expect(pending).toEqual([]);
        expect(shownQueue(server, pending)).toEqual(server);
      }),
      RUNS,
    ));

  test("before the server answers, the page shows its own edits over the server's queue; an edit already applied shows once", () =>
    fc.assert(
      fc.property(edits("b"), edits("a"), (theirs, mine) => {
        const server = applyAll(EMPTY_QUEUE, theirs);
        expect(shownQueue(server, mine)).toEqual(applyAll(server, mine));
        const partly = applyAll(server, mine.slice(0, 1));
        expect(shownQueue(partly, afterServer(mine, partly))).toEqual(applyAll(server, mine));
      }),
      RUNS,
    ));

  test("an Add applied by the server and still pending shows the item once", () => {
    const add = newEdit("a", 1, { _tag: "Add", item: "3" as ItemId, title: "three" });
    const server = applyQueueEdit(EMPTY_QUEUE, add);
    expect(shownQueue(server, [add]).entries).toEqual([{ item: "3", title: "three" }]);
    expect(afterServer([add], server)).toEqual(NO_PENDING_EDITS);
  });

  test("new edits of two pages have distinct ids", () => {
    expect(newEdit("a", 1, { _tag: "Source", source: "queue" }).id).not.toBe(newEdit("b", 1, { _tag: "Source", source: "queue" }).id);
    expect(newEdit("a", 1, { _tag: "Source", source: "queue" }).id).toBe("a:1");
  });
});
