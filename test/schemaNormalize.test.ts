import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { describe } from "../src/errors.ts";
import { clarificationCount, normalizeQuestionList, normalizeReport, normalizeTurn } from "../src/schemaNormalize.ts";
import { currentOf, entryOf } from "./helpers.ts";

// Finding 8 / decision Q4: the wire shapes become variants after decoding.
const turn = (complete: boolean, summary: string) => ({ message_to_user: "m", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1", "F1"], answered_ids: ["Q1"], complete, summary });
const ids = { asked: ["Q1", "F1"], answered: ["Q1"], current: currentOf({ id: "", context: "", text: "", terms: [], options: [] }) };

test("normalizeTurn: a summary is proposed only when complete is true and the summary is not blank", () => {
  assert.deepEqual(normalizeTurn(turn(true, "# Requirements")), { kind: "summary_proposed", message: "m", summary: "# Requirements", ...ids });
  assert.deepEqual(normalizeTurn(turn(true, "   \n")), { kind: "continuing", message: "m", ...ids });
  assert.deepEqual(normalizeTurn(turn(false, "# Requirements")), { kind: "continuing", message: "m", ...ids });
  assert.deepEqual(normalizeTurn(turn(false, "")), { kind: "continuing", message: "m", ...ids });
});

test("normalizeReport: finished, awaiting input with the question, blocked with the description", () => {
  assert.deepEqual(normalizeReport({ status: "finished", summary: "s", question: "ignored", remaining_work: "" }), { kind: "finished", summary: "s", remainingWork: "" });
  assert.deepEqual(normalizeReport({ status: "needs_input", summary: "s", question: "A or B?", remaining_work: "w" }), { kind: "awaiting_input", question: "A or B?", summary: "s", remainingWork: "w" });
  assert.deepEqual(normalizeReport({ status: "blocked", summary: "s", question: "no network", remaining_work: "w" }), { kind: "blocked", description: "no network", summary: "s", remainingWork: "w" });
});

const q = (id: string, defaultAnswer: string) => entryOf({ id, context: "c", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: defaultAnswer });

test("normalizeQuestionList keeps a default that names a proposed answer and nulls one that does not, with a note", () => {
  const result = normalizeQuestionList({ questions: [q("Q1", "A"), q("Q2", "C")] });
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success.questions.map((x) => x.default_answer), ["A", null]);
  assert.equal(result.success.notes.length, 1);
  assert.match(result.success.notes[0], /Q2.*C/);
});

test("normalizeQuestionList fails with QuestionListInvalid for duplicate or empty ids", () => {
  const duplicate = normalizeQuestionList({ questions: [q("Q1", "A"), q("Q1", "B"), q("Q2", "A"), q("Q2", "A")] });
  assert.ok(Result.isFailure(duplicate));
  assert.deepEqual(duplicate.failure.duplicateIds, ["Q1", "Q2"]);
  assert.match(describe(duplicate.failure), /more than one question with the id: Q1, Q2/);
  const empty = normalizeQuestionList({ questions: [q("", "A")] });
  assert.ok(Result.isFailure(empty));
  assert.equal(empty.failure.emptyIds, 1);
});

// Issue #21 (Q6): "x of N answered", N the agreed questions and the follow-ups asked so far.
test("clarificationCount: the agreed and the asked questions make the total, the answered among them the count", () => {
  assert.deepEqual(clarificationCount(["Q1", "Q2", "Q3"], [], [], []), { answered: 0, total: 3 });
  assert.deepEqual(clarificationCount(["Q1", "Q2", "Q3"], ["Q1", "Q2"], ["Q1"], []), { answered: 1, total: 3 });
  assert.deepEqual(clarificationCount(["Q1", "Q2"], ["Q1", "F1", "Q2", "F2"], ["Q1", "F1"], []), { answered: 2, total: 4 }, "follow-ups raise the total");
  assert.deepEqual(clarificationCount(["Q1"], ["Q1", "Q1", "F1", "F1"], ["F1", "F1", "Q1"], []), { answered: 2, total: 2 }, "repeated ids have no effect");
  assert.deepEqual(clarificationCount(["Q1"], ["Q1"], ["Q1", "Z9"], []), { answered: 1, total: 1 }, "an answered id that was neither agreed nor asked is not counted");
  assert.deepEqual(clarificationCount([], [], [], []), { answered: 0, total: 0 });
  assert.deepEqual(clarificationCount(["Q1", "Q2", "Q3"], ["Q1", "Q3"], ["Q1"], ["Q2"]), { answered: 1, total: 2 }, "issue #99: a skipped question is not counted");
  assert.deepEqual(clarificationCount(["Q1", "Q2"], ["Q1", "Q2"], ["Q1"], ["Q2"]), { answered: 1, total: 1 }, "issue #99: nor is a skipped one asked earlier");
});

// S3: the question an interview turn asks now reaches the Ui whole, with its context, terms and options.
test("normalizeTurn keeps the current question's context, terms and options", () => {
  const current = currentOf({ id: "F1", context: "Interloq, the orchestrator, asks.", text: "Which one?", terms: [{ term: "Interloq", explanation: "the program" }], options: [{ label: "A", description: "a" }] });
  assert.deepEqual(normalizeTurn({ ...turn(false, ""), current_question: current }).current, current);
});
