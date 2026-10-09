import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import * as S from "../src/schema.ts";
import type * as legacy from "./fixtures/legacy-types.ts";

// Type-level comparison, insensitive to readonly modifiers: Effect's Struct types are readonly,
// the frozen legacy types are not.
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameType = <_T extends true>(): void => {};

const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown): T =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const rejects = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown, what: string): void =>
  assert.throws(() => decode(schema, value), `${what} was accepted`);

const issue: legacy.Issue = { id: "P1-R1-1", severity: "major", location: "step 3", problem: "p", evidence: "e" };
const disposition: legacy.Disposition = { id: "P1-R1-1", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" };
const selfCorrection: legacy.SelfCorrection = { id: "A", new_action: "plan_error", explanation: "x" };
// Decision Q1 of the decision-support task: a question for the user is structured, with an optional list of options.
// S3 (issues #36, #59): with its context paragraph and the explanations of its terms. Issue #36 (30 Sep 2026): every text
// is a sequence of pieces, the context blocks of pieces (decision Q2), and the explanations a list the pieces refer to.
type Piece = { text: string; ref: string; code: boolean };
type Explanation = { id: string; term: string; senses: string[] };
type Block = { kind: "paragraph"; pieces: Piece[] } | { kind: "list"; items: { level: number; pieces: Piece[] }[] } | { kind: "code"; text: string };
type PieceOption = { label: Piece[]; description: Piece[] };
type UserQuestion = { context: Block[]; question: Piece[]; explanations: Explanation[]; options: PieceOption[] };
type WithQuestions<T> = Omit<T, "questions_for_user"> & { questions_for_user: UserQuestion[] };
const plain = (text: string): Piece[] => [{ text, ref: "", code: false }];
const para = (text: string): Block[] => [{ kind: "paragraph", pieces: plain(text) }];
const option = (label: string, description: string): PieceOption => ({ label: plain(label), description: plain(description) });
const userQuestion: UserQuestion = {
  context: [{ kind: "paragraph", pieces: plain("c") }, { kind: "list", items: [{ level: 0, pieces: plain("i") }, { level: 1, pieces: [{ text: "x", ref: "", code: true }] }] }, { kind: "code", text: "ls\n" }],
  question: [{ text: "q", ref: "t1", code: false }, { text: "?", ref: "", code: false }],
  explanations: [{ id: "t1", term: "q", senses: ["a letter"] }],
  options: [option("A", "a"), option("B", "b")],
};
const plannerResponse: WithQuestions<legacy.PlannerResponse> = { dispositions: [disposition], self_corrections: [selfCorrection], reviewer_feedback: "", questions_for_user: [userQuestion] };
// Issue #99: an entry carries its skip condition, null or the question and the answer that make it unnecessary.
type QuestionEntry = { id: string; context: Block[]; question: Piece[]; reason: Block[]; proposed_answers: PieceOption[]; default_answer: string; skip_if: { question: string; answer: string } | null };
const questionEntry: QuestionEntry = { id: "Q1", context: para("c"), question: plain("q?"), reason: para("r"), proposed_answers: [option("A", "a")], default_answer: "A", skip_if: null };
// Issue #21 (Q6 follow-up) and issue #35 (Q5, Q6): the fields the interview turn has beyond the frozen legacy shape.
type CurrentQuestion = { current_question: { id: string; context: Block[]; text: Piece[]; explanations: Explanation[]; options: PieceOption[] } };
const interviewTurn: legacy.InterviewTurn & { asked_ids: string[] } & CurrentQuestion = { message_to_user: "m", current_question: { id: "F1", context: para("c"), text: plain("q?"), explanations: [], options: [option("A", "a")] }, asked_ids: ["Q1", "F1"], answered_ids: ["Q1"], complete: false, summary: "" };
const execReport: legacy.ExecReport = { status: "finished", summary: "s", question: "", remaining_work: "" };
const execOutcome: legacy.ExecOutcome = { status: "needs_input", summary: "s", question: "q", remainingWork: "w", userInput: null };
// Version 2 (Q5): three shapes tagged by source.
const reviewEntry = { id: "A", phase: 1, round: 2, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r", duplicate_of: null, reverses: null, superseded: false, file_change: null };
const selfEntry = { id: "P1-S2-1", phase: 1, round: 2, source: "self_correction", problem: "p", action: "plan_error", rationale: "r", superseded: false, file_change: null };
const userEntry = { id: "A", phase: 1, round: 2, source: "user", problem: "p", action: "decided_by_user", rationale: "r", superseded: true };
const usage = { version: 2, agent: "claude", time: "2026-09-24T00:00:00.000Z", session: null, num_turns: 0, total_cost_usd: 0 };
// Issue #120, part 1: the tracker key.
type GithubTrackerShape = { kind: "github"; owner: string; repo: string; labels: { unrefined: string; refined: string; implementing: string; implemented: string; deployed: string } };
const config: typeof S.Config.Type = { ignorePaths: ["a.txt"], maxRounds: 5, maxIdleRounds: 2, maxTransportRetries: 3, transportRetryDelaySeconds: 5, countMinor: true, execPermissionMode: "auto", claudeModel: null, codexModel: null, tracker: null };

test("each schema decodes a valid sample and its type matches the legacy type", () => {
  assert.deepEqual(decode(S.Issue, issue), issue);
  assert.deepEqual(decode(S.Review, { issues: [issue] }), { issues: [issue] });
  assert.deepEqual(decode(S.Disposition, disposition), disposition);
  assert.deepEqual(decode(S.SelfCorrection, selfCorrection), selfCorrection);
  assert.deepEqual(decode(S.PlannerResponse, plannerResponse), plannerResponse);
  assert.deepEqual(decode(S.PlanWriteResult, { questions_for_user: [] }), { questions_for_user: [] });
  assert.deepEqual(decode(S.QuestionEntry, questionEntry), questionEntry);
  assert.deepEqual(decode(S.QuestionList, { questions: [questionEntry] }), { questions: [questionEntry] });
  assert.deepEqual(decode(S.QuestionListResponse, { ...plannerResponse, questions: [questionEntry] }), { ...plannerResponse, questions: [questionEntry] });
  assert.deepEqual(decode(S.InterviewTurn, interviewTurn), interviewTurn);
  assert.deepEqual(decode(S.ExecReport, execReport), execReport);
  assert.deepEqual(decode(S.ExecOutcome, execOutcome), execOutcome);
  assert.deepEqual(decode(S.LogEntry, reviewEntry), reviewEntry);
  assert.deepEqual(decode(S.LogEntry, selfEntry), selfEntry);
  assert.deepEqual(decode(S.LogEntry, userEntry), userEntry);
  assert.deepEqual(decode(S.Config, config), config);
  assert.deepEqual(decode(S.QuestionsFile, { version: 2, task: "t", questions: [questionEntry] }).task, "t");
  assert.equal(decode(S.UsageRecord, usage).agent, "claude");
  assert.equal(decode(S.UsageRecord, { version: 2, agent: "codex", time: "t", thread: "x", input_tokens: 1, output_tokens: 2 }).agent, "codex");

  sameType<Equals<DeepMutable<typeof S.Issue.Type>, DeepMutable<legacy.Issue>>>();
  sameType<Equals<DeepMutable<typeof S.Review.Type>, DeepMutable<legacy.Review>>>();
  sameType<Equals<DeepMutable<typeof S.Disposition.Type>, DeepMutable<legacy.Disposition>>>();
  sameType<Equals<DeepMutable<typeof S.SelfCorrection.Type>, DeepMutable<legacy.SelfCorrection>>>();
  sameType<Equals<DeepMutable<typeof S.PlannerResponse.Type>, DeepMutable<WithQuestions<legacy.PlannerResponse>>>>();
  sameType<Equals<DeepMutable<typeof S.PlanWriteResult.Type>, DeepMutable<WithQuestions<legacy.PlanWriteResult>>>>();
  sameType<Equals<DeepMutable<typeof S.QuestionEntry.Type>, QuestionEntry>>();
  sameType<Equals<DeepMutable<typeof S.QuestionList.Type>, { questions: QuestionEntry[] }>>();
  sameType<Equals<DeepMutable<typeof S.QuestionListResponse.Type>, DeepMutable<WithQuestions<Omit<legacy.QuestionListResponse, "questions">> & { questions: QuestionEntry[] }>>>();
  // G-R1-1: the context call returns the whole question as pieces.
  sameType<Equals<DeepMutable<typeof S.QuestionContext.Type>, { context: Block[]; question: Piece[]; options: PieceOption[]; details: Block[]; explanations: Explanation[] }>>();
  // Decision Q1: the explaining conversation returns each agreed entry divided into pieces, with its explanations.
  sameType<Equals<DeepMutable<typeof S.TermsEntry.Type>, { id: string; explanations: Explanation[]; context: Block[]; question: Piece[]; reason: Block[]; proposed_answers: PieceOption[] }>>();
  sameType<Equals<DeepMutable<typeof S.InterviewTurn.Type>, DeepMutable<legacy.InterviewTurn & { asked_ids: readonly string[] } & CurrentQuestion>>>();
  sameType<Equals<DeepMutable<typeof S.ExecReport.Type>, DeepMutable<legacy.ExecReport>>>();
  sameType<Equals<DeepMutable<typeof S.ExecOutcome.Type>, DeepMutable<legacy.ExecOutcome>>>();
  // Issue #26, Q1: the transport retry budget.
  sameType<Equals<DeepMutable<typeof S.Config.Type>, DeepMutable<Omit<legacy.Config, "questionPhase"> & { maxTransportRetries: number; transportRetryDelaySeconds: number; tracker: GithubTrackerShape | null }>>>();
});

test("each schema rejects a wrong enum value, a missing field and a wrong type", () => {
  rejects(S.Issue, { ...issue, severity: "huge" }, "severity huge");
  rejects(S.Issue, { id: "A", severity: "major", location: "l", problem: "p" }, "an issue without evidence");
  rejects(S.Review, { issues: issue }, "issues that are not an array");
  rejects(S.Disposition, { ...disposition, action: "maybe" }, "action maybe");
  rejects(S.Disposition, { id: "A", action: "accepted", rationale: "r" }, "a disposition without duplicate_of and reverses");
  rejects(S.SelfCorrection, { ...selfCorrection, new_action: "corrected" }, "new_action corrected");
  rejects(S.PlannerResponse, { ...plannerResponse, reviewer_feedback: 1 }, "numeric reviewer_feedback");
  rejects(S.QuestionEntry, { ...questionEntry, proposed_answers: [{ label: "A" }] }, "a proposed answer without a description");
  rejects(S.QuestionEntry, (({ skip_if: _, ...rest }) => rest)(questionEntry), "an entry without its skip condition");
  rejects(S.QuestionEntry, { ...questionEntry, skip_if: { question: "Q0" } }, "a skip condition without its answer");
  rejects(S.InterviewTurn, { ...interviewTurn, complete: "yes" }, "complete as a string");
  rejects(S.InterviewTurn, { message_to_user: "m", current_question: { id: "", context: [], text: [], explanations: [], options: [] }, answered_ids: [], complete: false, summary: "" }, "a turn without asked_ids");
  rejects(S.InterviewTurn, { message_to_user: "m", asked_ids: [], answered_ids: [], complete: false, summary: "" }, "a turn without current_question");
  rejects(S.InterviewTurn, { ...interviewTurn, current_question: { id: "Q1" } }, "a current question without its text");
  rejects(S.InterviewTurn, { ...interviewTurn, current_question: { id: "F1", text: "q?" } }, "a current question without its context, explanations and options");
  rejects(S.QuestionEntry, { id: "Q1", question: plain("q?"), reason: para("r"), proposed_answers: [], default_answer: "" }, "a question entry without its context");
  // Issue #36 (30 Sep 2026): a question's text is never a bare string.
  rejects(S.QuestionEntry, { ...questionEntry, question: "q?" }, "a question entry whose question is a string");
  rejects(S.QuestionEntry, { ...questionEntry, context: "c" }, "a question entry whose context is a string");
  rejects(S.InterviewTurn, { ...interviewTurn, current_question: { ...interviewTurn.current_question, text: "q?" } }, "a current question whose text is a string");
  rejects(S.ExecReport, { ...execReport, status: "done" }, "status done");
  rejects(S.ExecOutcome, { ...execOutcome, userInput: 5 }, "numeric userInput");
  rejects(S.LogEntry, { ...reviewEntry, source: "robot" }, "source robot");
  rejects(S.LogEntry, { ...reviewEntry, phase: "1" }, "phase as a string");
  rejects(S.LogEntry, { ...reviewEntry, action: "accpeted" }, "a misspelled review action (finding 6)");
  rejects(S.LogEntry, { ...selfEntry, action: "rejected" }, "a self-correction with the wire action rejected");
  rejects(S.LogEntry, { ...userEntry, severity: "major" }, "a user entry with a severity");
  rejects(S.LogEntry, { ...reviewEntry, superseded: undefined }, "a review entry without superseded");
  rejects(S.LogEntry, { ...reviewEntry, duplicate_of: "" }, "an empty reference (null in version 2)");
  rejects(S.Config, { ...config, maxRounds: "5" }, "maxRounds as a string");
  rejects(S.Config, { ...config, execPermissionMode: "yolo" }, "execPermissionMode yolo");
  rejects(S.QuestionsFile, { version: 2, questions: [questionEntry] }, "a questions file without a task");
  rejects(S.QuestionsFile, { task: "t", questions: [questionEntry] }, "a questions file without the version marker");
});

test("a question for the user is structured: with options, without options, never a bare string (decision Q1)", () => {
  assert.deepEqual(decode(S.UserQuestion, userQuestion), userQuestion);
  const free = { context: para("c"), question: plain("Which?"), explanations: [], options: [] };
  assert.deepEqual(decode(S.PlanWriteResult, { questions_for_user: [free] }), { questions_for_user: [free] });
  rejects(S.PlanWriteResult, { questions_for_user: ["Which?"] }, "a bare string question");
  rejects(S.PlannerResponse, { ...plannerResponse, questions_for_user: ["Which?"] }, "a bare string question in a response");
  rejects(S.UserQuestion, { ...free, options: undefined }, "a question without options");
  rejects(S.UserQuestion, { ...free, options: [{ label: plain("A") }] }, "an option without a description");
  rejects(S.UserQuestion, { question: plain("Which?"), options: [] }, "a question without its context and explanations (S3)");
  rejects(S.UserQuestion, { ...free, explanations: [{ id: "t1", term: "t" }] }, "an explanation without its text");
  // Issue #36 (30 Sep 2026): pieces and blocks, never strings.
  rejects(S.UserQuestion, { ...free, question: "Which?" }, "a question that is a string");
  rejects(S.UserQuestion, { ...free, context: "c" }, "a context that is a string");
  rejects(S.UserQuestion, { ...free, options: [{ label: "A", description: "a" }] }, "an option of strings");
  rejects(S.UserQuestion, { ...free, question: [{ text: "Which?", ref: "" }] }, "a piece without its code flag");
  rejects(S.UserQuestion, { ...free, context: [{ kind: "table", rows: [] }] }, "a block of an unknown kind");
  rejects(S.UserQuestion, { ...free, context: [{ kind: "list", items: [{ level: 0.5, pieces: [] }] }] }, "a list item at a fractional level");
});

test("Config rejects an unknown key", () => {
  rejects(S.Config, { ...config, maxRound: 3 }, "a misspelled key");
});

// Finding 5 of docs/functional-design-review.md: the program's own records accepted nonsensical numbers and empty ids.
test("the program's record schemas constrain counts, costs and ids", () => {
  for (const bad of [-0.5, 0, 1.5, 2 ** 53]) {
    rejects(S.Config, { ...config, maxRounds: bad }, `maxRounds ${bad}`);
    rejects(S.Config, { ...config, maxIdleRounds: bad }, `maxIdleRounds ${bad}`);
  }
  assert.equal(decode(S.Config, { ...config, maxRounds: 1, maxIdleRounds: 1 }).maxRounds, 1);
  for (const bad of [0, -1, 1.5, "3"]) rejects(S.Config, { ...config, maxTransportRetries: bad }, `maxTransportRetries ${bad}`);
  for (const bad of [0, -1, "5"]) rejects(S.Config, { ...config, transportRetryDelaySeconds: bad }, `transportRetryDelaySeconds ${bad}`);
  rejects(S.LogEntry, { ...reviewEntry, phase: -1 }, "phase -1");
  rejects(S.LogEntry, { ...reviewEntry, round: 0.5 }, "round 0.5");
  rejects(S.LogEntry, { ...reviewEntry, id: "" }, "an empty log entry id");
  assert.equal(decode(S.LogEntry, { ...reviewEntry, phase: 0, round: 1 }).phase, 0);
  assert.equal(decode(S.UsageRecord, usage).agent === "claude" ? 0 : 1, 0);
  rejects(S.UsageRecord, { ...usage, num_turns: -1 }, "num_turns -1");
  rejects(S.UsageRecord, { ...usage, total_cost_usd: -0.01 }, "a negative cost");
  const codex = { version: 2, agent: "codex", time: "t", thread: null, input_tokens: 0, output_tokens: 0 };
  rejects(S.UsageRecord, { ...codex, input_tokens: -1 }, "negative input tokens");
  rejects(S.UsageRecord, { ...codex, output_tokens: -1 }, "negative output tokens");
  rejects(S.QuestionsFile, { version: 2, task: "t", questions: [{ ...questionEntry, id: "" }] }, "an empty question id in questions.json");
});

// Decision support, plan step 1.2: the representation of docs/decision-making.md as structured data.
const el = (text: string, counterarguments: unknown[] = []) => ({ text, counterarguments });
const entry = (id: string, title: string, counter: unknown[] = []) => ({
  id,
  title,
  comparative_condition: el("c", counter),
  starting_cause: el("s"),
  intermediate_steps: el("i"),
  threshold: el("t"),
  effect_on_persons: el("e"),
  reason_the_effect_matters: el("r"),
  extent: { per_person: el("p"), persons_affected: el("a"), likelihood: el("l"), timing: el("w") },
});
// A counterargument, its defense, and the counterargument to that defense: three levels.
const nested = [{ id: "a1", text: "But x.", equivalent_to: "", replies: [{ id: "a2", text: "On the other hand y.", equivalent_to: "", replies: [{ id: "a3", text: "Then again z.", equivalent_to: "E2", replies: [] }] }] }];
const analysis = {
  decision: "d",
  columns: [
    { kind: "argued", option: "A", advantages: [entry("E1", "T1", nested)], disadvantages: [] },
    { kind: "argued", option: "B", advantages: [], disadvantages: [entry("E2", "T2")] },
    // Issue #35 (Q8): an option whose meaning is unclear is not argued from; the column states what is unclear.
    { kind: "unclear", option: "C", unclear: "C could mean a cache or a copy." },
  ],
  recommendation: { option: "", reason: "" },
};

test("the decision analysis decodes three levels of nested arguments; the response and the applied output carry it", () => {
  assert.deepEqual(decode(S.DecisionAnalysis, analysis), analysis);
  const response = { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], analysis };
  assert.deepEqual(decode(S.DecisionResponse, response), response);
  assert.deepEqual(decode(S.DecisionApplied, { analysis }), { analysis });
});

test("the decision analysis rejects a missing element, a missing part of the extent and an argument without replies", () => {
  const { threshold: _t, ...withoutThreshold } = entry("E1", "T1");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ kind: "argued", option: "A", advantages: [withoutThreshold], disadvantages: [] }] }, "an entry without a threshold");
  const e = entry("E1", "T1");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ kind: "argued", option: "A", advantages: [{ ...e, extent: { per_person: el("p") } }], disadvantages: [] }] }, "an extent with one part");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ kind: "argued", option: "A", advantages: [entry("E1", "T1", [{ id: "a", text: "t", equivalent_to: "" }])], disadvantages: [] }] }, "an argument without replies");
  rejects(S.DecisionAnalysis, { decision: "d", columns: [] }, "an analysis without a recommendation");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ option: "A", advantages: [], disadvantages: [] }] }, "a column without kind");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ kind: "unclear", option: "A", advantages: [], disadvantages: [] }] }, "an unclear column without its statement");
  rejects(S.DecisionAnalysis, { ...analysis, columns: [{ kind: "argued", option: "A", unclear: "u" }] }, "an argued column without entries");
});

// Issue #6 (Q1, F1): the plan is structured data. The agent returns stages and steps without statuses; the program
// records a status per step in plan.json.
const planStep = { id: "S1", number: 1, label: "Structured user questions (Q1)", text: "Add the **schema**." };
const plan = { stages: [{ number: 1, title: "the schema and its records", steps: [planStep] }] };
test("the plan's schemas: the reply without statuses, the record with them", () => {
  assert.deepEqual(decode(S.Plan, plan), plan);
  assert.deepEqual(decode(S.PlanWrite, { plan, questions_for_user: [userQuestion] }), { plan, questions_for_user: [userQuestion] });
  assert.deepEqual(decode(S.PlanResponse, { ...plannerResponse, plan }), { ...plannerResponse, plan });
  const recorded = { version: 2, plan: { stages: [{ ...plan.stages[0], steps: [{ ...planStep, status: "started" }] }] } };
  assert.deepEqual(decode(S.PlanFile, recorded), recorded);
  for (const status of ["pending", "started", "done", "unfinished"]) decode(S.StepStatus, status);
  rejects(S.StepStatus, "current", "a status the program does not record");
  rejects(S.Plan, { stages: [{ ...plan.stages[0], steps: [{ ...planStep, status: "done" }] }] }, "a reply step that carries a status");
  rejects(S.Plan, { stages: [{ ...plan.stages[0], steps: [{ ...planStep, number: 1.5 }] }] }, "a step number that is not an integer");
  rejects(S.PlanFile, { ...recorded, version: 1 }, "a plan file of another version");
  rejects(S.PlanFile, { version: 2, plan }, "a recorded step without a status");
});
