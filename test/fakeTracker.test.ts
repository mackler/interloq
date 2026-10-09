import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { readRefinement, refinementOf } from "../src/refinement.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { type FakeItem, makeFakeTracker } from "./fakeTracker.ts";

// Issue #120, part 1: the tracker in memory that the later tasks' tests use.
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));
const ITEMS: readonly FakeItem[] = [
  { id: id("1"), title: "one", body: "first", state: "unrefined", open: true },
  { id: id("2"), title: "two", body: "", state: "refined", open: true },
  { id: id("3"), title: "three", body: "closed", state: "unrefined", open: false },
  { id: id("4"), title: "four", body: "", state: "unrefined", open: true },
];
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

test("a listing holds the open items of that state, in their order", async () => {
  const { tracker } = await run(makeFakeTracker(ITEMS));
  assert.deepEqual((await run(tracker.list("unrefined"))).map((i) => i.id), ["1", "4"]);
  assert.deepEqual((await run(tracker.list("refined"))).map((i) => i.id), ["2"]);
  assert.deepEqual(await run(tracker.list("deployed")), []);
});

test("read gives an item, open or closed, and an unknown id is TrackerItemNotFound", async () => {
  const { tracker } = await run(makeFakeTracker(ITEMS));
  assert.equal((await run(tracker.read(id("3")))).title, "three");
  const missing = await run(Effect.flip(tracker.read(id("99"))));
  assert.equal(missing._tag, "TrackerItemNotFound");
});

test("a refinement written twice reads back once, and the developer's text stays", async () => {
  const { tracker, items } = await run(makeFakeTracker(ITEMS));
  await run(tracker.writeRefinement(id("1"), Result.getOrThrow(refinementOf("old"))));
  await run(tracker.writeRefinement(id("1"), Result.getOrThrow(refinementOf("new"))));
  const body = (await run(items)).find((i) => i.id === "1")?.body ?? "";
  assert.deepEqual(Result.getOrThrow(readRefinement(body)), Option.some("new"));
  assert.ok(body.startsWith("first"));
  assert.ok(!body.includes("old"));
});

test("a state change moves the item between lists", async () => {
  const { tracker } = await run(makeFakeTracker(ITEMS));
  await run(tracker.setState(id("1"), "implementing"));
  assert.deepEqual((await run(tracker.list("unrefined"))).map((i) => i.id), ["4"]);
  assert.deepEqual((await run(tracker.list("implementing"))).map((i) => i.id), ["1"]);
});

test("a scripted failure fails the next call of that operation alone", async () => {
  const { tracker, failNext } = await run(makeFakeTracker(ITEMS));
  await run(failNext("list", new TrackerUnreachable({ tracker: "fake", message: "down" })));
  assert.equal((await run(Effect.flip(tracker.list("unrefined"))))._tag, "TrackerUnreachable");
  assert.equal((await run(tracker.list("unrefined"))).length, 2);
  assert.equal((await run(tracker.read(id("1")))).id, "1");
});
