// Issue #131: the comments of an item's preparation as data: written legibly with one hidden data line, read back into
// what the item holds (none, partial, spent, stale, set aside, released, prepared).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { commentText, runCommentKey } from "../src/itemComments.ts";
import { refinementOf, withRefinement } from "../src/refinement.ts";
import {
  COMMENT_LENGTH_LIMIT,
  digestOf,
  eligible,
  markOf,
  type PreparationRecord,
  preparationCommentText,
  preparationOf,
  type PreparedQuestion,
  preparedComments,
  questionCommentText,
} from "../src/preparedComments.ts";
import type { StoredQuestion, TermsEntry } from "../src/schema.ts";
import { type ItemComment, type ItemId, type TrackerItem } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

const ITEM: TrackerItem = { id: "131" as ItemId, title: "Prepare questions", body: "The developer's text.", state: "unrefined", url: Option.none() };
const KEY = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131");
const plain = (text: string) => [{ text, ref: "", code: false }];
const question = (id: string, text = `Question ${id}?`): StoredQuestion => ({
  id,
  context: [{ kind: "paragraph", pieces: plain("The context.") }],
  history: [],
  question: plain(text),
  reason: [{ kind: "paragraph", pieces: plain("Why.") }],
  proposed_answers: [{ label: plain("Yes"), description: plain("Do it.") }, { label: plain("No"), description: plain("Do not.") }],
  default_answer: "Yes",
  skip_if: null,
});
const termsOf = (q: StoredQuestion): TermsEntry => ({ id: q.id, explanations: [{ id: "t1", term: "it", senses: ["the thing"] }], context: q.context, history: q.history, question: q.question, reason: q.reason, proposed_answers: q.proposed_answers });
const pq = (id: string, text?: string): PreparedQuestion => {
  const entry = question(id, text);
  return { entry, terms: termsOf(entry) };
};
const prepared = (count: number, generation = 1): PreparationRecord => ({ _tag: "Prepared", key: KEY, digest: digestOf(ITEM), count, generation, date: "2026-10-30" });
let next = 0;
const asComments = (texts: readonly string[]): ItemComment[] => texts.map((body) => ({ id: seededId(`p-${++next}`), body, created: "2026-10-30T00:00:00Z" }));
const written = (questions: readonly PreparedQuestion[], record: PreparationRecord = prepared(questions.length)): ItemComment[] =>
  asComments(Result.getOrThrow(preparedComments(KEY, questions, record)).map((c) => c.text));

test("a written preparation of two questions reads back Prepared with its questions and terms in order", () => {
  const qs = [pq("Q1"), pq("Q2")];
  const found = preparationOf(written(qs), ITEM, 1);
  assert.equal(found._tag, "Prepared");
  if (found._tag !== "Prepared") return;
  assert.deepEqual(found.questions, qs.map((q) => q.entry));
  assert.deepEqual(found.terms, qs.map((q) => q.terms));
  assert.equal(found.count, 2);
  assert.equal(found.ids.length, 3);
  assert.deepEqual(markOf(found), { _tag: "Prepared", questions: 2 });
  assert.equal(eligible(found), false);
});

test("the comments are the questions in order, then the preparation's own comment last", () => {
  const comments = Result.getOrThrow(preparedComments(KEY, [pq("Q1"), pq("Q2")], prepared(2)));
  assert.deepEqual(comments.map((c) => c.key), [runCommentKey(KEY, "q-1"), runCommentKey(KEY, "q-2"), KEY]);
});

test("no comment of a preparation is None; question comments without the own comment are Partial", () => {
  assert.equal(preparationOf(asComments(["a developer's comment"]), ITEM, 1)._tag, "None");
  const comments = written([pq("Q1"), pq("Q2")]);
  const partial = preparationOf(comments.slice(0, 2), ITEM, 1);
  assert.equal(partial._tag, "Partial");
  assert.equal(partial.ids.length, 2);
  assert.equal(eligible(partial), true);
  assert.equal(preparationOf([comments[0]!, comments[2]!], ITEM, 1)._tag, "Partial");
});

test("a preparation with no question is Prepared with count 0", () => {
  const found = preparationOf(written([]), ITEM, 1);
  assert.equal(found._tag, "Prepared");
  assert.deepEqual(markOf(found), { _tag: "Prepared", questions: 0 });
});

test("a refinement record after a complete preparation makes it Spent; one before it does not", () => {
  const record = asComments([commentText({ _tag: "RefinementRecord", key: runCommentKey("r"), date: "2026-10-30", asked: true })]);
  const comments = written([pq("Q1")]);
  assert.equal(preparationOf([...comments, ...record], ITEM, 1)._tag, "Spent");
  assert.equal(preparationOf([...record, ...comments], ITEM, 1)._tag, "Prepared");
});

test("a changed title or text makes a preparation Stale; the Refined using Interloq section does not count", () => {
  const comments = written([pq("Q1")]);
  assert.equal(preparationOf(comments, { ...ITEM, title: "Another title" }, 1)._tag, "Stale");
  assert.equal(preparationOf(comments, { ...ITEM, body: "Other text." }, 1)._tag, "Stale");
  const sectioned = { ...ITEM, body: Result.getOrThrow(withRefinement(ITEM.body, Result.getOrThrow(refinementOf("Requirements.")))) };
  assert.equal(digestOf(sectioned), digestOf(ITEM));
});

test("a set-aside reads back SetAside at its generation, Released at another, and Stale after an edit", () => {
  const record: PreparationRecord = { _tag: "SetAside", key: KEY, digest: digestOf(ITEM), generation: 3, date: "2026-10-30", cause: { _tag: "Paused", question: "Raise the round limit?" } };
  const comments = asComments([preparationCommentText(record)]);
  const found = preparationOf(comments, ITEM, 3);
  assert.equal(found._tag, "SetAside");
  assert.equal(eligible(found), false);
  assert.equal(markOf(found)?._tag, "SetAside");
  assert.equal(preparationOf(comments, ITEM, null)._tag, "SetAside");
  assert.equal(preparationOf(comments, ITEM, 4)._tag, "Released");
  assert.equal(preparationOf(comments, ITEM, 0)._tag, "Released");
  assert.equal(preparationOf(comments, { ...ITEM, title: "edited" }, 3)._tag, "Stale");
});

test("the newest preparation decides, and every preparation comment is reported for deletion", () => {
  const older = written([pq("Q1")]);
  const newer = asComments(Result.getOrThrow(preparedComments(runCommentKey("2026-10-31T00-00-00-000Z-preparation-131"), [pq("Q9")], { ...prepared(1), key: runCommentKey("2026-10-31T00-00-00-000Z-preparation-131") })).map((c) => c.text));
  const found = preparationOf([...older, ...newer], ITEM, 1);
  assert.equal(found._tag, "Prepared");
  if (found._tag === "Prepared") assert.deepEqual(found.questions.map((q) => q.id), ["Q9"]);
  assert.equal(found.ids.length, 4);
});

test("a question comment over the length limit is TooLong, naming the question", () => {
  const long = pq("Q2", "x".repeat(COMMENT_LENGTH_LIMIT));
  const result = preparedComments(KEY, [pq("Q1"), long], prepared(2));
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure, { _tag: "TooLong", question: "Q2" });
});

test("a question whose text holds comment closers and escapes round-trips exactly", () => {
  const text = "a --> b --!> c <!-- d \\ e \\u003e f > g";
  const comments = written([pq("Q1", text)]);
  const found = preparationOf(comments, ITEM, 1);
  assert.equal(found._tag, "Prepared");
  if (found._tag === "Prepared") assert.deepEqual(found.questions[0]!.question, plain(text));
  const first = questionCommentText(KEY, 1, 1, pq("Q1", text));
  assert.ok(Result.isSuccess(first));
});
