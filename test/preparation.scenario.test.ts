// Issue #131 (S13): prepareItem over the scripted agents and the fake tracker: the reviewed questions and terms written
// to the item as comments, the item set aside where its review stops for the developer or the preparation fails, and
// the item's state and body never touched.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Fiber, Layer, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { runCommentKey } from "../src/itemComments.ts";
import { digestOf, preparationOf, preparedComments } from "../src/preparedComments.ts";
import { type PreparationOutcome, prepareItem } from "../src/preparation.ts";
import { Tracker, type TrackerShape } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import { type FakeItem, type FakeTracker, seededId } from "./fakeTracker.ts";
import { fakeTrackerOf, issue, questionEntry, respond, scriptedItem, type TestOptions, tempRepo, testWiring } from "./helpers.ts";

const ITEM: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("131")), title: "Prepare questions", body: "The developer's text.", state: "unrefined", marked: true };
const q = (id: string) => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const twoQuestions: TestOptions = { steps: [{ output: { questions: [q("Q1"), q("Q2")] } }], reviews: [{ issues: [] }] };
const FAST = { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 };

const setup = (options: TestOptions, tracker: FakeTracker = fakeTrackerOf([ITEM]), trackerOf?: (t: TrackerShape) => TrackerShape) => {
  const { wiring, probe } = testWiring(tempRepo(), { ...options, tracker, config: { ...FAST, ...options.config } });
  const wired = trackerOf === undefined ? wiring : { ...wiring, tracker: () => Result.succeed(Layer.succeed(Tracker, trackerOf(tracker.tracker))) };
  const prepare = (comments = ITEM.comments ?? []) => Effect.scoped(prepareItem({ project: probe.project, item: ITEM, comments, generation: 1 }, wired));
  const held = async () => (await Effect.runPromise(tracker.items)).find((i) => i.id === ITEM.id)!;
  return { probe, tracker, prepare, held };
};
const runs = (project: string) => fs.readdirSync(path.join(project, "plan-review", "runs"));

test("a two-question item gets two question comments then its own, read back as the reviewed questions; state and body unchanged", async () => {
  const s = setup(twoQuestions);
  const outcome = await Effect.runPromise(s.prepare());
  assert.deepEqual(outcome, { _tag: "Prepared", count: 2 });
  const after = await s.held();
  assert.deepEqual([after.state, after.body, after.title], [ITEM.state, ITEM.body, ITEM.title]);
  const [dir] = runs(s.probe.project);
  assert.match(dir!, /-preparation-131$/u);
  const records = path.join(s.probe.project, "plan-review", "runs", dir!);
  assert.ok(fs.existsSync(path.join(records, "conversation.md")));
  const found = preparationOf(after.comments ?? [], after, 1);
  assert.equal(found._tag, "Prepared");
  if (found._tag !== "Prepared") return;
  // The seam: what the item holds is what the preparation's own questions.json and terms.json hold.
  const questions = JSON.parse(fs.readFileSync(path.join(records, "questions.json"), "utf8")).questions;
  const terms = JSON.parse(fs.readFileSync(path.join(records, "terms.json"), "utf8")).entries;
  assert.deepEqual(found.questions, questions);
  assert.deepEqual(found.terms, terms);
  assert.equal((after.comments ?? []).length, 3);
  assert.equal(found.key, runCommentKey(dir!));
});

test("a question review that reaches its idle limit sets the item aside with one comment, no question comment, nothing answered", async () => {
  const s = setup({
    config: { maxIdleRounds: 1 },
    steps: [{ output: { questions: [q("Q1")] } }, { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [q("Q1")] } }],
    reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [issue("Q-R2-1")] }],
  });
  const outcome = await Effect.runPromise(s.prepare());
  assert.equal(outcome._tag, "SetAside");
  assert.equal(outcome._tag === "SetAside" && outcome.cause._tag, "Paused");
  const after = await s.held();
  assert.equal((after.comments ?? []).length, 1);
  assert.equal(preparationOf(after.comments ?? [], after, 1)._tag, "SetAside");
  assert.equal(s.probe.ui.asked.length, 0);
});

test("a preparation whose Claude Code call halts sets the item aside as failed", async () => {
  const s = setup({ steps: [{ output: { nonsense: 1 } }, { output: { nonsense: 2 } }] });
  const outcome = await Effect.runPromise(s.prepare());
  assert.equal(outcome._tag === "SetAside" && outcome.cause._tag, "Failed");
});

test("a stale preparation on the item is deleted before the new comments are written", async () => {
  const oldKey = runCommentKey("2026-10-01T00-00-00-000Z-preparation-131");
  const stale = Result.getOrThrow(preparedComments(oldKey, [], { _tag: "Prepared", key: oldKey, digest: digestOf({ title: "old", body: "" }), count: 0, generation: 1, date: "2026-10-01" }));
  const seeded = stale.map((c, i) => ({ id: seededId(`old-${i}`), body: c.text, created: "2026-10-01T00:00:00Z" }));
  const s = setup(twoQuestions, fakeTrackerOf([{ ...ITEM, comments: seeded }]));
  await Effect.runPromise(s.prepare(seeded));
  const after = await s.held();
  assert.ok((after.comments ?? []).every((c) => !c.body.includes(oldKey)));
  assert.equal(preparationOf(after.comments ?? [], after, 1)._tag, "Prepared");
});

test("an interruption after the first question comment deletes every comment of the preparation", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let written = 0;
  const holding = (t: TrackerShape): TrackerShape => ({ ...t, comment: (id, text) => Effect.suspend(() => (++written === 2 ? Effect.promise(() => gate) : Effect.void)).pipe(Effect.andThen(t.comment(id, text))) });
  const s = setup(twoQuestions, fakeTrackerOf([ITEM]), holding);
  const fiber = Effect.runFork(s.prepare());
  for (let waited = 0; written < 2; waited += 10) {
    if (waited > 60_000) assert.fail("the second question comment was never written");
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(((await s.held()).comments ?? []).length, 1);
  await Effect.runPromise(Fiber.interrupt(fiber));
  release();
  assert.deepEqual((await s.held()).comments ?? [], []);
  const [dir] = runs(s.probe.project);
  assert.ok(fs.readFileSync(path.join(s.probe.project, "plan-review", "runs", dir!, "conversation.md"), "utf8").includes("**Preparation stopped.**"));
});

test("a tracker whose comment writes fail every time gives NotWritten, and no one is asked anything", async () => {
  const tracker = fakeTrackerOf([ITEM]);
  const failing = (t: TrackerShape): TrackerShape => ({ ...t, comment: () => Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) });
  const s = setup(twoQuestions, tracker, failing);
  const outcome: PreparationOutcome = await Effect.runPromise(s.prepare());
  assert.equal(outcome._tag, "NotWritten");
  assert.equal(s.probe.ui.asked.length, 0);
  assert.deepEqual((await s.held()).comments ?? [], []);
});
