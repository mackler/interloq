import { ENDINGS, endedEvent } from "./endingFixtures.ts";
import { PREPARATION_VIEW_OFF } from "../src/preparationSwitch.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import assert from "node:assert/strict";
import { NETWORK_CODES } from "../src/transport.ts";
import { test } from "node:test";
import { ATTACHED_KINDS, type Sense, type Senses } from "../src/question.ts";
import { Option, Result } from "effect";
import fc from "fast-check";
import { Schema } from "effect";
import { excerptOf, RUN_MODES } from "../src/runMode.ts";
import { itemIdOf, itemUrlOf } from "../src/tracker.ts";
import { chainSettingsOf, type ClientMessage, currentIds, listedItemOf, PresentedQuestionSchema, decodeClient, decodeServer, inSnapshot, type RunEvent, type RunRecord, type ServerMessage, type Stamped } from "../src/protocol.ts";
import type { ProcessKey } from "../src/liveOutput.ts";
import type { SubjectId } from "../src/artifacts.ts";
import type { Subject } from "../src/review.ts";
import type { DecisionResponse, PlannerResponse, QuestionListResponse } from "../src/schema.ts";
import { TERMS_MODES } from "../src/schema.ts";
import { decisionSubject, planSubject, questionSubject, requirementsSubject, updateSubject, verdictSubject, workSubject } from "../src/subjects.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { DECISION_SECTIONS, type RunUiState, type UiScope } from "../src/uiState.ts";
import { promptOf } from "../src/userPrompts.ts";
import * as prompts from "../src/prompts.ts";
import { entryOf, workExecution , TEST_ROOT } from "./helpers.ts";
import { begun, DEFAULT_SETTINGS, initialState, queueEdited } from "../src/chain.ts";
import { editIdOf, type QueueChange, type QueueEdit } from "../src/chainQueue.ts";
import { queueFrame } from "../web/src/tabs.ts";
import type { ItemId } from "../src/tracker.ts";

// Plan step 3.1: both sides decode with the same schemas; every variant survives the JSON round trip.
const nat = fc.nat({ max: 10_000 });
const text = fc.string({ maxLength: 20 });
const subject = fc.oneof(fc.constant("questions" as const), fc.constant("questionReading" as const), fc.constant("requirements" as const), nat.map((plan) => ({ plan })), nat.map((work) => ({ work })), nat.map((decision) => ({ decision })));
const phase = fc.oneof(fc.constant({ kind: "questions" as const }), fc.record({ kind: fc.constantFrom("planning" as const, "execution" as const, "work" as const), n: nat }));
const agent = fc.constantFrom("claude" as const, "codex" as const);
const reviewIssue = fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), severity: fc.constantFrom("blocking" as const, "major" as const, "minor" as const), location: text, problem: text, evidence: text, concern: fc.constant("c"), remedy: fc.constant("r") });
const review = fc.record({ issues: fc.array(reviewIssue, { maxLength: 3 }) });
// Issue #36: a question's text as pieces and blocks, every kind of block included.
const piece = fc.record({ text, ref: text, code: fc.boolean() });
const pieces = fc.array(piece, { maxLength: 3 });
const block = fc.oneof(
  fc.record({ kind: fc.constant("paragraph" as const), pieces }),
  fc.record({ kind: fc.constant("list" as const), items: fc.array(fc.record({ level: fc.nat(3), pieces }), { maxLength: 2 }) }),
  fc.record({ kind: fc.constant("code" as const), text }),
);
const shownBlock = fc.oneof(block, fc.record({ kind: fc.constant("document" as const), markdown: text }));
const explanation = fc.record({ id: text, term: text, senses: fc.array(text, { minLength: 1, maxLength: 2 }) });
// Issue #170: what a usage limit's wait rests on.
const limitBasis = fc.oneof(
  fc.constant({ kind: "reset" as const }),
  fc.record({ kind: fc.constant("pastReset" as const), namedMs: nat }),
  fc.record({ kind: fc.constant("noKnownEnd" as const), attempt: fc.integer({ min: 1, max: 1000 }) }),
);
const sense = text.filter((t) => t.trim() !== "").map((t) => t as Sense);
const shownExplanation = fc.record({ id: text, term: text, senses: fc.tuple(sense, fc.array(sense, { maxLength: 1 })).map(([first, rest]): Senses => [first, ...rest]) });
const pieceOption = fc.record({ label: pieces, description: pieces, figure: fc.constant(null) });
const userQuestion = fc.record({ context: fc.array(block, { maxLength: 2 }), history: fc.array(block, { maxLength: 2 }), question: pieces, explanations: fc.array(explanation, { maxLength: 2 }), options: fc.array(pieceOption, { maxLength: 2 }) });
const disposition = fc.record({ id: text, action: fc.constantFrom("accepted" as const, "rejected" as const, "partially_accepted" as const, "no_change_needed" as const, "clarification_requested" as const), rationale: text, duplicate_of: text, reverses: text, concern: fc.constant("c"), remedy: fc.constant("r"), resolution: fc.constant(null) });
const plannerResponse = fc.record({
  dispositions: fc.array(disposition, { maxLength: 3 }),
  self_corrections: fc.array(fc.record({ id: text, new_action: fc.constantFrom("accepted" as const, "rejected" as const, "plan_error" as const), explanation: text, concern: fc.constant("c"), remedy: fc.constant("r"), resolution: fc.constant(null) }), { maxLength: 2 }),
  reviewer_feedback: text,
  questions_for_user: fc.array(userQuestion, { maxLength: 2 }),
});
const questionEntry = fc.record({ id: text, context: fc.array(block, { maxLength: 2 }), history: fc.array(block, { maxLength: 2 }), question: pieces, reason: fc.array(block, { maxLength: 2 }), proposed_answers: fc.array(pieceOption, { maxLength: 2 }), default_answer: text, skip_if: fc.option(fc.record({ question: text, answer: text }), { nil: null }) });
// Defect A of docs/page-question-phase-defects.md: the question subject's response carries the amended list too.
// Issue #156: its dispositions carry Claude Code's mark, as the question list's schema requires.
const markedDisposition = fc.tuple(disposition, fc.boolean()).map(([d, task_dispute]) => ({ ...d, task_dispute }));
const markedListResponse = fc.tuple(plannerResponse, fc.array(markedDisposition, { maxLength: 3 }), fc.array(questionEntry, { maxLength: 2 })).map(([r, dispositions, questions]) => ({ ...r, dispositions, questions }));
const response = fc.oneof(plannerResponse, markedListResponse);
const outcome = fc.record({ status: fc.constantFrom("finished" as const, "needs_input" as const, "blocked" as const, "aborted" as const), summary: text, question: text, remainingWork: text, userInput: fc.option(text, { nil: null }), checks: fc.array(fc.record({ step: text, command: text, seconds: fc.double({ noNaN: true, noDefaultInfinity: true }), selection: fc.boolean(), counts: fc.option(fc.record({ passed: nat, failed: nat, skipped: nat }), { nil: null }) }), { maxLength: 2 }) });
// Issue #216 (W1-R1-2): the noun of Codex's pass that a pause, limit or unchanged origin carries.
const pass = fc.constantFrom("check" as const, "review" as const);
// S5: a question as the user is shown it, with every kind of origin and both kinds of answer.
const origin = fc.oneof(
  fc.record({ kind: fc.constantFrom("clarification" as const, "followUp" as const), id: text }),
  fc.record({ kind: fc.constantFrom("reply" as const, "relayed" as const) }),
  fc.record({ kind: fc.constant("planner" as const), heading: text }),
  fc.record({ kind: fc.constant("permission" as const), tool: text, input: text }),
  fc.record({ kind: fc.constant("pause" as const), heading: text, pass, pause: fc.constantFrom("reraised" as const, "secondClarification" as const, "disputedSelfCorrection" as const), id: text }),
  fc.record({ kind: fc.constant("pause" as const), heading: text, pass, pause: fc.constant("reversal" as const), id: text, reverses: text }),
  fc.record({ kind: fc.constant("pause" as const), heading: text, pass, pause: fc.constant("repeatedUnderNewId" as const), id: text, repeats: text }),
  fc.record({ kind: fc.constant("pause" as const), heading: text, pass, pause: fc.constant("idle" as const), idle: nat }),
  fc.record({ kind: fc.constant("limit" as const), heading: text, pass, limit: nat }),
  fc.record({ kind: fc.constant("unchanged" as const), heading: text, pass, fileLabel: text, accepted: fc.array(text, { maxLength: 2 }) }),
  fc.record({ kind: fc.constant("transport" as const), agent, what: text, attempts: nat, fault: text }),
  // Issue #171: the tracker's exhaustion question.
  fc.record({ kind: fc.constant("tracker" as const), tracker: text, what: text, attempts: nat, fault: text }),
  // Issue #181: the question after the final suite was stopped outside the work again.
  fc.record({ kind: fc.constant("suiteStopped" as const), command: text, suite: nat, stops: nat, reason: text }),
);
const presentedQuestion = fc.record({
  number: nat,
  origin,
  context: fc.record({ blocks: fc.array(shownBlock, { maxLength: 2 }), by: fc.constantFrom("agent" as const, "program" as const) }),
  history: fc.array(shownBlock, { maxLength: 2 }),
  // Issue #112: a presented explanation has one or more senses, none blank.
  explanations: fc.array(shownExplanation, { maxLength: 2 }),
  question: pieces,
  options: fc.array(fc.record({ label: pieces, description: pieces, figure: fc.constant(null), answer: fc.oneof(fc.record({ token: text }), fc.constant({ numeric: true as const })) }), { maxLength: 3 }),
  attached: fc.option(fc.record({ kind: fc.constantFrom(...ATTACHED_KINDS), blocks: fc.tuple(shownBlock).chain((first) => fc.array(shownBlock, { maxLength: 1 }).map((rest) => [...first, ...rest] as const)) }), { nil: null }),
  decision: fc.option(nat, { nil: null }),
});
const uiEvent: fc.Arbitrary<UiEvent> = fc.oneof(
  phase.map((p) => ({ _tag: "PhaseBegan" as const, phase: p })),
  fc.record({ _tag: fc.constant("PhaseEnded" as const), phase, result: text }),
  fc.record({ _tag: fc.constant("RoundBegan" as const), subject, round: nat, limit: nat }),
  fc.record({ _tag: fc.constant("ReviewReceived" as const), subject, round: nat, review, counted: nat }),
  fc.record({ _tag: fc.constant("ResponseReceived" as const), subject, round: nat, response, resultText: text }),
  fc.record({ _tag: fc.constant("LoopFinished" as const), subject, result: fc.constantFrom("converged" as const, "proceed" as const, "revise" as const) }),
  fc.record({ _tag: fc.constant("PlanWritten" as const), phase: nat, resultText: text }),
  fc.record({ _tag: fc.constant("ExecutionEnded" as const), phase: nat, outcome }),
  fc.record({ _tag: fc.constant("AgentCallStarted" as const), agent, purpose: text, callId: text }),
  fc.record({ _tag: fc.constant("ToolUsed" as const), agent, tool: text, target: text, callId: text }),
  fc.record({ _tag: fc.constant("AgentCallEnded" as const), agent, ok: fc.boolean(), callId: text }),
  fc.record({ _tag: fc.constant("InterviewTurn" as const), heading: text, message: text, summary: fc.option(text, { nil: null }), answered: nat, total: nat }),
  fc.record({ _tag: fc.constant("InterviewOpened" as const), heading: text, stage: fc.constantFrom("clarification" as const, "followUp" as const), total: nat }),
  fc.record({ _tag: fc.constant("ClaudeSaid" as const), text, running: fc.array(text, { maxLength: 3 }) }),
  // Issue #205: the agreed question list known, with its count.
  fc.record({ _tag: fc.constant("QuestionsAgreed" as const), count: nat }),
  // The dashboard's model lines: an agent's model as data, not a line of text.
  fc.oneof(
    fc.record({ _tag: fc.constant("ModelNamed" as const), model: fc.record({ agent: fc.constant("claude" as const), name: text }) }),
    fc.record({ _tag: fc.constant("ModelNamed" as const), model: fc.record({ agent: fc.constant("codex" as const), name: fc.option(text, { nil: null }) }) }),
  ),
  fc.constant({ _tag: "AnswerRejected" as const }),
  // Issue #26: the program's retry and its recovery.
  fc.record({ _tag: fc.constant("TransportRetrying" as const), wait: nat, agent, purpose: text, attempt: nat, of: nat, delaySeconds: fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), fault: text, fromMs: nat, untilMs: nat }),
  fc.record({ _tag: fc.constant("TransportRecovered" as const), agent }),
  // Issue #201: a try for an unreachable network.
  fc.record({ _tag: fc.constant("NetworkRetrying" as const), wait: nat, agent, purpose: text, what: text, attempt: nat, code: fc.constantFrom(...NETWORK_CODES), delaySeconds: fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), fault: text, fromMs: nat, untilMs: nat }),
  // Issue #171.
  fc.record({ _tag: fc.constant("TrackerRetrying" as const), wait: nat, tracker: text, what: text, attempt: nat, of: nat, delaySeconds: fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), fault: text, fromMs: nat, untilMs: nat }),
  fc.record({ _tag: fc.constant("TrackerRecovered" as const), tracker: text }),
  // Issue #170: a usage limit's wait with its basis.
  fc.record({ _tag: fc.constant("UsageLimitWaiting" as const), wait: nat, agent, purpose: text, limitType: fc.option(text, { nil: null }), basis: limitBasis, fromMs: nat, untilMs: nat }),
  fc.record({ _tag: fc.constant("UsageLimitLifted" as const), agent, waitedMs: nat }),
  // Issue #215: a wait the developer ended early.
  fc.record({ _tag: fc.constant("WaitEndedEarly" as const), wait: nat }),
  // Issue #26: the SDK's own reconnection.
  fc.record({ _tag: fc.constant("AgentReconnecting" as const), agent, by: fc.constant("sdk" as const), attempt: fc.option(nat, { nil: null }), of: fc.option(nat, { nil: null }), delayMs: fc.option(nat, { nil: null }), detail: text, callId: text }),
  // Issue #6: the phases known of the run.
  fc.record({ _tag: fc.constant("PhasesForeseen" as const), phases: fc.array(phase, { maxLength: 4 }) }),
  // Issue #6: the plan with its statuses, after every write and every report of a step.
  fc.record({
    _tag: fc.constant("PlanChanged" as const),
    phase: nat,
    plan: fc.record({
      stages: fc.array(
        fc.record({ number: nat, title: text, steps: fc.array(fc.record({ id: text, number: nat, label: text, text, status: fc.constantFrom("pending" as const, "started" as const, "done" as const, "unfinished" as const) }), { maxLength: 2 }) }),
        { maxLength: 2 },
      ),
    }),
    // Issue #53: the report that caused it, or null.
    step: fc.option(fc.record({ id: text, status: fc.constantFrom("started" as const, "done" as const) }), { nil: null }),
  }),
  fc.record({ _tag: fc.constant("QuestionPresented" as const), question: presentedQuestion }),
  fc.record({ _tag: fc.constant("AnalysisProgress" as const), decision: nat, question: fc.option(nat, { nil: null }), check: nat }),
  fc.record({
    _tag: fc.constant("DecisionAnalyzed" as const),
    decision: nat,
    question: text,
    presented: presentedQuestion,
    options: fc.array(fc.record({ label: text, description: text }), { maxLength: 3 }),
    analysis: fc.record({ decision: text, columns: fc.array(fc.oneof(fc.record({ kind: fc.constant("argued" as const), option: text, advantages: fc.constant([]), disadvantages: fc.constant([]) }), fc.record({ kind: fc.constant("unclear" as const), option: text, unclear: text })), { maxLength: 2 }), recommendation: fc.record({ option: text, reason: text }) }),
  }),
  // Issue #86: the document under review of a review loop, in each of its forms.
  fc.record({
    _tag: fc.constant("DocumentShown" as const),
    subject,
    document: fc.oneof(
      fc.record({ _tag: fc.constant("Markdown" as const), text }),
      fc.record({ _tag: fc.constant("Diff" as const), text }),
      fc.record({ _tag: fc.constant("Analysis" as const), analysis: fc.record({ decision: text, columns: fc.array(fc.record({ kind: fc.constant("unclear" as const), option: text, unclear: text }), { maxLength: 2 }), recommendation: fc.record({ option: text, reason: text }) }) }),
    ),
  }),
);
// Issue #120: the mode of a run, from the one source of the modes.
const mode = fc.constantFrom(...RUN_MODES);
const promptTexts = [prompts.decisionPrompt, prompts.limitPrompt, prompts.permissionPrompt, prompts.interviewMessagePrompt, "unknown > "];
const runEvent: fc.Arbitrary<RunEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Started" as const), project: text, location: text, task: text, mode, item: fc.record({ id: text, title: text }) }),
  fc.record({ _tag: fc.constant("Said" as const), text }),
  // Issue #185: a prompt may count down, with its expiry.
  fc
    .tuple(nat, fc.constantFrom(...promptTexts), fc.option(fc.record({ fromMs: nat, untilMs: nat }), { nil: null }))
    .map(([prompt, t, countdown]): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(t), countdown, deciding: null, beside: null })),
  // Issue #153: a prompt open beside a decision being prepared names its question; a withdrawn one its prompt.
  fc.tuple(nat, fc.constantFrom(...promptTexts), nat).map(([prompt, t, deciding]): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(t), countdown: null, deciding, beside: null })),
  fc.record({ _tag: fc.constant("PromptWithdrawn" as const), prompt: nat }),
  fc.record({ _tag: fc.constant("PromptClosed" as const), prompt: nat }),
  fc.record({ _tag: fc.constant("CountdownStopped" as const), prompt: nat, reason: fc.constantFrom("held" as const, "chainOff" as const) }),
  fc.record({ _tag: fc.constant("AnswerExpired" as const), prompt: nat, seconds: nat }),
  fc.record({ _tag: fc.constant("Answered" as const), prompt: nat, text }),
  uiEvent.map((event) => ({ _tag: "Notified" as const, event })),
  fc.constantFrom(...ENDINGS.flatMap((e) => (e._tag === "Unestablished" ? [] : [endedEvent(e)]))),
);
// Issue #1: every event carries the time of its publication, beside its seq, not inside the variant.
const stamped: fc.Arbitrary<Stamped> = fc.record({ time: text, event: runEvent });
const runRecord: fc.Arbitrary<RunRecord> = fc.record({ id: nat, events: fc.array(stamped, { maxLength: 4 }) });
// Issue #87: the shared state of a run's page.
const uiScope: fc.Arbitrary<UiScope> = fc.oneof(
  fc.record({ _tag: fc.constant("DecisionEntry" as const), decision: nat, entry: text }),
  // Issue #63: the progress rail's phases and branches.
  fc.record({ _tag: fc.constant("RailPhase" as const), phase: text }),
  fc.record({ _tag: fc.constant("RailBranch" as const), phase: text, branch: text }),
  // Issue #133: a collapsed heading of a decision's page.
  fc.record({ _tag: fc.constant("DecisionSection" as const), decision: nat, section: fc.constantFrom(...DECISION_SECTIONS) }),
  // Issue #22: the dashboard's heading of every answer.
  fc.constant({ _tag: "DashboardAnswers" as const }),
  // Issue #86: the dashboard's heading of the document under review.
  fc.constant({ _tag: "DashboardDocument" as const }),
);
const uiState: fc.Arbitrary<RunUiState> = fc.record({ version: nat, choices: fc.array(fc.record({ scope: uiScope, open: fc.boolean() }), { maxLength: 3 }) });
const client: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({ type: fc.constant("start" as const), mode: fc.constant("refinement" as const), item: text, terms: fc.constantFrom(...TERMS_MODES) }),
  fc.record({ type: fc.constant("start" as const), mode: fc.constant("implementation" as const), item: text }),
  fc.record({ type: fc.constant("items" as const), mode }),
  fc.record({ type: fc.constant("answer" as const), incarnation: text, run: nat, prompt: nat, text }),
  fc.record({ type: fc.constant("stop" as const), incarnation: text, run: nat }),
  fc.record({ type: fc.constant("hold" as const), incarnation: text, run: nat, prompt: nat }),
  fc.record({ type: fc.constant("ui" as const), incarnation: text, run: nat, flag: fc.record({ scope: uiScope, open: fc.boolean() }) }),
  // Issue #131: the preparation's switch turned on or off.
  fc.record({ type: fc.constant("preparation" as const), enabled: fc.boolean() }),
);
/** Issue #131: the preparation's view as the server sends it. */
const preparationView = fc.record({
  settings: fc.record({ enabled: fc.boolean(), generation: nat }),
  status: fc.oneof(fc.constant({ _tag: "Off" as const }), fc.constant({ _tag: "Idle" as const }), fc.record({ _tag: fc.constant("Preparing" as const), item: text, title: text }), fc.record({ _tag: fc.constant("Unavailable" as const), notice: text })),
});
/** Issue #125: an https address, as an adapter's itemUrlOf accepts. */
const httpsUrl = fc.tuple(fc.stringMatching(/^[a-z0-9]{1,10}$/u), fc.stringMatching(/^[a-z0-9/]{0,12}$/u)).map(([host, path]) => `https://${host}.example/${path}`);
const listedItem = fc.record({ id: text, title: text, excerpt: text, url: fc.option(httpsUrl, { nil: null }), sentBack: fc.nat(9), preparation: fc.constantFrom(null, { _tag: "Preparing" as const }, { _tag: "Prepared" as const, questions: 2 }, { _tag: "SetAside" as const, reason: "r" }) });
const server: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({ type: fc.constant("hello" as const), location: text, current: fc.record({ refinement: fc.array(nat, { maxLength: 3 }), implementation: fc.option(nat, { nil: null }) }), incarnation: text, chain: fc.constant(initialState(DEFAULT_SETTINGS)), preparation: preparationView }),
  // Issue #131: the preparation's switch and status after a change.
  fc.record({ type: fc.constant("preparation" as const), view: preparationView }),
  fc.constant({ type: "closing" as const }),
  // Issue #13: the frame of a tab the server closes for falling too far behind.
  fc.constant({ type: "behind" as const }),
  fc.record({ type: fc.constant("replay" as const), runs: fc.array(runRecord, { maxLength: 2 }), ui: fc.array(fc.record({ run: nat, state: uiState }), { maxLength: 2 }) }),
  fc.record({ type: fc.constant("ui" as const), run: nat, state: uiState }),
  fc.record({ type: fc.constant("event" as const), run: nat, seq: nat, time: text, event: runEvent }),
  fc.record({
    type: fc.constant("items" as const),
    mode: fc.constant("refinement" as const),
    result: fc.oneof(fc.record({ _tag: fc.constant("Listed" as const), items: fc.array(listedItem, { maxLength: 3 }), terms: fc.constantFrom(...TERMS_MODES) }), fc.record({ _tag: fc.constant("Unavailable" as const), notice: text })),
  }),
  fc.record({
    type: fc.constant("items" as const),
    mode: fc.constant("implementation" as const),
    result: fc.oneof(fc.record({ _tag: fc.constant("Listed" as const), items: fc.array(listedItem, { maxLength: 3 }) }), fc.record({ _tag: fc.constant("Unavailable" as const), notice: text })),
  }),
  fc.record({ type: fc.constant("refused" as const), mode: fc.option(mode, { nil: null }), reason: text }),
);

/** The value as plain objects (fast-check's records have no prototype, which strict deepEqual distinguishes). */
const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value));
const decoded = <A>(r: Result.Result<A, string>): A => {
  assert.ok(Result.isSuccess(r), `not decoded: ${Result.isFailure(r) ? r.failure : ""}`);
  return r.success;
};

// Issue #125: an item's address reaches the page only as an https address, or null where the tracker gave none.
test("an items frame whose item's address is not https does not decode; one with an https address or null does", () => {
  const frame = (url: unknown) => JSON.stringify({ type: "items", mode: "implementation", result: { _tag: "Listed", items: [{ id: "1", title: "t", excerpt: "", url, sentBack: 0, preparation: null }] } });
  assert.ok(Result.isFailure(decodeServer(frame("javascript:alert(1)"))));
  assert.ok(Result.isFailure(decodeServer(frame("http://github.com/x"))));
  assert.ok(Result.isSuccess(decodeServer(frame("https://github.com/mackler/interloq/issues/125"))));
  assert.ok(Result.isSuccess(decodeServer(frame(null))));
});

test("listedItemOf: the id, the title, the excerpt of the body, and the address or null", () => {
  const item = { id: Result.getOrThrow(itemIdOf("7")), title: "Seven", body: "The body.", state: "refined" as const };
  const page = Result.getOrThrow(itemUrlOf("https://github.com/mackler/interloq/issues/7"));
  assert.deepEqual(listedItemOf({ ...item, url: Option.some(page) }, 0), { id: "7", title: "Seven", excerpt: excerptOf("The body."), url: page, sentBack: 0, preparation: null });
  assert.deepEqual(listedItemOf({ ...item, url: Option.none() }, 2), { id: "7", title: "Seven", excerpt: excerptOf("The body."), url: null, sentBack: 2, preparation: null });
});

// Issue #186 (F1): the count of send-backs crosses the protocol as a non-negative whole number.
test("an items frame's sentBack decodes as a non-negative whole number, and a negative or a fraction is refused", () => {
  const frame = (sentBack: unknown) => JSON.stringify({ type: "items", mode: "implementation", result: { _tag: "Listed", items: [{ id: "7", title: "t", excerpt: "", url: null, sentBack, preparation: null }] } });
  assert.ok(Result.isSuccess(decodeServer(frame(2))));
  assert.ok(Result.isSuccess(decodeServer(frame(0))));
  assert.ok(Result.isFailure(decodeServer(frame(-1))));
  assert.ok(Result.isFailure(decodeServer(frame(1.5))));
  assert.ok(Result.isFailure(decodeServer(JSON.stringify({ type: "items", mode: "implementation", result: { _tag: "Listed", items: [{ id: "7", title: "t", excerpt: "", url: null }] } }))));
});

// Issue #120: a run is started from a mode and an item; the page sends no project and no task text.
test("a start message decodes with its mode and item; one with a project and a task, or an unknown mode, is refused", () => {
  // Issue #142: a refinement's start carries its choice of terms, an implementation's none.
  for (const frame of [{ type: "start", mode: "refinement", item: "120", terms: "onRequest" }, { type: "start", mode: "implementation", item: "120" }]) assert.deepEqual(decoded(decodeClient(JSON.stringify(frame))), frame);
  for (const frame of [{ type: "start", project: "/p", task: "t" }, { type: "start", mode: "review", item: "1" }, { type: "items", mode: "deployment" }, { type: "list", path: "/" }]) {
    assert.ok(Result.isFailure(decodeClient(JSON.stringify(frame))), JSON.stringify(frame));
  }
});

test("a refused frame keeps its mode, null included", () => {
  for (const m of [...RUN_MODES, null]) assert.deepEqual(decoded(decodeServer(JSON.stringify({ type: "refused", mode: m, reason: "r" }))), { type: "refused", mode: m, reason: "r" });
  assert.ok(Result.isFailure(decodeServer(JSON.stringify({ type: "refused", reason: "r" }))), "a refusal without its mode");
});

test("property: every client message survives the JSON round trip", () => {
  fc.assert(fc.property(client, (m) => assert.deepEqual(decoded(decodeClient(JSON.stringify(m))), plain(m))));
});

test("property: every server message survives the JSON round trip", () => {
  fc.assert(fc.property(server, (m) => assert.deepEqual(decoded(decodeServer(JSON.stringify(m))), plain(m))), { numRuns: 200 });
});

// A stop or an answer without its incarnation (the shape before finding 12) is refused too.
test("a frame that is not JSON, or not a message, or has an unknown field, is refused", () => {
  for (const frame of ["not json", "{}", JSON.stringify({ type: "start", project: "/p" }), JSON.stringify({ type: "stop", run: "1" }), JSON.stringify({ type: "stop", run: 1, extra: true }), JSON.stringify({ type: "stop", run: 1 }), JSON.stringify({ type: "answer", run: 1, prompt: 1, text: "x" })]) {
    assert.ok(Result.isFailure(decodeClient(frame)), frame);
  }
});

const T = "2026-09-27T14:03:27.000Z";

// Issue #1: a frame or a replay entry without its time, or a Started with the time it carried before, is refused.
test("an event frame without its time, a bare replay entry, and a Started that still carries a time are refused", () => {
  const said = { _tag: "Said", text: "x" };
  for (const frame of [
    { type: "event", run: 1, seq: 0, event: said },
    { type: "replay", ui: [], runs: [{ id: 1, events: [said] }] },
    { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Started", project: "/p", location: "/p", task: "t", mode: "refinement", item: { id: "1", title: "t" }, time: T } },
    { type: "replay", ui: [], runs: [{ id: 1, events: [{ event: said }] }] },
  ]) assert.ok(Result.isFailure(decodeServer(JSON.stringify(frame))), JSON.stringify(frame));
  const ok: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Started", project: "/p", location: "/p", task: "t", mode: "refinement", item: { id: "1", title: "t" } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(ok))), ok);
});

// P1-R1-2 (both rounds): the boundary is kept for every replayed run.
const position = fc.record({ run: fc.nat({ max: 5 }), seq: fc.nat({ max: 60 }) });
const replayed = fc.uniqueArray(fc.record({ id: fc.nat({ max: 5 }), count: fc.nat({ max: 60 }) }), { selector: (r) => r.id, maxLength: 2 }).map((rs) => rs.map((r): RunRecord => ({ id: r.id, events: Array.from({ length: r.count }, () => ({ time: T, event: { _tag: "Said" as const, text: "" } })) })));

test("property: inSnapshot drops exactly the first events.length events of each replayed run, and nothing of another run", () => {
  fc.assert(
    fc.property(replayed, position, (runs, message) => {
      const run = runs.find((r) => r.id === message.run);
      assert.equal(inSnapshot(runs, message), run !== undefined && message.seq < run.events.length);
    }),
  );
});

test("inSnapshot: with an empty replay nothing is dropped; a later run passes from seq 0; an ended run is filtered too", () => {
  assert.equal(inSnapshot([], { run: 1, seq: 0 }), false);
  const a: RunRecord = { id: 1, events: Array.from({ length: 50 }, () => ({ time: T, event: { _tag: "Said" as const, text: "" } })) };
  assert.equal(inSnapshot([a], { run: 2, seq: 0 }), false);
  assert.equal(inSnapshot([a], { run: 1, seq: 49 }), true);
  assert.equal(inSnapshot([a], { run: 1, seq: 50 }), false);
});

// Defect A of docs/page-question-phase-defects.md: a question review's response is a QuestionListResponse, the planner's
// response plus the amended list; the page's decoding refused it, and with it the whole replay.
const questionListResponse: QuestionListResponse = {
  dispositions: [{ id: "Q-R1-1", action: "accepted", rationale: "Added the database question.", duplicate_of: "", reverses: "", concern: "c", remedy: "r", resolution: null, task_dispute: false }],
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  correction_passages: [],
  questions: [entryOf({ id: "Q1", context: "c", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }], default_answer: "PostgreSQL" })],
};
const responseEvent = (subject: SubjectId, response: QuestionListResponse | PlannerResponse | DecisionResponse): RunEvent => ({ _tag: "Notified", event: { _tag: "ResponseReceived", subject, round: 1, response, resultText: "" } });

test("a question review's ResponseReceived survives the round trip, live and in a replay", () => {
  const event: ServerMessage = { type: "event", run: 1, seq: 5, time: T, event: { _tag: "Notified", event: { _tag: "ResponseReceived", subject: "questions", round: 1, response: questionListResponse, resultText: "" } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(event))), event);
  const replay: ServerMessage = { type: "replay", runs: [{ id: 1, events: [{ time: event.time, event: event.event }] }], ui: [] };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(replay))), replay);
});

const decisionAnalysis = { decision: "d", columns: [{ kind: "argued", option: "A", advantages: [], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "", reason: "" } };
const decisionResponseSchema = decisionSubject(1, 1, "format", (a) => Result.succeed({ value: a, notes: [] })).respond.schema;

test("every subject's response, as its own schema decodes it, survives the round trip inside a ResponseReceived", () => {
  const { questions: _questions, ...plannerResponse } = questionListResponse;
  // Issue #183: the plan's and the work's responses state each disposition's effect on the work.
  const effectResponse = { ...plannerResponse, dispositions: plannerResponse.dispositions.map((d) => ({ ...d, work_effect: { kind: "differs", difference: "a test" } })) };
  const subjects = [
    { subject: "questions" as SubjectId, schema: questionSubject("t").respond.schema, example: questionListResponse },
    { subject: "requirements" as const, schema: requirementsSubject().respond.schema, example: { ...plannerResponse, findings: [], requirements: null } },
    // Issue #6: the plan's response carries the whole plan.
    { subject: { plan: 1 }, schema: planSubject(TEST_ROOT, 1, true, null, NO_STEP_CHECKS).respond.schema, example: { ...effectResponse, plan: { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "x" }] }] } } },
    { subject: { work: 1 }, schema: workSubject("t", 1, true, workExecution, NO_STEP_CHECKS).respond.schema, example: effectResponse },
    // W2-R1-1: a decision's response carries the amended analysis.
    { subject: { decision: 1 }, schema: decisionResponseSchema, example: { ...plannerResponse, analysis: decisionAnalysis } },
    // Issue #216: Bring Up to Date's response carries the issue brought up to date; the page stopped on it, 2 Nov 2026.
    { subject: "update" as const, schema: updateSubject().respond.schema, example: { ...questionListResponse, questions: undefined, issue: { title: "t", text: "x" }, outcome: { kind: "current" }, developer_passages: [] } },
    // Issue #186: the verdict's response carries what the requirements leave out.
    { subject: { verdict: 1 }, schema: verdictSubject(1, 1, { kind: "planning", n: 1 }, { _tag: "FirstPlan" }, true).respond.schema, example: { ...plannerResponse, missing: "m" } },
  ];
  for (const { subject, schema, example } of subjects) {
    const response = Schema.decodeUnknownSync(schema)(example);
    const message: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: responseEvent(subject, response) };
    assert.deepEqual(decoded(decodeServer(JSON.stringify(message))), plain(message), JSON.stringify(subject));
  }
});

// The audit of defect A (step 2.3 of its plan): the response type of every subject must be exactly one of the members
// the event carries. `Subject<R>` requires only `R extends PlannerResponse`, so assignability would admit a wider R;
// equality does not. Both parameters are inferred: `applyDecisions.after` takes D, so fixing D would yield never.
// A subject added to src/subjects.ts is covered once it is added to this list. The members are the event's own
// (`UiEvent`'s ResponseReceived), so a response type the event does not carry fails here, not only at run time.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type EventResponse = Extract<UiEvent, { _tag: "ResponseReceived" }>["response"];
type MemberOf<R, U> = true extends (U extends unknown ? Same<R, U> : never) ? true : false;
type RespondOf<T> = T extends Subject<infer R, infer _D> ? R : never;
type Carried<R> = MemberOf<R, EventResponse>;
const holds = <_T extends true>(): void => undefined;
const fails = <_T extends false>(): void => undefined;
type Responses = [RespondOf<ReturnType<typeof questionSubject>>, RespondOf<ReturnType<typeof requirementsSubject>>, RespondOf<ReturnType<typeof planSubject>>, RespondOf<ReturnType<typeof workSubject>>, RespondOf<ReturnType<typeof decisionSubject>>];
fails<Same<Responses[0], never>>();
fails<Same<Responses[1], never>>();
fails<Same<Responses[2], never>>();
fails<Same<Responses[3], never>>();
holds<Carried<Responses[0]>>();
holds<Carried<Responses[1]>>();
holds<Carried<Responses[2]>>();
holds<Carried<Responses[3]>>();
fails<Same<Responses[4], never>>();
holds<Carried<Responses[4]>>();
type MoreResponses = [RespondOf<ReturnType<typeof updateSubject>>, RespondOf<ReturnType<typeof verdictSubject>>];
holds<Carried<MoreResponses[0]>>();
holds<Carried<MoreResponses[1]>>();
// The check itself refuses a response with a field the event does not carry.
fails<Carried<PlannerResponse & { extra: string }>>();

// Issue #5: Claude Code's prose travels to the page as data, attributed to Claude.
test("a ClaudeSaid event survives the round trip, live and in a replay", () => {
  const event: RunEvent = { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "**done**", running: [] } };
  for (const m of [{ type: "event", run: 1, seq: 0, time: T, event }, { type: "replay", ui: [], runs: [{ id: 1, events: [{ time: T, event }] }] }] as ServerMessage[]) {
    assert.deepEqual(decoded(decodeServer(JSON.stringify(m))), m);
  }
});

// Issue #40: the processes open when the message arrived survive the round trip; a record without them decodes with none.
test("a ClaudeSaid's running processes survive the round trip, and a ClaudeSaid written before issue #40 decodes with none", () => {
  const event: RunEvent = { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "tests passed", running: ["npm test", "watch log"] } };
  for (const m of [{ type: "event", run: 1, seq: 0, time: T, event }, { type: "replay", ui: [], runs: [{ id: 1, events: [{ time: T, event }] }] }] as ServerMessage[]) {
    assert.deepEqual(decoded(decodeServer(JSON.stringify(m))), m);
  }
  const old = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "done" } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(old))), { ...old, event: { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "done", running: [] } } });
});

// Issue #53 (G-R1-1): PlanChanged carries the report that caused it, or null for a plan the program wrote.
test("PlanChanged with and without its report survives the round trip", () => {
  const plan = { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "x", status: "started" as const }] }] };
  for (const step of [{ id: "S1", status: "started" as const }, null]) {
    const event: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "PlanChanged", phase: 1, plan, step } } };
    assert.deepEqual(decoded(decodeServer(JSON.stringify(event))), event);
  }
  const without = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "PlanChanged", phase: 1, plan } } };
  assert.ok(Result.isFailure(decodeServer(JSON.stringify(without))), "a PlanChanged without its step field is not a message of this protocol");
});

// Issue #87: the frames of the page's shared state.
test("the ui frames and a replay with shared states decode; an unknown scope and an excess property are refused", () => {
  const scope = { _tag: "DecisionEntry", decision: 2, entry: "e1" } as const;
  const frames: ServerMessage[] = [
    { type: "ui", run: 1, state: { version: 3, choices: [{ scope, open: true }] } },
    { type: "replay", runs: [{ id: 1, events: [] }], ui: [{ run: 1, state: { version: 1, choices: [{ scope, open: true }] } }] },
  ];
  for (const f of frames) assert.deepEqual(decoded(decodeServer(JSON.stringify(f))), f);
  const client: ClientMessage = { type: "ui", incarnation: "a", run: 1, flag: { scope, open: true } };
  assert.deepEqual(decoded(decodeClient(JSON.stringify(client))), client);
  for (const bad of [
    { type: "ui", incarnation: "a", run: 1, flag: { scope: { _tag: "RailPhase", key: "x" }, open: true } },
    { type: "ui", incarnation: "a", run: 1, flag: { scope: { ...scope, extra: 1 }, open: true } },
    { type: "ui", incarnation: "a", run: 1, flag: { scope, open: true }, extra: 1 },
  ]) assert.ok(Result.isFailure(decodeClient(JSON.stringify(bad))), JSON.stringify(bad));
  assert.ok(Result.isFailure(decodeServer(JSON.stringify({ type: "ui", run: 1, state: { version: 1, choices: [], extra: 1 } }))));
});

// Issue #112: a presented question's explanation has one or more senses, none blank; anything else is refused.
test("issue #112: a presented question with an empty senses list or a blank sense does not decode", () => {
  const question = (senses: readonly string[]) => ({ number: 1, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, history: [], explanations: [{ id: "z", term: "zod", senses }], question: [], options: [], attached: null, decision: null });
  const frame = (senses: readonly string[]) => JSON.stringify({ type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "QuestionPresented", question: question(senses) } } });
  assert.ok(Result.isSuccess(decodeServer(frame(["A library.", "The SDK's input library."]))));
  for (const senses of [[], [""], ["A library.", "  "]]) assert.ok(Result.isFailure(decodeServer(frame(senses))), JSON.stringify(senses));
});

// Issue #137: a presented question's attached material crosses the wire with its kind, and is never empty.
test("a presented question's attached material decodes with each kind and as null; empty blocks are refused", () => {
  const question = (attached: unknown) => ({ number: 1, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: [], options: [], attached, decision: null });
  const decode = Schema.decodeUnknownResult(PresentedQuestionSchema);
  for (const kind of ATTACHED_KINDS) {
    const q = question({ kind, blocks: [{ kind: "document", markdown: "x" }] });
    assert.deepEqual(Result.getOrThrow(decode(q)), q);
  }
  assert.deepEqual(Result.getOrThrow(decode(question(null))), question(null));
  assert.ok(Result.isFailure(decode(question({ kind: "reason", blocks: [] }))));
  assert.ok(Result.isFailure(decode({ ...question(null), attached: undefined, details: [] })));
});

// Issue #98: an option's picture crosses the wire; one the program would refuse does not decode in the page.
test("a presented question's option figure round-trips through a frame; a figure whose root is not svg does not decode", () => {
  const option = (figure: unknown) => ({ label: [{ text: "A", ref: "", code: false }], description: [], figure, answer: { token: "1" } });
  const question = (figure: unknown) => ({ number: 1, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: [], options: [option(figure), option(null)], attached: null, decision: null });
  const frame = (figure: unknown) => JSON.stringify({ type: "event", run: 1, seq: 1, time: "2026-11-03T00:00:00.000Z", event: { _tag: "Notified", event: { _tag: "QuestionPresented", question: question(figure) } } });
  const decode = Schema.decodeUnknownResult(PresentedQuestionSchema);
  const figure = { svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', alt: "A square." };
  assert.deepEqual(Result.getOrThrow(decode(question(figure))), question(figure));
  assert.ok(Result.isSuccess(decodeServer(frame(figure))));
  assert.ok(Result.isFailure(decode(question({ svg: "<div></div>", alt: "x" }))));
  assert.ok(Result.isFailure(decodeServer(frame({ svg: "<div></div>", alt: "x" }))));
  assert.ok(Result.isFailure(decode(question({ svg: figure.svg, alt: " " }))));
});

// Issue #138: the confirmation of the summary is gone, so the page refuses a question of its origin or its material.
test("a presented question of origin confirmSummary, or with attached material of kind summary, does not decode", () => {
  const question = (origin: unknown, attached: unknown) => ({ number: 1, origin, context: { blocks: [], by: "program" }, history: [], explanations: [], question: [], options: [], attached, decision: null });
  const decode = Schema.decodeUnknownResult(PresentedQuestionSchema);
  assert.ok(Result.isSuccess(decode(question({ kind: "reply" }, null))));
  assert.ok(Result.isFailure(decode(question({ kind: "confirmSummary" }, null))));
  assert.ok(Result.isFailure(decode(question({ kind: "reply" }, { kind: "summary", blocks: [{ kind: "document", markdown: "x" }] }))));
});

// Issue #162: a Full test suite phase crosses the protocol like every numbered phase, its kind from NUMBERED_PHASE_KINDS.
test("a PhaseBegan and a PhaseEnded of a Full test suite decode", () => {
  for (const event of [{ _tag: "PhaseBegan", phase: { kind: "suite", n: 2 } }, { _tag: "PhaseEnded", phase: { kind: "suite", n: 2 }, result: "failed" }] as const) {
    const message: ServerMessage = { type: "event", run: 1, seq: 0, time: "2026-10-14T00:00:00.000Z", event: { _tag: "Notified", event } };
    const decoded = decodeServer(JSON.stringify(message));
    assert.ok(Result.isSuccess(decoded), JSON.stringify(event));
    assert.deepEqual(decoded.success, message);
  }
});

// Issue #170: a usage limit's wait carries its basis; a try with no known end counts from 1.
test("a usage limit's wait decodes with each basis, and not with a try numbered 0 or without its basis", () => {
  const frame = (event: unknown) => JSON.stringify({ type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event } });
  const waiting = { _tag: "UsageLimitWaiting", agent: "claude", purpose: "planning", limitType: null, fromMs: 0, untilMs: 300_000, wait: 1 };
  for (const basis of [{ kind: "reset" }, { kind: "pastReset", namedMs: 5 }, { kind: "noKnownEnd", attempt: 1 }])
    assert.deepEqual(decoded(decodeServer(frame({ ...waiting, basis }))), { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { ...waiting, basis } } });
  assert.ok(Result.isFailure(decodeServer(frame({ ...waiting, basis: { kind: "noKnownEnd", attempt: 0 } }))));
  assert.ok(Result.isFailure(decodeServer(frame(waiting))));
});

// Issue #201: a network try round-trips with every network code, and a code outside the list does not decode.
test("a NetworkRetrying event decodes with a network code and not with another code", () => {
  const frame = (event: unknown) => JSON.stringify({ type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event } });
  const event = { _tag: "NetworkRetrying", agent: "codex", purpose: "review", what: "a review", attempt: 1, code: "ENOTFOUND", delaySeconds: 40, fault: "getaddrinfo ENOTFOUND", fromMs: 0, untilMs: 40_000, wait: 2 };
  for (const code of NETWORK_CODES) assert.deepEqual(decoded(decodeServer(frame({ ...event, code }))), { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { ...event, code } } });
  assert.ok(Result.isFailure(decodeServer(frame({ ...event, code: "ERR_OTHER" }))));
});

// Issue #147 (S11): the chain's frames. A setting the constructors refuse does not decode, like any malformed frame.
test("the chain frames survive the JSON round trip, and an invalid setting does not decode", () => {
  const frames: ClientMessage[] = [
    { type: "chain", settings: { enabled: true, runs: null, cutoff: null } },
    { type: "chain", settings: { enabled: false, runs: 3, cutoff: "2026-10-21T07:00:00.000Z" } },
  ];
  for (const frame of frames) assert.deepEqual(decoded(decodeClient(JSON.stringify(frame))), frame);
  for (const settings of [{ enabled: true, runs: 0, cutoff: null }, { enabled: true, runs: 1.5, cutoff: null }, { enabled: true, runs: null, cutoff: "07:00" }]) {
    assert.ok(Result.isFailure(decodeClient(JSON.stringify({ type: "chain", settings }))), JSON.stringify(settings));
  }
  const state = begun(initialState(DEFAULT_SETTINGS), 2, "7" as ItemId, "seven");
  const server: ServerMessage = { type: "chain", state };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(server))), server);
  assert.deepEqual(Result.getOrThrow(chainSettingsOf({ enabled: true, runs: 2, cutoff: "2026-10-21T07:00:00.000Z" })), { enabled: true, limits: { runs: 2, cutoff: Date.parse("2026-10-21T07:00:00.000Z") } });
});

// Issue #183: the plan's and the work's reviews carry each issue's statement of its effect on the work, and the page reads it.
test("a ReviewReceived whose issues state their effect on the work survives the round trip", () => {
  const review = { issues: [{ id: "W1-R1-1", severity: "major" as const, location: "S22", problem: "p", evidence: "e", concern: "c", remedy: "r", work_effect: { kind: "none" as const } }] };
  const message: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "ReviewReceived", subject: { work: 1 }, round: 1, review, counted: 1 } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(message))), message);
});

// Issue #191: the hello carries every refinement run in progress as a list, beside the implementation run.
test("a hello with several refinement runs decodes; the shape of one run per mode does not; currentIds lists every id", () => {
  const chain = initialState(DEFAULT_SETTINGS);
  const hello = { type: "hello", location: "/p", current: { refinement: [3, 5], implementation: 4 }, incarnation: "i", chain, preparation: PREPARATION_VIEW_OFF };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(hello))), hello);
  assert.ok(Result.isFailure(decodeServer(JSON.stringify({ ...hello, current: { refinement: 3, implementation: 4 } }))));
  assert.deepEqual(currentIds({ refinement: [3, 5], implementation: 4 }), [3, 5, 4]);
  assert.deepEqual(currentIds({ refinement: [], implementation: null }), []);
});

// Issue #185: an Asked recorded before the countdown existed decodes with none; a hold names an integer prompt.
test("an Asked without its countdown decodes with null, and a hold frame with a fractional prompt is refused", () => {
  const asked = { _tag: "Asked", prompt: 3, ...promptOf(prompts.decisionPrompt) };
  const frame = { type: "event", run: 1, seq: 0, time: "t", event: asked };
  const decodedFrame = decoded(decodeServer(JSON.stringify(frame)));
  assert.ok(decodedFrame.type === "event" && decodedFrame.event._tag === "Asked" && decodedFrame.event.countdown === null);
  assert.ok(Result.isSuccess(decodeClient(JSON.stringify({ type: "hold", incarnation: "i", run: 1, prompt: 2 }))));
  assert.ok(Result.isFailure(decodeClient(JSON.stringify({ type: "hold", incarnation: "i", run: 1, prompt: 2.5 }))));
});

// Issue #153: an Asked recorded before `deciding` existed decodes with null; one opened beside a decision round-trips, and so
// does the withdrawal of such a prompt.
test("an Asked without deciding decodes with null; deciding and PromptWithdrawn round-trip", () => {
  const asked = { _tag: "Asked", prompt: 3, ...promptOf(prompts.decisionPrompt), countdown: null };
  const frame = { type: "event", run: 1, seq: 0, time: "t", event: asked };
  const old = decoded(decodeServer(JSON.stringify(frame)));
  assert.ok(old.type === "event" && old.event._tag === "Asked" && old.event.deciding === null);
  assert.ok(old.type === "event" && old.event._tag === "Asked" && old.event.beside === null);
  const deciding = { ...frame, event: { ...asked, deciding: 3, beside: null } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(deciding))), deciding);
  // Issue #243: a question open beside the run, and a cancelled prompt, round-trip.
  const beside = { ...frame, event: { ...asked, deciding: null, beside: 2 } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(beside))), beside);
  const cancelled = { ...frame, event: { _tag: "PromptCancelled", prompt: 5 } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(cancelled))), cancelled);
  const withdrawn = { ...frame, event: { _tag: "PromptWithdrawn", prompt: 4 } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(withdrawn))), withdrawn);
  // Issue #217: a frame's answer accepted closes its prompt.
  const closed = { ...frame, event: { _tag: "PromptClosed", prompt: 4 } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(closed))), closed);
});

test("issue #49: an output frame round-trips, and one with an unknown status does not decode", () => {
  const frames: ServerMessage[] = [
    { type: "output", run: 2, event: { _tag: "Started", key: "suite:1" as ProcessKey, name: "suite" } },
    { type: "output", run: 2, event: { _tag: "Printed", key: "suite:1" as ProcessKey, name: "suite", text: "ok <b>`x`</b>\n" } },
    { type: "output", run: 2, event: { _tag: "Progress", key: "claude:t" as ProcessKey, name: "npm test", seconds: 3.5 } },
    { type: "output", run: 2, event: { _tag: "Finished", key: "suite:1" as ProcessKey, name: "suite", status: { _tag: "Signaled", signal: "SIGTERM" } } },
    { type: "output", run: 2, event: { _tag: "Touched", name: "Read a.txt" } },
  ];
  for (const f of frames) assert.deepEqual(decodeServer(JSON.stringify(f)), Result.succeed(f));
  const bad = { type: "output", run: 2, event: { _tag: "Finished", key: "suite:1", name: "suite", status: { _tag: "Vanished" } } };
  assert.ok(Result.isFailure(decodeServer(JSON.stringify(bad))));
  assert.ok(Result.isFailure(decodeServer(JSON.stringify({ type: "output", run: 2, event: { _tag: "Started", key: " ", name: "x" } }))));
});

// Issue #131: the page and the server ship together, so a listed item without its preparation mark does not decode.
test("a listed item without its preparation mark does not decode", () => {
  const frame = (item: Record<string, unknown>) => JSON.stringify({ type: "items", mode: "refinement", result: { _tag: "Listed", items: [item], terms: "checked" } });
  const item = { id: "7", title: "t", excerpt: "", url: null, sentBack: 0 };
  assert.ok(Result.isFailure(decodeServer(frame(item))));
  assert.ok(Result.isSuccess(decodeServer(frame({ ...item, preparation: { _tag: "Prepared", questions: 3 } }))));
});

// Issue #86: a document of another form does not decode.
test("a DocumentShown whose document has an unknown tag does not decode", () => {
  const good: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "DocumentShown", subject: { work: 1 }, document: { _tag: "Diff", text: "+a" } } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(good))), plain(good));
  const bad = JSON.parse(JSON.stringify(good));
  bad.event.event.document._tag = "Html";
  assert.equal(Result.isFailure(decodeServer(JSON.stringify(bad))), true);
});

// Issue #215: each wait the developer may end carries its id, required, and the early end names it.
test("the four endable waits carry their id, required, and WaitEndedEarly decodes", () => {
  const frame = (event: unknown) => JSON.stringify({ type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event } });
  const events = [
    { _tag: "TransportRetrying", agent: "codex", purpose: "review", attempt: 1, of: 3, delaySeconds: 5, fault: "reset", fromMs: 0, untilMs: 5000, wait: 3 },
    { _tag: "NetworkRetrying", agent: "claude", purpose: "planning", what: "a plan", attempt: 1, code: "EAI_AGAIN", delaySeconds: 40, fault: "x", fromMs: 0, untilMs: 40_000, wait: 4 },
    { _tag: "TrackerRetrying", tracker: "GitHub", what: "reading item 1", attempt: 1, of: 5, delaySeconds: 15, fault: "x", fromMs: 0, untilMs: 15_000, wait: 5 },
    { _tag: "UsageLimitWaiting", agent: "claude", purpose: "planning", limitType: null, basis: { kind: "reset" }, fromMs: 0, untilMs: 300_000, wait: 6 },
    { _tag: "WaitEndedEarly", wait: 6 },
  ];
  for (const event of events) {
    assert.deepEqual(decoded(decodeServer(frame(event))), { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event } });
    const { wait: _, ...without } = event;
    assert.ok(Result.isFailure(decodeServer(frame(without))), event._tag);
  }
});

// Issue #216 (W1-R1-2): a pause, limit or unchanged origin carries its pass; one recorded before the field decodes as review.
test("a pause, limit or unchanged origin round-trips with pass check, and decodes with pass review where it has none", () => {
  const decode = Schema.decodeUnknownResult(PresentedQuestionSchema);
  const question = (origin: unknown) => ({ number: 1, origin, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: [], options: [], attached: null, decision: null });
  const origins = [
    { kind: "pause", heading: "h", pause: "idle", idle: 2 },
    { kind: "pause", heading: "h", pause: "reraised", id: "U-R1-1" },
    { kind: "limit", heading: "h", limit: 5 },
    { kind: "unchanged", heading: "h", fileLabel: "issue.json", accepted: ["U-R1-1"] },
  ];
  for (const o of origins) {
    const checked = question({ ...o, pass: "check" });
    assert.deepEqual(Result.getOrThrow(decode(checked)), checked);
    assert.deepEqual(Result.getOrThrow(decode(question(o))), question({ ...o, pass: "review" }));
  }
});

// Issue #196: the queue frame, built by the page's one builder, decodes for every change; a blank id does not; the
// chain's state carries the queue, and an old-shaped state without one decodes as the backlog.
test("the queue frame round-trips for each change, refuses a blank item or edit id, and the chain frame carries the queue", () => {
  const edit = (n: number, change: QueueChange): QueueEdit => ({ id: Result.getOrThrow(editIdOf(`page:${n}`)), change });
  const item = Result.getOrThrow(itemIdOf("5"));
  const changes: readonly QueueChange[] = [
    { _tag: "Add", item, title: "five" },
    { _tag: "Remove", item },
    { _tag: "Move", item, before: null },
    { _tag: "Move", item, before: Result.getOrThrow(itemIdOf("3")) },
    { _tag: "Source", source: "queue" },
  ];
  changes.forEach((change, n) => {
    const frame = queueFrame(edit(n, change));
    assert.deepEqual(decoded(decodeClient(JSON.stringify(frame))), frame);
  });
  for (const bad of [
    { type: "queue", edit: { id: " ", change: { _tag: "Remove", item: "5" } } },
    { type: "queue", edit: { id: "p:1", change: { _tag: "Remove", item: "" } } },
    { type: "queue", edit: { id: "p:1", change: { _tag: "Source", source: "all" } } },
  ]) assert.ok(Result.isFailure(decodeClient(JSON.stringify(bad))), JSON.stringify(bad));
  const state = queueEdited(initialState(DEFAULT_SETTINGS), edit(9, { _tag: "Add", item, title: "five" }));
  const server: ServerMessage = { type: "chain", state };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(server))), server);
  const { queue: _queue, ...old } = initialState(DEFAULT_SETTINGS);
  assert.deepEqual(decoded(decodeServer(JSON.stringify({ type: "chain", state: old }))), { type: "chain", state: initialState(DEFAULT_SETTINGS) });
  const hello = { type: "hello", location: "/p", current: { refinement: [], implementation: null }, incarnation: "i", chain: state, preparation: PREPARATION_VIEW_OFF };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(hello))), hello);
});

// Issue #44 (S5): Ended carries the run's ending; one recorded before it decodes as not established.
test("an Ended without its ending decodes as unestablished, and every ending round-trips", async () => {
  const { StampedSchema } = await import("../src/protocol.ts");
  const decode = Schema.decodeUnknownSync(StampedSchema);
  const encode = Schema.encodeSync(StampedSchema);
  assert.deepEqual(decode({ time: "t", event: { _tag: "Ended", code: 0 } }).event, { _tag: "Ended", code: 0, ending: { _tag: "Unestablished" } });
  for (const ending of ENDINGS) {
    if (ending._tag === "Unestablished") continue;
    const stamped = { time: "t", event: endedEvent(ending) };
    assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(stamped)))), stamped);
  }
});

// Issue #39 (S9): the counts of a Full test suite's commands cross the protocol, and a count the runner could not have
// given does not decode.
test("a SuiteCounted event crosses the protocol, and a negative count or counts on an uncounted command do not decode", () => {
  const commands = [
    { _tag: "Uncounted", name: "npm run check", outcome: "passed" },
    { _tag: "Counted", name: "npm run test:unit", outcome: "passed", scope: "whole", counts: { passed: 10, failed: 0, skipped: 1 } },
  ];
  const frame = (cs: unknown) => JSON.stringify({ type: "event", run: 1, seq: 0, time: "2026-11-03T00:00:00.000Z", event: { _tag: "Notified", event: { _tag: "SuiteCounted", phase: { kind: "suite", n: 1 }, commands: cs } } });
  assert.deepEqual(Result.getOrThrow(decodeServer(frame(commands))), JSON.parse(frame(commands)));
  assert.ok(Result.isFailure(decodeServer(frame([{ ...commands[1], counts: { passed: -1, failed: 0, skipped: 0 } }]))));
  assert.ok(Result.isFailure(decodeServer(frame([{ ...commands[0], counts: { passed: 1, failed: 0, skipped: 0 } }]))));
});

// Issue #39 (S11): an earlier run's ExecutionEnded, whose checks lack selection and counts, still decodes, read as no
// selection and no counts.
test("an ExecutionEnded recorded before a check's selection and counts decodes with neither", () => {
  const outcome = (checks: unknown) => ({ status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks });
  const frame = JSON.stringify({ type: "event", run: 1, seq: 0, time: T, event: { _tag: "Notified", event: { _tag: "ExecutionEnded", phase: 1, outcome: outcome([{ step: "S1", command: "npm run check", seconds: 9 }]) } } });
  const decoded = Result.getOrThrow(decodeServer(frame));
  assert.deepEqual(decoded.type === "event" && decoded.event._tag === "Notified" && decoded.event.event._tag === "ExecutionEnded" ? decoded.event.event.outcome.checks : null, [
    { step: "S1", command: "npm run check", seconds: 9, selection: false, counts: null },
  ]);
});
