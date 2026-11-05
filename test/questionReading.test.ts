// Issue #166 (requirements Q2): the prompts of Codex's reading of the agreed questions' last sentences, and of Claude
// Code's answer to it, naming the reading's own records; the question list's own prompts unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { questionReadingSubject, questionSubject } from "../src/subjects.ts";
import { TEST_ROOT } from "./helpers.ts";

const criterion = (id: string) => prompts.QUESTION_RULES.find((r) => r.id === id)!.criterion;

test("the reading's prompt carries its marker, the five criteria and the reading's log, in a first and a later round", () => {
  for (const [round, thread] of [[1, "continued"], [2, "continued"], [3, "new"]] as const) {
    const text = prompts.questionReadingPrompt(TEST_ROOT, round, thread);
    assert.ok(text.includes(prompts.QUESTION_READING_MARKER), `${round}`);
    assert.ok(text.includes("question-reading-log.json"), `${round}`);
    assert.ok(!text.includes("questions-log.json"), `${round}`);
  }
  const first = prompts.questionReadingPrompt(TEST_ROOT, 1, "continued");
  for (const id of ["headingAlone", "oneReading", "programWords", "noInternalTerms", "nameThings"]) assert.ok(first.includes(criterion(id)), id);
  assert.match(first, /H-R1-1/);
  for (const text of [prompts.questionReviewPrompt(TEST_ROOT, 1, "continued"), prompts.questionRespondPrompt(TEST_ROOT, 1), prompts.termsReviewPrompt(TEST_ROOT, 1, "continued")]) assert.ok(!text.includes(prompts.QUESTION_READING_MARKER));
});

test("the question list's response and application prompts are unchanged for its own review, and name the reading's records for the reading", () => {
  assert.equal(prompts.questionRespondPrompt(TEST_ROOT, 2), prompts.questionRespondPrompt(TEST_ROOT, 2, "questions"));
  assert.equal(prompts.questionApplyDecisionsPrompt(TEST_ROOT), prompts.questionApplyDecisionsPrompt(TEST_ROOT, "questions"));
  assert.match(prompts.questionRespondPrompt(TEST_ROOT, 2), /question-review\/review-2\.json contains a review of the question list/);
  assert.match(prompts.questionRespondPrompt(TEST_ROOT, 2), /questions-log\.json/);
  const respond = prompts.questionRespondPrompt(TEST_ROOT, 2, "questionReading");
  const apply = prompts.questionApplyDecisionsPrompt(TEST_ROOT, "questionReading");
  assert.match(respond, /question-reading\/review-2\.json/);
  for (const text of [respond, apply]) {
    assert.match(text, /question-reading-log\.json/);
    assert.doesNotMatch(text, /questions-log\.json/);
  }
  const subject = questionReadingSubject("task");
  assert.equal(subject.applyDecisions.prompt(TEST_ROOT), apply);
  assert.equal(subject.respond.prompt(TEST_ROOT, 2, { review: { issues: [] }, log: [], records: null }), respond);
  assert.equal(subject.reviewPrompt(TEST_ROOT, 1, "continued"), prompts.questionReadingPrompt(TEST_ROOT, 1, "continued"));
  assert.equal(subject.disputesSettledBy, "agents");
  assert.equal(questionSubject("task").applyDecisions.prompt(TEST_ROOT), prompts.questionApplyDecisionsPrompt(TEST_ROOT));
});
