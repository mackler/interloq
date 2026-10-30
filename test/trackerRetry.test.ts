// Issue #171 (S9): a tracker request that reached no answer, or that the tracker answered with a server error, is
// repeated with backoff; a write answered with a server error is read back first; when the repeats run out the
// developer is asked Retry again or Stop. Over the fake tracker, with the first read's environment (heldTrackerEnv,
// whose records are held and whose question has no offer) and, once, the run's (runTrackerEnv, over testLayer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Option, Ref, Result } from "effect";
import { FileSystemError, TrackerAuthRefused, TrackerRequestRefused, TrackerUnreachable } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { OPENING_LINE, readRefinement, refinementOf } from "../src/refinement.ts";
import * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import type { CommentId, ItemId } from "../src/tracker.ts";
import { commentKeyOf, commentText } from "../src/itemComments.ts";
import { heldTrackerEnv, unattendedTrackerEnv, readCommentsWithRetry, readWithRetry, runTrackerEnv, type TrackerWrite, TrackerWriteFailed, writeWithRetry } from "../src/trackerRetry.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { makeFakeTracker, type FakeItem } from "./fakeTracker.ts";
import { ScriptedUi, tempRepo, testLayer } from "./helpers.ts";

const ID = "155" as ItemId;
const ITEM: FakeItem = { id: ID, title: "t", body: "the developer's text", state: "unrefined", open: true, url: Option.none() };
const unreached = () => new TrackerUnreachable({ tracker: "GitHub", message: "the request GET 155 reached no answer from GitHub", status: null });
const serverError = () => new TrackerUnreachable({ tracker: "GitHub", message: "GitHub answered PATCH 155 with status 500", status: 500 });
const refinement = Result.getOrThrow(refinementOf("the requirements"));
const writeRefinement: TrackerWrite = { kind: "writeRefinement", item: ID, refinement };
const setRefined: TrackerWrite = { kind: "setState", item: ID, state: "refined" };

const setup = async (answers: readonly string[] = [], retries = 2, delay = 0.01) => {
  const fake = await Effect.runPromise(makeFakeTracker([ITEM]));
  const ui = new ScriptedUi(answers);
  const held = Effect.runSync(Ref.make<readonly string[]>([]));
  const env = heldTrackerEnv(ui, { ...S.defaultConfig, maxTrackerRetries: retries, trackerRetryDelaySeconds: delay }, held);
  const failNext = (op: "read" | "writeRefinement" | "setState", error: TrackerUnreachable | TrackerAuthRefused | TrackerRequestRefused, times = 1) =>
    Effect.runPromise(Effect.forEach(Array.from({ length: times }), () => fake.failNext(op, error), { discard: true }));
  const item = async () => (await Effect.runPromise(fake.items))[0]!;
  return { fake, ui, env, held: () => Effect.runSync(Ref.get(held)), failNext, item };
};
const tagged = (events: readonly UiEvent[], tag: UiEvent["_tag"]) => events.filter((e) => e._tag === tag);
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};

test("a read that reached no answer twice is repeated and returns the item, each wait notified and recorded", async () => {
  const t = await setup();
  await t.failNext("read", unreached(), 2);
  const item = await Effect.runPromise(readWithRetry(t.fake.tracker, ID, t.env));
  assert.equal(item.id, ID);
  const retrying = tagged(t.ui.notified, "TrackerRetrying");
  assert.deepEqual(retrying.map((e) => e._tag === "TrackerRetrying" && [e.attempt, e.of, e.tracker, e.what]), [[1, 2, "GitHub", "reading item 155"], [2, 2, "GitHub", "reading item 155"]]);
  assert.deepEqual(retrying.map((e) => e._tag === "TrackerRetrying" && e.delaySeconds), [0.01, 0.02]);
  assert.equal(tagged(t.ui.notified, "TrackerRecovered").length, 1);
  assert.equal(t.held().filter((r) => r.includes("retry")).length, 2);
  assert.equal(t.ui.said.filter((r) => r.includes("retry")).length, 2);
  assert.deepEqual(t.ui.asked, []);
});

test("a refused credential and a refused request are not repeated: no wait, no question", async () => {
  for (const error of [new TrackerAuthRefused({ tracker: "GitHub", status: 401 }), new TrackerRequestRefused({ tracker: "GitHub", status: 422, message: "m" })]) {
    const t = await setup();
    await t.failNext("read", error);
    assert.equal(failureOf(await Effect.runPromiseExit(readWithRetry(t.fake.tracker, ID, t.env)))._tag, error._tag);
    await t.failNext("setState", error);
    const failed: unknown = failureOf(await Effect.runPromiseExit(writeWithRetry(t.fake.tracker, setRefined, t.env)));
    assert.ok(failed instanceof TrackerWriteFailed);
    assert.equal(failed.error._tag, error._tag);
    assert.deepEqual(failed.check, { kind: "unchecked" });
    assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying"), []);
    assert.deepEqual(t.ui.asked, []);
  }
});

test("a write of the requirements answered 500 before it applied is read back, repeated, and leaves exactly one section", async () => {
  const t = await setup();
  await t.failNext("writeRefinement", serverError());
  await Effect.runPromise(writeWithRetry(t.fake.tracker, writeRefinement, t.env));
  const body = (await t.item()).body;
  assert.deepEqual(Result.getOrThrow(readRefinement(body)), Option.some(refinement));
  assert.equal(body.split(OPENING_LINE).length - 1, 1);
  assert.equal(tagged(t.ui.notified, "TrackerRetrying").length, 1);
});

test("a write answered 500 after it applied is found by the read-back: no repeat, no question, the landed line recorded", async () => {
  for (const write of [writeRefinement, setRefined]) {
    const t = await setup();
    await Effect.runPromise(t.fake.failAfterNext(write.kind, serverError()));
    await Effect.runPromise(writeWithRetry(t.fake.tracker, write, t.env));
    assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying"), []);
    assert.equal(tagged(t.ui.notified, "TrackerRecovered").length, 1);
    assert.deepEqual(t.ui.asked, []);
    const line = prompts.trackerWriteLandedLine("GitHub", prompts.trackerOperationText(write));
    assert.ok(t.held().some((r) => r.includes(line)));
    assert.ok(t.ui.said.includes(line));
  }
  const t = await setup();
  await Effect.runPromise(t.fake.failAfterNext("setState", serverError()));
  await Effect.runPromise(writeWithRetry(t.fake.tracker, setRefined, t.env));
  assert.equal((await t.item()).state, "refined");
});

test("a read-back that fails counts as the write failing, which is repeated", async () => {
  const t = await setup();
  await t.failNext("setState", serverError());
  await t.failNext("read", unreached());
  await Effect.runPromise(writeWithRetry(t.fake.tracker, setRefined, t.env));
  assert.equal((await t.item()).state, "refined");
  assert.equal(tagged(t.ui.notified, "TrackerRetrying").length, 1);
});

test("when the repeats are used up the question is asked once, without the offer; Stop fails with the last failure", async () => {
  const t = await setup(["s"], 1);
  await t.failNext("read", unreached(), 2);
  const error = failureOf(await Effect.runPromiseExit(readWithRetry(t.fake.tracker, ID, t.env)));
  assert.equal(error._tag, "TrackerUnreachable");
  assert.deepEqual(t.ui.asked, [prompts.transportPrompt]);
  const presented = tagged(t.ui.notified, "QuestionPresented");
  assert.equal(presented.length, 1);
  const origin = presented[0]?._tag === "QuestionPresented" ? presented[0].question.origin : null;
  assert.deepEqual(origin, { kind: "tracker", tracker: "GitHub", what: "reading item 155", attempts: 2, fault: unreached().message });
  assert.ok(t.held().some((r) => r.includes(prompts.trackerDecisionLine("stop", "GitHub", "reading item 155"))));
});

test("Stop after a write: the check says what the item held after a read-back, or that it could not be checked after no answer", async () => {
  const held = await setup(["s"], 1);
  await held.failNext("setState", serverError(), 2);
  const a = failureOf(await Effect.runPromiseExit(writeWithRetry(held.fake.tracker, setRefined, held.env)));
  assert.deepEqual(a._tag === "TrackerWriteFailed" && a.check, { kind: "held", held: { kind: "state", state: "unrefined" } });
  const unchecked = await setup(["s"], 1);
  await unchecked.failNext("writeRefinement", unreached(), 2);
  const b = failureOf(await Effect.runPromiseExit(writeWithRetry(unchecked.fake.tracker, writeRefinement, unchecked.env)));
  assert.deepEqual(b._tag === "TrackerWriteFailed" && b.check, { kind: "unchecked" });
  assert.ok(b._tag === "TrackerWriteFailed" && b.error._tag === "TrackerUnreachable");
});

test("Retry again makes a full new set of repeats, numbered from 1, and the request then succeeds", async () => {
  const t = await setup(["r"], 2);
  await t.failNext("read", unreached(), 4);
  const item = await Effect.runPromise(readWithRetry(t.fake.tracker, ID, t.env));
  assert.equal(item.id, ID);
  assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying").map((e) => e._tag === "TrackerRetrying" && e.attempt), [1, 2, 1]);
  assert.equal(t.ui.asked.length, 1);
  assert.ok(t.held().some((r) => r.includes(prompts.trackerDecisionLine("retry", "GitHub", "reading item 155"))));
});

test("an interruption during a wait interrupts the request", async () => {
  const t = await setup([], 2, 60);
  await t.failNext("read", unreached());
  const fiber = Effect.runFork(readWithRetry(t.fake.tracker, ID, t.env));
  for (let waited = 0; tagged(t.ui.notified, "TrackerRetrying").length === 0 && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tagged(t.ui.notified, "TrackerRetrying").length, 1, "the wait never began");
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
});

test("in a run, the question carries the offer of decision support and the records go to conversation.md", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, { answers: ["s"], config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 } });
  const fake = await Effect.runPromise(makeFakeTracker([ITEM]));
  await Effect.runPromise(Effect.forEach([1, 2], () => fake.failNext("read", unreached()), { discard: true }));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* (yield* Store).init("task");
      return yield* readWithRetry(fake.tracker, ID, yield* runTrackerEnv);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(failureOf(exit)._tag, "TrackerUnreachable");
  assert.deepEqual(probe.ui.asked, [prompts.withOffer(prompts.transportPrompt)]);
  const fs = await import("node:fs");
  const conversation = fs.readFileSync(`${probe.dir}/conversation.md`, "utf8");
  assert.ok(conversation.includes("retry 1 of 1"));
  assert.ok(conversation.includes(prompts.trackerDecisionLine("stop", "GitHub", "reading item 155")));
});

// ---- issue #186: a comment write, reconciled by its key ----------------------------------------------------------------
const commentWrite = (key: string, text = "sent back"): TrackerWrite => ({ kind: "comment", item: ID, text: commentText({ _tag: "SentBack", key: Result.getOrThrow(commentKeyOf(key)), date: "2026-10-29", missing: text }), key });
/** The fake tracker with its comment POSTs counted. */
const counting = (t: Awaited<ReturnType<typeof setup>>) => {
  let posts = 0;
  let lists = 0;
  const tracker = { ...t.fake.tracker, comment: (id: ItemId, text: string) => Effect.suspend(() => { posts += 1; return t.fake.tracker.comment(id, text); }), comments: (id: ItemId) => Effect.suspend(() => { lists += 1; return t.fake.tracker.comments(id); }) };
  return { tracker, posts: () => posts, lists: () => lists, stored: async () => (await t.item()).comments ?? [] };
};

test("a comment applied and then answered 500 is counted done with no second POST", async () => {
  const t = await setup();
  const c = counting(t);
  await Effect.runPromise(t.fake.failAfterNext("comment", serverError()));
  await Effect.runPromise(writeWithRetry(c.tracker, commentWrite("r/verdict-1"), t.env));
  assert.equal(c.posts(), 1);
  assert.equal((await c.stored()).length, 1);
});

test("a comment applied whose response was lost is counted done with no second POST", async () => {
  const t = await setup();
  const c = counting(t);
  await Effect.runPromise(t.fake.failAfterNext("comment", unreached()));
  await Effect.runPromise(writeWithRetry(c.tracker, commentWrite("r/verdict-1"), t.env));
  assert.equal(c.posts(), 1);
  assert.equal((await c.stored()).length, 1);
});

test("a lost comment response whose first listing fails and second succeeds: one POST, one stored comment", async () => {
  const t = await setup();
  const c = counting(t);
  await Effect.runPromise(t.fake.failAfterNext("comment", unreached()));
  await Effect.runPromise(t.fake.failNext("comments", unreached()));
  await Effect.runPromise(writeWithRetry(c.tracker, commentWrite("r/verdict-1"), t.env));
  assert.equal(c.posts(), 1);
  assert.equal(c.lists(), 2);
  assert.equal((await c.stored()).length, 1);
});

test("a comment not applied is POSTed again only after a listing without its key", async () => {
  const t = await setup();
  const c = counting(t);
  await Effect.runPromise(t.fake.failNext("comment", unreached()));
  await Effect.runPromise(writeWithRetry(c.tracker, commentWrite("r/verdict-1"), t.env));
  assert.equal(c.posts(), 2);
  assert.equal(c.lists(), 1);
  assert.equal((await c.stored()).length, 1);
});

test("two writes with the same text and different keys leave two comments", async () => {
  const t = await setup();
  await Effect.runPromise(writeWithRetry(t.fake.tracker, commentWrite("r/verdict-1"), t.env));
  await Effect.runPromise(writeWithRetry(t.fake.tracker, commentWrite("s/verdict-1"), t.env));
  assert.equal(((await t.item()).comments ?? []).length, 2);
});

test("the repeats used up while reconciling, then Retry again, lists again and does not POST", async () => {
  const t = await setup(["r"], 1);
  const c = counting(t);
  await Effect.runPromise(t.fake.failAfterNext("comment", unreached()));
  await Effect.runPromise(t.fake.failNext("comments", unreached()));
  await Effect.runPromise(t.fake.failNext("comments", unreached()));
  await Effect.runPromise(writeWithRetry(c.tracker, commentWrite("r/verdict-1"), t.env));
  assert.equal(t.ui.asked.length, 1);
  assert.equal(c.posts(), 1);
  assert.equal(c.lists(), 3);
  assert.equal((await c.stored()).length, 1);
});

test("the comments' listing is repeated after TrackerUnreachable", async () => {
  const t = await setup();
  await Effect.runPromise(writeWithRetry(t.fake.tracker, commentWrite("r/verdict-1"), t.env));
  await Effect.runPromise(t.fake.failNext("comments", unreached()));
  const comments = await Effect.runPromise(readCommentsWithRetry(t.fake.tracker, ID, t.env));
  assert.equal(comments.length, 1);
  assert.equal(tagged(t.ui.notified, "TrackerRetrying").length, 1);
});

// Issue #185 (G-R1-1): after an abandonment the developer is away, so the repeats end with no question and no decision.
test("an unattended environment makes every repeat, asks nothing, records the last failure and fails with the check", async () => {
  const t = await setup([], 1);
  const env = unattendedTrackerEnv(t.env);
  await t.failNext("setState", serverError(), 2);
  await t.failNext("read", unreached(), 2);
  const failed: unknown = failureOf(await Effect.runPromiseExit(writeWithRetry(t.fake.tracker, setRefined, env)));
  assert.ok(failed instanceof TrackerWriteFailed);
  assert.equal(failed.error.message, serverError().message);
  assert.deepEqual(failed.check, { kind: "unchecked" });
  assert.deepEqual(t.ui.asked, []);
  const exhausted = prompts.trackerRepeatsExhaustedLine("GitHub", prompts.trackerOperationText(setRefined), 2, serverError().message);
  assert.ok(t.held().some((r) => r.includes(exhausted)), t.held().join("|"));
  assert.ok(t.ui.said.includes(exhausted));
  assert.ok(!t.held().some((r) => r.includes("**User decision:**")));
});

test("the run's environment still asks when the repeats are used up", async () => {
  const t = await setup(["s"], 1);
  await t.failNext("setState", unreached(), 2);
  failureOf(await Effect.runPromiseExit(writeWithRetry(t.fake.tracker, setRefined, t.env)));
  assert.equal(t.ui.asked.length, 1);
});

// Work review 2 of issue #185 (W2-R1-1): a record write that fails never cuts the unattended repeats short.
const failingRecord = () => Effect.fail(new FileSystemError({ operation: "append", path: "conversation.md", message: "disk full" }));

test("an unattended environment whose record write fails still repeats a write and succeeds", async () => {
  const t = await setup([], 2);
  const env = unattendedTrackerEnv({ ...t.env, record: failingRecord });
  await t.failNext("setState", unreached());
  const attempts = { n: 0 };
  const tracker = { ...t.fake.tracker, setState: (...args: Parameters<typeof t.fake.tracker.setState>) => Effect.andThen(Effect.sync(() => attempts.n++), t.fake.tracker.setState(...args)) };
  await Effect.runPromise(writeWithRetry(tracker, setRefined, env));
  assert.equal(attempts.n, 2);
  assert.equal((await t.item()).state, "refined");
});

test("an unattended environment whose record write fails ends with the tracker's last failure, not the record's", async () => {
  const t = await setup([], 1);
  const env = unattendedTrackerEnv({ ...t.env, record: failingRecord });
  await t.failNext("setState", unreached(), 2);
  await t.failNext("read", unreached(), 2);
  const failed: unknown = failureOf(await Effect.runPromiseExit(writeWithRetry(t.fake.tracker, setRefined, env)));
  assert.ok(failed instanceof TrackerWriteFailed, String(failed));
  assert.equal(failed.error.message, unreached().message);
});

// Issue #131: a deletion of Interloq's own comment, idempotent, so a server error is settled by a listing of the comments.
const deleting = async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.tracker.comment(ID, "prepared"));
  const [comment] = (await t.item()).comments ?? [];
  let deletes = 0;
  const tracker = { ...t.fake.tracker, deleteComment: (id: ItemId, c: CommentId) => Effect.suspend(() => { deletes += 1; return t.fake.tracker.deleteComment(id, c); }) };
  const write: TrackerWrite = { kind: "deleteComment", item: ID, comment: comment!.id };
  return { t, tracker, write, deletes: () => deletes };
};
test("a deletion that reached no answer is repeated and succeeds", async () => {
  const d = await deleting();
  await Effect.runPromise(d.t.fake.failNext("deleteComment", unreached()));
  await Effect.runPromise(writeWithRetry(d.tracker, d.write, d.t.env));
  assert.equal(d.deletes(), 2);
  assert.deepEqual((await d.t.item()).comments, []);
});
test("a deletion applied and then answered 500 is read back and counted done with no second DELETE", async () => {
  const d = await deleting();
  await Effect.runPromise(d.t.fake.failAfterNext("deleteComment", serverError()));
  await Effect.runPromise(writeWithRetry(d.tracker, d.write, d.t.env));
  assert.equal(d.deletes(), 1);
  assert.deepEqual((await d.t.item()).comments, []);
});
test("a deletion whose repeats are used up in the unattended environment asks nothing and fails with TrackerWriteFailed", async () => {
  const d = await deleting();
  await Effect.runPromise(Effect.forEach([1, 2, 3], () => d.t.fake.failNext("deleteComment", unreached()), { discard: true }));
  const exit = await Effect.runPromiseExit(writeWithRetry(d.tracker, d.write, unattendedTrackerEnv(d.t.env)));
  assert.ok(failureOf(exit) instanceof TrackerWriteFailed);
  assert.equal(d.t.ui.asked.length, 0);
});
