import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { planReviewPrompt, questionReviewPrompt } from "../src/prompts.ts";
import * as prompts from "../src/prompts.ts";
import { blocksMarkdown } from "../src/pieces.ts";
import { para, plain } from "./helpers.ts";
/** A tool's input as the terminal and conversation.md print it (S34): its blocks as Markdown, without the heading. */
const inputLines = (input: unknown): string => blocksMarkdown(prompts.toolInputBlocks(input).slice(1));
import { appendRound } from "../src/issueLog.ts";
import type { IssueId } from "../src/round.ts";
import * as S from "../src/schema.ts";

// Decision Q5: the prompts describe the version-2 issue log (an object with entries; three sources; null references).
test("the log rules name the entries list, the three sources and null references", () => {
  for (const text of [planReviewPrompt(1, 1, false), questionReviewPrompt(1)]) {
    assert.match(text, /'entries'/);
    assert.match(text, /source 'review'/);
    assert.match(text, /source 'self_correction'/);
    assert.match(text, /source 'user'/);
    assert.match(text, /duplicate_of .*null|null .*duplicate_of/);
  }
});

// Issue #31 (the seam of S7): every key the log rules name for the measurement is a key of an entry appendRound writes,
// and the rules name the field by the schema's constant. The rules are in round 1's prompt; later rounds refer to them in the same thread.
test("the log rules explain file_change with the keys the log entries carry", () => {
  const [entry] = appendRound([], { phase: 1, round: 1, review: { issues: [{ id: "P1-R1-1" as IssueId, severity: "major", location: "l", problem: "p", evidence: "e" }] }, dispositions: [{ id: "P1-R1-1" as IssueId, action: "accepted", rationale: "r", duplicateOf: null, reverses: null }], selfCorrections: [], notes: [], reviewerFeedback: "", questionsForUser: [] }, { changed: true, added: 1, removed: 0 });
  const serialized = JSON.parse(JSON.stringify(entry)) as Record<string, Record<string, unknown>>;
  for (const text of [planReviewPrompt(1, 1, false), questionReviewPrompt(1), prompts.requirementsReviewPrompt(1), prompts.decisionReviewPrompt("f", 1, 1), prompts.workReviewPrompt(1, 1, true)]) {
    assert.ok(text.includes(`${S.FILE_CHANGE_FIELD}:`), "the rules do not explain the field");
    for (const key of ["changed", "added", "removed"]) {
      assert.match(text, new RegExp(`\\b${key}\\b`));
      assert.ok(key in serialized[S.FILE_CHANGE_FIELD]!, `the entry lacks ${key}`);
    }
  }
});

// S16 and S18: the interview asks for a question's parts in current_question under the rules of every question; an
// agreed question of questions.json is named by its id alone, since the program shows it as it was reviewed.
test("the interview prompts ask for the current question's parts under the rules, and for an agreed question its id alone", () => {
  const texts = [prompts.interviewOpenPrompt, prompts.interviewGapsPrompt("plan-review/requirements-review/review-1.json", ["G-R1-1"])];
  for (const text of texts) {
    assert.ok(text.includes(prompts.questionWritingRules()));
    assert.match(text, /For an agreed question of plan-review\/questions\.json, give only its id/);
    assert.match(text, /For any other question, give its context, its text, its explanations and its options/);
    assert.doesNotMatch(text, /show each proposed answer on its own line/);
  }
});

// Plan step 2.6: the prompts of the work review and the revision of the plan after an execution phase.
test("the work review prompt names the change record, the plan, the requirements, the log and the ids", () => {
  const first = prompts.workReviewPrompt(2, 1, true);
  assert.match(first, /plan-review\/work-review-2\/changes\.diff/);
  assert.match(first, /plan-review\/plan\.json/);
  assert.match(first, /plan-review\/requirements\.md/);
  assert.match(first, /plan-review\/work-review-log\.json/);
  assert.match(first, /W2-R1-1/);
  assert.match(first, /Missing work of a step with another status is not an issue/);
  assert.doesNotMatch(prompts.workReviewPrompt(2, 1, false), /requirements\.md/);
  const later = prompts.workReviewPrompt(2, 3, true);
  assert.match(later, /W2-R3-1/);
  assert.match(later, /changes\.diff has been rewritten/);
});

test("the work response prompt forbids any file change and defers the corrections", () => {
  const text = prompts.workRespondPrompt(2, 1, { review: { issues: [] }, log: [], changes: "" });
  assert.match(text, /plan-review\/work-review-2\/review-1\.json/);
  assert.match(text, /later execution phase after the plan has been revised/);
  assert.match(text, /Do not modify any file\./);
});

// Stage A, decision Q1: a read-only work response gets the review, its phase's log entries and the diff in the prompt.
test("the work response prompt carries the review, the log entries of its phase only, and the diff verbatim", () => {
  const review = { issues: [{ id: "W2-R2-1", severity: "major" as const, location: "src/a.ts:3", problem: "the parser drops the last line", evidence: "a.ts reads lines.slice(0, -1)" }] };
  const entry = (phase: number, id: string) => ({ id, phase, round: 1, problem: `problem of ${id}`, rationale: `rationale of ${id}`, superseded: false, source: "review" as const, severity: "minor" as const, location: "x", evidence: "e", action: "rejected" as const, duplicate_of: null, reverses: null });
  const log = [entry(1, "W1-R1-1"), entry(2, "W2-R1-1")] as unknown as Parameters<typeof prompts.workRespondPrompt>[2]["log"];
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+const lines = text.split(\"\\n\");\n";
  const text = prompts.workRespondPrompt(2, 2, { review, log, changes: diff });
  assert.ok(text.includes("the parser drops the last line"), "the review");
  assert.ok(text.includes("rationale of W2-R1-1"), "the phase's log entry");
  assert.ok(!text.includes("W1-R1-1"), "another phase's log entry");
  assert.ok(text.includes(diff), "the diff, verbatim");
  assert.match(text, /Do not modify any file\./);
  assert.match(text, /cannot use any tool/);
});

test("the revision prompt after an execution phase names the stop and the work review's outcome", () => {
  const stopOnly = prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: "converged" });
  assert.match(stopOnly, /^Execution phase 1 has ended\./);
  assert.match(stopOnly, /last entry of plan-review\/user-decisions\.md/);
  assert.match(stopOnly, /Work review 1 found no issue in the work so far/);
  const revise = prompts.revisePlanAfterExecutionPrompt(2, { stopped: false, workReview: { revisedInRound: 3 } });
  assert.doesNotMatch(revise, /last entry of plan-review\/user-decisions\.md contains the user's input for this stop/);
  assert.match(revise, /Work review 2 ended in round 3/);
  assert.match(revise, /plan-review\/work-review-2\/round-3\.json/);
  assert.match(revise, /plan-review\/work-review-log\.json/);
  assert.ok(revise.includes(prompts.PLAN_ID_RULE));
  const both = prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: { revisedInRound: 1 } });
  assert.match(both, /user's input for this stop/);
  assert.match(both, /Work review 1 ended in round 1/);
});

// W2-R1-4: the page's help and notice texts live here, with the other texts the user reads.
test("the page's hint, notices, progress line and badge", () => {
  assert.equal(prompts.answerHint("line"), "Enter sends.");
  assert.equal(prompts.answerHint("message"), "Enter sends; Shift+Enter starts a new line.");
  assert.equal(prompts.draftWithdrawnNotice("my text"), "This question was answered in another tab; your unsent text was discarded: «my text»");
  assert.equal(prompts.SERVER_CLOSED_NOTICE, "The server has ended. The page reconnects when it is started again.");
  assert.equal(prompts.notSentNotice("answer", "ended"), "Your answer was not sent: the run has ended.");
  assert.equal(prompts.notSentNotice("stop", "ended"), "Stop was not sent: the run has ended.");
  assert.equal(prompts.notSentNotice("answer", "restarted"), "Your answer was not sent: the server has been restarted since.");
  assert.equal(prompts.notSentNotice("stop", "restarted"), "Stop was not sent: the server has been restarted since.");
  assert.equal(prompts.progressLine(null, null), "Progress: no phase has begun");
  assert.equal(prompts.progressLine("Planning 1", null), "Progress: Planning 1");
  assert.equal(prompts.progressLine("Planning 1", "cycle 2"), "Progress: Planning 1, cycle 2");
  assert.equal(prompts.progressLine("Gather Requirements — Clarification", "3 of 7 answered"), "Progress: Gather Requirements — Clarification, 3 of 7 answered");
  assert.equal(prompts.unseenBadge(3), "· 3 new");
});

// Defect B of docs/page-question-phase-defects.md: the notices of a frame the page cannot read and of the failed page.
test("the protocol error's notice carries the reason, cut to 200 characters", () => {
  assert.equal(prompts.protocolErrorNotice("Expected no excess property"), "The page could not read a message from the server; reconnecting. Reason: Expected no excess property");
  const long = "x".repeat(500);
  assert.equal(prompts.protocolErrorNotice(long), `The page could not read a message from the server; reconnecting. Reason: ${"x".repeat(200)}…`);
  assert.equal(prompts.protocolErrorNotice("y".repeat(200)), `The page could not read a message from the server; reconnecting. Reason: ${"y".repeat(200)}`);
  assert.match(prompts.CONNECTION_FAILED_NOTICE, /stopped reconnecting/);
  assert.match(prompts.CONNECTION_FAILED_NOTICE, /[Rr]eload the page/);
  assert.equal(prompts.UNSENT_HEADING, "Not sent");
});

test("an action not sent because the page is no longer connected, with the answer's text quoted or in the field", () => {
  assert.equal(prompts.notSentNotice("answer", "disconnected"), "Your answer was not sent: the page is no longer connected to the server. Its text is still in the answer field.");
  assert.equal(prompts.notSentNotice("answer", "disconnected", "my text"), "Your answer was not sent: the page is no longer connected to the server. Its text is kept under “Not sent”: «my text»");
  assert.equal(prompts.notSentNotice("stop", "disconnected"), "Stop was not sent: the page is no longer connected to the server.");
  assert.equal(prompts.notSentNotice("start", "disconnected"), "The new task was not sent: the page is no longer connected to the server.");
  assert.equal(prompts.notSentNotice("list", "disconnected"), "The directory listing was not requested: the page is no longer connected to the server.");
});

// Issue #14: the user reads "cycle", never "round", at the limit; the agents' prompts and the records keep "round".
// S8: the counts are in the question (limitQuestion), the hint says only how to answer.
test("the cycle limit's question and hints, in the terminal and in the page, speak of cycles", () => {
  assert.equal(prompts.limitQuestion("Planning phase 1", 5), "Planning phase 1 has completed 5 cycles without convergence. How do you want the run to continue?");
  assert.match(prompts.limitPrompt, /more cycles/);
  assert.match(prompts.limitNoProceedPrompt, /more cycles/);
  assert.doesNotMatch(prompts.limitPrompt + prompts.limitNoProceedPrompt, /round/);
  assert.equal(prompts.pagePromptText("limit", prompts.limitPrompt), "Proceed without convergence, add cycles, or stop the run.");
  assert.equal(prompts.pagePromptText("limitNoProceed", prompts.limitNoProceedPrompt), "Add cycles, or stop the run.");
});

test("the status lines of the phases name Gather Requirements and Implementation", () => {
  assert.equal(prompts.questionListLine, "Gather Requirements: Claude Code formulates the question list ...");
  assert.equal(prompts.implementationBeganLine("Implementation 2", "auto"), "\nImplementation 2: Claude Code implements the plan (permission mode auto) ...");
  assert.equal(prompts.implementationEndedLine("Implementation", "finished"), "\nImplementation ended with status: finished");
  assert.equal(prompts.planningBeganLine("Planning", true), "Planning: requesting the initial plan from Claude Code ...");
  assert.equal(prompts.planningBeganLine("Planning 2", false), "\nPlanning 2: Claude Code revises the plan ...");
  assert.equal(prompts.workReviewBeganLine("Work review"), "\nWork review: Codex reviews the changes to the project since the run began ...");
  assert.equal(prompts.taskFinishedLine(3), "\nClaude Code reports that the task is finished after 3 implementation phase(s).");
  assert.equal(prompts.IMPLEMENTATION_STOPPED_LINE, "\nClaude Code has stopped implementation with a question.");
});

// The Q5 follow-up of issue #21: the user reads "clarification" where the records say "interview".
test("the clarification's headings and help", () => {
  assert.equal(prompts.clarificationHeading("clarification"), "Clarification");
  assert.equal(prompts.clarificationHeading("followUp"), "Follow-up clarification");
  assert.equal(prompts.interviewHelp("Clarification"), "Clarification. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.");
  assert.equal(prompts.END_CLARIFICATION, "Finish clarification and start planning");
});

// Issue #14 (Q1, Q2, G-R1-1): a cycle's line and a finished loop's line; no limit anywhere.
test("the cycle lines and the finished loop's line", () => {
  assert.equal(prompts.cycleLine(2, null, null), "cycle 2");
  assert.equal(prompts.cycleLine(2, 3, 3), "cycle 2: 3 issues");
  assert.equal(prompts.cycleLine(1, 1, 1), "cycle 1: 1 issue");
  assert.equal(prompts.cycleLine(3, 0, 0), "cycle 3: 0 issues");
  assert.equal(prompts.cycleLine(2, 3, 1), "cycle 2: 3 issues (1 counted)");
});

// Issue #28: "n issues resolved in m cycles", singular and plural on both numbers, in every branch.
test("a finished loop's line reads n issues resolved in m cycles", () => {
  const table: readonly (readonly [number, number, "converged" | "proceed" | "revise", string])[] = [
    [1, 0, "converged", "0 issues resolved in 1 cycle"],
    [1, 1, "converged", "1 issue resolved in 1 cycle"],
    [2, 2, "converged", "2 issues resolved in 2 cycles"],
    [2, 1, "proceed", "1 issue resolved in 2 cycles, proceeded without convergence"],
    [1, 0, "proceed", "0 issues resolved in 1 cycle, proceeded without convergence"],
    [5, 2, "proceed", "2 issues resolved in 5 cycles, proceeded without convergence"],
    [1, 0, "revise", "0 corrections due after 1 cycle"],
    [1, 2, "revise", "2 corrections due after 1 cycle"],
    [2, 1, "revise", "1 correction due after 2 cycles"],
  ];
  for (const [cycles, corrections, result, expected] of table) assert.equal(prompts.loopSummary(cycles, corrections, result), expected);
});

// Issue #33: the first step of Gather Requirements identifies the choices; the other steps keep their names.
test("the steps of Gather Requirements", () => {
  assert.equal(prompts.stepLabel("formulate"), "Identify choices");
  assert.equal(prompts.stepLabel("clarification"), "Clarification");
});

// Issue #21 (Q6 follow-up): Claude reports every question asked, follow-ups with ids of their own, and the answered ones.
test("the interview rules define asked_ids with follow-up ids, and answered_ids over both", () => {
  for (const text of [prompts.interviewOpenPrompt, prompts.interviewGapsPrompt("plan-review/requirements-review/review-1.json", ["G-R1-1"])]) {
    assert.match(text, /asked_ids: the ids of every question you have asked so far: the agreed questions you have asked, and an id F1, F2, … that you assign to each follow-up question/);
    assert.match(text, /answered_ids: the ids of the questions, agreed or follow-up, that the user has answered so far/);
  }
  assert.match(prompts.interviewGapsPrompt("r.json", ["G-R1-1"]), /use the issue ids in asked_ids and answered_ids/);
});

// W1-R1-1: the error texts the user reads at a halt are in src/prompts.ts too.
test("the texts of an invalid cycle and of the stop at the cycle limit", () => {
  assert.equal(prompts.cycleInvalidText(["a", "b"]), "the cycle is invalid: a; b");
  assert.equal(prompts.cycleLimitStopText("Planning phase 1"), "stopped by the user at the cycle limit of Planning phase 1");
});

// Decision Q1 of the decision-support task: every prompt that may put a question to the user says how to fill its options.
test("every prompt that may return questions_for_user says how to fill a question's options", () => {
  const texts = [
    prompts.planRespondPrompt(1, 1),
    prompts.requirementsRespondPrompt(1),
    prompts.questionRespondPrompt(1),
    prompts.workRespondPrompt(1, 1, { review: { issues: [] }, log: [], changes: null }),
    prompts.initialPlanPrompt("t", false),
    prompts.revisePlanPrompt,
    prompts.revisePlanAfterExecutionPrompt(1, { stopped: false, workReview: "converged" }),
  ];
  for (const text of texts) {
    assert.ok(text.includes(prompts.QUESTION_OPTIONS_RULE), text.slice(0, 80));
    assert.match(prompts.QUESTION_OPTIONS_RULE, /two or more mutually exclusive options/);
    assert.match(prompts.QUESTION_OPTIONS_RULE, /empty options array/);
  }
});

// Decision support, plan step 2.2 (D7): the prompts carry docs/decision-making.md verbatim.
const FORMAT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
const decisionQuestion = { phase: { kind: "planning" as const, n: 2 }, label: "Planning 2", question: "Which database?", options: [{ label: "SQLite", description: "one file" }, { label: "PostgreSQL", description: "a server" }] };

test("the analysis prompt carries the format byte for byte, the binding sentence, the question, the options in order and the context", () => {
  const text = prompts.decisionAnalysisPrompt(FORMAT, decisionQuestion, { task: "Build it.", requirements: "# R\nreq text", plan: null });
  assert.ok(text.includes(FORMAT), "the format is not in the prompt verbatim");
  assert.ok(text.includes(prompts.DECISION_FORMAT_AUTHORITY));
  assert.match(prompts.DECISION_FORMAT_AUTHORITY, /authority for the content and layout/);
  assert.ok(text.indexOf("SQLite") < text.indexOf("PostgreSQL"), "the options are not in the question's order");
  assert.match(text, /Which database\?/);
  assert.match(text, /Build it\./);
  assert.match(text, /req text/);
  assert.match(text, /plan-review\/plan\.md does not exist yet/);
  assert.match(text, /Planning 2/);
  assert.match(text, /equivalent_to/);
  assert.match(text, /Disadvantages:/);
});

test("the decision review prompt carries the format in its first round, names the analysis and the question, and the ids D<k>-R<n>-<i>", () => {
  const first = prompts.decisionReviewPrompt(FORMAT, 3, 1);
  assert.ok(first.includes(FORMAT), "the format is not in the first review prompt verbatim");
  assert.match(first, /plan-review\/decision-3\/analysis\.json/);
  assert.match(first, /plan-review\/decision-3\/question\.json/);
  assert.match(first, /D3-R1-1/);
  assert.match(first, /recommendation/);
  assert.match(first, /ids begin with D3-/);
  const later = prompts.decisionReviewPrompt(FORMAT, 3, 2);
  assert.match(later, /D3-R2-1/);
  assert.match(later, /plan-review\/decision-3\/analysis\.json/);
});

test("the decision respond and apply-decisions prompts ask for the complete analysis and forbid file changes", () => {
  const respond = prompts.decisionRespondPrompt(3, 2);
  assert.match(respond, /plan-review\/decision-3\/review-2\.json/);
  assert.match(respond, /complete analysis/);
  assert.match(respond, /Do not modify any file/);
  const apply = prompts.decisionApplyDecisionsPrompt(3);
  assert.match(apply, /user-decisions\.md/);
  assert.match(apply, /complete analysis/);
});

// Issue #25, one line: only the first word of a button label is capitalized, and the terminal's offer line names the
// button's label, built from the same constant.
test("the offer's label reads Help me decide, and the terminal's offer line carries that label", () => {
  assert.equal(prompts.HELP_ME_DECIDE, "Help me decide");
  assert.ok(prompts.OFFER_LINE.includes(`/decide = ${prompts.HELP_ME_DECIDE}:`), prompts.OFFER_LINE);
});

// Issue #35 (Q5, Q6): the ids the question list and interview prompts assign. S6: the user reads the run's number, not the id.
test("the ids the prompts assign to agreed and follow-up questions", () => {
  const agreed = `${prompts.AGREED_QUESTION_PREFIX}1, ${prompts.AGREED_QUESTION_PREFIX}2, and so on`;
  assert.ok(prompts.questionListPrompt("t").includes(`id: ${agreed}`), "the question list prompt assigns other ids");
  const rules = [prompts.interviewOpenPrompt, prompts.interviewGapsPrompt("f", ["G-R1-1"])];
  for (const text of rules) {
    assert.ok(text.includes(`${prompts.FOLLOW_UP_PREFIX}1, ${prompts.FOLLOW_UP_PREFIX}2, …`), "the interview rules assign other follow-up ids");
    assert.match(text, /current_question: the question this message asks the user to answer now/);
  }
});

// Issue #35: the prompts of a decision follow the amended docs/decision-making.md ("Also,", both headings and the
// labels placed by the program, the unclear option), and contradict it nowhere.
test("the analysis prompt maps the amended format: Also, sequences, headings and labels left to the program, unclear columns", () => {
  const text = prompts.decisionAnalysisPrompt(FORMAT, decisionQuestion, { task: "t", requirements: null, plan: null });
  assert.match(text, /first counterargument at an element begins with "But," and each further one at that element with "Also,"/);
  assert.match(text, /first defense of a counterargument begins with "On the other hand," and each further one with "Also,"/);
  assert.match(text, /first counterargument to a defense begins with "Then again," and each further one with "Also,"/);
  assert.doesNotMatch(text, /Begin the text of a counterargument with "But", of a defense with/);
  for (const placed of ['"Advantages:"', '"Disadvantages:"', '"Advantage 1:"', '"Disadvantage 1:"']) assert.ok(text.includes(placed), placed);
  assert.match(text, /the program places the headings, the labels of the entries and the symbols/);
  assert.match(text, /kind: "argued"/);
  assert.match(text, /kind: "unclear"/);
  assert.match(text, /unclear: what is unclear about the option and which readings are possible/);
});

test("the decision review prompt says the program places both headings and the labels, and how an unclear option is represented", () => {
  const first = prompts.decisionReviewPrompt(FORMAT, 3, 1);
  assert.match(first, /places the headings "Advantages:" and "Disadvantages:" and the labels of the entries \("Advantage 1:", "Disadvantage 1:"\)/);
  assert.match(first, /kind "unclear"/);
  assert.match(first, /"Also,"/);
});

// Issue #6 (F1, G-R1-1): every call that creates or changes the plan returns it whole in 'plan' and keeps the ids; the
// prompt's rule and the validation that enforces it are tested together, and the repair turn repeats the rule.
const planProducing = () => [
  prompts.initialPlanPrompt("t", false),
  prompts.revisePlanPrompt,
  prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: "converged" }),
  prompts.planApplyDecisionsPrompt,
  prompts.planRespondPrompt(1, 1),
];
// Issue #78: no step of a plan may end with a command expected to outlast one shell command, whose ceiling every Claude
// Code call carries; the execution prompt states the same ceiling and how to wait for a long suite.
test("every prompt that asks for the whole plan states the step duration rule, in minutes of COMMAND_CEILING_MS", async () => {
  const minutes = prompts.COMMAND_CEILING_MS / 60_000;
  assert.match(prompts.PLAN_STEP_DURATION_RULE, new RegExp(`\\b${minutes} minutes\\b`));
  for (const text of planProducing()) assert.ok(text.includes(prompts.PLAN_STEP_DURATION_RULE), text.slice(0, 80));
  // Every prompt that carries PLAN_FORMAT carries the rule beside it, so that a sixth one added later is not missed.
  const source = fs.readFileSync(new URL("../src/prompts.ts", import.meta.url), "utf8");
  const uses = source.split("${PLAN_FORMAT}").length - 1;
  assert.ok(uses >= 5);
  assert.equal(source.split("${PLAN_FORMAT}\n${PLAN_STEP_DURATION_RULE}").length - 1, uses, "a prompt carries PLAN_FORMAT without the step duration rule");
  // The seam with the environment of every call: the same ceiling.
  const { claudeEnv } = await import("../src/claude.ts");
  assert.equal(claudeEnv({}, prompts.COMMAND_CEILING_MS).BASH_MAX_TIMEOUT_MS, String(prompts.COMMAND_CEILING_MS));
});

test("the execution prompt states the ceiling for a foreground command and says to wait for a long suite in the background without editing", () => {
  assert.ok(prompts.executePrompt.includes(prompts.BACKGROUND_SUITE_SENTENCE));
  assert.ok(prompts.BACKGROUND_SUITE_SENTENCE.includes(`timeout set to ${prompts.COMMAND_CEILING_MS}`), prompts.BACKGROUND_SUITE_SENTENCE);
  assert.match(prompts.BACKGROUND_SUITE_SENTENCE, /in the background/);
  assert.match(prompts.BACKGROUND_SUITE_SENTENCE, /do not edit/);
});

test("every prompt that produces the plan asks for it whole as data and states the id rule", () => {
  for (const text of planProducing()) {
    assert.ok(text.includes(prompts.PLAN_FORMAT), text.slice(0, 80));
    assert.ok(text.includes(prompts.PLAN_ID_RULE), text.slice(0, 80));
    assert.doesNotMatch(text, /(Write|amend|Revise) plan-review\/plan\.md/);
  }
  assert.match(prompts.PLAN_FORMAT, /'plan'/);
  assert.match(prompts.PLAN_FORMAT, /do not write either file/);
});

test("each clause of the id rule is enforced by validatePlan, and the repair prompt states the rule", async () => {
  const { validatePlan } = await import("../src/plan.ts");
  const { Result } = await import("effect");
  const step = (id: string, text = `t ${id}`) => ({ id, number: 1, label: `l ${id}`, text });
  const plan = (...steps: ReturnType<typeof step>[]) => ({ stages: [{ number: 1, title: "s", steps: steps.map((st, i) => ({ ...st, number: i + 1 })) }] });
  const previous = { stages: [{ number: 1, title: "s", steps: [{ ...step("S1"), status: "done" as const }, { ...step("S2"), number: 2, status: "pending" as const }] }] };
  const clauses: readonly [RegExp, ReturnType<typeof plan>][] = [
    [/unique across the plan/, plan(step("S1"), step("S1"))],
    [/every step has an id/i, plan(step("S1"), step(""))],
    [/'done' stays in the plan/, plan(step("S2"))],
    [/with its id, label and text unchanged/, plan(step("S1", "rewritten"), step("S2"))],
  ];
  for (const [clause, reply] of clauses) {
    assert.match(prompts.PLAN_ID_RULE, clause);
    const r = validatePlan(previous, reply);
    assert.ok(Result.isFailure(r), String(clause));
    const repair = prompts.planRepairPrompt(r.failure);
    assert.ok(repair.includes(prompts.PLAN_ID_RULE));
    for (const line of prompts.planProblemLines(r.failure)) assert.ok(repair.includes(line));
  }
});

test("the plan review and the work review read plan.json with its statuses", () => {
  for (const text of [prompts.planReviewPrompt(1, 1, false), prompts.workReviewPrompt(1, 1, false)]) {
    assert.match(text, /plan-review\/plan\.json/);
    assert.match(text, /status 'done'/);
    assert.doesNotMatch(text, /plan-review\/plan\.md/);
  }
  assert.match(prompts.planReviewPrompt(1, 2, false), /plan-review\/plan\.json/);
});

// Issue #6 (numbering): a kind with one instance in the run carries no number; with two or more, every one does.
test("phaseLabel numbers a phase only when the run holds more than one of its kind", () => {
  assert.deepEqual([prompts.phaseLabel("planning", 1, 1), prompts.phaseLabel("execution", 1, 1), prompts.phaseLabel("work", 1, 1)], ["Planning", "Implementation", "Code review"]);
  assert.deepEqual([prompts.phaseLabel("planning", 1, 2), prompts.phaseLabel("execution", 2, 2), prompts.phaseLabel("work", 2, 3)], ["Planning 1", "Implementation 2", "Code review 2"]);
  assert.equal(prompts.phaseLabel("questions", 0, 1), "Gather Requirements");
});

// Issue #42 (Q7): the busy indicator asserts only that an agent works, beside the measured time of the call.
test("runningFor gives m:ss, and h:mm:ss from one hour on; elapsedMs is clamped at 0", async () => {
  const { elapsedMs } = await import("../web/src/time.ts");
  assert.equal(prompts.runningFor(0), "running for 0:00");
  assert.equal(prompts.runningFor(65_999), "running for 1:05");
  assert.equal(prompts.runningFor(3_599_000), "running for 59:59");
  assert.equal(prompts.runningFor(3_600_000 + 62_000), "running for 1:01:02");
  assert.equal(elapsedMs("2026-09-28T12:00:00.000Z", Date.parse("2026-09-28T12:01:30.000Z")), 90_000);
  assert.equal(elapsedMs("2026-09-28T12:00:10.000Z", Date.parse("2026-09-28T12:00:00.000Z")), 0);
  assert.equal(elapsedMs("not a time", 0), 0);
});

// Issue #50 (Q2): the durations of the rail share one format; the running step's indicator names its state and the work.
test("durationText, runningFor, phaseTook and phaseElapsed share one format", () => {
  assert.equal(prompts.durationText(0), "0:00");
  assert.equal(prompts.durationText(59_999), "0:59");
  assert.equal(prompts.durationText(61_000), "1:01");
  assert.equal(prompts.durationText(3_723_000), "1:02:03");
  for (const ms of [0, 61_000, 3_723_000]) {
    assert.equal(prompts.runningFor(ms), `running for ${prompts.durationText(ms)}`);
    assert.equal(prompts.phaseTook(ms), `took ${prompts.durationText(ms)}`);
    assert.equal(prompts.phaseElapsed(ms), `${prompts.durationText(ms)} so far`);
  }
});

test("stepWorkingLabel names the step's state as its mark says it and that an agent is working", () => {
  const phaseStep = prompts.stepWorkingLabel("phaseStep");
  const planStep = prompts.stepWorkingLabel("planStep");
  assert.ok(phaseStep.includes(prompts.TIMELINE_STATE_LABEL.active), phaseStep);
  assert.ok(planStep.includes(prompts.PLAN_STEP_STATE_LABEL.current), planStep);
  for (const label of [phaseStep, planStep]) assert.ok(label.toLowerCase().includes(prompts.AGENT_WORKING_LABEL.toLowerCase()), label);
});

// S34 (W1-R1-2, P2-R1-2): a tool's input as the user reads it.
test("toolInputBlocks labels the known fields in plain words and keeps each unknown field's own name; toolInputExplanations explains those", () => {
  const known = { file_path: "/a", old_string: "x", new_string: "y", replace_all: true, content: "c", command: "ls", description: "d", pattern: "p", path: "/p", url: "https://e" };
  const lines = inputLines(known);
  // No key is shown as an identifier ("file_path: …" or its quoted name); a label may use an English word such as "command".
  for (const key of Object.keys(known)) assert.ok(!new RegExp(`(^|\\n)\\s*- ${key}:`).test(lines) && !lines.includes(`"${key}"`), `${key} in ${lines}`);
  for (const key of ["file_path", "old_string", "new_string", "replace_all"]) assert.ok(!lines.includes(key), key);
  assert.deepEqual(prompts.toolInputExplanations(known), []);
  assert.notEqual(inputLines({ overwrite: true }), inputLines({ dry_run: true }));
  assert.match(inputLines({ overwrite: true }), /`overwrite`/);
  assert.deepEqual(prompts.toolInputExplanations({ overwrite: true, edits: [{ old_string: "a", mode: "m" }] }).map((t) => t.term), ["overwrite", "mode"]);
  assert.ok(prompts.unknownSettingExplanation.trim() !== "");
  // A multi-line value stays readable, and nested fields are labeled too.
  assert.ok(!inputLines({ edits: [{ old_string: "a", new_string: "b" }] }).includes("old_string"));
});

// S45 (P4-R1-1): the code span of a single-line value: its delimiter one backtick longer than the value's longest run,
// padded on both sides only where CommonMark would otherwise strip or merge an edge.
test("codeSpan pads symmetrically where an edge is a backtick or a space, and never a value of spaces alone", () => {
  assert.equal(prompts.codeSpan("abc"), "`abc`");
  assert.equal(prompts.codeSpan("a`b"), "``a`b``");
  assert.equal(prompts.codeSpan("`x"), "`` `x ``");
  assert.equal(prompts.codeSpan("x`"), "`` x` ``");
  assert.equal(prompts.codeSpan(" v "), "`  v  `");
  assert.equal(prompts.codeSpan(" x"), "`  x `");
  assert.equal(prompts.codeSpan(""), prompts.emptyTextPhrase);
  assert.equal(prompts.codeSpan("  "), prompts.spacesPhrase(2));
  assert.equal(prompts.codeFence("a\n```\nb"), "````");
});

// S48 (W3-R1-2 of work review 4, P5-R1-1, P5-R1-2): whitespace alone is named as its runs in order; a character a code
// span or the browser would change or hide is written as a visible escape, with the note once per field.
test("codeSpan names whitespace-only values as ordered runs, so that values with equal counts never look alike", () => {
  assert.equal(prompts.codeSpan("\t"), "(1 tab)");
  assert.equal(prompts.codeSpan("\u00a0"), "(1 non-breaking space)");
  assert.equal(prompts.codeSpan("\t  "), "(1 tab, then 2 spaces)");
  assert.equal(prompts.codeSpan("  \t"), "(2 spaces, then 1 tab)");
  assert.notEqual(prompts.codeSpan("\t  "), prompts.codeSpan("  \t"));
  assert.equal(prompts.codeSpan("   "), prompts.spacesPhrase(3));
});

test("codeSpan escapes carriage returns, controls, invisible characters and special spaces at an edge, with ASCII escapes", () => {
  const bs = "\\";
  assert.equal(prompts.codeSpan("before\rafter"), `\`before${bs}rafter\``);
  assert.equal(prompts.codeSpan("end\r"), `\`end${bs}r\``);
  assert.equal(prompts.codeSpan("a\u200bb"), `\`a${bs}u200Bb\``);
  assert.equal(prompts.codeSpan("bell\u0007"), `\`bell${bs}u0007\``);
  assert.equal(prompts.codeSpan("\u00a0x"), `\`${bs}u00A0x\``);
  // A backslash of the value is doubled only where the value is shown with escapes.
  assert.equal(prompts.codeSpan("c:\\dir\r"), `\`c:${bs}${bs}dir${bs}r\``);
  assert.equal(prompts.codeSpan("c:\\dir"), "`c:\\dir`");
  // Ordinary spaces and tabs inside printable text stay literal, as does an inner non-breaking space.
  assert.equal(prompts.codeSpan("a\tb c"), "`a\tb c`");
  assert.equal(prompts.codeSpan("a\u00a0b"), "`a\u00a0b`");
});

test("an escaped field carries ESCAPED_VALUE_NOTE once, in the lines the terminal and conversation.md print; a literal one none", () => {
  const escaped = inputLines({ old_string: "a\rb", new_string: "c\u200b" });
  assert.equal(escaped.split(prompts.ESCAPED_VALUE_NOTE).length - 1, 2);
  assert.ok(!escaped.includes("\r") && !escaped.includes("\u200b"));
  assert.ok(!inputLines({ new_string: "plain" }).includes(prompts.ESCAPED_VALUE_NOTE));
  const block = inputLines({ content: "line 1\r\nline 2" });
  assert.ok(block.includes("line 1\\r\nline 2"), block);
  assert.equal(block.split(prompts.ESCAPED_VALUE_NOTE).length - 1, 1);
});

// S37: a plain piece never carries code, so the escapes' note writes each escape it explains as a code piece of its own,
// derived from ESCAPED_VALUE_NOTE, whose Markdown it still is.
test("S37: the escapes' note is pieces, each escape it explains a code piece, written as ESCAPED_VALUE_NOTE", () => {
  const blocks = prompts.toolInputBlocks({ "a\nb": "c\r", content: "x\r\ny" });
  const pieces = blocks.flatMap((b) => (b.kind === "paragraph" ? b.pieces : b.kind === "list" ? b.items.flatMap((i) => i.pieces) : []));
  const explained = [...prompts.ESCAPED_VALUE_NOTE.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  assert.ok(explained.length > 0);
  const code = pieces.filter((p) => p.code).map((p) => p.text);
  for (const e of explained) assert.ok(code.includes(e), `the escape ${e} is a code piece`);
  assert.ok(pieces.every((p) => p.code || !p.text.includes("`")), "no plain piece holds a backtick");
  assert.equal(blocksMarkdown(blocks).split(prompts.ESCAPED_VALUE_NOTE).length - 1, 3);
});

// S49 (W4-R1-1): the permission question names the action and points at the input shown with it; its length does not
// depend on the input, so that a long command cannot push the answers out of view.
test("permissionQuestion names neither the command, nor the file, nor the address, and its length does not depend on the input", () => {
  const long = "echo step;\n".repeat(300);
  const inputs = [{ command: "ls" }, { command: long }, { file_path: "/tmp/config" }, { file_path: `/tmp/${"d/".repeat(500)}f` }, { url: "https://example.org/x" }];
  for (const input of inputs) {
    const q = prompts.permissionQuestion("Bash", input);
    for (const value of Object.values(input)) assert.ok(!q.includes(value), q);
    assert.ok(q.endsWith("?"));
  }
  assert.equal(prompts.permissionQuestion("Bash", { command: "ls" }).length, prompts.permissionQuestion("Bash", { command: long }).length);
  assert.equal(prompts.permissionQuestion("Edit", { file_path: "/a" }).length, prompts.permissionQuestion("Edit", { file_path: `/${"b".repeat(3000)}` }).length);
  assert.ok(prompts.permissionQuestion("Bash", { command: "ls" }).includes(prompts.TOOL_INPUT_HEADING));
});

// S52 (W5-R1-1): every question the program composes has a length independent of its inputs. An argument is either free
// text of an agent or an SDK (the fault, the stop description), which no question embeds, or a short name the program
// chooses at the call site: a heading (subjectHeading: "Planning phase 1", "Decision 2"…), a file label (the subjects'
// fileLabel: "plan.json"…), an agent, a kind of call (transportWhat, transportReviewWhat over a heading), a count.
test("the questions the program composes embed no agent-written or SDK-written text", () => {
  const short = "x";
  const long = "y".repeat(3000);
  // The fault and the stop description are no longer arguments of the question at all.
  assert.equal(prompts.transportExhaustedQuestion.length, 2);
  assert.equal(prompts.execStopQuestion.length, 0);
  for (const q of [prompts.transportExhaustedQuestion("claude", prompts.transportWhat("planning")), prompts.execStopQuestion()]) assert.ok(!q.includes(long) && !q.includes(short + short));
  // The program-chosen names, bounded by the program's own vocabulary.
  const headings = ["Question review", "Terms review", "Requirements review", "Planning phase 12", "Work review 3", "Decision 7"];
  const files = ["questions.json", "terms.json", "requirements.md", "plan.json", "analysis.json", "changes.diff"];
  for (const heading of headings) {
    assert.ok(prompts.limitQuestion(heading, 5).length < 200, heading);
    for (const file of files) assert.ok(prompts.unchangedQuestion(heading, file).length < 200, `${heading} ${file}`);
  }
  for (const file of files) for (const pause of ["unexplained", "identical"] as const) assert.ok(prompts.pauseQuestion({ pause, fileLabel: file, heading: "Planning phase 1", round: 1 } as never).length < 200, file);
});
test("the transport pause's details hold the attempts and the whole fault under their heading; the fallback context points to them", () => {
  const fault = `read ECONNRESET ${"z".repeat(2500)}`;
  const details = blocksMarkdown(prompts.transportDetails(4, fault));
  assert.ok(details.startsWith(prompts.TRANSPORT_FAULT_HEADING));
  assert.ok(details.includes("4"));
  assert.ok(details.includes(fault));
  const context = prompts.fallbackContext({ kind: "transport", agent: "codex", what: "the review", attempts: 4, fault });
  assert.ok(!context.includes(fault), "the fallback paragraph embeds the fault");
  assert.ok(context.length < 1000);
});
test("an execution stop's details hold Claude Code's description under their heading", () => {
  const description = "The build needs a decision about **the cache**.";
  const shown = (d: string) => blocksMarkdown(prompts.execStopDetails(d));
  assert.ok(shown(description).startsWith(prompts.EXEC_STOP_HEADING));
  assert.ok(shown(description).includes(description));
  assert.deepEqual(prompts.execStopDetails(description)[1], { kind: "document", markdown: description }, "Claude Code's prose is shown whole");
  assert.ok(shown("  ").includes(prompts.EXEC_STOP_NO_DESCRIPTION));
});

// S54: the terminal's lines and conversation.md carry the edge line breaks as escapes, as the page does.
test("a multi-line value's edge line breaks are escaped in the terminal's lines and the record", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const lines = inputLines({ content: "a\nb\n" });
  assert.ok(lines.includes("a\nb\\n"), lines);
  assert.ok(lines.includes(prompts.ESCAPED_VALUE_NOTE));
  assert.ok(prompts.ESCAPED_VALUE_NOTE.includes("`\\n`"));
  assert.notEqual(inputLines({ content: "a\nb" }), lines);
  const record = renderQuestionRecord({ number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details: prompts.toolInputBlocks({ content: "a\nb\n" }), decision: null });
  assert.ok(record.includes("a\nb\\n"));
});

// S55 (W6-R1-1, P7-R1-1): the label table is looked up by own properties; an unknown name is shown as code, its line
// breaks escaped, in the terminal's lines and conversation.md alike.
test("an unknown field's name is shown literally and looked up by own properties only", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const own = (key: string) => Object.defineProperty({}, key, { value: 1, enumerable: true });
  for (const key of ["constructor", "toString", "__proto__"]) {
    const lines = inputLines(own(key));
    assert.ok(lines.includes(prompts.unknownSettingLabel(key)), lines);
    assert.doesNotMatch(lines, /function|native code/);
  }
  assert.equal(prompts.unknownSettingLabel("**mode**"), "The tool's setting named `**mode**`");
  assert.ok(inputLines(own("a\nb")).includes("`a\\nb`"));
  const record = renderQuestionRecord({ number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details: prompts.toolInputBlocks(own("<target>")), decision: null });
  assert.ok(record.includes("`<target>`"));
});

// S57 (W6-R1-1 of work review 7, P8-R1-1): distinct field names never display alike, each keeps its own term, and an
// escaped name carries the escape note. Keys and expected texts are built from character codes, not escapes in source.
const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const SP = String.fromCharCode(32);
const withKeys = (keys: readonly string[]) => {
  const input: Record<string, unknown> = {};
  for (const k of keys) Object.defineProperty(input, k, { value: 1, enumerable: true, configurable: true, writable: true });
  return input;
};
const NAME_GROUPS: readonly (readonly string[])[] = [
  [`a${LF}b`, `a${BS}nb`],
  [`a${BS}b`, `a${BS}${BS}b`],
  ["", "(empty text)", "(empty name)"],
  [SP, "(1 space)", `${BS}u0020`],
  [TAB, "(1 tab)", `${BS}u0009`],
];
test("S57: the names of each group display differently, each non-empty one with its own non-blank term", () => {
  for (const group of NAME_GROUPS) {
    const input = withKeys(group);
    const shown = group.filter((k) => k !== "").map((k) => prompts.shownName(k).text);
    assert.equal(new Set(shown).size, shown.length, JSON.stringify(group));
    const labels = group.map((k) => prompts.unknownSettingLabel(k));
    assert.equal(new Set(labels).size, labels.length, JSON.stringify(group));
    const lines = inputLines(input);
    for (const label of labels) assert.ok(lines.includes(label), label);
    const terms = prompts.toolInputExplanations(input);
    assert.equal(terms.length, group.filter((k) => k !== "").length, JSON.stringify(group));
    assert.equal(new Set(terms.map((t) => t.term)).size, terms.length);
    for (const t of terms) {
      assert.ok(t.term.trim() !== "", JSON.stringify(t));
      assert.ok(labels.some((l) => l.includes(t.term)), t.term);
    }
  }
  assert.equal(prompts.shownName(SP).text, `${BS}u0020`);
  assert.equal(prompts.shownName(`${BS}u0020`).text, `${BS}${BS}u0020`);
  assert.equal(prompts.shownName(TAB).text, `${BS}u0009`);
  assert.equal(prompts.unknownSettingLabel(""), prompts.EMPTY_NAME_LABEL);
  assert.ok(prompts.unknownSettingLabel(`a${LF}b`).includes(prompts.ESCAPED_VALUE_NOTE));
  assert.ok(prompts.unknownSettingLabel(`a${BS}nb`).includes(prompts.ESCAPED_VALUE_NOTE));
  assert.ok(!prompts.unknownSettingLabel("mode").includes(prompts.ESCAPED_VALUE_NOTE));
});

test("S57: shownName is one-to-one over non-empty names, never blank, and the empty name's label is unlike any other", async () => {
  const fc = (await import("fast-check")).default;
  const chars = fc.constantFrom("a", "b", BS, LF, TAB, SP, "n", "u", "0", "2", String.fromCharCode(13), String.fromCharCode(0x200b));
  const names = fc.array(chars, { minLength: 1, maxLength: 6 }).map((cs) => cs.join(""));
  fc.assert(fc.property(names, names, (a, b) => a === b || prompts.shownName(a).text !== prompts.shownName(b).text), { numRuns: 20000, examples: [[`a${LF}b`, `a${BS}nb`], [SP, `${BS}u0020`]] });
  fc.assert(fc.property(names, (a) => prompts.shownName(a).text.trim() !== "" && prompts.unknownSettingLabel(a) !== prompts.unknownSettingLabel("")));
});

test("S57: conversation.md carries the labels and notes of escaped names", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const details = prompts.toolInputBlocks(withKeys([`a${BS}nb`, SP]));
  const record = renderQuestionRecord({ number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details, decision: null });
  assert.ok(record.includes(prompts.unknownSettingLabel(`a${BS}nb`)));
  assert.ok(record.includes(prompts.unknownSettingLabel(SP)));
});

// S60 (W8-R1-2): an empty list, an empty object and an input with no fields are named by fixed phrases, so that they
// never display alike.
test("S60: empty lists, empty objects, the empty text and null display differently, nested too; no fields has its phrase", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const inputs = [{ settings: [] }, { settings: {} }, { settings: "" }, { settings: null }];
  const lines = inputs.map((i) => inputLines(i));
  assert.equal(new Set(lines).size, inputs.length, JSON.stringify(lines));
  const facts = inputs.map((i) => prompts.permissionFacts("T", i));
  assert.equal(new Set(facts).size, inputs.length, JSON.stringify(facts));
  assert.ok(lines[0].includes(prompts.EMPTY_LIST_PHRASE));
  assert.ok(lines[1].includes(prompts.EMPTY_OBJECT_PHRASE));
  assert.ok(facts[0].includes(prompts.EMPTY_LIST_PHRASE));
  assert.ok(facts[1].includes(prompts.EMPTY_OBJECT_PHRASE));
  const nested = [{ edits: [{}] }, { edits: [[]] }];
  assert.notEqual(inputLines(nested[0]), inputLines(nested[1]));
  assert.notEqual(prompts.permissionFacts("T", nested[0]), prompts.permissionFacts("T", nested[1]));
  assert.equal(inputLines({}), prompts.NO_INPUT_PHRASE);
  assert.ok(prompts.permissionFacts("T", {}).includes(prompts.NO_INPUT_PHRASE));
  const record = renderQuestionRecord({ number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details: prompts.toolInputBlocks(inputs[0]), decision: null });
  assert.ok(record.includes(prompts.EMPTY_LIST_PHRASE));
});

// S17 of the task of issue #36 (issue #59): every question the program composes asks what the user wants, and ends with
// its question mark; its options' descriptions state only how they differ, so none repeats what the others share.
test("S17: every question Interloq composes names the user as the one who decides and ends with a question mark", () => {
  const pauses = [
    { pause: "reraised", id: "A" },
    { pause: "secondClarification", id: "A" },
    { pause: "reversal", id: "A", reverses: "B" },
    { pause: "repeatedUnderNewId", id: "A", repeats: "B" },
    { pause: "disputedSelfCorrection", id: "A" },
    { pause: "unexplained", fileLabel: "plan.json", heading: "Planning phase 1", round: 1 },
    { pause: "identical", fileLabel: "plan.json" },
    { pause: "idle", idle: 2 },
  ] as const;
  const questions = [
    ...pauses.map((p) => prompts.pauseQuestion(p)),
    prompts.limitQuestion("Planning phase 1", 5),
    prompts.unchangedQuestion("Planning phase 1", "plan.json"),
    prompts.transportExhaustedQuestion("codex", "the review"),
    prompts.permissionQuestion("Bash", { command: "ls" }),
    prompts.permissionQuestion("Edit", { file_path: "/a" }),
    prompts.CONFIRM_SUMMARY_QUESTION,
    prompts.execStopQuestion(),
    prompts.REPLY_QUESTION,
  ];
  for (const q of questions) {
    assert.match(q, /\?$/, q);
    assert.match(q.slice(q.lastIndexOf(". ") + 1), /\byou\b/i, `the question sentence does not name the user: ${q}`);
    assert.doesNotMatch(q, /How should the run continue|Should it be allowed|Should .* stand\?/, q);
  }
});

test("S17: the options Interloq composes do not repeat what they share", () => {
  const groups = [
    [prompts.PERMISSION_ALLOW_DESCRIPTION, prompts.PERMISSION_DENY_DESCRIPTION],
    Object.values(prompts.unchangedOptionDescriptions(false)),
    Object.values(prompts.unchangedOptionDescriptions(true)),
    Object.values(prompts.limitOptionDescriptions("proceed to implementation with the plan as it is")),
    Object.values(prompts.transportOptionDescriptions()),
  ];
  for (const group of groups) {
    // Every description reads after the preamble: it starts in lower case and is a clause, not a sentence of its own.
    for (const d of group) assert.match(d, /^([a-z]|Claude Code |Codex )/, d);
    // What every option shares is described in none: "continues" for Claude Code, and the records kept apart from Stop.
    assert.ok(!group.every((d) => /continues/.test(d)), group.join(" | "));
  }
});

// W2-R1-1 and P3-R1-1 (S26): a multi-line value is a code block, and a value that needs escapes is followed by the
// escapes note; neither ends the tool's input as a list. They sit inside the item of their setting, and the settings after
// them keep their nesting: the inner timeout under `outer`, the outer one at the top level.
test("a multi-line value and its escapes note keep the nesting of the settings after them", () => {
  const timeout = "The time limit in milliseconds";
  assert.equal(
    inputLines({ outer: { command: "a\nb", timeout: 12 }, timeout: 34 }),
    `- The tool's setting named \`outer\`:\n  - The command:\n\n    \`\`\`\n    a\n    b\n    \`\`\`\n\n  - ${timeout}: \`12\`\n- ${timeout}: \`34\``,
  );
  assert.equal(
    inputLines({ outer: { command: "a\nb\r", timeout: 12 }, timeout: 34 }),
    `- The tool's setting named \`outer\`:\n  - The command:\n\n    \`\`\`\n    a\n    b\\r\n    \`\`\`\n\n    ${prompts.ESCAPED_VALUE_NOTE}\n\n  - ${timeout}: \`12\`\n- ${timeout}: \`34\``,
  );
});

// S1, moved here from test/questionRules.test.ts on 5 Oct 2026 (the requirements name this file): the one list of the
// ids of QUESTION_RULES, with the seven of issues #59, #91, #92 and #93.
const RULE_IDS = ["whetherToAsk", "selfContained", "nameThings", "noIdentifiers", "noLiterals", "kindBeforeNumber", "oneWord", "noInternalTerms", "questionLast", "context", "contextNoAnnouncement", "contextBearsOnChoice", "purposeOwner", "askWhatUserWants", "askOutcome", "determinateOptions", "optionDifferences", "readerConsequence", "statedWarrant", "developmentFacts", "readerInstructions", "namedActor", "terms"];

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

test("no rule restates another: no two entries of QUESTION_RULES or QUESTION_FORMAT share an id or a text", () => {
  const ids = [...prompts.QUESTION_RULES.map((r) => r.id), ...prompts.QUESTION_FORMAT.map((c) => c.id)];
  assert.equal(new Set(ids).size, ids.length);
  const texts = [...prompts.QUESTION_RULES.flatMap((r) => [r.rule, r.criterion]), ...prompts.QUESTION_FORMAT.flatMap((c) => [c.text, c.criterion])].filter((x) => x !== "");
  assert.equal(new Set(texts).size, texts.length);
});

// Issue #95 (S5): whether to ask is stated once, in QUESTION_RULES; no prompt that asks for a question states an inclusion
// test of its own beside it, as questionListPrompt and questionReviewPrompt once did.
test("no prompt that asks for a question states an inclusion test of its own", () => {
  const own = [/only if its answer/, /only questions that/, /is unnecessary because/, /determines (it|the answer)/, /user alone can answer/];
  const texts: Readonly<Record<string, string>> = {
    questionListPrompt: prompts.questionListPrompt("t"),
    questionReviewPrompt: prompts.questionReviewPrompt(1),
    questionRespondPrompt: prompts.questionRespondPrompt(1),
    initialPlanPrompt: prompts.initialPlanPrompt("t", true),
    revisePlanPrompt: prompts.revisePlanPrompt,
    revisePlanAfterExecutionPrompt: prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: "converged" }),
    planRespondPrompt: prompts.planRespondPrompt(1, 1),
    interviewOpenPrompt: prompts.interviewOpenPrompt,
    interviewGapsPrompt: prompts.interviewGapsPrompt("r.json", ["G-R1-1"]),
    termsPrompt: prompts.termsPrompt("t"),
    executePrompt: prompts.executePrompt,
  };
  for (const [name, text] of Object.entries(texts)) {
    const outside = text.split(prompts.questionWritingRules()).join("").split(prompts.questionReviewCriteria()).join("");
    for (const pattern of own) assert.doesNotMatch(outside, pattern, `${name} states its own inclusion test`);
  }
});
