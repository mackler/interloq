// The review loop as a pure state machine (finding 13 of docs/functional-design-review.md; decision Q7):
// `advance(state, event)` returns the next state and the commands to execute. The interpreter in
// src/review.ts executes the commands against the services and feeds each result back as the next event.
// The pause order of decided behaviour 7 is the order of the steps below. No I/O, no Effect.

import { AcceptedWithoutChange, type RoundInvalid, RoundLimitStop, type RunError } from "./errors.ts";
import { lineChange } from "./lineChange.ts";
import { limitStops, optionText, parseExtraRounds, parseUnchangedAnswer } from "./input.ts";
import * as prompts from "./prompts.ts";
import * as log from "./issueLog.ts";
import { renderRound } from "./render.ts";
import { type IssueId, validateRound, type ValidatedIssue, type ValidatedReview, type ValidatedRound } from "./round.ts";
import type { CheckpointPoint, RoundRecord } from "./records.ts";
import type { Config, FileChange, Investigation, LogEntry, PlannerResponse, Position, Review, UserQuestion, WorkEffect, WorkEffects } from "./schema.ts";
import { piecesText } from "./pieces.ts";
import { type PauseFacts, pauseOriginOf } from "./question.ts";
import { changesNothing } from "./workEffect.ts";
import { changesAuthority, investigatedIds, resolutionOf, resolutionOutcomes, standingDisputes } from "./resolution.ts";
import type * as S from "./schema.ts";
import type { SubjectId } from "./artifacts.ts";
import type { LoopResult, UiEvent } from "./uiEvents.ts";
import { type Brand, Result } from "effect";

/** A reply's resolution as the program keeps it (issue #38); the round's validation has refused a blank one. */
const resolvedOf = (r: S.ResolutionReply | null): S.Resolution | null => { const v = resolutionOf(r); return Result.isSuccess(v) ? v.success : null; };
export type Stage = "start" | "response" | "decision";
export type Observation = Readonly<{ round: number; stage: Stage; hash: string }>;
/** The one typed decision of the user (finding 15): the issue log entry and the record lines both derive from it. */
export type DecisionEvent = Readonly<{ subject: string; id: IssueId | null; decision: string; phase: number; round: number }>;

/** What the loop asks the interpreter to do. A batch ends with at most one command that yields an event. */
export type ReviewCommand =
  /** `status`: a line about the loop's own progress (a cycle begins, its count, the response), which a decision's loop does not say (S21). */
  | Readonly<{ kind: "Say"; text: string; status?: true }>
  | Readonly<{ kind: "Notify"; event: UiEvent }>
  | Readonly<{ kind: "Converse"; markdown: string }>
  | Readonly<{ kind: "RecordDecision"; decision: DecisionEvent }>
  | Readonly<{ kind: "RecordFeedback"; round: number; text: string }>
  | Readonly<{ kind: "SaveReview"; round: number; review: Review }>
  | Readonly<{ kind: "SaveResponse"; round: number; response: PlannerResponse }>
  | Readonly<{ kind: "SaveLog"; log: readonly LogEntry[] }>
  | Readonly<{ kind: "SaveRound"; record: RoundRecord }>
  | Readonly<{ kind: "Checkpoint"; point: CheckpointPoint }>
  /**
   * A question Claude Code returned with its response (S7), the one question a review loop still waits for (issue #243:
   * every pause of behaviour 7 is opened beside the review instead); `options`: the options the decision offers.
   */
  | Readonly<{ kind: "AskDecision"; asks: PlannerAsks; id: IssueId | null; options: readonly Option[] }>
  /** Issue #243: a question opened beside the running review; the review goes on and reads its answer at a boundary. */
  | Readonly<{ kind: "OpenBeside"; beside: Beside }>
  /** Issue #243: a question opened beside the review withdrawn unanswered (a later one supersedes it). */
  | Readonly<{ kind: "CloseBeside"; key: BesideKey }>
  /** Issue #243: the dispute answers the loop recorded, which it so consumes from the run's registry. */
  | Readonly<{ kind: "AcknowledgeDisputes"; keys: readonly BesideKey[] }>
  /** Issue #243: the answers given so far to the questions open beside the review, read and never waited for. */
  | Readonly<{ kind: "AwaitBoundary" }>
  /** Issue #208: `unexplained`, the previous response's unexplained change the review is told of, or null. */
  | Readonly<{ kind: "CallReviewer"; round: number; unexplained: prompts.UnexplainedChange | null }>
  /** Issue #38: `investigating`, the ids whose disagreement Claude Code's response is to look for a resolution of first. */
  | Readonly<{ kind: "CallPlanner"; round: number; investigating: readonly IssueId[] }>
  /** Issue #38: investigation turn `attempt` of the round, in the same session; its reply comes back as InvestigationDecoded. */
  | Readonly<{ kind: "CallInvestigation"; round: number; ids: readonly IssueId[]; attempt: number }>
  /** Issue #30: corrective turn `attempt` of the round, in the same session; its reply comes back as CorrectionDecoded. */
  | Readonly<{ kind: "CallCorrective"; round: number; attempt: number }>
  | Readonly<{ kind: "ApplyDecisions" }>
  | Readonly<{ kind: "Amend"; round: number }>
  | Readonly<{ kind: "ObserveFile"; stage: Stage }>
  | Readonly<{ kind: "Halt"; error: RunError }>
  | Readonly<{ kind: "Finish"; result: LoopResult }>;

/** What the world reports back. */
export type ReviewEvent =
  /** `text`: the reviewed file's text, from which the change during a response is measured (issue #31); "" when absent. */
  | Readonly<{ kind: "Begin"; hash: string; text: string; log: readonly LogEntry[] }>
  /** Issue #243: the answers to the questions open beside the review given since they were opened (AwaitBoundary). */
  | Readonly<{ kind: "BoundaryReached"; answers: readonly BoundaryAnswer[] }>
  // Issue #151: a decoded review or response carries the value the interpreter validated, with its repair turn, before
  // the state machine sees it (reviewValidation, roundValidation of src/round.ts), so no transition refuses one.
  | Readonly<{ kind: "ReviewDecoded"; review: Review; validated: ValidatedReview }>
  | Readonly<{ kind: "ResponseDecoded"; response: PlannerResponse; round: ValidatedRound; costUsd: number | null }>
  | Readonly<{ kind: "CorrectionDecoded"; response: PlannerResponse; round: ValidatedRound; costUsd: number | null }>
  | Readonly<{ kind: "InvestigationDecoded"; response: PlannerResponse; round: ValidatedRound; costUsd: number | null }>
  | Readonly<{ kind: "DecisionGiven"; text: string }>
  | Readonly<{ kind: "DecisionsApplied" }>
  | Readonly<{ kind: "Amended" }>
  | Readonly<{ kind: "FileObserved"; hash: string; text: string }>;

/** What the loop is set up with: the subject's names and the configuration. */
/** Who settles a disputed pause of behavior 7 (issues #112, #156 and #183). */
export type DisputesSettledBy = "user" | "agents" | "noWorkEffect";
export type ReviewSetup = Readonly<{
  /** The subject, as the Ui events name it. */
  subject: SubjectId;
  heading: string;
  fileLabel: string;
  /** The subject directory under plan-review/, recorded in the round records. */
  dirName: string;
  phase: number;
  /** The number in the subject's generated ids: the decision number of a decision, the phase otherwise (P1-R1-1). */
  idNumber: number;
  /** The label of the choice to proceed at the round limit; null: no such choice, "p" is a stop (Q13). */
  proceed: string | null;
  hasAmend: boolean;
  /**
   * What a round with a correction due does: "continue" (the loop goes on), "leave" (Q14: the loop ends with "revise"
   * right after its log, before the observation; the verdict), or "collect" (issue #252, the work review: the loop goes
   * on, and ends with "revise" at the first review with no counted issue or at the round limit).
   */
  onAcceptance: OnAcceptance;
  /** G-R1-1: a non-empty decision at any pause ends the loop with "revise" instead of a planning call. */
  leaveOnDecision: boolean;
  /**
   * Issue #30: what follows a response that accepted an issue and left the reviewed file unchanged: a corrective turn
   * (the question list, the plan, a decision), the pause at once (the requirements, G-R1-1), or nothing (the work review,
   * Q7). A subject with a value is measured (issue #31): its file is observed before the round is logged.
   */
  onUnchanged: "corrective" | "pause" | null;
  /**
   * Issue #112: who settles a disagreement between Codex and Claude Code over an issue (the disputed pauses of behavior
   * 7: an issue raised again or repeated under a new id, a reversal, a disputed self-correction, a second clarification
   * request). "user": the pause is asked. "agents" (the question list and the terms): it is not, Claude Code's disposition
   * stands and the loop goes on, unless Claude Code's latest answer marks the disagreement as about what the task
   * requires, which is asked (issue #156). "noWorkEffect" (the plan and the work, issue #183): it is not asked where
   * both agents state that it changes nothing in the work, and is asked otherwise.
   */
  disputesSettledBy: DisputesSettledBy;
  maxRounds: number;
  maxIdleRounds: number;
  countMinor: boolean;
}>;

/** An option of a pause's decision: a label and its description. */
export type Option = Readonly<{ label: string; description: string }>;
/** What a decision of the loop asks (S7): a pause of behaviour 7 with its facts (S11), or a question Claude Code returned with its response. */
export type Asks = Readonly<{ kind: "pause"; facts: PauseFacts }> | PlannerAsks;
/** A question Claude Code returned with its response, the one ask that still waits (issue #243). */
export type PlannerAsks = Readonly<{ kind: "planner"; question: UserQuestion }>;
/** Issue #243: a question opened beside the review, `${dirName}/${phase}/R${round}/${what}`, unique across the run. */
export type BesideKey = string & Brand.Brand<"BesideKey">;
/** Issue #243: a disputed pause put to the developer beside the review, with the options its positions offer. */
export type DisputeAsk = Readonly<{ asks: Readonly<{ kind: "pause"; facts: PauseFacts }>; id: IssueId | null; options: readonly Option[]; taskDispute: boolean }>;
/**
 * Issue #243: what a question beside the review asks: the round limit reached (`limit`, the limit then), the idle limit
 * (its facts), an accepted point that left the file unchanged (its round and ids, so a Retry can be carried out after
 * that round's data is gone), or a disputed pause.
 */
export type BesideQuestion =
  | Readonly<{ kind: "limit"; limit: number }>
  | Readonly<{ kind: "idle"; facts: PauseFacts }>
  | Readonly<{ kind: "unchanged"; round: number; accepted: readonly string[]; retry: "corrective" | "clarification" }>
  | Readonly<{ kind: "dispute"; dispute: DisputeAsk; round: number }>;
export type Beside = Readonly<{ key: BesideKey; question: BesideQuestion }>;
/** Issue #243: an end of the loop held until the boundary is drained; `final`, the commands said only when it ends. */
export type Ending = Readonly<{ result: LoopResult; final: readonly ReviewCommand[] }>;
export type BoundaryAnswer = Readonly<{ key: BesideKey | string; text: string }>;
/** `key`: the condition and the id of a pause that depends on the dispositions, so that it is asked once per round (P1-R1-3). */
/** `taskDispute`: the disagreement Claude Code marked as about what the task requires (issue #156); none for the planner's questions. */
type Ask = Readonly<{ asks: Asks; id: IssueId | null; options?: readonly Option[]; key?: string; taskDispute?: boolean }>;
/** The subject of a decision in the records, from what it asks (S7): prompts.recordSubject is the one place it is composed. */
export const subjectOf = (heading: string, asks: Asks): string =>
  asks.kind === "pause" ? prompts.pauseSubject(pauseOriginOf(asks.facts)) : prompts.recordSubject({ kind: "planner", heading }, piecesText(asks.question.question));
/** The reviewer's position and the planner's position at a disputed pause (decision Q1). */
const positions = (reviewer: string, planner: string): readonly Option[] => [
  { label: prompts.REVIEWER_POSITION, description: reviewer },
  { label: prompts.PLANNER_POSITION, description: planner },
];
/** W1-R1-3 of issue #38: an agent's concern and remedy as a Position, null where it stated neither. */
const positionOf = (p: Readonly<{ concern: string; remedy: string }> | null | undefined): Position | null =>
  p === null || p === undefined || (p.concern.trim() === "" && p.remedy.trim() === "") ? null : { concern: p.concern as S.PositionText, remedy: p.remedy as S.PositionText };
/** An option's description followed by its agent's concern and remedy, where it stated them (requirement 5 of issue #38). */
const sideText = (text: string, p: Position | null): string => (p === null ? text : `${text} ${prompts.positionLine(p.concern, p.remedy)}`.trim());
/** Codex's and Claude Code's options, each stating its agent's concern and remedy. */
const sides = (reviewer: string, reviewerPosition: Position | null, planner: string, plannerPosition: Position | null): readonly Option[] =>
  positions(sideText(reviewer, reviewerPosition), sideText(planner, plannerPosition));
/** Codex's position on an id in the log: its last review entry's. */
const loggedReviewer = (history: readonly LogEntry[], id: string): Position | null => {
  const e = history.filter((x) => x.id === id && x.source === "review").at(-1);
  return e !== undefined && e.source === "review" ? e.reviewer_position : null;
};
/** Claude Code's position on an id in the log: its current entry's. */
const loggedPlanner = (e: LogEntry | undefined): Position | null => (e === undefined || e.source === "user" ? null : e.planner_position);
/** What Codex states in an issue: its problem and its evidence. */
const reviewerSays = (i: Review["issues"][number] | undefined): string => (i === undefined ? "" : `${i.problem} ${i.evidence}`.trim());
/**
 * Both agents' statements on a disputed issue (issue #183): Codex's from the issue as this round's review raised it, Claude
 * Code's latest answer as given; null where either stated nothing.
 */
const effectsAt = (issue: ValidatedIssue | undefined, planner: WorkEffect | null | undefined): WorkEffects | null =>
  issue === undefined || issue.workEffect === null || planner === null || planner === undefined ? null : { reviewer: issue.workEffect, planner };
/** Claude Code's latest statement on an id in the log: its current review entry's (issue #183). */
const loggedPlannerEffect = (history: readonly LogEntry[], id: string): WorkEffect | null => {
  const e = currentEntry(history, id);
  return e !== undefined && e.source === "review" && e.work_effects !== null ? e.work_effects.planner : null;
};
/** The current entry of an id in the log (the last one that is not superseded). */
const currentEntry = (history: readonly LogEntry[], id: string): LogEntry | undefined => history.filter((e) => e.id === id && e.superseded !== true).at(-1);
/**
 * Whether Claude Code's latest answer to an id in the log carries its mark (issue #156): the id's latest review entry,
 * current or superseded by a self-correction, is marked (W1-R1-1 of issue #38, since a self-correction entry carries no
 * mark and would otherwise drop it); false where the id's current entry is the developer's decision, which ends the
 * dispute.
 */
const markedEntry = (history: readonly LogEntry[], id: string): boolean => {
  if (currentEntry(history, id)?.source === "user") return false;
  const e = history.filter((x) => x.id === id && x.source === "review").at(-1);
  return e !== undefined && e.source === "review" && e.task_dispute;
};
/** Where the loop is inside a round: what the next event means. */
export type Step =
  | Readonly<{ name: "idle" }>
  | Readonly<{ name: "awaitingReview" }>
  | Readonly<{ name: "awaitingResponse" }>
  /** The questions Claude Code returned with its response, asked in turn (they still wait, issue #243). */
  | Readonly<{ name: "askingPauses"; asking: Ask; queue: readonly Ask[] }>
  | Readonly<{ name: "applyingPauseDecisions" }>
  | Readonly<{ name: "amending" }>
  /** A measured subject: the observation after the response, before the round is logged (issue #31). */
  | Readonly<{ name: "measuring" }>
  /** Issue #30: awaiting the reply of a corrective turn. */
  | Readonly<{ name: "correcting" }>
  /** Issue #38: awaiting the reply of an investigation turn. */
  | Readonly<{ name: "investigating" }>
  | Readonly<{ name: "observingResponse" }>
  /** Issue #243: reading the answers given beside the review before the next round. */
  | Readonly<{ name: "atBoundary" }>
  /** Issue #243: an end of the loop reached while questions are open, held until their answers are read. */
  | Readonly<{ name: "finishingAtBoundary"; ending: Ending }>
  /** Issue #243: decisions answered beside the review applied, then the file observed. */
  | Readonly<{ name: "applyingBeside" }>
  | Readonly<{ name: "observingBeside" }>
  | Readonly<{ name: "finished" }>;

/** The data of the round in progress. */
export type RoundInProgress = Readonly<{
  review: Review | null;
  validatedReview: ValidatedReview | null;
  round: ValidatedRound | null;
  response: PlannerResponse | null;
  decided: boolean;
  /** A decision at the pauses after the latest reply that is not yet applied. */
  toApply: boolean;
  decisions: readonly DecisionEvent[];
  /** The keys of the disposition-dependent pauses asked this round. */
  asked: readonly string[];
  /** The keys of the disposition-dependent pauses settled this round between the agents while unmarked (issue #156). */
  settled: readonly string[];
  /** The corrective turns taken this round (issue #30). */
  corrections: number;
  /** The reviewed file's text when the round began, from which the response's change is measured (issue #31). */
  startText: string;
  /** The issue log when the round began: the round's log is built from it (P2-R1-1). */
  startLog: readonly LogEntry[];
  /**
   * Issue #38: the disputes investigated in this round, keyed by the dispute's own id, as the round's latest reply left
   * them; their pauses are not asked this round, and the round's log records them (appendRound).
   */
  investigating: ReadonlyMap<string, readonly Investigation[]>;
  /** The investigation turns taken this round (issue #38). */
  investigations: number;
}>;

/** Issue #252: what a round with a correction due does. */
export type OnAcceptance = "continue" | "leave" | "collect";

export type ReviewState = Readonly<{
  setup: ReviewSetup;
  /** Issue #252: a round of this collecting loop had a correction due. */
  collected: boolean;
  step: Step;
  round: number;
  limit: number;
  idle: number;
  /** Issue #243: this loop's questions open beside the review and not yet answered at a boundary. */
  beside: readonly Beside[];
  log: readonly LogEntry[];
  observations: readonly Observation[];
  /** The reviewed file's text at the last observation (issue #31). */
  lastText: string;
  counts: readonly number[];
  costs: readonly (number | null)[];
  current: RoundInProgress;
  /** Issue #208: an unexplained change detected and not yet sent with a review. */
  unexplained: prompts.UnexplainedChange | null;
  /** Issue #38: the own ids of the disputes that had their one investigation in this loop, seeded from the log. */
  investigated: ReadonlySet<string>;
}>;

export type Transition = Readonly<{ state: ReviewState; commands: readonly ReviewCommand[] }>;

const freshRound: RoundInProgress = { review: null, validatedReview: null, round: null, response: null, decided: false, toApply: false, decisions: [], asked: [], settled: [], corrections: 0, startText: "", startLog: [], investigating: new Map(), investigations: 0 };

/**
 * Issue #243: `continueFrom`, a loop of the same subject that ran before in this phase: this loop continues its round
 * numbers, so its rounds' files are written beside the earlier ones and none is overwritten.
 */
export const initialState = (setup: ReviewSetup, config: Pick<Config, "maxRounds" | "maxIdleRounds" | "countMinor">, continueFrom: Readonly<{ round: number }> | null = null): ReviewState => ({
  setup: { ...setup, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor },
  collected: false,
  step: { name: "idle" },
  round: continueFrom?.round ?? 0,
  limit: (continueFrom?.round ?? 0) + config.maxRounds,
  idle: 0,
  beside: [],
  log: [],
  observations: [],
  lastText: "",
  counts: [],
  costs: [],
  current: freshRound,
  unexplained: null,
  investigated: new Set(),
});

// ---- rendering ----------------------------------------------------------------------------------

const say = (text: string): ReviewCommand => ({ kind: "Say", text });
const status = (text: string): ReviewCommand => ({ kind: "Say", text, status: true });
/** The prefix of a subject's issue ids, as its review prompt names them (plan 2.5). */
export const idPrefixOf = (subject: SubjectId): string => (subject === "update" ? "U" : subject === "questions" ? "Q" : subject === "questionReading" ? "H" : subject === "terms" ? "T" : subject === "requirements" ? "G" : "plan" in subject ? "P" : "work" in subject ? "W" : "verdict" in subject ? "V" : "D");
const notify = (event: UiEvent): ReviewCommand => ({ kind: "Notify", event });
/** The log entries of one id: the history a pause's facts show as prose (S11). */
const entriesOf = (history: readonly LogEntry[], id: string): readonly LogEntry[] => history.filter((e) => e.id === id);
const describeObservation = (o: Observation): string => prompts.observedAfter(o.round, o.stage === "decision");

// ---- transitions --------------------------------------------------------------------------------

const done = (state: ReviewState, command: ReviewCommand, before: readonly ReviewCommand[] = []): Transition => ({ state: { ...state, step: { name: "finished" } }, commands: [...before, command] });
/**
 * The round's validation of a response against the round's review and the log as the round began (issue #151): the
 * interpreter validates a reply with it, with its repair turn, before the reply reaches the state machine.
 */
export const roundCheckOf =
  (s: ReviewState): ((response: PlannerResponse) => Result.Result<ValidatedRound, RoundInvalid>) =>
  (response) =>
    validateRound(s.current.validatedReview!, response, s.current.startLog, s.setup.phase, s.round, idPrefixOf(s.setup.subject), s.setup.idNumber);

const halt = (state: ReviewState, error: RunError): Transition => done(state, { kind: "Halt", error });
const noop = (state: ReviewState): Transition => ({ state, commands: [] });
const decisionOf = (s: ReviewState, ask: Ask, text: string): DecisionEvent => ({ subject: subjectOf(s.setup.heading, ask.asks), id: ask.id, decision: text, phase: s.setup.phase, round: s.round });
/** The checkpoint of the transition just committed (Q6): after the last record of its batch. */
const checkpoint = (s: ReviewState, stage: CheckpointPoint["stage"]): ReviewCommand => ({ kind: "Checkpoint", point: { subject: s.setup.dirName, phase: s.setup.phase, round: s.round, stage } });
/** A decision is recorded and is a committed transition of its own. */
const record = (s: ReviewState, d: DecisionEvent): readonly ReviewCommand[] => [{ kind: "RecordDecision", decision: d }, checkpoint(s, "decided")];
const ask = (s: ReviewState, step: Step, asking: Ask, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step },
  commands: [...before, { kind: "AskDecision", asks: asking.asks as PlannerAsks, id: asking.id, options: asking.options ?? [] }],
});

// ---- issue #243: the questions beside the review ------------------------------------------------------------------

/** A question opened beside the review, under its key. */
const opening = (s: ReviewState, question: BesideQuestion, what: string): readonly [ReviewState, ReviewCommand] => {
  const beside: Beside = { key: `${s.setup.dirName}/${s.setup.phase}/${what}` as BesideKey, question };
  return [{ ...s, beside: [...s.beside, beside] }, { kind: "OpenBeside", beside }];
};
/** The line of a limit reached, the question opened (`asked`) or still open (`again`), said and written. */
const extension = (s: ReviewState, kind: "rounds" | "idle", when: "asked" | "again"): readonly ReviewCommand[] => {
  const text = prompts.limitExtendedLine(s.setup.heading, kind, kind === "rounds" ? s.setup.maxRounds : s.setup.maxIdleRounds, when, prompts.passNoun(s.setup.subject));
  return [say(text), { kind: "Converse", markdown: `${text}\n\n` }];
};
const isOpen = (s: ReviewState, kind: BesideQuestion["kind"]): boolean => s.beside.some((b) => b.question.kind === kind);

/** Round n + 1 begins: the answers given beside the review read first where any question is open. */
const startRound = (s: ReviewState): Transition =>
  s.beside.length > 0 ? { state: { ...s, step: { name: "atBoundary" } }, commands: [{ kind: "AwaitBoundary" }] } : roundOrLimit(s);

/**
 * Issue #243: the round limit never stops the review: reached, it is extended by maxRounds at once and the round begins
 * in the same batch, the limit's question opened beside it where none is open.
 */
const roundOrLimit = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  if (s.round + 1 <= s.limit) return withBefore(beginRound(s), before);
  const counted = prompts.cycleCountsLines(s.setup.heading, s.counts, s.costs).map(say);
  // Issue #252 (requirements Q1): a collecting review leaves at its limit with everything found so far, extending nothing.
  if (s.setup.onAcceptance === "collect") return leave(s, [...before, ...counted, ...recorded(prompts.collectedLimitLine(s.setup.heading, s.round))]);
  const extended: ReviewState = { ...s, limit: s.limit + s.setup.maxRounds };
  if (isOpen(s, "limit")) return withBefore(beginRound(extended), [...before, ...counted, ...extension(s, "rounds", "again")]);
  const [state, open] = opening(extended, { kind: "limit", limit: s.limit }, `R${s.round}/limit`);
  return withBefore(beginRound(state), [...before, ...counted, ...extension(s, "rounds", "asked"), open]);
};
const beginRound = (s: ReviewState): Transition => {
  const n = s.round + 1;
  return {
    state: { ...s, round: n, step: { name: "awaitingReview" }, current: { ...freshRound, startText: s.lastText, startLog: s.log }, unexplained: null },
    commands: [notify({ _tag: "RoundBegan", subject: s.setup.subject, round: n, limit: s.limit }), status(prompts.cycleReviewLine(s.setup.heading, n, prompts.passNoun(s.setup.subject))), { kind: "CallReviewer", round: n, unexplained: s.unexplained }],
  };
};

/**
 * Issue #243: an end of the loop. Where questions are open beside the review their answers are read first
 * (`finishingAtBoundary`), so an answer given during the last cycle is never lost; `final` is said only when it ends.
 */
const ending = (s: ReviewState, result: LoopResult, before: readonly ReviewCommand[], final: readonly ReviewCommand[]): Transition =>
  s.beside.length === 0
    ? done(s, { kind: "Finish", result }, [...before, ...final])
    : { state: { ...s, step: { name: "finishingAtBoundary", ending: { result, final } } }, commands: [...before, { kind: "AwaitBoundary" }] };
const finished = (s: ReviewState, result: LoopResult): readonly ReviewCommand[] => [notify({ _tag: "LoopFinished", subject: s.setup.subject, result })];
const proceedLine = (s: ReviewState): ReviewCommand => ({ kind: "Converse", markdown: `**User decision:** ${s.setup.proceed} without convergence after round ${s.round} of ${s.setup.heading}.\n\n` });

/** An answer read at a boundary, with the question it answers. */
type Answered = Readonly<{ beside: Beside; text: string }>;
/** The answers that halt: Stop at the limit, Stop at an unchanged question. */
const haltingAnswer = (s: ReviewState, answered: readonly Answered[]): Transition | null => {
  const { heading, fileLabel, proceed } = s.setup;
  for (const a of answered) {
    const q = a.beside.question;
    if (q.kind === "limit" && limitStops(a.text, proceed !== null)) return halt(s, new RoundLimitStop({ heading }));
    if (q.kind === "unchanged" && parseUnchangedAnswer(a.text) === "stop") {
      const recorded: ReviewCommand = { kind: "Converse", markdown: prompts.unchangedDecisionLine("stop", fileLabel, q.round, heading) };
      return done(s, { kind: "Halt", error: new AcceptedWithoutChange({ fileLabel, accepted: q.accepted.length }) }, [recorded]);
    }
  }
  return null;
};
/** The decision of a question beside the review in the records. */
const besideDecision = (s: ReviewState, asks: Asks, id: IssueId | null, text: string): DecisionEvent => ({ subject: subjectOf(s.setup.heading, asks), id, decision: text, phase: s.setup.phase, round: s.round });
/** A Retry of an earlier round's unchanged question, as a decision the planner applies. */
const retryDecision = (s: ReviewState, q: Extract<BesideQuestion, { kind: "unchanged" }>): DecisionEvent => ({
  subject: prompts.unchangedRecordSubject(s.setup.fileLabel),
  id: null,
  decision: prompts.unchangedRetryDecision(s.setup.fileLabel, q.round, q.accepted),
  phase: s.setup.phase,
  round: s.round,
});
/** A dispute answered: recorded, logged on its id; whether it applies anything (an answer for Claude Code's position does not). */
const recordDispute = (s: ReviewState, d: DisputeAsk, text: string): Readonly<{ state: ReviewState; commands: readonly ReviewCommand[]; applies: boolean }> => {
  const decision = besideDecision(s, d.asks, d.id, text);
  const updated = d.id === null ? s.log : log.appendUserDecision(s.log, d.id, text, s.setup.phase, s.round);
  return { state: { ...s, log: updated }, commands: [...record(s, decision), { kind: "SaveLog", log: updated }], applies: !keepsPlannerPosition(d.options, text) };
};
/** Decisions answered beside the review applied, then the file observed, then the next round. */
const applyBeside = (s: ReviewState, before: readonly ReviewCommand[]): Transition => ({ state: { ...s, step: { name: "applyingBeside" } }, commands: [...before, { kind: "ApplyDecisions" }] });
/** Every unchanged question still open but the latest is closed: a later round's question supersedes it. */
const closeSuperseded = (s: ReviewState): Readonly<{ state: ReviewState; commands: readonly ReviewCommand[] }> => {
  const unchanged = s.beside.filter((b) => b.question.kind === "unchanged");
  const superseded = unchanged.slice(0, -1).map((b) => b.key);
  return { state: { ...s, beside: s.beside.filter((b) => !superseded.includes(b.key)) }, commands: superseded.map((key): ReviewCommand => ({ kind: "CloseBeside", key })) };
};
const answeredOf = (s: ReviewState, answers: readonly BoundaryAnswer[]): Readonly<{ answered: readonly Answered[]; state: ReviewState }> => {
  const answered = answers.flatMap((a): readonly Answered[] => {
    const beside = s.beside.find((b) => b.key === a.key);
    return beside === undefined ? [] : [{ beside, text: a.text }];
  });
  const keys = answered.map((a) => a.beside.key);
  return { answered, state: { ...s, beside: s.beside.filter((b) => !keys.includes(b.key)) } };
};

/**
 * Issue #243: the answers given beside the review read at a round's boundary, applied in their precedence: a Stop halts;
 * Proceed ends the loop; the disputes answered are recorded (and so consumed), an answer for Codex's position applied or,
 * where the subject leaves on a decision, the loop left; an idle answer applied; a number of cycles sets the limit; a
 * Retry corrects the round just ended or, for an earlier round, is applied as a decision; then the next round.
 */
const onBoundary = (s0: ReviewState, answers: readonly BoundaryAnswer[]): Transition => {
  const { answered, state: s1 } = answeredOf(s0, answers);
  const halting = haltingAnswer(s1, answered);
  if (halting !== null) return halting;
  const { heading, fileLabel, proceed } = s1.setup;
  if (proceed !== null && answered.some((a) => a.beside.question.kind === "limit" && a.text.trim() === "p")) return ending(s1, "proceed", [proceedLine(s1)], finished(s1, "proceed"));
  let s = s1;
  const commands: ReviewCommand[] = [];
  let toApply = false;
  let leaving = false;
  const acknowledged: BesideKey[] = [];
  for (const a of answered) {
    const q = a.beside.question;
    if (q.kind !== "dispute") continue;
    const r = recordDispute(s, q.dispute, a.text);
    s = r.state;
    commands.push(...r.commands);
    acknowledged.push(a.beside.key);
    if (r.applies && s.setup.leaveOnDecision) leaving = true;
    else if (r.applies) toApply = true;
  }
  if (acknowledged.length > 0) commands.push({ kind: "AcknowledgeDisputes", keys: acknowledged });
  if (leaving) return leave(s, commands);
  for (const a of answered) {
    const q = a.beside.question;
    if (q.kind === "idle" && a.text.trim() !== "") {
      commands.push(...record(s, besideDecision(s, { kind: "pause", facts: q.facts }, null, a.text)));
      // A subject that leaves on a decision (the work review, whose response is read-only) leaves for a revision.
      if (s.setup.leaveOnDecision) return leave(s, commands);
      toApply = true;
    }
    if (q.kind === "limit") {
      const added = parseExtraRounds(a.text);
      if (added !== null) {
        s = { ...s, limit: s.round + added };
        commands.push({ kind: "Converse", markdown: `${prompts.limitAnsweredLine(heading, added, s.round)}\n\n` });
      }
    }
  }
  let correctNow = false;
  for (const a of answered) {
    const q = a.beside.question;
    if (q.kind !== "unchanged") continue;
    const answer = parseUnchangedAnswer(a.text);
    commands.push({ kind: "Converse", markdown: prompts.unchangedDecisionLine(answer ?? "proceed", fileLabel, q.round, heading) });
    if (answer !== "retry") continue;
    if (q.round === s.round && !toApply && s.current.round !== null) correctNow = true;
    else {
      commands.push(...record(s, retryDecision(s, q)));
      toApply = true;
    }
  }
  if (correctNow && toApply) {
    // A Retry of the round just ended joins the decisions being applied.
    const q = answered.find((a) => a.beside.question.kind === "unchanged" && a.beside.question.round === s.round)!.beside.question as Extract<BesideQuestion, { kind: "unchanged" }>;
    commands.push(...record(s, retryDecision(s, q)));
    correctNow = false;
  }
  const closed = closeSuperseded(s);
  s = closed.state;
  commands.push(...closed.commands);
  if (toApply) return applyBeside(s, commands);
  if (correctNow) return s.setup.onUnchanged === "pause" ? { state: { ...s, step: { name: "amending" } }, commands: [...commands, { kind: "Amend", round: s.round }] } : correct(s, commands);
  return roundOrLimit(s, commands);
};

/**
 * Issue #243: the answers read when the loop would end. A Stop halts. Where it would end with no counted issue, an answer
 * for Codex's position in a dispute and a Retry of an unchanged question are carried out (the file changes, so Codex
 * reviews it in another round), or, where the subject leaves on a decision, the dispute's answer makes the loop leave.
 * Every other answer is recorded with its line and the end stands. Where it would leave for a revision, or proceed, the
 * disputes answered are left to the run's registry, which carries them to the next point that can change the work.
 */
const onFinishingBoundary = (s0: ReviewState, held: Ending, answers: readonly BoundaryAnswer[]): Transition => {
  const { answered, state: s1 } = answeredOf(s0, answers);
  const halting = haltingAnswer(s1, answered);
  if (halting !== null) return halting;
  const { heading, fileLabel } = s1.setup;
  let s = s1;
  const commands: ReviewCommand[] = [];
  const after = (text: string): ReviewCommand => ({ kind: "Converse", markdown: `${prompts.answerAfterEndLine(heading, text)}\n\n` });
  let toApply = false;
  let result = held.result;
  const acknowledged: BesideKey[] = [];
  for (const a of answered) {
    const q = a.beside.question;
    if (q.kind === "dispute") {
      if (held.result !== "converged") continue;
      // Every answer is recorded before it is acknowledged (review P1-R1-1); only its position decides whether it applies.
      const r = recordDispute(s, q.dispute, a.text);
      s = r.state;
      commands.push(...r.commands);
      acknowledged.push(a.beside.key);
      if (!r.applies) continue;
      if (s.setup.leaveOnDecision) result = "revise";
      else toApply = true;
    } else if (q.kind === "unchanged" && parseUnchangedAnswer(a.text) === "retry" && held.result === "converged") {
      commands.push(...record(s, retryDecision(s, q)));
      toApply = true;
    } else commands.push(after(a.text));
  }
  if (acknowledged.length > 0) commands.push({ kind: "AcknowledgeDisputes", keys: acknowledged });
  if (toApply && result === "converged") return applyBeside(s, commands);
  const final = result === held.result ? held.final : finished(s, result);
  return done(s, { kind: "Finish", result }, [...commands, ...final]);
};

/** After the reraised prompts: the planner's response. */
const toResponse = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step: { name: "awaitingResponse" } },
  commands: [...before, status(prompts.cycleResponseLine(s.setup.heading, s.round)), { kind: "CallPlanner", round: s.round, investigating: [...s.current.investigating.keys()] as IssueId[] }],
});

/**
 * Issue #112: the asks a subject puts to the user, and the lines that record the disputed pauses it does not. With
 * disputesSettledBy "agents" (the question list and the terms) a pause of behavior 7 that concerns a disagreement about
 * how a question to the user is worded is not asked: the user cannot judge whether a word in a question he has not read
 * needs explaining to him, and both agents argue it from the one statement of the rules. The loop exists to settle such
 * a disagreement by review and response; Claude Code's disposition stands, its rationale goes back to Codex in the next
 * round, and the round limit and the idle limit still bound the loop. A corrective turn could not move a rejection, and
 * taking Codex's position would record a decision no one made. Issue #156: a disagreement Claude Code marks as about
 * what the task requires is asked, because no statement of the question rules settles it and the user can answer it in
 * a line. The planner's own questions are always asked.
 */
/**
 * Whether a subject's policy settles an ask without the user, the one statement of it (issues #112, #156 and #183): under
 * "user" none; under "agents" a disputed pause Claude Code did not mark; under "noWorkEffect" a disputed pause on which
 * both agents state that nothing in the work would differ.
 */
export const settles = (policy: DisputesSettledBy, a: Ask): boolean => {
  if (a.asks.kind !== "pause" || a.asks.facts.pause === "authorityResolution") return false;
  switch (policy) {
    case "user":
      return false;
    case "agents":
      return a.taskDispute !== true;
    case "noWorkEffect":
      return disputedEffects(a.asks.facts) !== null && changesNothing(disputedEffects(a.asks.facts)!);
  }
};
/**
 * An asked dispute of a "noWorkEffect" subject (issue #183): each position's option names the differences the agents stated
 * and what choosing it costs; any other ask unchanged.
 */
const withEffectOptions = (setup: ReviewSetup, a: Ask): Ask => {
  if (setup.disputesSettledBy !== "noWorkEffect" || a.asks.kind !== "pause" || !("effects" in a.asks.facts) || a.options === undefined) return a;
  const effects = a.asks.facts.effects;
  const join = (...texts: readonly string[]): string => texts.filter((t) => t.trim() !== "").join(" ");
  return {
    ...a,
    options: a.options.map((o) =>
      o.label === prompts.REVIEWER_POSITION
        ? { ...o, description: join(o.description, effects === null ? "" : prompts.followCodexChanges(effects), prompts.followCodexCost(setup.leaveOnDecision)) }
        : o.label === prompts.PLANNER_POSITION
          ? { ...o, description: join(o.description, effects === null ? "" : prompts.followClaudeCodeKeeps(effects), prompts.FOLLOW_CLAUDE_CODE_COST) }
          : o.label === prompts.RESOLUTION_POSITION
            ? { ...o, description: join(o.description, prompts.followCodexCost(setup.leaveOnDecision)) }
            : o,
    ),
  };
};
/**
 * Whether an answer to a disputed pause keeps Claude Code's position (issue #183): the planner's option as the answer
 * stands for it (optionText, which answerOf returns for its number) or its label as typed. Such an answer decides nothing
 * to carry out (issue #243: the loop and the run's registry of disputes both read it).
 */
export const keepsPlannerPosition = (options: readonly Option[], text: string): boolean => {
  const planner = options.find((o) => o.label === prompts.PLANNER_POSITION);
  return planner !== undefined && (text === optionText(planner) || text.trim() === planner.label);
};
/** The agents' statements a pause's facts carry: those of the five disputed pauses, null for every other pause (issue #183). */
const disputedEffects = (facts: PauseFacts): WorkEffects | null => ("effects" in facts ? facts.effects : null);
/** The line of a pause a subject's policy settles (issues #112, #156 and #183), as said on the page and written to conversation.md. */
/** A line said on the page after its heading and written to conversation.md under it in bold, asking nothing. */
const recordedLine = (heading: string, line: string): readonly ReviewCommand[] => [say(`${heading} ${line}`), { kind: "Converse", markdown: `**${heading}** ${line}\n\n` }];
const settledLines = (s: ReviewState, a: Ask & { asks: { kind: "pause" } }): readonly ReviewCommand[] => {
  const origin = pauseOriginOf(a.asks.facts);
  if (s.setup.disputesSettledBy === "noWorkEffect") {
    const line = prompts.noWorkEffectDisputeLine(origin, s.setup.heading, a.options?.[0]?.description ?? "", a.options?.[1]?.description ?? "");
    return recordedLine(prompts.NO_WORK_EFFECT_HEADING, line);
  }
  const line = prompts.unmarkedDisputeLine(origin, s.setup.heading);
  return [say(line), { kind: "Converse", markdown: `**${prompts.WORDING_DISPUTE_HEADING}** ${line}\n\n` }];
};
const askedOrSettled = (s: ReviewState, asks: readonly Ask[]): Readonly<{ asked: readonly Ask[]; settledAsks: readonly Ask[]; settled: readonly ReviewCommand[] }> => {
  if (s.setup.disputesSettledBy === "user") return { asked: asks, settledAsks: [], settled: [] };
  const settledAsks = asks.filter((a) => settles(s.setup.disputesSettledBy, a));
  return {
    asked: asks.filter((a) => !settles(s.setup.disputesSettledBy, a)).map((a) => withEffectOptions(s.setup, a)),
    settledAsks,
    settled: settledAsks.flatMap((a) => (a.asks.kind === "pause" ? settledLines(s, a as Ask & { asks: { kind: "pause" } }) : [])),
  };
};

/** Issue #243: the disputes a subject's policy does not settle, opened beside the review, each with its line. */
const openDisputes = (s: ReviewState, asks: readonly Ask[]): Readonly<{ state: ReviewState; commands: readonly ReviewCommand[] }> =>
  asks.reduce(
    (acc, a) => {
      if (a.asks.kind !== "pause") return acc;
      const facts = a.asks.facts;
      const dispute: DisputeAsk = { asks: { kind: "pause", facts }, id: a.id, options: a.options ?? [], taskDispute: a.taskDispute === true };
      const [state, open] = opening(acc.state, { kind: "dispute", dispute, round: s.round }, `R${s.round}/${a.key ?? `reraised ${a.id ?? ""}`}`);
      return { state, commands: [...acc.commands, ...recordedLine(prompts.DISPUTE_PUT_TO_YOU_HEADING, prompts.disputeBesideLine(pauseOriginOf(facts), s.setup.heading)), open] };
    },
    { state: s, commands: [] as readonly ReviewCommand[] },
  );

const askEach = (s: ReviewState, queue: readonly Ask[], step: (asking: Ask, rest: readonly Ask[]) => Step, otherwise: (s: ReviewState, before: readonly ReviewCommand[]) => Transition, before: readonly ReviewCommand[] = []): Transition => {
  if (queue.length === 0) return otherwise(s, before);
  const [asking, ...rest] = queue;
  return ask(s, step(asking, rest), asking, before);
};

// ---- the investigation before a disagreement is put to the developer (issue #38) ----------------------------------

const INVESTIGATED: ReadonlySet<string> = new Set(["reraised", "secondClarification", "reversal", "repeatedUnderNewId", "disputedSelfCorrection"]);
/** The dispute's own id: the issue of a re-raise or second clarification, the new id of a reversal or repetition, the self-correction's id. */
const ownId = (a: Ask): string | null => (a.asks.kind === "pause" && "id" in a.asks.facts ? a.asks.facts.id : null);
/** Whether an ask is a dispute that has its one investigation before the developer is asked. */
const investigable = (a: Ask): boolean => a.asks.kind === "pause" && INVESTIGATED.has(a.asks.facts.pause);
const investigationOf = (a: Ask): Investigation => {
  const facts = (a.asks as Readonly<{ kind: "pause"; facts: PauseFacts }>).facts;
  const other = "reverses" in facts ? facts.reverses : "repeats" in facts ? facts.repeats : null;
  return { pause: facts.pause as Investigation["pause"], other: other === null ? null : (other as IssueId) };
};
/** A dispute not yet investigated in this loop. */
const fresh = (s: ReviewState, a: Ask): boolean => investigable(a) && !s.investigated.has(ownId(a) ?? "");
/** The third option of a disputed pause: the resolution of both concerns, labeled by its record label. */
const resolutionOption = (r: S.Resolution): Option => ({ label: prompts.RESOLUTION_POSITION, description: prompts.resolutionDescription(r) });
const withResolution = (options: readonly Option[], r: S.Resolution | null): readonly Option[] => (r === null ? options : [...options, resolutionOption(r)]);
/** Codex's position as the log keeps it: its concern and remedy where given, else the problem. */
const reviewerOf = (e: LogEntry | undefined): string =>
  e === undefined ? "" : e.source === "review" && e.reviewer_position !== null ? `${e.reviewer_position.concern} ${e.reviewer_position.remedy}` : e.problem;
/** A log entry's disposition as a pause's facts show it. */
const dispositionOfEntry = (e: LogEntry): S.Disposition | null =>
  e.source !== "review"
    ? null
    : { id: e.id, action: e.action, rationale: e.rationale, duplicate_of: e.duplicate_of ?? "", reverses: e.reverses ?? "", concern: e.planner_position?.concern ?? "", remedy: e.planner_position?.remedy ?? "", resolution: e.resolution };
const resolutionOfEntry = (e: LogEntry | undefined): S.Resolution | null => (e === undefined || e.source === "user" ? null : e.resolution);

/** A point raised again, from this review's issue and the id's entry, with the third option where the entry gives a resolution. */
const reraisedAsk = (s: ReviewState, review: Review, validated: ValidatedReview, id: string): Ask => {
  const taskDispute = markedEntry(s.log, id);
  const entry = currentEntry(s.log, id);
  const raised = review.issues.find((i) => i.id === id);
  const planner = loggedPlanner(entry);
  return {
    asks: { kind: "pause", facts: { pause: "reraised", id, history: entriesOf(s.log, id), issue: raised ?? null, planner, taskDispute, effects: effectsAt(validated.issues.find((i) => i.id === id), loggedPlannerEffect(s.log, id)) } },
    id: id as IssueId,
    options: withResolution(sides(reviewerSays(raised), positionOf(raised) ?? loggedReviewer(s.log, id), entry?.rationale ?? "", planner), resolutionOfEntry(entry)),
    key: `reraised ${id}`,
    taskDispute,
  };
};
/**
 * The disputes that had their investigation and still stand (standingDisputes of src/resolution.ts), rebuilt by their
 * recorded kind: each when this review raises its own id, a disputed self-correction whenever it stands, since it is
 * Claude Code's own challenge to a correction both agents accepted.
 */
const standingAsks = (s: ReviewState, review: Review, validated: ValidatedReview): readonly Ask[] => {
  const raised = new Set(review.issues.map((i) => i.id));
  const issueOf = (id: string) => review.issues.find((i) => i.id === id) ?? null;
  return standingDisputes(s.log).flatMap(({ id, investigation, entry }): Ask[] => {
    const taskDispute = markedEntry(s.log, id);
    const effects = effectsAt(validated.issues.find((i) => i.id === id), loggedPlannerEffect(s.log, id));
    const options = withResolution(sides(reviewerSays(issueOf(id) ?? undefined), positionOf(issueOf(id)) ?? loggedReviewer(s.log, id), entry.rationale, loggedPlanner(entry)), resolutionOfEntry(entry));
    const other = investigation.other ?? "";
    switch (investigation.pause) {
      case "reraised":
        return raised.has(id) ? [reraisedAsk(s, review, validated, id)] : [];
      case "repeatedUnderNewId":
        return raised.has(id) ? [{ asks: { kind: "pause", facts: { pause: "repeatedUnderNewId", id, repeats: other, history: entriesOf(s.log, other), issue: issueOf(id), disposition: dispositionOfEntry(entry), taskDispute, effects } }, id, options, key: `repeat ${id} ${other}`, taskDispute }] : [];
      case "reversal":
        return raised.has(id) ? [{ asks: { kind: "pause", facts: { pause: "reversal", id, reverses: other, history: entriesOf(s.log, other), issue: issueOf(id), disposition: dispositionOfEntry(entry), taskDispute, effects } }, id, options, key: `reversal ${id} ${other}`, taskDispute }] : [];
      case "secondClarification":
        return raised.has(id) ? [{ asks: { kind: "pause", facts: { pause: "secondClarification", id, history: entriesOf(s.log, id), disposition: dispositionOfEntry(entry), taskDispute, effects } }, id, options, key: `clarification ${id}`, taskDispute }] : [];
      case "disputedSelfCorrection": {
        const lastReview = s.log.filter((e) => e.id === id && e.source === "review").at(-1);
        return [
          {
            asks: { kind: "pause", facts: { pause: "disputedSelfCorrection", id, explanation: entry.rationale, history: entriesOf(s.log, id), reviewer: loggedReviewer(s.log, id), planner: loggedPlanner(entry), taskDispute, effects: null, resolution: resolutionOfEntry(entry) } },
            id,
            options: withResolution(sides(lastReview?.problem ?? "", loggedReviewer(s.log, id), entry.rationale, loggedPlanner(entry)), resolutionOfEntry(entry)),
            key: `disputed ${id}`,
            taskDispute,
          },
        ];
      }
    }
  });
};
/** The ordinary re-raise rule (behavior 7): every raised id not accepted in full, unless a standing dispute of that id is asked already. */
const reraisedAsks = (s: ReviewState, review: Review, validated: ValidatedReview, standing: readonly Ask[]): readonly Ask[] => {
  const covered = new Set(standing.map(ownId));
  return log.reraisedIds(s.log, review).filter((id) => !covered.has(id)).map((id) => reraisedAsk(s, review, validated, id));
};
/** A resolution of the previous round that would change what only the developer may change, put to him. */
const authorityAsk = (s: ReviewState, e: LogEntry): Ask => {
  const resolution = resolutionOfEntry(e)!;
  return {
    asks: { kind: "pause", facts: { pause: "authorityResolution", id: e.id, history: entriesOf(s.log, e.id), resolution, taskDispute: false, effects: e.source === "review" ? e.work_effects : null } },
    id: e.id,
    options: [...sides(reviewerOf(e), loggedReviewer(s.log, e.id), e.rationale, loggedPlanner(e)), resolutionOption(resolution)],
    key: `authority ${e.id}`,
  };
};
/** The line said and written before the agents investigate the given disputes. */
const investigationLines = (s: ReviewState, asks: readonly Ask[]): readonly ReviewCommand[] =>
  asks.length === 0 ? [] : recordedLine(prompts.INVESTIGATION_HEADING, prompts.investigationLine("", [...new Set(asks.map((a) => ownId(a) ?? ""))], prompts.passNoun(s.setup.subject)).trim());
/** The disputes given their investigation: recorded under their own ids, and in the loop's investigated set. */
const investigating = (s: ReviewState, asks: readonly Ask[]): ReviewState => {
  const map = new Map(s.current.investigating);
  for (const id of new Set(asks.map((a) => ownId(a) ?? ""))) map.set(id, asks.filter((a) => ownId(a) === id).map(investigationOf));
  return { ...s, investigated: new Set([...s.investigated, ...map.keys()]), current: { ...s.current, investigating: map } };
};

const onReviewDecoded = (s: ReviewState, review: Review, validated: ValidatedReview): Transition => {
  const { countMinor } = s.setup;
  const n = s.round;
  const counted = log.countedIssues(review, countMinor);
  const state: ReviewState = { ...s, counts: [...s.counts, counted], current: { ...freshRound, startText: s.current.startText, startLog: s.current.startLog, review, validatedReview: validated } };
  const before: ReviewCommand[] = [
    { kind: "SaveReview", round: n, review },
    { kind: "SaveRound", record: { kind: "no_response", subject: s.setup.dirName, phase: s.setup.phase, round: n, reconstructed: false, review: validated } },
    notify({ _tag: "ReviewReceived", subject: s.setup.subject, round: n, review, counted }),
    status(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`),
  ];
  // Issue #38: the resolutions of the previous round that Codex did not raise again: agreed, or put to the developer.
  const outcomes = resolutionOutcomes(s.log, review.issues.map((i) => i.id), s.setup.phase, n);
  const agreed = outcomes.agreed.flatMap((a) => recordedLine(prompts.RESOLUTION_AGREED_HEADING, prompts.resolutionAgreedLine("", a.id, a.resolution.text).trim()));
  const authority = outcomes.authority.map((e) => authorityAsk(state, e));
  const standing = standingAsks(state, review, validated);
  if (counted === 0) {
    const selfCorrections = askedOrSettled(state, standing.filter((a) => a.asks.kind === "pause" && a.asks.facts.pause === "disputedSelfCorrection"));
    // Issue #243: the asks of a review with no counted issue are opened beside the run, and the loop ends.
    const opened = openDisputes(state, [...authority, ...selfCorrections.asked]);
    const ended = endOfLoop(state, n);
    return ending(opened.state, ended.result, [...before, ...agreed, ...selfCorrections.settled, ...opened.commands], [...ended.lines, checkpoint(state, "reviewed"), ...finished(state, ended.result)]);
  }
  const disputes = [...standing, ...reraisedAsks(state, review, validated, standing)];
  const { asked, settled } = askedOrSettled(state, disputes);
  const deferred = asked.filter((a) => fresh(state, a));
  const now = asked.filter((a) => !fresh(state, a));
  // A dispute opened at the review is not opened again for the response of the same round.
  const investigated = investigating({ ...state, current: { ...state.current, asked: now.map((a) => a.key ?? "") } }, deferred);
  // Issue #243: what would have been asked is opened beside the review, which goes on to the response.
  const opened = openDisputes(investigated, [...authority, ...now]);
  return toResponse(opened.state, [...before, ...agreed, ...settled, ...investigationLines(state, deferred), checkpoint(state, "reviewed"), ...opened.commands]);
};

/**
 * The pauses of behaviour 7 that depend on a response's dispositions, in their order, each with its key; `history` is
 * the log as the round began. The questions for the user are the last.
 */
const disposedPauses = (history: readonly LogEntry[], review: Review, round: ValidatedRound, response: PlannerResponse): readonly Ask[] => {
  // Claude Code's latest answer to the new id is this response's disposition (issue #156).
  const markedNow = (id: string): boolean => round.dispositions.find((d) => d.id === id)?.taskDispute ?? false;
  const dispositionOf = (id: string) => response.dispositions.find((d) => d.id === id) ?? null;
  // Issue #183: Codex's statement on the issue this round and Claude Code's in this response.
  const effectsNow = (id: string): WorkEffects | null => effectsAt(round.review.issues.find((i) => i.id === id), round.dispositions.find((d) => d.id === id)?.workEffect);
  return [
    ...log.secondClarifications(history, round).map((id): Ask => {
      const taskDispute = markedNow(id);
      return {
        asks: { kind: "pause", facts: { pause: "secondClarification", id, history: entriesOf(history, id), disposition: dispositionOf(id), taskDispute, effects: effectsNow(id) } },
        id: id as IssueId,
        options: withResolution(sides(reviewerSays(review.issues.find((i) => i.id === id)), positionOf(review.issues.find((i) => i.id === id)), dispositionOf(id)?.rationale ?? "", positionOf(dispositionOf(id))), resolvedOf(dispositionOf(id)?.resolution ?? null)),
        key: `clarification ${id}`,
        taskDispute,
      };
    }),
    ...response.self_corrections.filter((sc) => sc.new_action === "rejected").map((sc): Ask => {
      // A self-correction carries no mark: the answer it disputes is the issue's entry as the round began.
      const taskDispute = markedEntry(history, sc.id);
      return {
        asks: { kind: "pause", facts: { pause: "disputedSelfCorrection", id: sc.id, explanation: sc.explanation, history: entriesOf(history, sc.id), reviewer: loggedReviewer(history, sc.id), planner: positionOf(sc), taskDispute, effects: null, resolution: resolvedOf(sc.resolution) } },
        id: sc.id as IssueId,
        options: withResolution(sides(currentEntry(history, sc.id)?.problem ?? "", loggedReviewer(history, sc.id), sc.explanation, positionOf(sc)), resolvedOf(sc.resolution)),
        key: `disputed ${sc.id}`,
        taskDispute,
      };
    }),
    ...log.reversals(round).map(([idNew, idOld]): Ask => {
      const taskDispute = markedNow(idNew);
      return {
        asks: { kind: "pause", facts: { pause: "reversal", id: idNew, reverses: idOld, history: entriesOf(history, idOld), issue: review.issues.find((i) => i.id === idNew) ?? null, disposition: dispositionOf(idNew), taskDispute, effects: effectsNow(idNew) } },
        id: idNew as IssueId,
        options: withResolution(sides(reviewerSays(review.issues.find((i) => i.id === idNew)), positionOf(review.issues.find((i) => i.id === idNew)), dispositionOf(idNew)?.rationale ?? "", positionOf(dispositionOf(idNew))), resolvedOf(dispositionOf(idNew)?.resolution ?? null)),
        key: `reversal ${idNew} ${idOld}`,
        taskDispute,
      };
    }),
    ...log.repeatedUnderNewId(history, round).map(([idNew, idOld]): Ask => {
      const taskDispute = markedNow(idNew);
      // Marked, Claude Code's position is the reading it gave the new id (P1-R1-1); unmarked, its earlier rationale as before.
      const planner = taskDispute ? (dispositionOf(idNew)?.rationale ?? "") : (currentEntry(history, idOld)?.rationale ?? "");
      return {
        asks: { kind: "pause", facts: { pause: "repeatedUnderNewId", id: idNew, repeats: idOld, history: entriesOf(history, idOld), issue: review.issues.find((i) => i.id === idNew) ?? null, disposition: dispositionOf(idNew), taskDispute, effects: effectsNow(idNew) } },
        id: idNew as IssueId,
        options: withResolution(sides(reviewerSays(review.issues.find((i) => i.id === idNew)), positionOf(review.issues.find((i) => i.id === idNew)), planner, taskDispute ? positionOf(dispositionOf(idNew)) : loggedPlanner(currentEntry(history, idOld))), resolvedOf(dispositionOf(idNew)?.resolution ?? null)),
        key: `repeat ${idNew} ${idOld}`,
        taskDispute,
      };
    }),
    ...response.questions_for_user.map((question, i): Ask => ({ asks: { kind: "planner", question }, id: null, options: question.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) })), key: `question ${i}` })),
  ];
};

/**
 * A response, or a corrective turn's reply (issue #30), with its round as the interpreter validated it against the round's
 * review and the log as the round began (P2-R1-1, roundCheckOf), recorded, and followed by the pauses it raises that were
 * not asked for this round before.
 */
/** What a reply is (issue #38): the response to a review, a corrective turn's reply (issue #30), or an investigation turn's. */
type ReplyMode = "response" | "corrective" | "investigation";
const NOT_ACCEPTED_IN_FULL: ReadonlySet<string> = new Set(["rejected", "partially_accepted", "no_change_needed"]);
/**
 * Issue #38: the records of the disputes investigated this round follow the latest reply: the kinds of its
 * disposition-based asks of that own id; a point still not accepted in full a re-raise; one now accepted, or a
 * self-correction no longer disputed, none; otherwise the list stands.
 */
const followReply = (investigatingNow: ReadonlyMap<string, readonly Investigation[]>, all: readonly Ask[], response: PlannerResponse): ReadonlyMap<string, readonly Investigation[]> => {
  const map = new Map<string, readonly Investigation[]>();
  for (const [id, list] of investigatingNow) {
    const asks = all.filter((a) => a.asks.kind === "pause" && ownId(a) === id);
    const d = response.dispositions.find((x) => x.id === id);
    const sc = response.self_corrections.find((x) => x.id === id);
    if (asks.length > 0) map.set(id, asks.map(investigationOf));
    else if (d !== undefined && NOT_ACCEPTED_IN_FULL.has(d.action)) map.set(id, [{ pause: "reraised", other: null }]);
    else if ((d !== undefined && d.action === "accepted") || (d === undefined && (sc === undefined || sc.new_action !== "rejected"))) map.set(id, []);
    else map.set(id, list);
  }
  return map;
};

const onResponseDecoded = (s: ReviewState, response: PlannerResponse, round: ValidatedRound, costUsd: number | null, mode: ReplyMode = "response"): Transition => {
  const { heading, phase } = s.setup;
  const n = s.round;
  const review = s.current.review!;
  const history = s.current.startLog;
  const corrective = mode !== "response";
  // The costs are the session's running totals: a corrective or investigation turn's replaces the round's.
  const withCost: ReviewState = { ...s, costs: corrective ? [...s.costs.slice(0, -1), costUsd] : [...s.costs, costUsd] };
  const all = disposedPauses(history, review, round, response);
  // Issue #38: the investigated disputes follow this reply, and are not asked this round.
  const records = followReply(s.current.investigating, all, response);
  // A pause asked this round is not asked again; one settled this round is not settled again, but is asked if a
  // corrective reply now marks it (issue #156, P1-R1-3).
  const pauses = all.filter((a) => !s.current.asked.includes(a.key ?? "") && (!s.current.settled.includes(a.key ?? "") || !settles(s.setup.disputesSettledBy, a)) && !records.has(ownId(a) ?? "\u0000"));
  const { asked: toAsk, settledAsks, settled } = askedOrSettled(withCost, pauses);
  const keysOf = (asks: readonly Ask[]): readonly string[] => asks.map((a) => a.key ?? "");
  const freshAsks = toAsk.filter((a) => fresh(withCost, a));
  // Issue #38: a dispute not yet investigated has its investigation turn first, and nothing of this reply is asked.
  const asked = freshAsks.length > 0 ? [] : toAsk;
  // Issue #243: a disputed pause is opened beside the review; only Claude Code's own questions are asked and waited for.
  const planner = asked.filter((a) => a.asks.kind === "planner");
  const disputes = openDisputes(withCost, asked.filter((a) => a.asks.kind === "pause"));
  const base: ReviewState = {
    ...disputes.state,
    current: { ...s.current, round, response, asked: [...s.current.asked, ...keysOf(asked)], settled: [...s.current.settled, ...keysOf(settledAsks)], investigating: records },
  };
  const state = investigating(base, freshAsks);
  const before: ReviewCommand[] = [
    ...(corrective ? [] : [{ kind: "SaveResponse", round: n, response } as ReviewCommand]),
    {
      kind: "SaveRound",
      record: {
        kind: "validated",
        subject: s.setup.dirName,
        phase,
        round: n,
        reconstructed: false,
        review: round.review,
        response: { dispositions: round.dispositions, selfCorrections: round.selfCorrections, reviewerFeedback: round.reviewerFeedback, questionsForUser: round.questionsForUser },
        notes: round.notes,
      },
    },
    notify({ _tag: "ResponseReceived", subject: s.setup.subject, round: n, response }),
    ...(mode === "corrective" ? [{ kind: "Converse", markdown: `**${prompts.correctiveTurnHeading(s.current.corrections, n)}**\n\n` } as ReviewCommand] : []),
    ...(mode === "investigation" ? [{ kind: "Converse", markdown: `**${prompts.investigationTurnHeading(n)}**\n\n` } as ReviewCommand] : []),
    { kind: "Converse", markdown: renderRound(heading, n, review, response) },
    ...round.notes.map((note): ReviewCommand => {
      const why = note.reason === "unknown" ? "names no current entry of the issue log" : "names an issue whose current disposition is not an accepted correction";
      return { kind: "Converse", markdown: `**Reference dropped:** ${note.field} = ${note.named} of issue ${note.id} ${why}; treated as no reference.\n\n` };
    }),
    ...(response.reviewer_feedback !== "" && !corrective ? [{ kind: "RecordFeedback", round: n, text: response.reviewer_feedback } as ReviewCommand] : []),
    ...settled,
    checkpoint(state, "responded"),
    ...disputes.commands,
  ];
  if (freshAsks.length > 0) {
    const attempt = state.current.investigations + 1;
    const ids = [...new Set(freshAsks.map((a) => ownId(a) ?? ""))] as IssueId[];
    return { state: { ...state, step: { name: "investigating" }, current: { ...state.current, investigations: attempt } }, commands: [...before, ...investigationLines(state, freshAsks), { kind: "CallInvestigation", round: n, ids, attempt }] };
  }
  return askEach(state, planner, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, before);
};

const afterPauses = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.current.toApply ? { state: { ...s, step: { name: "applyingPauseDecisions" } }, commands: [...before, { kind: "ApplyDecisions" }] } : amendStep(s, before);

const amendStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.setup.hasAmend ? { state: { ...s, step: { name: "amending" } }, commands: [...before, { kind: "Amend", round: s.round }] } : logStep(s, before);

/** The log of the round in progress: the round, then the user's decisions on single issues, which replace the round's disposition. */
const roundLog = (s: ReviewState, decisions: readonly DecisionEvent[], change: FileChange | null): readonly LogEntry[] =>
  decisions.reduce((acc, d) => (d.id === null ? acc : log.appendUserDecision(acc, d.id, d.decision, s.setup.phase, s.round)), log.appendRound(s.current.startLog, s.current.round!, change, s.current.investigating));

/** A line said on the page and written to conversation.md. */
const recorded = (text: string): readonly ReviewCommand[] => [say(text), { kind: "Converse", markdown: `${text}\n\n` }];
/**
 * The end of the loop at a review with no counted issue: agreement, or, for a collecting loop that had a correction due
 * (issue #252), the leave for planning with every accepted finding; the agreement block, which src/earlierPlan.ts reads
 * as a review that ended in agreement, is written only for agreement.
 */
const endOfLoop = (s: ReviewState, n: number): Readonly<{ result: LoopResult; lines: readonly ReviewCommand[] }> =>
  s.collected
    ? { result: "revise", lines: recorded(prompts.collectedLeaveLine(s.setup.heading, n)) }
    : { result: "converged", lines: [{ kind: "Converse", markdown: prompts.reviewConvergedMarkdown(s.setup.heading, n, s.setup.fileLabel, prompts.passNoun(s.setup.subject)) }] };

/** The loop leaves for a planning phase (a work review, plan 2.4). */
const leave = (s: ReviewState, before: readonly ReviewCommand[]): Transition => ending(s, "revise", before, finished(s, "revise"));

/**
 * The issue log update. A measured subject (issue #31) first observes the file, so that the log carries the response's
 * change and the checks after the response use the same observation; an unmeasured one logs with file_change null and
 * observes after (with onAcceptance "leave", a round with a correction due leaves right after its log, Q14).
 */
const logStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  if (s.setup.onUnchanged !== null) return { state: { ...s, step: { name: "measuring" } }, commands: [...before, { kind: "ObserveFile", stage: "response" }] };
  const { state, logged } = logRound(s, null, before);
  const due = log.correctionsDue(s.current.round!);
  if (s.setup.onAcceptance === "leave" && due) return leave(state, logged);
  const collected = state.collected || (s.setup.onAcceptance === "collect" && due);
  return { state: { ...state, collected, step: { name: "observingResponse" } }, commands: [...logged, { kind: "ObserveFile", stage: "response" }] };
};
const logRound = (s: ReviewState, change: FileChange | null, before: readonly ReviewCommand[]): { state: ReviewState; logged: readonly ReviewCommand[] } => {
  const updated = roundLog(s, s.current.decisions, change);
  return { state: { ...s, log: updated }, logged: [...before, { kind: "SaveLog", log: updated }, checkpoint(s, "logged")] };
};

const lastHash = (s: ReviewState): string => s.observations[s.observations.length - 1]?.hash ?? "";
const roundCounts = (s: ReviewState): { accepted: number; selfCount: number } => ({
  accepted: log.acceptedCount(s.current.round!),
  selfCount: s.current.response!.self_corrections.length,
});

/** Behaviour 7's identical-content check (issue #243: a line, asking nothing), then the end of the round. */
const identicalCheck = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const seen = hash !== lastHash(s) ? s.observations.find((o) => o.hash === hash) : undefined;
  if (seen === undefined) return finishRound(s, hash, stage, before);
  return finishRound(s, hash, stage, [...before, ...recordedLine(prompts.IDENTICAL_CONTENT_HEADING, prompts.identicalContentLine(s.setup.fileLabel, s.round, describeObservation(seen)).trim())]);
};

/**
 * The observation of the round is recorded; the idle counter follows the policy. Issue #243: the idle limit reached
 * restarts the count and opens its question beside the review, where none is open, and the review goes on.
 */
const finishRound = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const { phase, maxIdleRounds } = s.setup;
  const { accepted, selfCount } = roundCounts(s);
  const idle = accepted === 0 && selfCount === 0 ? s.idle + 1 : 0;
  const state: ReviewState = { ...s, observations: [...s.observations, { round: s.round, stage, hash }], idle };
  if (idle < maxIdleRounds) return withBefore(startRound(state), before);
  const reset: ReviewState = { ...state, idle: 0 };
  if (isOpen(s, "idle")) return withBefore(startRound(reset), [...before, ...extension(s, "idle", "again")]);
  const issues = state.log.filter((x) => x.phase === phase && x.round === s.round && x.source === "review" && x.action !== "accepted");
  const [opened, open] = opening(reset, { kind: "idle", facts: { pause: "idle", idle, round: s.round, issues } }, `R${s.round}/idle`);
  return withBefore(startRound(opened), [...before, ...extension(s, "idle", "asked"), open]);
};
const withBefore = (t: Transition, before: readonly ReviewCommand[]): Transition => (before.length === 0 ? t : { state: t.state, commands: [...before, ...t.commands] });

/**
 * The checks of behaviour 7 on the observation after the response, in their order. An unexplained change is recorded
 * and carried to the next review, not asked (issue #208).
 */
const checkResponse = (s: ReviewState, hash: string, before: readonly ReviewCommand[] = []): Transition => {
  const { fileLabel, heading } = s.setup;
  const { accepted, selfCount } = roundCounts(s);
  const last = lastHash(s);
  // Issue #252: a collecting review's response is read-only, so its file is unchanged by design; it never takes this branch.
  if (accepted > 0 && hash === last && s.setup.onAcceptance !== "collect") {
    // Issue #30: one corrective turn in the same session before the condition is put to the user.
    if (s.setup.onUnchanged === "corrective" && s.current.corrections === 0) return correct(s, before);
    // Issue #243: the question is opened beside the review, which goes on as Proceed would; one per round and attempt.
    const ids = s.current.round!.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
    const retry = s.setup.onUnchanged === "pause" ? "clarification" : "corrective";
    const [state, open] = opening(s, { kind: "unchanged", round: s.round, accepted: ids, retry }, `R${s.round}/unchanged ${s.current.corrections}`);
    return identicalCheck(state, hash, "response", [
      ...before,
      say(prompts.unchangedLine(fileLabel, s.round, ids, s.current.corrections > 0)),
      open,
      ...recordedLine(prompts.UNCHANGED_HEADING, prompts.unchangedContinuesLine(fileLabel, s.round, prompts.passNoun(s.setup.subject))),
    ]);
  }
  if (accepted === 0 && selfCount === 0 && !s.current.decided && hash !== last) {
    // Issue #208: not asked, since Codex reviews the changed file in the next round anyway; it is told of the change.
    const { added, removed } = lineChange(s.current.startText, s.lastText);
    const change: prompts.UnexplainedChange = { fileLabel, heading, round: s.round, added, removed };
    return identicalCheck({ ...s, unexplained: change }, hash, "response", [...before, ...recordedLine(prompts.UNEXPLAINED_CHANGE_HEADING, prompts.unexplainedChangeLine(change))]);
  }
  return identicalCheck(s, hash, "response", before);
};

/** The next corrective turn of the round (issue #30). */
const correct = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  const attempt = s.current.corrections + 1;
  return { state: { ...s, step: { name: "correcting" }, current: { ...s.current, corrections: attempt } }, commands: [...before, { kind: "CallCorrective", round: s.round, attempt }] };
};

/** Every observation leaves its text as the last seen (issue #31). */
const onFileObserved = (s: ReviewState, hash: string, text: string): Transition => onObservation({ ...s, lastText: text }, hash, text);
const onObservation = (s: ReviewState, hash: string, text: string): Transition => {
  switch (s.step.name) {
    case "measuring": {
      const { state, logged } = logRound(s, lineChange(s.current.startText, text), []);
      return checkResponse(state, hash, logged);
    }
    case "observingResponse":
      return checkResponse(s, hash);
    case "observingBeside":
      return startRound({ ...s, observations: [...s.observations, { round: s.round, stage: "decision", hash }] });
    default:
      return noop(s);
  }
};

/**
 * A non-empty decision with leaveOnDecision (G-R1-1): recorded, then the round with every issue-naming decision of it,
 * logged once, then the exit. Each checkpoint written is one readCheckpoint accepts. Issue #243: only Claude Code's own
 * questions are still asked, after the response and before the round is logged.
 */
const leaveOnDecision = (s: ReviewState, asking: Ask, text: string): Transition | null => {
  if (!s.setup.leaveOnDecision) return null;
  const decision = decisionOf(s, asking, text);
  const updated = roundLog(s, asking.id === null ? s.current.decisions : [...s.current.decisions, decision], null);
  return leave({ ...s, log: updated }, [...record(s, decision), { kind: "SaveLog", log: updated }, checkpoint(s, "logged")]);
};


const onDecisionGiven = (s: ReviewState, text: string): Transition => {
  const step = s.step;
  if (step.name !== "askingPauses") return noop(s);
  const given = text !== "";
  if (given) {
    const left = leaveOnDecision(s, step.asking, text);
    if (left !== null) return left;
  }
  const decision = decisionOf(s, step.asking, text);
  const decisions = step.asking.id === null ? s.current.decisions : [...s.current.decisions, decision];
  const state: ReviewState = given ? { ...s, current: { ...s.current, decided: true, toApply: true, decisions } } : s;
  return askEach(state, step.queue, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, given ? record(s, decision) : []);
};

const onDecisionsApplied = (s: ReviewState): Transition => {
  switch (s.step.name) {
    case "applyingPauseDecisions":
      return amendStep({ ...s, current: { ...s.current, toApply: false } });
    case "applyingBeside":
      return { state: { ...s, step: { name: "observingBeside" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    default:
      return noop(s);
  }
};

/** The next state and the commands to run for it. Pure and total: an event that does not fit the step is ignored. */
export const advance = (state: ReviewState, event: ReviewEvent): Transition => {
  switch (event.kind) {
    case "Begin":
      return startRound({ ...state, log: event.log, lastText: event.text, observations: [{ round: 0, stage: "start", hash: event.hash }], investigated: new Set([...state.investigated, ...investigatedIds(event.log)]) });
    case "BoundaryReached":
      return state.step.name === "atBoundary" ? onBoundary(state, event.answers) : state.step.name === "finishingAtBoundary" ? onFinishingBoundary(state, state.step.ending, event.answers) : noop(state);
    case "ReviewDecoded":
      return state.step.name === "awaitingReview" ? onReviewDecoded(state, event.review, event.validated) : noop(state);
    case "ResponseDecoded":
      return state.step.name === "awaitingResponse" ? onResponseDecoded(state, event.response, event.round, event.costUsd) : noop(state);
    case "CorrectionDecoded":
      return state.step.name === "correcting" ? onResponseDecoded(state, event.response, event.round, event.costUsd, "corrective") : noop(state);
    case "InvestigationDecoded":
      return state.step.name === "investigating" ? onResponseDecoded(state, event.response, event.round, event.costUsd, "investigation") : noop(state);
    case "DecisionGiven":
      return onDecisionGiven(state, event.text);
    case "DecisionsApplied":
      return onDecisionsApplied(state);
    case "Amended":
      return state.step.name === "amending" ? logStep(state) : noop(state);
    case "FileObserved":
      return onFileObserved(state, event.hash, event.text);
  }
};
