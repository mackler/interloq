// Issue #98: what Interloq reads back from disk or the tracker, written before an option carried `figure`, decodes
// with no picture, so prepared comments already on items, earlier runs' round files and a relayed question's JSON
// written without the field keep their meaning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result, Schema } from "effect";
import { runCommentKey } from "../src/itemComments.ts";
import { type PreparedQuestion, digestOf, preparationOf, preparedComments } from "../src/preparedComments.ts";
import { parseRelayedQuestion } from "../src/question.ts";
import { RoundFile } from "../src/records.ts";
import { QuestionsFile } from "../src/schema.ts";
import type { ItemId, TrackerItem } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

const plain = (text: string) => [{ text, ref: "", code: false }];
const oldOption = (label: string) => ({ label: plain(label), description: plain(`${label}, described.`) });

test("a prepared comment written before figures decodes, each answer with no picture", () => {
  const item: TrackerItem = { id: "98" as ItemId, title: "Figures", body: "Text.", state: "unrefined", url: Option.none() };
  const key = runCommentKey("2026-11-03T00-00-00-000Z-preparation-98");
  const entry = { id: "Q1", context: [], history: [], question: plain("Which?"), reason: [], proposed_answers: [{ ...oldOption("A"), figure: null }, { ...oldOption("B"), figure: null }], default_answer: "A", skip_if: null };
  const pq: PreparedQuestion = { entry, terms: { id: "Q1", explanations: [], context: [], history: [], question: entry.question, reason: [], proposed_answers: entry.proposed_answers } };
  const texts = Result.getOrThrow(preparedComments(key, [pq], { _tag: "Prepared", key, digest: digestOf(item), count: 1, generation: 1, date: "2026-11-03" })).map((c) => c.text);
  const old = texts.map((t) => t.replaceAll(',"figure":null', ""));
  assert.ok(old.every((t) => !t.includes("figure")), "the comments were written in the old shape");
  const found = preparationOf(old.map((body, i) => ({ id: seededId(`f-${i}`), body, created: "2026-11-03T00:00:00Z" })), item, 1);
  assert.equal(found._tag, "Prepared");
  if (found._tag !== "Prepared") return;
  assert.deepEqual(found.questions[0]!.proposed_answers.map((a) => a.figure), [null, null]);
  assert.deepEqual(found.terms[0]!.proposed_answers.map((a) => a.figure), [null, null]);
});

test("questions.json written before figures decodes with no picture", () => {
  const file = { version: 2, task: "t", questions: [{ id: "Q1", context: [], history: [], question: plain("Which?"), reason: [], proposed_answers: [oldOption("A")], default_answer: null, skip_if: null }] };
  const decoded = Schema.decodeUnknownSync(QuestionsFile)(file);
  assert.equal(decoded.questions[0]!.proposed_answers[0]!.figure, null);
});

test("an earlier run's round file whose questions for the user carry no figure decodes with null", () => {
  const round = {
    version: 2, kind: "validated", subject: "planning-1", phase: 1, round: 1, reconstructed: false,
    review: { issues: [] },
    response: { dispositions: [], selfCorrections: [], reviewerFeedback: "", questionsForUser: [{ context: [], history: [], question: plain("Which?"), explanations: [], options: [oldOption("A"), oldOption("B")] }] },
    notes: [],
  };
  const decoded = Schema.decodeUnknownSync(RoundFile)(round);
  assert.equal(decoded.kind, "validated");
  if (decoded.kind !== "validated") return;
  assert.deepEqual(decoded.response.questionsForUser[0]!.options.map((o) => o.figure), [null, null]);
});

test("a relayed question's JSON without figure parses, each option with no picture", () => {
  const text = JSON.stringify({ context: [{ kind: "paragraph", pieces: plain("Interloq writes a file when a run ends.") }], history: [], question: plain("Which file do you want written?"), explanations: [], options: [oldOption("A"), oldOption("B")] });
  const parsed = parseRelayedQuestion(text, [{ label: "A", description: "A, described." }, { label: "B", description: "B, described." }]);
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed!.options.map((o) => o.figure), [null, null]);
});
