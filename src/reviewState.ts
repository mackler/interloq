// The review loop as a pure state machine (finding 13 of docs/functional-design-review.md; decision Q7):
// `advance(state, event)` returns the next state and the commands to execute. The interpreter in
// src/review.ts executes the commands against the services and feeds each result back as the next event.
// The pause order of decided behaviour 7 is the order of the steps below. No I/O, no Effect.

import { AcceptedWithoutChange, RoundLimitStop, type RunError } from "./errors.ts";
import { lineChange } from "./lineChange.ts";
import { parseExtraRounds } from "./input.ts";
import * as prompts from "./prompts.ts";
import * as log from "./issueLog.ts";
import { renderRound } from "./render.ts";
import { type IssueId, validateReview, validateRound, type ValidatedReview, type ValidatedRound } from "./round.ts";
import type { CheckpointPoint, RoundRecord } from "./records.ts";
import type { Config, FileChange, LogEntry, PlannerResponse, Review, UserQuestion } from "./schema.ts";
import { piecesText } from "./pieces.ts";
import { type PauseFacts, pauseOriginOf } from "./question.ts";
import type { SubjectId } from "./artifacts.ts";
import type { LoopResult, UiEvent } from "./uiEvents.ts";
import { Result } from "effect";

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
  | Readonly<{ kind: "AskLimit"; limit: number }>
  /** Issue #30: the pause of an accepted issue with the file unchanged; Retry is a corrective turn or another interview. */
  | Readonly<{ kind: "AskUnchanged"; accepted: readonly string[]; retry: "corrective" | "interview" }>
  /**
   * A pause of behaviour 7, or a question Claude Code returned with its response (S7: the origin, not a composed
   * subject); `options`: the options the decision offers (decision Q1 of decision support); none at the other pauses.
   */
  | Readonly<{ kind: "AskDecision"; asks: Asks; id: IssueId | null; options: readonly Option[] }>
  | Readonly<{ kind: "CallReviewer"; round: number }>
  | Readonly<{ kind: "CallPlanner"; round: number }>
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
  | Readonly<{ kind: "LimitAnswer"; answer: string }>
  | Readonly<{ kind: "UnchangedAnswer"; answer: "retry" | "proceed" | "stop" }>
  | Readonly<{ kind: "ReviewDecoded"; review: Review }>
  | Readonly<{ kind: "ResponseDecoded"; response: PlannerResponse; resultText: string; costUsd: number | null }>
  | Readonly<{ kind: "CorrectionDecoded"; response: PlannerResponse; resultText: string; costUsd: number | null }>
  | Readonly<{ kind: "DecisionGiven"; text: string }>
  | Readonly<{ kind: "DecisionsApplied" }>
  | Readonly<{ kind: "Amended" }>
  | Readonly<{ kind: "FileObserved"; hash: string; text: string }>;

/** What the loop is set up with: the subject's names and the configuration. */
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
  /** Q14: a round with a correction due ends the loop with "revise" right after its log, before the observation. */
  leaveOnAcceptance: boolean;
  /** G-R1-1: a non-empty decision at any pause ends the loop with "revise" instead of a planning call. */
  leaveOnDecision: boolean;
  /**
   * Issue #30: what follows a response that accepted an issue and left the reviewed file unchanged: a corrective turn
   * (the question list, the plan, a decision), the pause at once (the requirements, G-R1-1), or nothing (the work review,
   * Q7). A subject with a value is measured (issue #31): its file is observed before the round is logged.
   */
  onUnchanged: "corrective" | "pause" | null;
  /**
   * Issue #112: who settles a disagreement between Codex and Claude Code over an issue (the disputed pauses of behaviour
   * 7: an issue raised again or repeated under a new id, a reversal, a disputed self-correction, a second clarification
   * request). "user": the pause is asked. "agents": it is not; Claude Code's disposition stands and the loop goes on
   * (the question list and the terms, whose disputes are about how a question to the user is worded).
   */
  disputesSettledBy: "user" | "agents";
  maxRounds: number;
  maxIdleRounds: number;
  countMinor: boolean;
}>;

/** An option of a pause's decision: a label and its description. */
export type Option = Readonly<{ label: string; description: string }>;
/** What a decision of the loop asks (S7): a pause of behaviour 7 with its facts (S11), or a question Claude Code returned with its response. */
export type Asks = Readonly<{ kind: "pause"; facts: PauseFacts }> | Readonly<{ kind: "planner"; question: UserQuestion }>;
/** `key`: the condition and the id of a pause that depends on the dispositions, so that it is asked once per round (P1-R1-3). */
type Ask = Readonly<{ asks: Asks; id: IssueId | null; options?: readonly Option[]; key?: string }>;
/** The subject of a decision in the records, from what it asks (S7): prompts.recordSubject is the one place it is composed. */
export const subjectOf = (heading: string, asks: Asks): string =>
  asks.kind === "pause" ? prompts.recordSubject({ kind: "pause", heading, ...pauseOriginOf(asks.facts) }, "") : prompts.recordSubject({ kind: "planner", heading }, piecesText(asks.question.question));
/** The reviewer's position and the planner's position at a disputed pause (decision Q1). */
const positions = (reviewer: string, planner: string): readonly Option[] => [
  { label: prompts.REVIEWER_POSITION, description: reviewer },
  { label: prompts.PLANNER_POSITION, description: planner },
];
/** What Codex states in an issue: its problem and its evidence. */
const reviewerSays = (i: Review["issues"][number] | undefined): string => (i === undefined ? "" : `${i.problem} ${i.evidence}`.trim());
/** The current entry of an id in the log (the last one that is not superseded). */
const currentEntry = (history: readonly LogEntry[], id: string): LogEntry | undefined => history.filter((e) => e.id === id && e.superseded !== true).at(-1);
/** Where the loop is inside a round: what the next event means. */
export type Step =
  | Readonly<{ name: "idle" }>
  | Readonly<{ name: "awaitingLimit" }>
  | Readonly<{ name: "awaitingReview" }>
  | Readonly<{ name: "askingReraised"; asking: Ask; queue: readonly Ask[] }>
  | Readonly<{ name: "awaitingResponse" }>
  | Readonly<{ name: "askingPauses"; asking: Ask; queue: readonly Ask[] }>
  | Readonly<{ name: "applyingPauseDecisions" }>
  | Readonly<{ name: "amending" }>
  /** A measured subject: the observation after the response, before the round is logged (issue #31). */
  | Readonly<{ name: "measuring" }>
  /** Issue #30: awaiting the reply of a corrective turn. */
  | Readonly<{ name: "correcting" }>
  /** Issue #30: the pause; `hash` is the observation the round continues from on Proceed. */
  | Readonly<{ name: "askingUnchanged"; hash: string }>
  | Readonly<{ name: "observingResponse" }>
  | Readonly<{ name: "askingUnexplained"; asking: Ask; hash: string }>
  | Readonly<{ name: "applyingUnexplained" }>
  | Readonly<{ name: "observingUnexplained" }>
  | Readonly<{ name: "askingIdentical"; asking: Ask; hash: string; stage: Stage }>
  | Readonly<{ name: "applyingIdentical" }>
  | Readonly<{ name: "observingIdentical" }>
  | Readonly<{ name: "askingIdle"; asking: Ask }>
  | Readonly<{ name: "applyingIdle" }>
  | Readonly<{ name: "observingIdle" }>
  | Readonly<{ name: "finished" }>;

/** The data of the round in progress. */
export type RoundInProgress = Readonly<{
  review: Review | null;
  validatedReview: ValidatedReview | null;
  round: ValidatedRound | null;
  response: PlannerResponse | null;
  resultText: string;
  decided: boolean;
  /** A decision at the pauses after the latest reply that is not yet applied. */
  toApply: boolean;
  decisions: readonly DecisionEvent[];
  /** The keys of the disposition-dependent pauses asked this round. */
  asked: readonly string[];
  /** The corrective turns taken this round (issue #30). */
  corrections: number;
  /** The reviewed file's text when the round began, from which the response's change is measured (issue #31). */
  startText: string;
  /** The issue log when the round began: the round's log is built from it (P2-R1-1). */
  startLog: readonly LogEntry[];
}>;

export type ReviewState = Readonly<{
  setup: ReviewSetup;
  step: Step;
  round: number;
  limit: number;
  idle: number;
  log: readonly LogEntry[];
  observations: readonly Observation[];
  /** The reviewed file's text at the last observation (issue #31). */
  lastText: string;
  counts: readonly number[];
  costs: readonly (number | null)[];
  current: RoundInProgress;
}>;

export type Transition = Readonly<{ state: ReviewState; commands: readonly ReviewCommand[] }>;

const freshRound: RoundInProgress = { review: null, validatedReview: null, round: null, response: null, resultText: "", decided: false, toApply: false, decisions: [], asked: [], corrections: 0, startText: "", startLog: [] };

export const initialState = (setup: ReviewSetup, config: Pick<Config, "maxRounds" | "maxIdleRounds" | "countMinor">): ReviewState => ({
  setup: { ...setup, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor },
  step: { name: "idle" },
  round: 0,
  limit: config.maxRounds,
  idle: 0,
  log: [],
  observations: [],
  lastText: "",
  counts: [],
  costs: [],
  current: freshRound,
});

// ---- rendering ----------------------------------------------------------------------------------

const say = (text: string): ReviewCommand => ({ kind: "Say", text });
const status = (text: string): ReviewCommand => ({ kind: "Say", text, status: true });
/** The prefix of a subject's issue ids, as its review prompt names them (plan 2.5). */
const idPrefixOf = (subject: SubjectId): string => (subject === "questions" ? "Q" : subject === "terms" ? "T" : subject === "requirements" ? "G" : "plan" in subject ? "P" : "work" in subject ? "W" : "D");
const notify = (event: UiEvent): ReviewCommand => ({ kind: "Notify", event });
/** The log entries of one id: the history a pause's facts show as prose (S11). */
const entriesOf = (history: readonly LogEntry[], id: string): readonly LogEntry[] => history.filter((e) => e.id === id);
const describeObservation = (o: Observation): string => prompts.observedAfter(o.round, o.stage === "decision");

// ---- transitions --------------------------------------------------------------------------------

const done = (state: ReviewState, command: ReviewCommand, before: readonly ReviewCommand[] = []): Transition => ({ state: { ...state, step: { name: "finished" } }, commands: [...before, command] });
const halt = (state: ReviewState, error: RunError): Transition => done(state, { kind: "Halt", error });
const noop = (state: ReviewState): Transition => ({ state, commands: [] });
const decisionOf = (s: ReviewState, ask: Ask, text: string): DecisionEvent => ({ subject: subjectOf(s.setup.heading, ask.asks), id: ask.id, decision: text, phase: s.setup.phase, round: s.round });
/** The checkpoint of the transition just committed (Q6): after the last record of its batch. */
const checkpoint = (s: ReviewState, stage: CheckpointPoint["stage"]): ReviewCommand => ({ kind: "Checkpoint", point: { subject: s.setup.dirName, phase: s.setup.phase, round: s.round, stage } });
/** A decision is recorded and is a committed transition of its own. */
const record = (s: ReviewState, d: DecisionEvent): readonly ReviewCommand[] => [{ kind: "RecordDecision", decision: d }, checkpoint(s, "decided")];
const ask = (s: ReviewState, step: Step, asking: Ask, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step },
  commands: [...before, { kind: "AskDecision", asks: asking.asks, id: asking.id, options: asking.options ?? [] }],
});

/** Round n + 1 begins: the limit prompt if the limit is reached, otherwise the Codex review. */
const startRound = (s: ReviewState): Transition => {
  const { heading } = s.setup;
  const n = s.round + 1;
  if (n > s.limit) {
    const lines = prompts.cycleCountsLines(heading, s.counts, s.costs);
    return { state: { ...s, step: { name: "awaitingLimit" } }, commands: [...lines.map(say), { kind: "AskLimit", limit: s.limit }] };
  }
  return {
    state: { ...s, round: n, step: { name: "awaitingReview" }, current: { ...freshRound, startText: s.lastText, startLog: s.log } },
    commands: [notify({ _tag: "RoundBegan", subject: s.setup.subject, round: n, limit: s.limit }), status(prompts.cycleReviewLine(heading, n)), { kind: "CallReviewer", round: n }],
  };
};

const onLimitAnswer = (s: ReviewState, answer: string): Transition => {
  const { heading, proceed } = s.setup;
  if (answer === "p" && proceed !== null) {
    return done(s, { kind: "Finish", result: "proceed" }, [
      { kind: "Converse", markdown: `**User decision:** ${proceed} without convergence after round ${s.round} of ${heading}.\n\n` },
      notify({ _tag: "LoopFinished", subject: s.setup.subject, result: "proceed" }),
    ]);
  }
  const added = parseExtraRounds(answer);
  if (added === null) return halt(s, new RoundLimitStop({ heading }));
  return startRound({ ...s, limit: s.limit + added });
};

/** After the reraised prompts: the planner's response. */
const toResponse = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step: { name: "awaitingResponse" } },
  commands: [...before, status(prompts.cycleResponseLine(s.setup.heading, s.round)), { kind: "CallPlanner", round: s.round }],
});

/**
 * Issue #112: the asks a subject puts to the user, and the lines that record the disputed pauses it does not. With
 * disputesSettledBy "agents" (the question list and the terms) no pause of behaviour 7 that concerns a disputed issue
 * is asked: the dispute is about how a question to the user is worded, which the user cannot judge before he has read
 * the question, and both agents argue it from the one statement of the rules. The loop exists to settle such a
 * disagreement by review and response; Claude Code's disposition stands, its rationale goes back to Codex in the next
 * round, and the round limit and the idle limit still bound the loop. A corrective turn could not move a rejection, and
 * taking Codex's position would record a decision no one made. The planner's own questions are always asked.
 */
const askedOrSettled = (s: ReviewState, asks: readonly Ask[]): Readonly<{ asked: readonly Ask[]; settled: readonly ReviewCommand[] }> => {
  if (s.setup.disputesSettledBy === "user") return { asked: asks, settled: [] };
  const disputed = (a: Ask): a is Ask & { asks: { kind: "pause" } } => a.asks.kind === "pause";
  return {
    asked: asks.filter((a) => !disputed(a)),
    settled: asks.filter(disputed).flatMap((a) => {
      const line = prompts.wordingDisputeLine(pauseOriginOf(a.asks.facts), s.setup.heading);
      return [say(line), { kind: "Converse", markdown: `**${prompts.WORDING_DISPUTE_HEADING}** ${line}\n\n` } as ReviewCommand];
    }),
  };
};

const askEach = (s: ReviewState, queue: readonly Ask[], step: (asking: Ask, rest: readonly Ask[]) => Step, otherwise: (s: ReviewState, before: readonly ReviewCommand[]) => Transition, before: readonly ReviewCommand[] = []): Transition => {
  if (queue.length === 0) return otherwise(s, before);
  const [asking, ...rest] = queue;
  return ask(s, step(asking, rest), asking, before);
};

const onReviewDecoded = (s: ReviewState, review: Review): Transition => {
  const { heading, fileLabel, countMinor } = s.setup;
  const n = s.round;
  const checked = validateReview(review);
  if (Result.isFailure(checked)) return halt(s, checked.failure);
  const counted = log.countedIssues(review, countMinor);
  const state: ReviewState = { ...s, counts: [...s.counts, counted], current: { ...freshRound, startText: s.current.startText, startLog: s.current.startLog, review, validatedReview: checked.success } };
  const before: ReviewCommand[] = [
    { kind: "SaveReview", round: n, review },
    { kind: "SaveRound", record: { kind: "no_response", subject: s.setup.dirName, phase: s.setup.phase, round: n, reconstructed: false, review: checked.success } },
    notify({ _tag: "ReviewReceived", subject: s.setup.subject, round: n, review, counted }),
    status(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`),
  ];
  if (counted === 0) {
    return done(state, { kind: "Finish", result: "converged" }, [...before, { kind: "Converse", markdown: `## ${heading}, round ${n}\n\n### Codex\n\nNo counted issue. The review of ${fileLabel} has converged.\n\n` }, checkpoint(state, "reviewed"), notify({ _tag: "LoopFinished", subject: s.setup.subject, result: "converged" })]);
  }
  const reraised: Ask[] = log.reraisedIds(s.log, review).map((id) => ({
    asks: { kind: "pause", facts: { pause: "reraised", id, history: entriesOf(s.log, id), issue: review.issues.find((i) => i.id === id) ?? null } },
    id: id as IssueId,
    options: positions(reviewerSays(review.issues.find((i) => i.id === id)), currentEntry(s.log, id)?.rationale ?? ""),
  }));
  const { asked, settled } = askedOrSettled(state, reraised);
  return askEach(state, asked, (asking, queue) => ({ name: "askingReraised", asking, queue }), toResponse, [...before, ...settled, checkpoint(state, "reviewed")]);
};

/**
 * The pauses of behaviour 7 that depend on a response's dispositions, in their order, each with its key; `history` is
 * the log as the round began. The questions for the user are the last.
 */
const disposedPauses = (history: readonly LogEntry[], review: Review, round: ValidatedRound, response: PlannerResponse): readonly Ask[] => {
  return [
    ...log.secondClarifications(history, round).map((id): Ask => ({
      asks: { kind: "pause", facts: { pause: "secondClarification", id, history: entriesOf(history, id), disposition: response.dispositions.find((d) => d.id === id) ?? null } },
      id: id as IssueId,
      options: positions(reviewerSays(review.issues.find((i) => i.id === id)), response.dispositions.find((d) => d.id === id)?.rationale ?? ""),
      key: `clarification ${id}`,
    })),
    ...response.self_corrections.filter((sc) => sc.new_action === "rejected").map((sc): Ask => ({
      asks: { kind: "pause", facts: { pause: "disputedSelfCorrection", id: sc.id, explanation: sc.explanation, history: entriesOf(history, sc.id) } },
      id: sc.id as IssueId,
      options: positions(currentEntry(history, sc.id)?.problem ?? "", sc.explanation),
      key: `disputed ${sc.id}`,
    })),
    ...log.reversals(round).map(([idNew, idOld]): Ask => ({
      asks: { kind: "pause", facts: { pause: "reversal", id: idNew, reverses: idOld, history: entriesOf(history, idOld), issue: review.issues.find((i) => i.id === idNew) ?? null, disposition: response.dispositions.find((d) => d.id === idNew) ?? null } },
      id: idNew as IssueId,
      options: positions(reviewerSays(review.issues.find((i) => i.id === idNew)), response.dispositions.find((d) => d.id === idNew)?.rationale ?? ""),
      key: `reversal ${idNew} ${idOld}`,
    })),
    ...log.repeatedUnderNewId(history, round).map(([idNew, idOld]): Ask => ({
      asks: { kind: "pause", facts: { pause: "repeatedUnderNewId", id: idNew, repeats: idOld, history: entriesOf(history, idOld), issue: review.issues.find((i) => i.id === idNew) ?? null } },
      id: idNew as IssueId,
      options: positions(reviewerSays(review.issues.find((i) => i.id === idNew)), currentEntry(history, idOld)?.rationale ?? ""),
      key: `repeat ${idNew} ${idOld}`,
    })),
    ...response.questions_for_user.map((question, i): Ask => ({ asks: { kind: "planner", question }, id: null, options: question.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) })), key: `question ${i}` })),
  ];
};

/**
 * A response, or a corrective turn's reply (issue #30), validated against the round's review and the log as the round
 * began (P2-R1-1), recorded, and followed by the pauses it raises that were not asked for this round before.
 */
const onResponseDecoded = (s: ReviewState, response: PlannerResponse, resultText: string, costUsd: number | null, corrective = false): Transition => {
  const { heading, phase } = s.setup;
  const n = s.round;
  const review = s.current.review!;
  const history = s.current.startLog;
  const checked = validateRound(s.current.validatedReview!, response, history, phase, n, idPrefixOf(s.setup.subject), s.setup.idNumber);
  // The costs are the session's running totals: a corrective turn's replaces the round's.
  const withCost: ReviewState = { ...s, costs: corrective ? [...s.costs.slice(0, -1), costUsd] : [...s.costs, costUsd] };
  if (Result.isFailure(checked)) return halt(withCost, checked.failure);
  const round = checked.success;
  const pauses = disposedPauses(history, review, round, response).filter((a) => !s.current.asked.includes(a.key ?? ""));
  const state: ReviewState = { ...withCost, current: { ...s.current, round, response, resultText, asked: [...s.current.asked, ...pauses.map((a) => a.key ?? "")] } };
  const { asked, settled } = askedOrSettled(state, pauses);
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
    notify({ _tag: "ResponseReceived", subject: s.setup.subject, round: n, response, resultText }),
    ...(corrective ? [{ kind: "Converse", markdown: `**${prompts.correctiveTurnHeading(s.current.corrections, n)}**\n\n` } as ReviewCommand] : []),
    { kind: "Converse", markdown: renderRound(heading, n, review, response) },
    ...round.notes.map((note): ReviewCommand => {
      const why = note.reason === "unknown" ? "names no current entry of the issue log" : "names an issue whose current disposition is not an accepted correction";
      return { kind: "Converse", markdown: `**Reference dropped:** ${note.field} = ${note.named} of issue ${note.id} ${why}; treated as no reference.\n\n` };
    }),
    ...(response.reviewer_feedback !== "" && !corrective ? [{ kind: "RecordFeedback", round: n, text: response.reviewer_feedback } as ReviewCommand] : []),
    ...settled,
    checkpoint(state, "responded"),
  ];
  return askEach(state, asked, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, before);
};

const afterPauses = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.current.toApply ? { state: { ...s, step: { name: "applyingPauseDecisions" } }, commands: [...before, { kind: "ApplyDecisions" }] } : amendStep(s, before);

const amendStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.setup.hasAmend ? { state: { ...s, step: { name: "amending" } }, commands: [...before, { kind: "Amend", round: s.round }] } : logStep(s, before);

/** The log of the round in progress: the round, then the user's decisions on single issues, which replace the round's disposition. */
const roundLog = (s: ReviewState, decisions: readonly DecisionEvent[], change: FileChange | null): readonly LogEntry[] =>
  decisions.reduce((acc, d) => (d.id === null ? acc : log.appendUserDecision(acc, d.id, d.decision, s.setup.phase, s.round)), log.appendRound(s.current.startLog, s.current.round!, change));

/** The loop leaves for a planning phase (a work review, plan 2.4). */
const leave = (s: ReviewState, before: readonly ReviewCommand[]): Transition =>
  done(s, { kind: "Finish", result: "revise" }, [...before, notify({ _tag: "LoopFinished", subject: s.setup.subject, result: "revise" })]);

/**
 * The issue log update. A measured subject (issue #31) first observes the file, so that the log carries the response's
 * change and the checks after the response use the same observation; an unmeasured one logs with file_change null and
 * observes after (with leaveOnAcceptance, a round with a correction due leaves right after its log, Q14).
 */
const logStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  if (s.setup.onUnchanged !== null) return { state: { ...s, step: { name: "measuring" } }, commands: [...before, { kind: "ObserveFile", stage: "response" }] };
  const { state, logged } = logRound(s, null, before);
  if (s.setup.leaveOnAcceptance && log.correctionsDue(s.current.round!)) return leave(state, logged);
  return { state: { ...state, step: { name: "observingResponse" } }, commands: [...logged, { kind: "ObserveFile", stage: "response" }] };
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

/** Behaviour 7's identical-content pause, then the end of the round. */
const identicalCheck = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const { fileLabel } = s.setup;
  const seen = hash !== lastHash(s) ? s.observations.find((o) => o.hash === hash) : undefined;
  if (seen === undefined) return finishRound(s, hash, stage, before);
  const asking: Ask = { asks: { kind: "pause", facts: { pause: "identical", fileLabel, round: s.round, seen: describeObservation(seen) } }, id: null };
  return ask(s, { name: "askingIdentical", hash, stage, asking }, asking, before);
};

/** The observation of the round is recorded; the idle counter follows the policy; the idle pause when it is reached. */
const finishRound = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const { phase, maxIdleRounds } = s.setup;
  const { accepted, selfCount } = roundCounts(s);
  const idle = accepted === 0 && selfCount === 0 ? s.idle + 1 : 0;
  const state: ReviewState = { ...s, observations: [...s.observations, { round: s.round, stage, hash }], idle };
  if (idle < maxIdleRounds) return withBefore(startRound(state), before);
  const issues = state.log.filter((x) => x.phase === phase && x.round === s.round && x.source === "review" && x.action !== "accepted");
  const asking: Ask = { asks: { kind: "pause", facts: { pause: "idle", idle, round: s.round, issues } }, id: null };
  return ask(state, { name: "askingIdle", asking }, asking, before);
};
const withBefore = (t: Transition, before: readonly ReviewCommand[]): Transition => (before.length === 0 ? t : { state: t.state, commands: [...before, ...t.commands] });

/** The checks of behaviour 7 on the observation after the response, in their order. */
const checkResponse = (s: ReviewState, hash: string, before: readonly ReviewCommand[] = []): Transition => {
  const { fileLabel, heading } = s.setup;
  const { accepted, selfCount } = roundCounts(s);
  const last = lastHash(s);
  if (accepted > 0 && hash === last) {
    // Issue #30: one corrective turn in the same session before the condition is put to the user.
    if (s.setup.onUnchanged === "corrective" && s.current.corrections === 0) return correct(s, before);
    const ids = s.current.round!.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
    const retry = s.setup.onUnchanged === "pause" ? "interview" : "corrective";
    return {
      state: { ...s, step: { name: "askingUnchanged", hash } },
      commands: [...before, say(prompts.unchangedLine(fileLabel, s.round, ids, s.current.corrections > 0)), { kind: "AskUnchanged", accepted: ids, retry }],
    };
  }
  if (accepted === 0 && selfCount === 0 && !s.current.decided && hash !== last) {
    const asking: Ask = {
      asks: { kind: "pause", facts: { pause: "unexplained", fileLabel, heading, round: s.round, resultText: s.current.resultText } },
      id: null,
    };
    return ask(s, { name: "askingUnexplained", hash, asking }, asking, before);
  }
  return identicalCheck(s, hash, "response", before);
};

/** The next corrective turn of the round (issue #30). */
const correct = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  const attempt = s.current.corrections + 1;
  return { state: { ...s, step: { name: "correcting" }, current: { ...s.current, corrections: attempt } }, commands: [...before, { kind: "CallCorrective", round: s.round, attempt }] };
};

/** The user's answer at the pause of issue #30. */
const onUnchangedAnswer = (s: ReviewState, hash: string, answer: "retry" | "proceed" | "stop"): Transition => {
  const { fileLabel, heading } = s.setup;
  const recorded: ReviewCommand = { kind: "Converse", markdown: prompts.unchangedDecisionLine(answer, fileLabel, s.round, heading) };
  switch (answer) {
    case "retry":
      return s.setup.onUnchanged === "pause" ? { state: { ...s, step: { name: "amending" } }, commands: [recorded, { kind: "Amend", round: s.round }] } : correct(s, [recorded]);
    case "proceed":
      return identicalCheck(s, hash, "response", [recorded]);
    case "stop": {
      const accepted = log.acceptedCount(s.current.round!);
      return done(s, { kind: "Halt", error: new AcceptedWithoutChange({ fileLabel, accepted }) }, [recorded]);
    }
  }
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
    case "observingUnexplained":
      return identicalCheck(s, hash, "decision");
    case "observingIdentical":
      return finishRound(s, hash, "decision");
    case "observingIdle":
      return startRound({ ...s, observations: [...s.observations, { round: s.round, stage: "decision", hash }], idle: 0 });
    default:
      return noop(s);
  }
};

/**
 * A non-empty decision with leaveOnDecision (G-R1-1): recorded, then what the step has not yet persisted, then
 * the exit. Each checkpoint written is one readCheckpoint accepts (P1-R1-1 of the earlier run's second review).
 */
const leaveOnDecision = (s: ReviewState, asking: Ask, text: string): Transition | null => {
  if (!s.setup.leaveOnDecision) return null;
  const decision = decisionOf(s, asking, text);
  const recorded = record(s, decision);
  switch (s.step.name) {
    // (i) After the response, before logStep: the round and every issue-naming decision of it, once; then logged.
    case "askingPauses": {
      const updated = roundLog(s, asking.id === null ? s.current.decisions : [...s.current.decisions, decision], null);
      return leave({ ...s, log: updated }, [...recorded, { kind: "SaveLog", log: updated }, checkpoint(s, "logged")]);
    }
    // (iii) Before the response: only the decision's entry; the round record stays no_response, so decided, not logged.
    case "askingReraised": {
      const updated = asking.id === null ? s.log : log.appendUserDecision(s.log, asking.id, text, s.setup.phase, s.round);
      return leave({ ...s, log: updated }, [...recorded, { kind: "SaveLog", log: updated }, checkpoint(s, "decided")]);
    }
    // (ii) After logStep: the round is already logged, and these asks name no issue.
    default:
      return leave(s, recorded);
  }
};

const onDecisionGiven = (s: ReviewState, text: string): Transition => {
  const step = s.step;
  const given = text !== "";
  if (given && "asking" in step) {
    const left = leaveOnDecision(s, step.asking, text);
    if (left !== null) return left;
  }
  switch (step.name) {
    case "askingReraised": {
      const decision = decisionOf(s, step.asking, text);
      const state: ReviewState = given ? { ...s, current: { ...s.current, decisions: [...s.current.decisions, decision] } } : s;
      return askEach(state, step.queue, (asking, queue) => ({ name: "askingReraised", asking, queue }), toResponse, given ? record(s, decision) : []);
    }
    case "askingPauses": {
      const decision = decisionOf(s, step.asking, text);
      const state: ReviewState = given ? { ...s, current: { ...s.current, decided: true, toApply: true, decisions: step.asking.id === null ? s.current.decisions : [...s.current.decisions, decision] } } : s;
      return askEach(state, step.queue, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, given ? record(s, decision) : []);
    }
    case "askingUnexplained":
      return given
        ? { state: { ...s, step: { name: "applyingUnexplained" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : identicalCheck(s, step.hash, "response");
    case "askingIdentical":
      return given
        ? { state: { ...s, step: { name: "applyingIdentical" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : finishRound(s, step.hash, step.stage);
    case "askingIdle":
      return given
        ? { state: { ...s, step: { name: "applyingIdle" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : startRound({ ...s, idle: 0 });
    default:
      return noop(s);
  }
};

const onDecisionsApplied = (s: ReviewState): Transition => {
  switch (s.step.name) {
    case "applyingPauseDecisions":
      return amendStep({ ...s, current: { ...s.current, toApply: false } });
    case "applyingUnexplained":
      return { state: { ...s, step: { name: "observingUnexplained" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    case "applyingIdentical":
      return { state: { ...s, step: { name: "observingIdentical" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    case "applyingIdle":
      return { state: { ...s, step: { name: "observingIdle" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    default:
      return noop(s);
  }
};

/** The next state and the commands to run for it. Pure and total: an event that does not fit the step is ignored. */
export const advance = (state: ReviewState, event: ReviewEvent): Transition => {
  switch (event.kind) {
    case "Begin":
      return startRound({ ...state, log: event.log, lastText: event.text, observations: [{ round: 0, stage: "start", hash: event.hash }] });
    case "LimitAnswer":
      return state.step.name === "awaitingLimit" ? onLimitAnswer(state, event.answer) : noop(state);
    case "UnchangedAnswer":
      return state.step.name === "askingUnchanged" ? onUnchangedAnswer(state, state.step.hash, event.answer) : noop(state);
    case "ReviewDecoded":
      return state.step.name === "awaitingReview" ? onReviewDecoded(state, event.review) : noop(state);
    case "ResponseDecoded":
      return state.step.name === "awaitingResponse" ? onResponseDecoded(state, event.response, event.resultText, event.costUsd) : noop(state);
    case "CorrectionDecoded":
      return state.step.name === "correcting" ? onResponseDecoded(state, event.response, event.resultText, event.costUsd, true) : noop(state);
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
