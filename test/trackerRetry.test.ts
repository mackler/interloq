// Issue #171 (S9): a tracker request that reached no answer, or that the tracker answered with a server error, is
// repeated with backoff; a write answered with a server error is read back first; when the repeats run out the
// developer is asked Retry again or Stop. Over the fake tracker, with the first read's environment (heldTrackerEnv,
// whose records are held and whose question has no offer) and, once, the run's (runTrackerEnv, over testLayer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Option, Ref, Result } from "effect";
import { TrackerAuthRefused, TrackerRequestRefused, TrackerUnreachable } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { OPENING_LINE, readRefinement, refinementOf } from "../src/refinement.ts";
import * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import type { ItemId } from "../src/tracker.ts";
import { heldTrackerEnv, readWithRetry, runTrackerEnv, type TrackerWrite, TrackerWriteFailed, writeWithRetry } from "../src/trackerRetry.ts";
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
