// Issue #171 (S10): every write of a run to its item goes through the tracker retry. Scenarios over testLayer and the
// fake tracker, with waits of 0.01 s: a request that reached no answer is repeated and the run goes on; a refused
// credential halts at once; a write answered 500 is read back; an exhausted request asks before the run halts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { describe, TrackerAuthRefused, TrackerUnreachable } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { OPENING_LINE, readRefinement, refinementOf, withRefinement } from "../src/refinement.ts";
import { implementationRun, refinementRun } from "../src/run.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import type * as S from "../src/schema.ts";
import { type Services, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, finished, questionEntry, scriptedItem, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: { id: "", context: [], history: [], text: [], explanations: [], options: [] }, asked_ids: [], answered_ids: [], complete, summary });
const FAST = { maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.01 };
const unrefined: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("155")), title: "Retry", body: "Repeat a failed request.", state: "unrefined" };
const refined: FakeItem = { ...unrefined, id: Result.getOrThrow(itemIdOf("171")), body: Result.getOrThrow(withRefinement("Repeat it.", Result.getOrThrow(refinementOf("# Requirements")))), state: "refined" };
const oneQuestion = (answers: readonly string[] = []): TestOptions => ({
  answers: ["A", "", ...answers],
  steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", false, "") }, { output: turn("Done.", true, "# Requirements\n\nQ1: A") }],
  reviews: [{ issues: [] }, { issues: [] }],
  config: FAST,
});
const converging = (answers: readonly string[] = []): TestOptions => ({ answers, steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], config: FAST });

const unreached = () => new TrackerUnreachable({ tracker: "GitHub", message: "reached no answer from GitHub", status: null });
const serverError = () => new TrackerUnreachable({ tracker: "GitHub", message: "GitHub answered PATCH 155 with status 500", status: 500 });
const failTimes = (tracker: FakeTracker, op: "writeRefinement" | "setState", error: TrackerUnreachable | TrackerAuthRefused, times: number) =>
  Effect.runPromise(Effect.forEach(Array.from({ length: times }), () => tracker.failNext(op, error), { discard: true }));

const refine = async (tracker: FakeTracker, options: TestOptions) => {
  const { layer, probe } = testLayer(tempRepo(), options);
  const exit = await Effect.runPromiseExit(refinementRun("Retry\n\nRepeat a failed request.", unrefined.id, "checked").pipe(Effect.provide(Layer.succeed(Tracker, tracker.tracker)), Effect.provide(layer as Layer.Layer<Services>)));
  return { exit, probe, conversation: () => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8") };
};
const implement = async (tracker: FakeTracker, options: TestOptions) => {
  const { layer, probe } = testLayer(tempRepo(), { ...options, tracker });
  const exit = await Effect.runPromiseExit(implementationRun("Retry\n\nRepeat it.", refined.id, null, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  return { exit, probe, conversation: () => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8") };
};
const itemOf = async (tracker: FakeTracker, id: string): Promise<FakeItem> => (await Effect.runPromise(tracker.items)).find((i) => i.id === id) ?? assert.fail("no item");
const ok = (exit: Exit.Exit<unknown, unknown>) => assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};

test("a write of the requirements that reached no answer is repeated, the run goes on, and each wait is in conversation.md", async () => {
  const tracker = fakeTrackerOf([unrefined]);
  await failTimes(tracker, "writeRefinement", unreached(), 2);
  const { exit, conversation } = await refine(tracker, oneQuestion());
  ok(exit);
  const after = await itemOf(tracker, unrefined.id);
  assert.equal(after.state, "refined");
  assert.ok(conversation().includes(prompts.trackerRetryLine("GitHub", "writing the requirements to item 155", 1, 2, 0.01, unreached().message)));
  assert.ok(conversation().includes(prompts.trackerRetryLine("GitHub", "writing the requirements to item 155", 2, 2, 0.02, unreached().message)));
});

test("a refused credential on the state is not repeated: the run halts at once and asks nothing", async () => {
  const tracker = fakeTrackerOf([unrefined]);
  await failTimes(tracker, "setState", new TrackerAuthRefused({ tracker: "GitHub", status: 401 }), 1);
  const { exit, probe } = await refine(tracker, oneQuestion());
  assert.equal(failureOf(exit)._tag, "TrackerStepFailed");
  assert.deepEqual(probe.ui.notified.filter((e) => e._tag === "TrackerRetrying"), []);
  assert.ok(!probe.ui.asked.some((p) => p.includes(prompts.transportPrompt)));
});

test("a write of the requirements answered 500 before it applied leaves the item with exactly one section", async () => {
  const tracker = fakeTrackerOf([unrefined]);
  await failTimes(tracker, "writeRefinement", serverError(), 1);
  const { exit } = await refine(tracker, oneQuestion());
  ok(exit);
  const body = (await itemOf(tracker, unrefined.id)).body;
  assert.ok(Option.isSome(Result.getOrThrow(readRefinement(body))));
  assert.equal(body.split(OPENING_LINE).length - 1, 1);
});

test("a state set to refined answered 500 after it applied is found by the read-back: the run goes on with no question", async () => {
  const tracker = fakeTrackerOf([unrefined]);
  await Effect.runPromise(tracker.failAfterNext("setState", serverError()));
  const { exit, probe, conversation } = await refine(tracker, oneQuestion());
  ok(exit);
  assert.equal((await itemOf(tracker, unrefined.id)).state, "refined");
  assert.ok(conversation().includes(prompts.trackerWriteLandedLine("GitHub", "setting item 155 to refined")));
  assert.ok(!probe.ui.asked.some((p) => p.includes(prompts.transportPrompt)));
});

test("an implementation whose state cannot be set to implementing asks, with the offer, and Stop halts naming the check before any agent call", async () => {
  const tracker = fakeTrackerOf([refined]);
  await failTimes(tracker, "setState", serverError(), 3);
  const { exit, probe } = await implement(tracker, converging(["s"]));
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /setting item 171 to implementing could not be completed[^]*After the last attempt, item 171 was in the state refined\./u);
  assert.deepEqual(probe.ui.asked, [prompts.withOffer(prompts.transportPrompt)]);
  assert.deepEqual([probe.planner.prompts, probe.reviewer.prompts], [[], []]);
});

test("an implemented state applied and answered 500, whose read-backs all fail, halts saying the item could not be checked, never that it stays implementing (W1-R1-1)", async () => {
  const tracker = fakeTrackerOf([refined]);
  await Effect.runPromise(Effect.all([tracker.failAfterNext("setState", serverError(), "implemented"), tracker.failAfterNext("setState", serverError(), "implemented"), tracker.failNext("read", unreached()), tracker.failNext("read", unreached())], { discard: true }));
  const { exit } = await implement(tracker, { ...converging(["s"]), config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 } });
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /could not be checked after the last attempt/u);
  assert.doesNotMatch(describe(error), /stays implementing/u);
  assert.equal((await itemOf(tracker, refined.id)).state, "implemented");
});

test("the same answered Retry again, then succeeding: the run goes on and finishes implemented", async () => {
  const tracker = fakeTrackerOf([refined]);
  await failTimes(tracker, "setState", unreached(), 3);
  const { exit, conversation } = await implement(tracker, converging(["r"]));
  ok(exit);
  assert.equal((await itemOf(tracker, refined.id)).state, "implemented");
  assert.ok(conversation().includes(prompts.trackerDecisionLine("retry", "GitHub", "setting item 171 to implementing")));
});
