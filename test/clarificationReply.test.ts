// Issue #184 (S2): the first interview's reply (S.InterviewReply), the prompt that asks for it, its validation and its
// normalization, tested together (CLAUDE.md: a prompt and the validation of the value it asks for change together).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as S from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { replyValidation } from "../src/conversation.ts";
import { normalizeReply } from "../src/schemaNormalize.ts";
import { TEST_ROOT, opt } from "./helpers.ts";

const reply = (extra: Partial<S.InterviewReply> = {}): S.InterviewReply => ({ message_to_user: "", follow_ups: [], unnecessary: [], complete: false, summary: "", ...extra });
const followUp = (id: string): S.InterviewReply["follow_ups"][number] => ({
  id,
  context: [{ kind: "paragraph", pieces: [{ text: "The page shows one question at a time.", ref: "", code: false }] }],
  history: [],
  text: [{ text: "Which order do you want?", ref: "", code: false }],
  explanations: [],
  options: [opt("First"), opt("Second")],
});
const premises = { questions: [{ id: "Q1", context: [], history: [], question: [], reason: [], proposed_answers: [opt("a"), opt("b")], default_answer: null, skip_if: null }, { id: "Q2", context: [], history: [], question: [], reason: [], proposed_answers: [opt("a")], default_answer: null, skip_if: { question: "Q1", answer: "a" } }], answers: new Map([["Q1", { kind: "option" as const, label: "a" }]]) };

test("the rules name every field of the reply", () => {
  const rules = prompts.clarificationOpenPrompt(TEST_ROOT);
  for (const field of Object.keys(S.InterviewReply.fields)) assert.ok(rules.includes(field), field);
  assert.ok(prompts.clarificationRequestPrompt([], [], { kind: "listDone" }).includes(prompts.LIST_DONE_SENTENCE));
  assert.ok(!prompts.clarificationRequestPrompt([{ kind: "agreed", id: "Q1", text: "a", option: "a" }], [], null).includes(prompts.LIST_DONE_SENTENCE));
});

test("a blank or reused follow-up id is refused with a repair prompt naming it", () => {
  const validate = replyValidation(["Q1", "Q2"], ["F1"], premises, false);
  const blank = validate(reply({ follow_ups: [followUp(" ")] }));
  assert.ok(Result.isFailure(blank));
  assert.equal(blank.failure.error._tag, "InterviewTurnInvalid");
  assert.match(blank.failure.repair, /blank id/);
  const reused = validate(reply({ follow_ups: [followUp("F1")] }));
  assert.ok(Result.isFailure(reused) && reused.failure.repair.includes("F1"));
  const twice = validate(reply({ follow_ups: [followUp("F2"), followUp("F2")] }));
  assert.ok(Result.isFailure(twice) && twice.failure.repair.includes("F2"));
  assert.ok(Result.isSuccess(validate(reply({ follow_ups: [followUp("F2")] }))));
});

test("a closing summary that omits a skipped question is refused", () => {
  const closing = replyValidation(["Q1", "Q2"], [], premises, true);
  const omits = closing(reply({ complete: true, summary: "# Requirements\n\nQ1: a." }));
  assert.ok(Result.isFailure(omits) && omits.failure.repair.includes("Q2"));
  assert.ok(Result.isSuccess(closing(reply({ complete: true, summary: "Q1: a. Skipped questions: Q2." }))));
  // Not a closing request: the summary is ignored, so nothing is checked.
  assert.ok(Result.isSuccess(replyValidation(["Q1", "Q2"], [], premises, false)(reply({ complete: true, summary: "Q1: a." }))));
});

test("complete is ignored on a request that is not closing, and on a closing reply that asks a follow-up", () => {
  assert.equal(normalizeReply(reply({ complete: true, summary: "S" }), false).kind, "acknowledged");
  assert.equal(normalizeReply(reply({ complete: true, summary: "S", follow_ups: [followUp("F1")] }), true).kind, "acknowledged");
  assert.equal(normalizeReply(reply({ complete: true, summary: "  " }), true).kind, "acknowledged");
  assert.equal(normalizeReply(reply({ complete: true, summary: "S" }), true).kind, "summary_proposed");
});
