import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { type FakeItem, makeFakeTracker, seededId } from "./fakeTracker.ts";

// Issue #186, requirements Q3: the tracker port's comment operations, over the fake tracker.
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));
const ITEMS: readonly FakeItem[] = [
  { id: id("1"), title: "one", body: "", state: "implementing", open: true, url: Option.none() },
  { id: id("2"), title: "two", body: "", state: "refined", open: true, url: Option.none(), comments: [{ id: seededId(), body: "earlier", created: "2026-10-01T00:00:00Z" }] },
];
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

test("a comment written is listed after the item's earlier comments, in order", async () => {
  const { tracker } = await run(makeFakeTracker(ITEMS));
  await run(tracker.comment(id("2"), "first"));
  await run(tracker.comment(id("2"), "second"));
  assert.deepEqual((await run(tracker.comments(id("2")))).map((c) => c.body), ["earlier", "first", "second"]);
  assert.deepEqual(await run(tracker.comments(id("1"))), []);
});

test("a comment on an unknown item, and its listing, are TrackerItemNotFound", async () => {
  const { tracker } = await run(makeFakeTracker(ITEMS));
  assert.equal((await run(Effect.flip(tracker.comment(id("99"), "x"))))._tag, "TrackerItemNotFound");
  assert.equal((await run(Effect.flip(tracker.comments(id("99")))))._tag, "TrackerItemNotFound");
});

test("a scripted failure of comment writes nothing; one after it writes and fails", async () => {
  const fake = await run(makeFakeTracker(ITEMS));
  const lost = new TrackerUnreachable({ tracker: "fake", message: "lost", status: null });
  await run(fake.failNext("comment", lost));
  assert.equal((await run(Effect.flip(fake.tracker.comment(id("1"), "a"))))._tag, "TrackerUnreachable");
  assert.deepEqual(await run(fake.tracker.comments(id("1"))), []);
  await run(fake.failAfterNext("comment", lost));
  assert.equal((await run(Effect.flip(fake.tracker.comment(id("1"), "b"))))._tag, "TrackerUnreachable");
  assert.deepEqual((await run(fake.tracker.comments(id("1")))).map((c) => c.body), ["b"]);
  await run(fake.failNext("comments", lost));
  assert.equal((await run(Effect.flip(fake.tracker.comments(id("1")))))._tag, "TrackerUnreachable");
});
