// The determination of need in a refinement run's questions (the developer's instruction of 29 Oct 2026): the question
// list is discovered by investigating the task and what accomplishing it requires, and a question is asked only where
// the user's knowledge or decision is needed. The writer's rule and the reviewer's criterion come from one source
// (QUESTION_RULES), and the concerns come from TASK_CONCERNS, so neither side can drift from the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const need = () => prompts.QUESTION_RULES.find((r) => r.id === "whetherToAsk")!;

test("the question list is asked for by investigation, not by what would change a plan", () => {
  const list = prompts.questionListPrompt("t");
  assert.doesNotMatch(list, /before you can write an implementation plan/, "the plan-change selection sentence is gone");
  assert.ok(list.includes(prompts.TASK_INVESTIGATION), "the list prompt carries TASK_INVESTIGATION");
  assert.match(prompts.TASK_INVESTIGATION, /Understand the task and what accomplishing it requires/);
  assert.match(prompts.TASK_INVESTIGATION, /intended outcome/);
  // Generate-then-filter is refused in the writer's own words, since no check can see the discarded questions.
  assert.match(prompts.TASK_INVESTIGATION, /Do not survey the choices the task contains, write a question for each and then remove/);
  assert.match(prompts.TASK_INVESTIGATION, /without writing an implementation plan/);
  assert.match(list, /Return an empty list where the investigation reached nothing that needs the user/);
});

test("the concerns are lenses from one source, given to the writer and to the reviewer alike", () => {
  const text = prompts.taskConcernsText();
  for (const concern of prompts.TASK_CONCERNS) assert.ok(text.includes(concern), concern);
  assert.match(text, /not as a checklist that owes a question each/);
  assert.match(text, /not exhaustive/);
  assert.ok(prompts.TASK_CONCERNS.includes("security"));
  assert.ok(prompts.TASK_CONCERNS.includes("cost and resource stewardship, the user's own time and attention included"));
  assert.ok(prompts.TASK_INVESTIGATION.includes(text), "the writer gets the concerns from taskConcernsText");
  for (const thread of ["continued", "new"] as const) {
    assert.ok(prompts.questionReviewPrompt(TEST_ROOT, thread === "new" ? 3 : 1, thread).includes(text), `the ${thread} thread's review gets the same text`);
  }
});

test("the named practices are examples that settle nothing by themselves", () => {
  for (const practice of ["Twelve-Factor App", "Humble and Farley", "Beck"]) assert.ok(prompts.TASK_INVESTIGATION.includes(practice), practice);
  assert.match(prompts.TASK_INVESTIGATION, /treat none of them as settling a choice by itself/);
});

test("whetherToAsk requires the user's knowledge or decision, and refuses a different plan as the ground", () => {
  const rule = need();
  for (const text of [rule.rule, rule.criterion]) {
    assert.match(text, /the user's knowledge or decision/, "the need is stated as the user's knowledge or decision");
    assert.match(text, /convention/, "the conventions the codebase follows are a source");
    assert.match(text, /practice/, "an applicable practice is a source");
  }
  assert.match(rule.rule, /does not establish the need/, "a different plan or different work is not the ground");
  assert.match(rule.rule, /responsibly carry yourself/);
  assert.match(rule.rule, /time and attention are scarce/);
  // The default is evidence and not a verdict, in both directions.
  assert.match(rule.rule, /is evidence that you may proceed without asking, and is not conclusive/);
  assert.match(rule.rule, /what would follow if it were wrong/);
  assert.match(rule.rule, /cost the user little to correct, choose the behavior the conventions or the practice support and do not ask/);
  // The four sources of the earlier rule, the premise and the instruction to settle it yourself all stand.
  for (const text of [rule.rule, rule.criterion]) {
    for (const source of ["the task text", "the codebase", "the project documentation"]) assert.ok(text.includes(source), source);
    assert.match(text, /answer the user has already given|earlier answer of the user/);
    assert.match(text, /premise/);
  }
  assert.match(rule.rule, /settle the matter yourself and say what you settled/);
});

test("the reviewer can raise an unnecessary question on evidence it holds", () => {
  const criterion = need().criterion;
  // Each clause names what the reviewer must point at, so that a violation is shown and not asserted.
  assert.match(criterion, /name the file, the convention or the answer/);
  assert.match(criterion, /although the user's knowledge or decision is not needed for it/);
  assert.match(criterion, /shows only that the answer would change the plan or the work/);
  assert.match(criterion, /name the convention or practice that supports the default/);
  assert.match(criterion, /cost the user more than the question costs/);
});

test("the reviewer can raise a consequential missing question on evidence it holds", () => {
  const review = prompts.questionReviewPrompt(TEST_ROOT, 1, "continued");
  assert.match(review, /a question is missing that the user's knowledge or decision is needed for/);
  assert.match(review, /name the concern it bears on, what in the task or the codebase leaves it open, and what would go wrong if the work proceeded without it/);
  assert.match(review, /not out of a survey of the choices that would change a plan/);
  // The criteria the review had before stay.
  assert.match(review, /a question combines several decisions/);
  assert.match(review, /a proposed answer is not feasible in this codebase/);
  assert.match(review, /does not carry the evidence the rule on whether to ask requires of it/);
});

test("the reason field carries the evidence both sides need, and the contract is unchanged", () => {
  const list = prompts.questionListPrompt("t");
  assert.match(list, /which of the task's concerns it bears on/);
  assert.match(list, /each source named/);
  assert.match(list, /what would follow if the answer in default_answer were wrong/);
  assert.match(list, /the cost of a wrong default can be compared with the cost of asking the user/);
  assert.match(list, /its support and the consequence of its being wrong go in the reason/);
  // No field was added, removed or retyped: the schema the agents receive is the one they received before.
  const entry = S.QuestionList.fields.questions;
  assert.ok(entry !== undefined, "QuestionList still carries questions");
  assert.deepEqual(Object.keys(S.QuestionEntry.fields).sort(), ["context", "default_answer", "history", "id", "proposed_answers", "question", "reason", "skip_if"].sort());
});

test("a follow-up question of the first interview is held to the same determination of need", () => {
  const rules = prompts.clarificationOpenPrompt(TEST_ROOT);
  assert.ok(rules.includes(prompts.questionWritingRules()), "the interview carries the writer's rules, whetherToAsk among them");
  assert.match(rules, /for which an answer has shown that you need the user's knowledge or decision/);
  assert.match(rules, /is not itself a reason to ask about it/);
  assert.match(rules, /settle anything else yourself from the codebase/);
  assert.doesNotMatch(rules, /any follow-up question that the answers make necessary/, "the undefined word 'necessary' is gone");
});
