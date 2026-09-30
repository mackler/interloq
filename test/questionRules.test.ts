// S1: one statement of the rules for a question put to the user. The prompt that asks an agent for a question and the
// review that approves one are both rendered from QUESTION_RULES, so that they cannot disagree (rules for changes: the seam).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";

const RULE_IDS = ["selfContained", "nameThings", "noIdentifiers", "noLiterals", "kindBeforeNumber", "oneWord", "noInternalTerms", "questionLast", "context", "contextNoAnnouncement", "purposeOwner", "askWhatUserWants", "determinateOptions", "optionDifferences", "terms"];

test("QUESTION_RULES holds one entry per rule, with unique ids and a rule and a criterion each", () => {
  assert.deepEqual(prompts.QUESTION_RULES.map((r) => r.id), RULE_IDS);
  for (const r of prompts.QUESTION_RULES) {
    assert.ok(r.rule.trim().length > 0, r.id);
    assert.ok(r.criterion.trim().length > 0, r.id);
  }
});

test("the writer's rendering carries every rule, and the reviewer's every criterion, from the one array", () => {
  const writing = prompts.questionWritingRules();
  const review = prompts.questionReviewCriteria();
  for (const r of prompts.QUESTION_RULES) {
    assert.ok(writing.includes(r.rule), `the writing rules lack ${r.id}`);
    assert.ok(review.includes(r.criterion), `the review criteria lack ${r.id}`);
  }
});

test("the context rule names the five points, in the words the reviewer checks", () => {
  const context = prompts.QUESTION_RULES.find((r) => r.id === "context")!;
  for (const text of [context.rule, context.criterion]) {
    for (const point of [/one to three words/, /what each does/, /where in the application/, /when, during the operation of the program/, /purpose .* in computing terms and in human terms/]) assert.match(text, point, context.id);
  }
});

test("every prompt that may return questions_for_user carries the writer's rendering", () => {
  const texts = [
    prompts.planRespondPrompt(1, 1),
    prompts.requirementsRespondPrompt(1),
    prompts.questionRespondPrompt(1),
    prompts.decisionRespondPrompt(1, 1),
    prompts.workRespondPrompt(1, 1, { review: { issues: [] }, log: [], changes: null }),
    prompts.initialPlanPrompt("t", false),
    prompts.revisePlanPrompt,
    prompts.revisePlanAfterExecutionPrompt(1, { stopped: false, workReview: "converged" }),
  ];
  for (const text of texts) assert.ok(text.includes(prompts.questionWritingRules()), text.slice(0, 80));
});

// S15 (issues #34, #58, #59): the question list's prompt asks for the context of every entry under the rules, which
// apply to the reason, the proposed answers and the default too; its review is given the same rules as criteria.
test("the question list prompt carries the writer's rules and asks for a context per entry; its review carries the criteria", () => {
  const list = prompts.questionListPrompt("t");
  assert.ok(list.includes(prompts.questionWritingRules()));
  assert.match(list, /context: the context paragraph that precedes the question/);
  assert.match(list, /The rules apply to the question, its reason, its proposed answers and its default alike/);
  const review = prompts.questionReviewPrompt(1);
  assert.ok(review.includes(prompts.questionReviewCriteria()));
  // The criteria the review had before stay.
  assert.match(review, /a question is ambiguous or combines several decisions/);
  const respond = prompts.questionRespondPrompt(1);
  assert.ok(respond.includes(prompts.questionWritingRules()));
});

// S16 of the task of issue #36 (issue #59): what an option says, how the context paragraph is written, and what the
// question sentence asks; each rule and its criterion from the one array, the preamble from one constant.
test("S16: an option states only how it differs, by the preamble that is never displayed, in the rule and in the criterion", () => {
  const rule = prompts.QUESTION_RULES.find((r) => r.id === "optionDifferences")!;
  for (const text of [rule.rule, rule.criterion]) assert.ok(text.includes(prompts.OPTION_DIFFERENCE_PREAMBLE), text);
  assert.equal(prompts.OPTION_DIFFERENCE_PREAMBLE, "This choice differs from the others, because if you make this choice, then unlike any other choices, ...");
  assert.match(rule.rule, /shared? .*neither|described in neither/);
  assert.match(rule.rule, /names? which ones/);
  assert.match(rule.rule, /descending order of how many other options/);
});

test("S16: the context does not announce itself, a purpose names its owner, and the question asks what the user wants", () => {
  const byId = (id: string) => prompts.QUESTION_RULES.find((r) => r.id === id)!;
  assert.match(byId("contextNoAnnouncement").rule, /Two parts are involved/);
  assert.match(byId("contextNoAnnouncement").rule, /begins with the first thing it describes/);
  assert.match(byId("purposeOwner").rule, /is what allows you to/);
  assert.match(byId("askWhatUserWants").rule, /How do you want/);
  for (const id of ["contextNoAnnouncement", "purposeOwner", "askWhatUserWants", "optionDifferences"]) {
    assert.ok(prompts.questionWritingRules().includes(byId(id).rule), id);
    assert.ok(prompts.questionReviewCriteria().includes(byId(id).criterion), id);
  }
});
