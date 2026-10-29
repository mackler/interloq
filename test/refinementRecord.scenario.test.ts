import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { TrackerRequestRefused } from "../src/errors.ts";
import { lastRefinementAsked, parseComment } from "../src/itemComments.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { type Services, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, questionEntry, scriptedItem, summaryReply, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

// Issue #186 (requirements Q5): a refinement run records on its item whether it asked the developer any question, after
// the requirements are written and before the item is set to refined, so the send-back's guard can read it.
type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const item: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("186")), title: "Send back", body: "Declare it unrefined.", state: "unrefined" };
const oneQuestion: TestOptions = { answers: ["A", ""], steps: [{ output: { questions: [q("Q1")] } }], closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }], reviews: [{ issues: [] }, { issues: [] }] };
const empty: TestOptions = { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] };

/** The fake with the order of its writes recorded. */
const logged = (fake: FakeTracker) => {
  const order: string[] = [];
  const t = fake.tracker;
  const tracker = { ...t, writeRefinement: (...a: Parameters<typeof t.writeRefinement>) => Effect.andThen(Effect.sync(() => order.push("writeRefinement")), t.writeRefinement(...a)), comment: (...a: Parameters<typeof t.comment>) => Effect.andThen(Effect.sync(() => order.push("comment")), t.comment(...a)), setState: (...a: Parameters<typeof t.setState>) => Effect.andThen(Effect.sync(() => order.push("setState")), t.setState(...a)) };
  return { tracker, order };
};
const refine = async (options: TestOptions, fake: FakeTracker = fakeTrackerOf([item])) => {
  const { layer, probe } = testLayer(tempRepo(), options);
  const { tracker, order } = logged(fake);
  const exit = await Effect.runPromiseExit(refinementRun("Send back\n\nDeclare it unrefined.", item.id, "checked").pipe(Effect.provide(Layer.succeed(Tracker, tracker)), Effect.provide(layer as Layer.Layer<Services>)));
  const after = (await Effect.runPromise(fake.items)).find((i) => i.id === item.id)!;
  return { exit, probe, after, order };
};

test("a refinement that asked a question records asked=yes, between the requirements and the state", async () => {
  const { exit, probe, after, order } = await refine(oneQuestion);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.deepEqual(order, ["writeRefinement", "comment", "setState"]);
  assert.equal(lastRefinementAsked(after.comments ?? []), true);
  const marker = parseComment(after.comments![0]!.body);
  assert.equal(marker?._tag, "RefinementRecord");
  assert.equal(marker?.key, probe.dir.slice(probe.dir.lastIndexOf("/") + 1));
});

test("a refinement with an empty agreed list records asked=no", async () => {
  const { exit, after } = await refine(empty);
  assert.ok(Exit.isSuccess(exit));
  assert.equal((after.comments ?? []).length, 1);
  assert.equal(lastRefinementAsked(after.comments ?? []), false);
  assert.equal(after.state, "refined");
});

test("a record that cannot be written halts with TrackerStepFailed, the item still unrefined", async () => {
  const fake = fakeTrackerOf([item]);
  await Effect.runPromise(fake.failNext("comment", new TrackerRequestRefused({ tracker: "GitHub", status: 422, message: "refused" })));
  const { exit, after } = await refine(empty, fake);
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error) && error.value._tag === "TrackerStepFailed" && error.value.step === "recordRefinement");
  assert.equal(after.state, "unrefined");
});
