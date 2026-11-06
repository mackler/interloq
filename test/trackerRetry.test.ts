// Issue #171 (S9): a tracker request that reached no answer, or that the tracker answered with a server error, is
// repeated with backoff; a write answered with a server error is read back first; when the repeats run out the
// developer is asked Retry again or Stop. Over the fake tracker, with the first read's environment (heldTrackerEnv,
// whose records are held and whose question has no offer) and, once, the run's (runTrackerEnv, over testLayer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Clock, Effect, Exit, Fiber, Option, Ref, Result } from "effect";
import { USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";
import type { RunEvent } from "../src/protocol.ts";
import { makeWebUi } from "../src/webUi.ts";
import { FileSystemError, TrackerAuthRefused, TrackerRateLimited, TrackerRequestRefused, TrackerUnreachable } from "../src/errors.ts";
import type { TrackerError } from "../src/services.ts";
import * as prompts from "../src/prompts.ts";
import { OPENING_LINE, readRefinement, refinementOf } from "../src/refinement.ts";
import * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import type { CommentId, ItemId } from "../src/tracker.ts";
import { commentKeyOf, commentText } from "../src/itemComments.ts";
import { heldTrackerEnv, unattendedTrackerEnv, readCommentsWithRetry, readWithRetry, runTrackerEnv, type TrackerWrite, TrackerWriteFailed, writeWithRetry } from "../src/trackerRetry.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { makeFakeTracker, type FakeItem } from "./fakeTracker.ts";
import { resolvable, type ScriptedAnswer, ScriptedUi, steppingClock, tempRepo, testLayer } from "./helpers.ts";

const ID = "155" as ItemId;
const ITEM: FakeItem = { id: ID, title: "t", body: "the developer's text", state: "unrefined", open: true, url: Option.none() };
const unreached = () => new TrackerUnreachable({ tracker: "GitHub", message: "the request GET 155 reached no answer from GitHub", status: null });
const serverError = () => new TrackerUnreachable({ tracker: "GitHub", message: "GitHub answered PATCH 155 with status 500", status: 500 });
const refinement = Result.getOrThrow(refinementOf("the requirements"));
const writeRefinement: TrackerWrite = { kind: "writeRefinement", item: ID, refinement };
const setRefined: TrackerWrite = { kind: "setState", item: ID, state: "refined" };

const setup = async (answers: readonly string[] = [], retries = 2, delay = 0.01) => {
  const fake = await Effect.runPromise(makeFakeTracker([ITEM]));
  // Issue #243: every answer of these tests is to the exhaustion question, open beside the repeats.
  const ui = new ScriptedUi(answers.map((beside) => ({ beside })));
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
  // Issue #243: the third wait is the one beside the question, which the answer ends at once.
  assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying").map((e) => e._tag === "TrackerRetrying" && e.attempt), [1, 2, 3, 1]);
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

test("in a run, the question is put beside the repeats without the offer, and the records go to conversation.md", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, { answers: [{ beside: "s" }], config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 } });
  const fake = await Effect.runPromise(makeFakeTracker([ITEM]));
  await Effect.runPromise(Effect.forEach([1, 2], () => fake.failNext("read", unreached()), { discard: true }));
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* (yield* Store).init("task");
      return yield* readWithRetry(fake.tracker, ID, yield* runTrackerEnv);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(failureOf(exit)._tag, "TrackerUnreachable");
  assert.deepEqual(probe.ui.asked, [prompts.transportPrompt]);
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

// Issue #215: the developer ends a repeat's wait; the request is made again at once, and in the first read the line goes
// into the held records like the read's other lines.
test("a repeat's wait ended early: the read is made again at once, and the line is in the held records", async () => {
  const t = await setup([], 2, 3600);
  await t.failNext("read", unreached(), 1);
  const fiber = Effect.runFork(readWithRetry(t.fake.tracker, ID, t.env));
  while (!t.ui.notified.some((e) => e._tag === "TrackerRetrying")) await new Promise((r) => setTimeout(r, 5));
  const waiting = t.ui.notified.find((e) => e._tag === "TrackerRetrying");
  assert.ok(waiting !== undefined && waiting._tag === "TrackerRetrying");
  assert.equal(await Effect.runPromise(t.ui.endWait(waiting.wait)), "ended");
  const item = await Effect.runPromise(Fiber.join(fiber));
  assert.equal(item.id, ID);
  const line = prompts.waitEndedLine({ kind: "tracker", tracker: "GitHub", what: prompts.trackerOperationText({ kind: "read", item: ID }) });
  assert.ok(t.held().join("").includes(line), t.held().join(""));
  assert.deepEqual(tagged(t.ui.notified, "WaitEndedEarly"), [{ _tag: "WaitEndedEarly", wait: waiting.wait }]);
});

// ---- Issue #243: the repeats used up, the question open beside further repeats ----

const besideSetup = (answers: readonly ScriptedAnswer[]) => {
  const ui = new ScriptedUi(answers);
  const held = Effect.runSync(Ref.make<readonly string[]>([]));
  const env = heldTrackerEnv(ui, { ...S.defaultConfig, maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, held);
  return { ui, env, held: () => Effect.runSync(Ref.get(held)) };
};
const scriptedReads = (results: readonly ("fail" | "ok" | "hang")[], onAttempt: (n: number) => void = () => {}) => {
  let n = 0;
  const tracker = {
    read: () =>
      Effect.suspend(() => {
        const r = results[n] ?? "ok";
        n += 1;
        onAttempt(n);
        return r === "fail" ? Effect.fail(unreached()) : r === "hang" ? Effect.never : Effect.succeed({ ...ITEM, state: "unrefined" as const });
      }),
  } as unknown as Parameters<typeof readWithRetry>[0];
  return { tracker, attempts: () => n };
};

test("#243: with no answer the repeats go on after USAGE_LIMIT_RETRY_SECONDS, and the question is cancelled when one succeeds", async () => {
  const events: RunEvent[] = [];
  const web = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const held = Effect.runSync(Ref.make<readonly string[]>([]));
  const env = heldTrackerEnv(web, { ...S.defaultConfig, maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, held);
  const { clock, sleeps } = steppingClock(Date.UTC(2026, 10, 4));
  const r = scriptedReads(["fail", "fail", "fail", "ok"]);
  const item = await Effect.runPromise(readWithRetry(r.tracker, ID, env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(item.id, ID);
  assert.equal(r.attempts(), 4);
  assert.ok(sleeps.includes(USAGE_LIMIT_RETRY_SECONDS * 1000), String(sleeps));
  assert.ok(events.some((e) => e._tag === "Notified" && e.event._tag === "QuestionPresented"), "the question was presented");
  assert.equal(await Effect.runPromise(web.pending), null, "no question is left open");
});

test("#243: Stop answered while a repeat is held fails even where that repeat succeeds", async () => {
  let release = () => {};
  const during = new Promise<void>((r) => (release = r));
  const t = besideSetup([{ beside: "s", when: () => during }]);
  const { clock } = steppingClock(Date.UTC(2026, 10, 4));
  const r = scriptedReads(["fail", "fail", "ok"], (n) => (n === 3 ? release() : undefined));
  const slow = { read: () => r.tracker.read(ID).pipe(Effect.tap(() => Effect.promise(() => new Promise((res) => setTimeout(res, 20))))) } as unknown as Parameters<typeof readWithRetry>[0];
  const exit = await Effect.runPromiseExit(readWithRetry(slow, ID, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(failureOf(exit)._tag, "TrackerUnreachable");
});

test("#243: q answered while a repeat is held and never released fails with UserStopped at once", async () => {
  let release = () => {};
  const during = new Promise<void>((r) => (release = r));
  const t = besideSetup([{ beside: "q", when: () => during }]);
  const { clock } = steppingClock(Date.UTC(2026, 10, 4));
  const r = scriptedReads(["fail", "fail", "hang"], (n) => (n === 3 ? release() : undefined));
  const exit = await Effect.runPromiseExit(readWithRetry(r.tracker, ID, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(failureOf(exit)._tag, "UserStopped");
});

test("#243: Retry again then a second exhaustion: a second, new question is presented and answerable", async () => {
  // The real clock: each answer ends the wait beside its question at once, long before USAGE_LIMIT_RETRY_SECONDS.
  const t = besideSetup([{ beside: "r" }, { beside: "s" }]);
  const r = scriptedReads(["fail", "fail", "fail", "fail", "fail"]);
  const exit = await Effect.runPromiseExit(readWithRetry(r.tracker, ID, t.env));
  assert.equal(failureOf(exit)._tag, "TrackerUnreachable");
  const numbers = t.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question.number] : []));
  assert.equal(numbers.length, 2);
  assert.notEqual(numbers[0], numbers[1]);
});

// ---- W6-R1-1: a question's Scope closed by the repeats' cleanup even while the question is being presented ----

test("W6-R1-1, in a run: the repeats interrupted while the question's record is written: once released, no question is asked", async () => {
  const repo = tempRepo();
  const events: RunEvent[] = [];
  const web = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const questionText = prompts.trackerExhaustedQuestion("GitHub", "reading item 155");
  const reached = resolvable();
  const release = resolvable();
  let released = false;
  const afterRelease: string[] = [];
  const { layer } = testLayer(repo, {
    ui: web,
    config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 },
    store: (store) => ({
      ...store,
      converse: (text: string) =>
        Effect.suspend(() => {
          if (released) afterRelease.push(text);
          return text.includes(questionText) ? Effect.promise(() => (reached.resolve(), release.promise)).pipe(Effect.andThen(store.converse(text))) : store.converse(text);
        }),
    }),
  });
  const r = scriptedReads(["fail", "fail", "fail", "fail"]);
  const { clock } = steppingClock(Date.UTC(2026, 10, 4));
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      yield* (yield* Store).init("task");
      return yield* readWithRetry(r.tracker, ID, yield* runTrackerEnv);
    }).pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(layer)),
  );
  await reached.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  released = true;
  release.resolve();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(events.filter((e) => e._tag === "Asked" && e.beside !== null).length, 0, "an Asked with beside was published");
  assert.equal(await Effect.runPromise(web.pending), null);
  assert.deepEqual(afterRelease, []);
});

test("W6-R1-1, the first read: the repeats interrupted after the question's producer was forked and before its handle was kept: the producer ends and nothing is left pending", async () => {
  const events: RunEvent[] = [];
  const web = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const heldRecords = Effect.runSync(Ref.make<readonly string[]>([]));
  const held = heldTrackerEnv(web, { ...S.defaultConfig, maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, heldRecords);
  const reached = resolvable();
  let producer: Fiber.Fiber<string, unknown> | null = null;
  const env = {
    ...held,
    openQuestion: (scope: Parameters<typeof held.openQuestion>[0], draft: Parameters<typeof held.openQuestion>[1], onAccepted: Parameters<typeof held.openQuestion>[2]) =>
      held.openQuestion(scope, draft, onAccepted).pipe(
        Effect.tap((handle) => Effect.sync(() => ((producer = handle.fiber), reached.resolve()))),
        Effect.tap(() => Effect.never),
      ),
  };
  const r = scriptedReads(["fail", "fail", "fail", "fail"]);
  const { clock } = steppingClock(Date.UTC(2026, 10, 4));
  const fiber = Effect.runFork(readWithRetry(r.tracker, ID, env).pipe(Effect.provideService(Clock.Clock, clock)));
  await reached.promise;
  await new Promise((res) => setTimeout(res, 20));
  await Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(producer !== null);
  assert.ok((producer as Fiber.Fiber<string, unknown>).pollUnsafe() !== undefined, "the question's producer is still running");
  assert.equal(await Effect.runPromise(web.pending), null);
  const asked = events.find((e) => e._tag === "Asked" && e.beside !== null);
  if (asked !== undefined && asked._tag === "Asked") assert.ok(events.some((e) => e._tag === "PromptCancelled" && e.prompt === asked.prompt), "no PromptCancelled followed the Asked");
});

// ---- issue #219: a rate limit is waited out, outside the repeats' budget -----------------------------------------------
const rateLimited = (seconds: number | null) =>
  new TrackerRateLimited({ tracker: "GitLab", status: 429, message: "GitLab answered GET 155 with status 429", reset: seconds === null ? { _tag: "Unstated" } : { _tag: "After", seconds } });
const START = Date.UTC(2026, 10, 5, 12, 59, 23);

test("#219: a read refused for the rate limit waits until the stated reset plus the margin, then succeeds, asking nothing", async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.failNext("read", rateLimited(30)));
  const { clock, sleeps } = steppingClock(START);
  const item = await Effect.runPromise(readWithRetry(t.fake.tracker, ID, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(item.id, ID);
  assert.deepEqual(sleeps, [31_000]);
  const waiting = tagged(t.ui.notified, "TrackerRateLimitWaiting");
  assert.deepEqual(waiting.map((e) => e._tag === "TrackerRateLimitWaiting" && [e.tracker, e.stated, e.fromMs, e.untilMs]), [["GitLab", true, START, START + 31_000]]);
  assert.deepEqual(t.ui.notified.map((e) => e._tag).filter((tag) => tag === "TrackerRateLimitWaiting" || tag === "TrackerRecovered"), ["TrackerRateLimitWaiting", "TrackerRecovered"]);
  const line = prompts.trackerRateLimitLine("GitLab", "reading item 155", START + 31_000, true);
  assert.ok(t.ui.said.includes(line));
  assert.ok(t.held().some((r) => r.includes(line)));
  assert.deepEqual(t.ui.asked, []);
  assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying"), []);
});

test("#219: an unstated reset waits the fallback minute", async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.failNext("read", rateLimited(null)));
  const { clock, sleeps } = steppingClock(START);
  await Effect.runPromise(readWithRetry(t.fake.tracker, ID, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.deepEqual(sleeps, [60_000]);
});

test("#219: rate limits spend none of the repeats: three in a row, then every repeat of the set", async () => {
  const t = await setup([], 2);
  for (let i = 0; i < 3; i += 1) await Effect.runPromise(t.fake.failNext("read", rateLimited(5)));
  await t.failNext("read", unreached(), 2);
  const { clock } = steppingClock(START);
  const item = await Effect.runPromise(readWithRetry(t.fake.tracker, ID, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(item.id, ID);
  assert.equal(tagged(t.ui.notified, "TrackerRateLimitWaiting").length, 3);
  assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying").map((e) => e._tag === "TrackerRetrying" && [e.attempt, e.of]), [[1, 2], [2, 2]]);
  assert.deepEqual(t.ui.asked, []);
});

test("#219: the developer ends the rate-limit wait early and the read is made at once", async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.failNext("read", rateLimited(3600)));
  const fiber = Effect.runFork(readWithRetry(t.fake.tracker, ID, t.env));
  for (let waited = 0; tagged(t.ui.notified, "TrackerRateLimitWaiting").length === 0 && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const [announced] = tagged(t.ui.notified, "TrackerRateLimitWaiting");
  assert.ok(announced?._tag === "TrackerRateLimitWaiting", "the wait never began");
  assert.equal(await Effect.runPromise(t.ui.endWait(announced.wait as never)), "ended");
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(tagged(t.ui.notified, "WaitEndedEarly").length, 1);
});

test("#219: an interruption during the rate-limit wait ends the request", async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.failNext("read", rateLimited(3600)));
  const fiber = Effect.runFork(readWithRetry(t.fake.tracker, ID, t.env));
  for (let waited = 0; tagged(t.ui.notified, "TrackerRateLimitWaiting").length === 0 && waited < 5000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
});

/** A tracker whose read-backs (reads) and listings are scripted to fail first with the errors given. */
const failingReads = (t: Awaited<ReturnType<typeof setup>>, reads: readonly TrackerError[], listings: readonly TrackerError[] = []) => {
  let r = 0;
  let l = 0;
  let posts = 0;
  const tracker = {
    ...t.fake.tracker,
    read: (id: ItemId) => Effect.suspend(() => (r < reads.length ? Effect.fail(reads[r++]!) : t.fake.tracker.read(id))),
    comments: (id: ItemId) => Effect.suspend(() => (l < listings.length ? Effect.fail(listings[l++]!) : t.fake.tracker.comments(id))),
    comment: (id: ItemId, text: string) => Effect.suspend(() => { posts += 1; return t.fake.tracker.comment(id, text); }),
  };
  return { tracker, posts: () => posts };
};

test("#219 (P1-R1-1): a write answered 500 whose read-back is rate limited waits it out and succeeds, its repeats unspent", async () => {
  const t = await setup([], 2);
  await t.failNext("setState", serverError());
  const f = failingReads(t, [rateLimited(10)]);
  const { clock, sleeps } = steppingClock(START);
  await Effect.runPromise(writeWithRetry(f.tracker, setRefined, t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal((await t.item()).state, "refined");
  assert.deepEqual(sleeps, [11_000]);
  assert.deepEqual(tagged(t.ui.notified, "TrackerRetrying"), []);
});

test("#219 (P1-R1-1): the same in the unattended environment with one repeat still succeeds rather than stopping", async () => {
  const t = await setup();
  const held = Effect.runSync(Ref.make<readonly string[]>([]));
  const env = unattendedTrackerEnv(heldTrackerEnv(t.ui, { ...S.defaultConfig, maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, held));
  await t.failNext("setState", serverError());
  const f = failingReads(t, [rateLimited(10), rateLimited(10)]);
  const { clock } = steppingClock(START);
  await Effect.runPromise(writeWithRetry(f.tracker, setRefined, env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal((await t.item()).state, "refined");
});

test("#219 (P1-R1-1): a comment answered 500 whose reconciling listing is rate limited lists again after the wait: one POST", async () => {
  const t = await setup();
  await Effect.runPromise(t.fake.failAfterNext("comment", serverError()));
  const f = failingReads(t, [], [rateLimited(10)]);
  const { clock } = steppingClock(START);
  await Effect.runPromise(writeWithRetry(f.tracker, commentWrite("r/verdict-1"), t.env).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(f.posts(), 1);
  assert.equal(((await t.item()).comments ?? []).length, 1);
});
