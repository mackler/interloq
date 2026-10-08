// S1: one statement of the rules for a question put to the user. The prompt that asks an agent for a question and the
// review that approves one are both rendered from QUESTION_RULES, so that they cannot disagree (rules for changes: the seam).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";

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
  // The criteria the review had before stay; ambiguity is the criterion of determinateOptions since issue #96.
  assert.match(review, /a question combines several decisions/);
  assert.doesNotMatch(review, /a question is ambiguous or combines/);
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

// Issues #59, #91, #92 and #93 (5 Oct 2026): what each of the seven rules of the question put to the user says, in the
// writer's rule and in the reviewers' criterion, each entry looked up by its id.
test("the seven rules of 5 Oct 2026 say, in the rule and in the criterion, what the writer and the reviewers are held to", () => {
  const byId = (id: string) => {
    const found = prompts.QUESTION_RULES.find((r) => r.id === id);
    assert.ok(found !== undefined, `QUESTION_RULES has no entry ${id}`);
    return found;
  };
  const both = (id: string) => [byId(id).rule, byId(id).criterion];
  for (const text of both("statedWarrant")) for (const word of ["'so'", "'therefore'", "'which means'", "'hence'", "'thus'"]) assert.ok(text.includes(word), word);
  const occasions = ["at a commit", "on every push", "when someone asks for it"];
  assert.ok(byId("developmentFacts").rule.includes("The adapter builds the options of each call and is tested against a fake of the library"));
  for (const text of both("developmentFacts")) for (const occasion of occasions) assert.ok(text.includes(occasion), occasion);
  for (const text of both("readerInstructions")) for (const name of ["'the repository's rules'", "'the repository's instructions'", "'the project's rules'", "'the rules'"]) assert.ok(text.includes(name), name);
  assert.ok(byId("namedActor").rule.includes("its text is shown to you before it is written"));
  for (const text of both("namedActor")) for (const actor of ["who shows", "who writes", "who decides", "who refuses"]) assert.ok(text.includes(actor), actor);
  for (const text of both("contextBearsOnChoice")) assert.match(text, /five points .*this one governs|disagree, this one governs/);
  for (const text of both("readerConsequence")) for (const cost of ["time", "work that falls to someone later", "a risk", "money"]) assert.ok(text.includes(cost), cost);
});

// Issues #95 and #99 (S5): one statement of whether to ask, over the four sources, with the premise its options share.
test("whetherToAsk names the three conditions, the four sources and the premise, in the rule and in the criterion", () => {
  const rule = prompts.QUESTION_RULES.find((r) => r.id === "whetherToAsk");
  assert.ok(rule !== undefined, "QUESTION_RULES has no entry whetherToAsk");
  for (const text of [rule.rule, rule.criterion]) {
    for (const source of ["the task text", "the codebase", "the project documentation"]) assert.ok(text.includes(source), source);
    assert.match(text, /answer the user has already given|earlier answer of the user/);
    assert.match(text, /premise/);
  }
  assert.match(rule.rule, /settle the matter yourself and say what you settled/);
  const consequence = prompts.QUESTION_RULES.find((r) => r.id === "readerConsequence")!;
  assert.doesNotMatch(consequence.rule, /whether to ask/, "readerConsequence no longer states the inclusion test");
  assert.doesNotMatch(consequence.criterion, /should have settled/);
});

// Issue #96 (S6): what an option's label carries and what its description carries is stated once, in determinateOptions.
test("determinateOptions alone says that a label names the outcome and the description what produces it", () => {
  const byId = (id: string) => prompts.QUESTION_RULES.find((r) => r.id === id)!;
  const options = byId("determinateOptions");
  for (const text of [options.rule, options.criterion]) {
    assert.match(text, /label/);
    assert.match(text, /outcome/);
    assert.match(text, /mechanism/);
    assert.match(text, /taken two ways/);
  }
  assert.ok(options.rule.includes("docs/decision-making.md"));
  assert.match(options.rule, /as they are now/);
  const outcome = byId("askOutcome");
  for (const text of [outcome.rule, outcome.criterion]) assert.doesNotMatch(text, /label|make those outcomes the options/);
});

// Issue #97 (S7): a consequence is computed for the configuration the task names, not described in general terms.
test("readerConsequence asks for the consequence computed for the configuration the task names", () => {
  const consequence = prompts.QUESTION_RULES.find((r) => r.id === "readerConsequence")!;
  for (const text of [consequence.rule, consequence.criterion]) {
    for (const example of ["a window size", "a file", "a count", "a version"]) assert.ok(text.includes(example), example);
    assert.match(text, /when X is taller than Y/);
    assert.match(text, /cannot be (had|computed)/);
    for (const cost of ["time", "work that falls to someone later", "a risk", "money"]) assert.ok(text.includes(cost), cost);
  }
});

// Issue #111: a question may not ask the reader for the knowledge its own explanations exist to give him; a choice between
// two wordings he can see is the exception. The writer's rule and the reviewers' criterion both say so.
test("explainedKnowledge names the meaning of a term, whether it needs explaining, the codebase, and the exception of two wordings", () => {
  const rule = prompts.QUESTION_RULES.find((r) => r.id === "explainedKnowledge");
  assert.ok(rule !== undefined, "QUESTION_RULES has no entry explainedKnowledge");
  for (const text of [rule.rule, rule.criterion]) {
    assert.match(text, /what a term (means|should mean)/);
    assert.match(text, /whether a term needs explaining/);
    assert.match(text, /codebase|the code settles/);
    assert.match(text, /two wordings/);
    assert.match(text, /in how they read, not in what they claim|in how they read and not in what they claim/);
  }
  assert.equal(prompts.QUESTION_RULES.findIndex((r) => r.id === "explainedKnowledge"), prompts.QUESTION_RULES.findIndex((r) => r.id === "whetherToAsk") + 1);
});
