// Issue #99 (S2): the problems of a list's skip conditions, case by case, and the premise a question waits on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { type PremiseEntry, orderBySkipCondition, skipConditionProblems, skippedQuestions, waitingFor } from "../src/premises.ts";
import { opt } from "./helpers.ts";

const entry = (id: string, skip_if: PremiseEntry["skip_if"] = null, labels: readonly string[] = ["Yes", "No"]): PremiseEntry => ({ id, proposed_answers: labels.map((l) => opt(l, `${l}.`)), skip_if });

test("a condition naming a question not in the list is reported", () => {
  assert.deepEqual(skipConditionProblems([entry("Q1"), entry("Q2", { question: "Q9", answer: "No" })]), [{ kind: "unknownQuestion", id: "Q2", names: "Q9" }]);
});

test("a condition naming its own entry is reported, and the order rejects it", () => {
  const list = [entry("Q1", { question: "Q1", answer: "No" })];
  assert.deepEqual(skipConditionProblems(list), [{ kind: "selfReference", id: "Q1" }]);
  const ordered = orderBySkipCondition(list);
  assert.ok(Result.isFailure(ordered));
  assert.deepEqual(ordered.failure, { kind: "selfReference", id: "Q1" });
});

test("a condition naming an answer that is none of the named question's proposed answers is reported", () => {
  assert.deepEqual(skipConditionProblems([entry("Q1"), entry("Q2", { question: "Q1", answer: "Maybe" })]), [{ kind: "unknownAnswer", id: "Q2", question: "Q1", answer: "Maybe" }]);
});

test("two entries naming each other are one cycle, reported once in the order of the list", () => {
  const list = [entry("Q1", { question: "Q2", answer: "No" }), entry("Q2", { question: "Q1", answer: "No" })];
  assert.deepEqual(skipConditionProblems(list), [{ kind: "cycle", ids: ["Q1", "Q2"] }]);
  assert.deepEqual(orderBySkipCondition(list), Result.fail({ kind: "cycle", ids: ["Q1", "Q2"] }));
});

test("a dependent question listed before its premise is moved after it", () => {
  const ordered = orderBySkipCondition([entry("Q2", { question: "Q1", answer: "No" }), entry("Q3"), entry("Q1")]);
  assert.ok(Result.isSuccess(ordered));
  assert.deepEqual(ordered.success.map((q) => q.id), ["Q3", "Q1", "Q2"]);
});

test("a question waits on its unanswered premise, and not once it is answered", () => {
  const list = [entry("Q1"), entry("Q2", { question: "Q1", answer: "No" })];
  assert.equal(waitingFor(list, new Map(), "Q2"), "Q1");
  assert.equal(waitingFor(list, new Map(), "Q1"), null);
  assert.equal(waitingFor(list, new Map([["Q1", { kind: "option", label: "Yes" }]]), "Q2"), null);
  assert.equal(waitingFor(list, new Map([["Q1", { kind: "text" }]]), "Q2"), null);
});

test("a skipped question names the question and the answer that removed it; one below it names the skipped premise", () => {
  const list = [entry("Q1"), entry("Q2", { question: "Q1", answer: "No" }), entry("Q3", { question: "Q2", answer: "Yes" })];
  assert.deepEqual(skippedQuestions(list, new Map([["Q1", { kind: "option", label: "No" }]])), [
    { id: "Q2", question: "Q1", answer: "No", cause: "answered" },
    { id: "Q3", question: "Q2", answer: "Yes", cause: "premiseSkipped" },
  ]);
  assert.deepEqual(skippedQuestions(list, new Map([["Q1", { kind: "option", label: "Yes" }]])), []);
});

// W1-R1-1: a summary names a skipped question by its whole id, not as part of a longer one.
test("mentionsId finds an id as a whole token and not inside a longer id", async () => {
  const { mentionsId } = await import("../src/premises.ts");
  for (const text of ["Q2", "Q2: no", "see Q2.", "(Q2)", "Q1 and Q2", "Q2\nnext", "- Q2, skipped"]) assert.ok(mentionsId(text, "Q2"), text);
  for (const text of ["Q20: answered.", "Q2a", "AQ2", "Q2-R1", "Q2_x", "", "Q1"]) assert.ok(!mentionsId(text, "Q2"), text);
});
