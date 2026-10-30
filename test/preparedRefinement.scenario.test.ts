// Issue #131 (S14): Refine on a prepared item asks its first prepared question with no question-list, review or terms
// call; a stale preparation is ignored; a preparation with no question needs no agent call at all; the comments are
// deleted once the item is refined, and a deletion that fails for good does not halt the run.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { runCommentKey } from "../src/itemComments.ts";
import { digestOf, preparationOf, preparedComments, type PreparedQuestion } from "../src/preparedComments.ts";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { Tracker, type TrackerShape } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import { type FakeItem, seededId } from "./fakeTracker.ts";
import { fakeTrackerOf, presentedQuestions, questionEntry, questionText, scriptedItem, scriptedStart, summaryReply, type TestOptions, tempRepo, testWiring } from "./helpers.ts";

const BASE: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("131")), title: "Prepare questions", body: "The developer's text.", state: "unrefined" };
const KEY = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131");
const stored = (id: string): S.StoredQuestion => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const termsOf = (q: S.StoredQuestion): S.TermsEntry => ({ id: q.id, explanations: [], context: q.context, history: q.history, question: q.question, reason: q.reason, proposed_answers: q.proposed_answers });
const prepared = (questions: readonly S.StoredQuestion[], item: Pick<FakeItem, "title" | "body"> = BASE): FakeItem => {
  const pqs: PreparedQuestion[] = questions.map((entry) => ({ entry, terms: termsOf(entry) }));
  const texts = Result.getOrThrow(preparedComments(KEY, pqs, { _tag: "Prepared", key: KEY, digest: digestOf(item), count: pqs.length, generation: 1, date: "2026-10-30" }));
  return { ...BASE, comments: texts.map((c, i) => ({ id: seededId(`p-${i + 1}`), body: c.text, created: "2026-10-30T00:00:00Z" })) };
};
const refine = async (item: FakeItem, options: TestOptions, trackerOf?: (t: TrackerShape) => TrackerShape, terms: S.TermsMode = "checked") => {
  const tracker = fakeTrackerOf([item]);
  const { wiring, probe } = testWiring(tempRepo(), { ...options, tracker, config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 } });
  const wired = trackerOf === undefined ? wiring : { ...wiring, tracker: () => Result.succeed(Layer.succeed(Tracker, trackerOf(tracker.tracker))) };
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement", item.id, terms), wired)));
  const after = (await Effect.runPromise(tracker.items))[0]!;
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  return { code, probe, after, conversation };
};
const answered: TestOptions = { answers: ["A", "A"], closings: [{ output: summaryReply("# Requirements\n\nQ1: A, Q2: A", "Done.") }], reviews: [{ issues: [] }] };

test("a current preparation of two questions: its first question first, no list, review or terms call, and no preparation comment left", async () => {
  const { code, probe, after, conversation } = await refine(prepared([stored("Q1"), stored("Q2")]), answered);
  assert.equal(code, 0);
  assert.equal(probe.planner.prompts.length, 0, "a question-list call was made");
  assert.equal(probe.planner.termsPrompts.length, 0, "a terms call was made");
  assert.equal(probe.reviewer.prompts.length, 1, "a review other than the requirements review was made");
  assert.equal(questionText(presentedQuestions(probe.ui)[0]!), "question Q1?");
  assert.equal(after.state, "refined");
  assert.equal(preparationOf(after.comments ?? [], after, null).ids.length, 0);
  assert.ok(conversation.includes(prompts.preparationUsedLine(KEY)), conversation);
});

test("a preparation made from another title is ignored: the whole phase runs, and its comments are deleted at the end", async () => {
  const stale = prepared([stored("Q1")], { title: "An older title", body: BASE.body });
  const { code, probe, after } = await refine(stale, {
    answers: ["A"],
    steps: [{ output: { questions: [stored("Q9")] } }],
    closings: [{ output: summaryReply("# Requirements\n\nQ9: A", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  assert.equal(code, 0);
  assert.equal(probe.planner.prompts.length, 1);
  assert.equal(preparationOf(after.comments ?? [], after, null).ids.length, 0);
});

test("a preparation with no question ends 0 with NOTHING_TO_SETTLE, refined, and no agent called at all", async () => {
  const { code, probe, after, conversation } = await refine(prepared([]), {});
  assert.equal(code, 0);
  assert.equal(probe.planner.prompts.length + probe.planner.termsPrompts.length + probe.reviewer.prompts.length, 0);
  assert.equal(after.state, "refined");
  assert.ok(conversation.includes(prompts.NOTHING_TO_SETTLE));
  assert.ok(fs.readFileSync(path.join(probe.dir, "requirements.md"), "utf8").includes("No question was needed."));
});

test("with the choice onRequest a prepared item offers no Explain the terms: its terms come from the preparation", async () => {
  const { code, probe, conversation } = await refine(prepared([stored("Q1"), stored("Q2")]), answered, undefined, "onRequest");
  assert.equal(code, 0);
  assert.ok(probe.ui.asked.every((p) => !p.includes(prompts.TERMS_OFFER_LINE)), "the terms were offered");
  assert.ok(conversation.includes(prompts.PREPARED_TERMS_CHOICE_LINE));
});

test("a deletion of the preparation's comments that fails for good leaves the run ending 0, and says so", async () => {
  const failing = (t: TrackerShape): TrackerShape => ({ ...t, deleteComment: () => Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) });
  const { code, after, conversation } = await refine(prepared([stored("Q1"), stored("Q2")]), answered, failing);
  assert.equal(code, 0);
  assert.equal(after.state, "refined");
  assert.ok(conversation.includes(prompts.preparationCleanupFailedLine(BASE.id, "GitHub: down").split(":")[0]!), conversation);
  // A leftover preparation followed by the refinement's record is spent, never used again.
  assert.equal(preparationOf(after.comments ?? [], after, null)._tag, "Spent");
});
