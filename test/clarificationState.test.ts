// Issue #184 (S1): examples of the first interview's state (src/clarificationState.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PremiseEntry } from "../src/premises.ts";
import { INITIAL_CLARIFICATION, nextQuestion, progressOf, takeFollowUp, withAnswer, withFollowUps, withShown } from "../src/clarificationState.ts";
import { opt } from "./helpers.ts";

const questions: readonly PremiseEntry[] = ["Q1", "Q2", "Q3"].map((id) => ({ id, proposed_answers: [opt("a"), opt("b")], skip_if: null }));
const ids = questions.map((q) => q.id);
const followUp = (id: string) => ({ id, context: [], history: [], text: [], explanations: [], options: [] });

test("a follow-up received while a question is shown comes before the next agreed question", () => {
  const shown = withShown(INITIAL_CLARIFICATION, "Q1");
  const received = withFollowUps(shown, [followUp("F1")], ids);
  const answered = withAnswer(received, "Q1", { kind: "option", label: "a" });
  const next = nextQuestion(questions, answered);
  assert.equal(next.kind, "followUp");
  assert.equal(next.kind === "followUp" ? next.followUp.id : "", "F1");
  const after = withAnswer(takeFollowUp(answered), "F1", null);
  const then = nextQuestion(questions, after);
  assert.equal(then.kind === "agreed" ? then.question.id : "", "Q2");
  assert.deepEqual(progressOf(ids, questions, after), { answered: 2, total: 4 });
});

test("a follow-up naming an agreed question, or an id already received, is dropped", () => {
  const once = withFollowUps(INITIAL_CLARIFICATION, [followUp("Q2"), followUp("F1")], ids);
  const twice = withFollowUps(takeFollowUp(once), [followUp("F1"), followUp("F2")], ids);
  assert.deepEqual(once.followUps.map((f) => f.id), ["F1"]);
  assert.deepEqual(twice.followUps.map((f) => f.id), ["F2"]);
  assert.deepEqual(twice.askedFollowUps, ["F1", "F2"]);
});
