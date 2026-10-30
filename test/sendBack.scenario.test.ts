import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TrackerRequestRefused, TrackerUnreachable } from "../src/errors.ts";
import { commentText, parseComment, runCommentKey } from "../src/itemComments.ts";
import { parkBranchOf } from "../src/park.ts";
import { sendBack } from "../src/sendBack.ts";
import { type Services, Store, type StoreShape, Tracker } from "../src/services.ts";
import type { ItemComment } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, type ScriptedAnswer, scriptedItem, tempRepo, testLayer, TEST_ROOT } from "./helpers.ts";
import { Result } from "effect";
import { seededId } from "./fakeTracker.ts";

// Issue #186: an item whose verdict stood is sent back (parked, commented, unrefined), or stopped by the guard of
// requirements Q5 (parked, commented, implementing); a failed parking writes nothing; a tracker failure after the
// parking is SendBackIncomplete with the parking's note; an interruption during the parking lets it complete.
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const record = (asked: boolean): ItemComment => ({ id: seededId(), body: commentText({ _tag: "RefinementRecord", key: runCommentKey("refinement-run"), date: "2026-10-28", asked }), created: "2026-10-28T00:00:00Z" });
const itemWith = (comments: readonly ItemComment[]): FakeItem => ({ ...scriptedItem, state: "implementing", comments });
const branch = Result.getOrThrow(parkBranchOf(scriptedItem.id, TEST_ROOT));

/** A run that began, committed one change and left another uncommitted (`work`), then gave a verdict that stood. */
const setup = (tracker: FakeTracker, options: { work?: boolean; store?: (s: StoreShape) => StoreShape; answers?: readonly ScriptedAnswer[] } = {}) => {
  const repo = tempRepo();
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  const { layer, probe } = testLayer(repo, { tracker, answers: options.answers ?? [], config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, ...(options.store === undefined ? {} : { store: options.store }) });
  const prepared = Effect.gen(function* () {
    const store = yield* Store;
    yield* store.init("task");
    yield* store.writeBaseline();
    if (options.work ?? true) {
      fs.writeFileSync(path.join(repo, "committed.txt"), "c\n");
      git(repo, "add", "committed.txt");
      git(repo, "commit", "-qm", "the run's commit");
      fs.writeFileSync(path.join(repo, "left.txt"), "l\n");
    }
  });
  const start = git(repo, "rev-parse", "HEAD");
  const provided = <A, E>(e: Effect.Effect<A, E, Services | Tracker>) => Effect.andThen(prepared, e).pipe(Effect.provide(Layer.merge(layer as Layer.Layer<Services>, Layer.succeed(Tracker, tracker.tracker))));
  const runIt = <A, E>(e: Effect.Effect<A, E, Services | Tracker>) => Effect.runPromiseExit(provided(e));
  return { repo, probe, start, runIt, provided };
};
const held = async (tracker: FakeTracker) => (await Effect.runPromise(tracker.items))[0]!;
const tags = (item: FakeItem) => (item.comments ?? []).map((c) => parseComment(c.body)?._tag ?? "developer");
const failure = <A, E extends { _tag: string }>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "it succeeded");
  const e = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(e), Cause.pretty(exit.cause));
  return e.value;
};

test("an item whose last refinement asked is parked, commented once and labeled unrefined", async () => {
  const tracker = fakeTrackerOf([itemWith([record(true)])]);
  const { repo, start, runIt, probe } = setup(tracker);
  const exit = await runIt(sendBack(scriptedItem.id, 1, "The retention period."));
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.equal(exit.value.park._tag, "Parked");
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.ok(git(repo, "branch", "--list", branch).includes(branch));
  const item = await held(tracker);
  assert.equal(item.state, "unrefined");
  assert.deepEqual(tags(item), ["RefinementRecord", "SentBack"]);
  assert.equal(parseComment(item.comments![1]!.body)?.key, runCommentKey(path.basename(probe.dir), "verdict-1"));
  assert.ok(item.comments![1]!.body.includes("The retention period."));
});

test("nothing to park: NothingParked, parked.json Nothing, still sent back", async () => {
  const tracker = fakeTrackerOf([itemWith([record(true)])]);
  const { runIt, probe } = setup(tracker, { work: false });
  const exit = await runIt(sendBack(scriptedItem.id, 1, "m"));
  assert.ok(Exit.isSuccess(exit) && exit.value.park._tag === "NothingParked");
  assert.equal(JSON.parse(fs.readFileSync(path.join(probe.dir, "parked.json"), "utf8"))._tag, "Nothing");
  assert.equal((await held(tracker)).state, "unrefined");
});

test("a last refinement that asked nothing: stopped, parked, commented, still implementing", async () => {
  const tracker = fakeTrackerOf([itemWith([record(false)])]);
  const { runIt } = setup(tracker);
  const error = failure(await runIt(sendBack(scriptedItem.id, 1, "m")));
  assert.equal(error._tag, "NotRefinedStopped");
  assert.ok(error._tag === "NotRefinedStopped" && error.park?._tag === "Parked");
  const item = await held(tracker);
  assert.equal(item.state, "implementing");
  assert.deepEqual(tags(item), ["RefinementRecord", "StoppedUnrefined"]);
});

test("no record of the last refinement counts as asked: sent back (requirements G-R1-1)", async () => {
  const tracker = fakeTrackerOf([itemWith([])]);
  const { runIt } = setup(tracker);
  assert.ok(Exit.isSuccess(await runIt(sendBack(scriptedItem.id, 1, "m"))));
  assert.equal((await held(tracker)).state, "unrefined");
});

test("a parking that fails writes no comment and leaves the item implementing", async () => {
  const tracker = fakeTrackerOf([itemWith([record(true)])]);
  const { repo, start, runIt } = setup(tracker);
  git(repo, "branch", branch, start);
  const error = failure(await runIt(sendBack(scriptedItem.id, 1, "m")));
  assert.equal(error._tag, "SendBackNotParked");
  const item = await held(tracker);
  assert.equal(item.state, "implementing");
  assert.deepEqual(tags(item), ["RefinementRecord"]);
});

for (const asked of [true, false]) {
  test(`${asked ? "a send-back" : "a guard stop"} whose comment fails for good after the parking is SendBackIncomplete with the Parked note`, async () => {
    const tracker = fakeTrackerOf([itemWith([record(asked)])]);
    await Effect.runPromise(tracker.failNext("comment", new TrackerRequestRefused({ tracker: "GitHub", status: 422, message: "refused" })));
    const { runIt } = setup(tracker);
    const error = failure(await runIt(sendBack(scriptedItem.id, 1, "m")));
    assert.ok(error._tag === "SendBackIncomplete" && error.park._tag === "Parked" && error.ending === (asked ? "sentBack" : "stoppedUnrefined"), error._tag);
    assert.equal((await held(tracker)).state, "implementing");
  });
}

test("a send-back whose label fails for good after its comment is SendBackIncomplete, the comment written", async () => {
  const tracker = fakeTrackerOf([itemWith([record(true)])]);
  await Effect.runPromise(tracker.failNext("setState", new TrackerRequestRefused({ tracker: "GitHub", status: 422, message: "refused" })));
  const { runIt } = setup(tracker);
  const error = failure(await runIt(sendBack(scriptedItem.id, 1, "m")));
  assert.ok(error._tag === "SendBackIncomplete" && error.park._tag === "Parked");
  const item = await held(tracker);
  assert.equal(item.state, "implementing");
  assert.deepEqual(tags(item), ["RefinementRecord", "SentBack"]);
});

test("an interruption while the leftovers are committed lets the parking complete before it takes effect", async () => {
  const tracker = fakeTrackerOf([itemWith([record(true)])]);
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const t = setup(tracker, {
    store: (s) => ({ ...s, commitLeftovers: (m) => Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), s.commitLeftovers(m))) }),
  });
  const fiber = Effect.runFork(t.provided(sendBack(scriptedItem.id, 1, "m")));
  await Effect.runPromise(Deferred.await(entered));
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await interrupted;
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.probe.dir, "parked.json"), "utf8"))._tag, "Parked");
  assert.equal(git(t.repo, "rev-parse", "HEAD"), t.start);
  assert.ok(git(t.repo, "branch", "--list", branch).includes(branch));
  assert.equal((await held(tracker)).state, "implementing", "the interruption took effect before the comment and the label");
});

// Issue #185: a send-back's tracker step whose exhaustion question goes unanswered is its own ending, carrying the step
// and the parking's note; no write sets the label refined.
for (const [step, op, work] of [["label", "setState", true], ["label", "setState", false], ["comment", "comment", true]] as const) {
  test(`a send-back whose ${step} step's question goes unanswered${work ? "" : " with nothing to park"} fails with SendBackUnanswered`, async () => {
    const tracker = fakeTrackerOf([itemWith([record(true)])]);
    const { runIt } = setup(tracker, { work, answers: [{ noAnswer: true }] });
    for (let i = 0; i < 2; i++) await Effect.runPromise(tracker.failNext(op, new TrackerUnreachable({ tracker: "GitHub", message: "no answer", status: null })));
    const error = failure(await runIt(sendBack(scriptedItem.id, 1, "The retention period.")));
    assert.equal(error._tag, "SendBackUnanswered");
    assert.ok(error._tag === "SendBackUnanswered" && error.step === step);
    assert.equal(error._tag === "SendBackUnanswered" && error.park._tag, work ? "Parked" : "NothingParked");
    assert.notEqual((await held(tracker)).state, "refined");
  });
}
