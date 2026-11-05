// Issue #232: the rule that keeps accepted corrections and the check that holds a response to it come from one source,
// and one test exercises both, as test/stepCheckRule.test.ts does for the step checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathOf, recordPath } from "../src/artifacts.ts";
import { describe } from "../src/errors.ts";
import { appendUserDecision } from "../src/issueLog.ts";
import { CorrectionDropped } from "../src/errors.ts";
import * as K from "../src/keptCorrections.ts";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import type { LogEntry } from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const logs = {
  plan: pathOf({ kind: "log", subject: { plan: 1 } }),
  questions: pathOf({ kind: "log", subject: "questions" }),
  terms: pathOf({ kind: "log", subject: "terms" }),
  decision: pathOf({ kind: "log", subject: { decision: 1 } }),
};
const count = (text: string, part: string) => text.split(part).length - 1;

test("the four responses that rewrite their file carry the rule once, naming the log their loop reads", () => {
  const responds = {
    plan: prompts.planRespondPrompt(TEST_ROOT, 1, 2, S.NO_STEP_CHECKS),
    questions: prompts.questionRespondPrompt(TEST_ROOT, 2),
    terms: prompts.termsRespondPrompt(TEST_ROOT, 2),
    decision: prompts.decisionRespondPrompt(TEST_ROOT, 1, 2),
  };
  for (const [subject, text] of Object.entries(responds)) {
    const rule = prompts.keepCorrectionsRule(TEST_ROOT, logs[subject as keyof typeof logs]);
    assert.equal(count(text, rule), 1, subject);
    assert.ok(rule.includes(`${recordPath(TEST_ROOT, { kind: "log", subject: subject === "plan" ? { plan: 1 } : subject === "decision" ? { decision: 1 } : (subject as "questions" | "terms") })}`), subject);
  }
  for (const text of [prompts.requirementsRespondPrompt(TEST_ROOT, 2), prompts.planApplyDecisionsPrompt(TEST_ROOT, S.NO_STEP_CHECKS)]) assert.ok(!text.includes(prompts.KEEP_CORRECTIONS_SENTENCES.correctionMissing));
  const applies = { plan: prompts.planApplyDecisionsPrompt(TEST_ROOT, S.NO_STEP_CHECKS, 1), questions: prompts.questionApplyDecisionsPrompt(TEST_ROOT), terms: prompts.termsApplyDecisionsPrompt(TEST_ROOT), decision: prompts.decisionApplyDecisionsPrompt(TEST_ROOT, 1) };
  for (const [subject, text] of Object.entries(applies)) assert.equal(count(text, prompts.keepCorrectionsApplyRule(TEST_ROOT, logs[subject as keyof typeof logs])), 1, subject);
  assert.ok(prompts.correctivePrompt(TEST_ROOT, "plan.json", 1, ["P1-R1-1"]).includes(S.CORRECTION_PASSAGES_FIELD));
  assert.ok(prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, S.NO_STEP_CHECKS, "continued").includes(S.KEPT_PASSAGES_FIELD));
});

test("the rule names both fields and has one sentence for every kind of problem the check reports", () => {
  const rule = prompts.keepCorrectionsRule(TEST_ROOT, logs.plan);
  assert.ok(rule.includes(S.CORRECTION_PASSAGES_FIELD) && rule.includes(S.KEPT_PASSAGES_FIELD));
  for (const kind of prompts.KEPT_CORRECTION_PROBLEM_KINDS) assert.equal(count(rule, prompts.KEEP_CORRECTIONS_SENTENCES[kind]), 1, kind);
});

const baseline = [{ id: "P1-R1-1", passages: ["retry twice"] }];
const restatable = new Set(["P1-R1-1"]);
const accepted = (id: string) => ({ id: id as S.IssueId, action: "accepted" as const, reverses: null });
const rejected = (id: string, reverses: string | null) => ({ id: id as S.IssueId, action: "rejected" as const, reverses: reverses as S.IssueId | null });
/** A reply built as the rule describes passes; a reply that breaks one sentence gives that sentence's kind. */
const cases: readonly [string, K.KeptCorrectionsInput, readonly (typeof prompts.KEPT_CORRECTION_PROBLEM_KINDS)[number][]][] = [
  ["kept, reflowed", { baseline, restatable, dispositions: [accepted("P1-R2-1")], entries: [{ id: "P1-R2-1", passages: ["log each try"] }], texts: ["retry\n twice, and log each  try"] }, []],
  ["restated", { baseline, restatable, dispositions: [], entries: [{ id: "P1-R1-1", passages: ["make two retry attempts"] }], texts: ["make two retry attempts"] }, []],
  ["reversed", { baseline, restatable, dispositions: [rejected("P1-R2-1", "P1-R1-1")], entries: [], texts: [""] }, []],
  ["no entry for an accepted issue", { baseline: [], restatable, dispositions: [accepted("P1-R2-1")], entries: [], texts: [] }, ["entryMissing"]],
  ["two entries", { baseline: [], restatable, dispositions: [accepted("P1-R2-1")], entries: [{ id: "P1-R2-1", passages: [] }, { id: "P1-R2-1", passages: [] }], texts: [] }, ["entryDuplicate"]],
  ["an entry for an issue not accepted", { baseline: [], restatable, dispositions: [rejected("P1-R2-1", null)], entries: [{ id: "P1-R2-1", passages: [] }], texts: [] }, ["entryNotAccepted"]],
  ["a blank passage", { baseline: [], restatable, dispositions: [accepted("P1-R2-1")], entries: [{ id: "P1-R2-1", passages: [" "] }], texts: [] }, ["passageBlank"]],
  ["a passage not in the file", { baseline: [], restatable, dispositions: [accepted("P1-R2-1")], entries: [{ id: "P1-R2-1", passages: ["absent"] }], texts: ["present"] }, ["passageNotInReply"]],
  ["a correction dropped", { baseline, restatable, dispositions: [], entries: [], texts: ["rewritten"] }, ["correctionMissing"]],
  ["a reversal of its own id does not count", { baseline, restatable, dispositions: [rejected("P1-R1-1", null)], entries: [], texts: ["rewritten"] }, ["correctionMissing"]],
];

test("a reply as the rule describes passes the check, and one that breaks a sentence gives that sentence's kind", () => {
  for (const [name, input, kinds] of cases) assert.deepEqual(K.keptCorrectionProblems(input).map((p) => p.kind), kinds, name);
});

test("for every kind, the repair prompt and the halt name the problem's id and passage, the repair prompt with its sentence", () => {
  for (const kind of prompts.KEPT_CORRECTION_PROBLEM_KINDS) {
    const problem = { kind, id: "P1-R7-3", passage: kind === "passageNotInReply" || kind === "correctionMissing" ? "the passage" : "" };
    const repair = prompts.keptCorrectionsRepairPrompt([problem]);
    const halt = describe(new CorrectionDropped({ problems: [problem] }));
    for (const text of [repair, halt]) {
      assert.ok(text.includes(problem.id), `${kind}: ${text}`);
      if (problem.passage !== "") assert.ok(text.includes(problem.passage), kind);
    }
    assert.ok(repair.includes(prompts.KEEP_CORRECTIONS_SENTENCES[kind]), kind);
  }
});

// Work review 1 of issue #232 (W1-R1-1): the rules name only the entries the check reads, the current entries of this review.
test("both rules state the scope the check reads, once each, and never ask for every entry of the log", () => {
  for (const rule of [prompts.keepCorrectionsRule(TEST_ROOT, logs.plan), prompts.keepCorrectionsApplyRule(TEST_ROOT, logs.plan)]) {
    assert.equal(count(rule, prompts.KEPT_CORRECTIONS_SCOPE_SENTENCE), 1, rule);
    assert.ok(!rule.includes("every entry of the log"), rule);
  }
});

const kept = (phase: number) =>
  ({ id: "P1-R1-1" as S.IssueId, phase, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r", duplicate_of: null, reverses: null, reviewer_position: null, planner_position: null, resolution: null, investigations: [], superseded: false, file_change: null, task_dispute: false, work_effects: null, kept_passages: ["retry twice"] }) as LogEntry;
const missingOf = (log: readonly LogEntry[], phase: number) =>
  K.keptCorrectionProblems({ baseline: K.keptBaselineOf(log, phase), restatable: K.restatable(log, phase), dispositions: [], entries: [], texts: ["rewritten"] }).filter((p) => p.kind === "correctionMissing");

test("the scope the sentence states is the check's: a user's decision and an earlier review end the protection", () => {
  const decided = appendUserDecision([kept(1)], "P1-R1-1" as S.IssueId, "do it another way", 1, 2);
  assert.deepEqual(K.keptBaselineOf(decided, 1), []);
  assert.deepEqual(missingOf(decided, 1), []);
  assert.deepEqual(missingOf([kept(1)], 2), []);
  assert.equal(missingOf([kept(1)], 1).length, 1);
});
