// The messages between the web page and the server (plan step 3.1), as Effect schemas so that both sides decode
// the same way. Pure: no Node import (the browser imports this module).

import { Effect, Option, Result, Schema } from "effect";
import * as S from "./schema.ts";
import { NUMBERED_PHASE_KINDS, type UiEvent } from "./uiEvents.ts";
import { DECISION_SECTIONS, type RunUiState, type UiFlag } from "./uiState.ts";
import type { Choice, PromptKind } from "./userPrompts.ts";
import { excerptOf, RunMode } from "./runMode.ts";
import { itemUrlOf, type TrackerItem } from "./tracker.ts";
import { ATTACHED_KINDS } from "./question.ts";
import { type ChainSettings, type ChainState, ChainStateSchema, cutoffOf, runLimitOf } from "./chain.ts";

/**
 * Issue #185: what happens when a question's wait for an answer runs out: the run is abandoned, or (a review's round or
 * idle limit) the review goes on with more cycles.
 */
export const ON_EXPIRIES = ["abandon", "extend"] as const;
export type OnExpiry = (typeof ON_EXPIRIES)[number];
const OnExpirySchema = Schema.Literals(ON_EXPIRIES);


/** A prompt the run waits on, with its widget (src/userPrompts.ts). `prompt` numbers the prompts of a run. */
/**
 * Issue #185: the wait of a question that counts down, on the server's clock: from when, until when, and what its
 * expiry does. The page counts down exactly this, the length the server times.
 */
export type Countdown = Readonly<{ fromMs: number; untilMs: number; then: OnExpiry }>;
/** Issue #185: `countdown`, null where the question waits as long as it takes (and in a record written before it). */
export type Asked = Readonly<{
  _tag: "Asked";
  prompt: number;
  text: string;
  kind: PromptKind;
  mode: "ask" | "message";
  choices: readonly Choice[];
  free: "none" | "line" | "message";
  countdown: Countdown | null;
}>;
/** What happened in a run, in order: the run's Ui calls and its start and end. */
export type RunEvent =
  | Readonly<{
      _tag: "Started";
      /** The path the user typed, which the records name. */
      project: string;
      /** The project's identification (issue #29): its host directory, or the path as given where that cannot be determined. */
      location: string;
      task: string;
      /** The run's mode and the item of the tracker it was started from (issue #120). */
      mode: RunMode;
      item: Readonly<{ id: string; title: string }>;
    }>
  | Readonly<{ _tag: "Said"; text: string }>
  | Asked
  | Readonly<{ _tag: "Answered"; prompt: number; text: string }>
  /**
   * Issue #185: the question now waits as long as it takes: the developer said he is working on it (`held`), or the
   * run stopped being the chain's run while it waited (`chainOff`).
   */
  | Readonly<{ _tag: "CountdownStopped"; prompt: number; reason: "held" | "chainOff" }>
  /** Issue #185: the wait ran out; the prompt is withdrawn. */
  | Readonly<{ _tag: "AnswerExpired"; prompt: number; seconds: number; then: OnExpiry }>
  | Readonly<{ _tag: "Notified"; event: UiEvent }>
  | Readonly<{ _tag: "Ended"; code: number }>;
/**
 * An event with the time of its publication (issue #1), an ISO string read from the Clock where the event gets its
 * seq. seq is the order; the times of events published concurrently may differ slightly in order from their seq.
 */
export type Stamped = Readonly<{ time: string; event: RunEvent }>;
export type RunRecord = Readonly<{ id: number; events: readonly Stamped[] }>;
/** The shared state of the page for one run (issue #87), held beside the run's events and never part of them. */
export type RunUi = Readonly<{ run: number; state: RunUiState }>;
/**
 * The incarnation (finding 12 of docs/gui-review.md) names one start of the server: run and prompt numbers restart
 * with the server, so an answer or a stop carries the incarnation it was made in, and the hello says which one is live.
 */
/**
 * What starts a run (issue #120): the mode and the id of its item, the server reading the item, never the page. Issue #142:
 * a refinement carries the choice of terms the page's control shows; an implementation run has no question phase, so
 * no choice.
 */
export type StartRequest = Readonly<{ mode: "refinement"; item: string; terms: S.TermsMode }> | Readonly<{ mode: "implementation"; item: string }>;
export type ClientMessage =
  /** Start a run of the mode from the item of that id. */
  | (Readonly<{ type: "start" }> & StartRequest)
  /** The items a mode's tab lists (issue #120): the server asks the tracker and answers with an items frame. */
  | Readonly<{ type: "items"; mode: RunMode }>
  | Readonly<{ type: "answer"; incarnation: string; run: number; prompt: number; text: string }>
  | Readonly<{ type: "stop"; incarnation: string; run: number }>
  /** Issue #185: the developer is working on the prompt: its countdown stops for good. */
  | Readonly<{ type: "hold"; incarnation: string; run: number; prompt: number }>
  /** Open or close one scope of the run's shared state (issue #87). */
  | Readonly<{ type: "ui"; incarnation: string; run: number; flag: UiFlag }>
  /** The chain's settings (issue #147): the mode on or off, a number of runs and the resolved cutoff instant, each optional. */
  | Readonly<{ type: "chain"; settings: ChainFrameSettings }>;
/** The chain's settings as the page sends them: the run limit a positive whole number, the cutoff an ISO instant. */
export type ChainFrameSettings = Readonly<{ enabled: boolean; runs: number | null; cutoff: string | null }>;
/** The settings a decoded chain frame names; a value its schema let through that the constructors refuse is the reason. */
export const chainSettingsOf = (frame: ChainFrameSettings): Result.Result<ChainSettings, string> => {
  const runs = frame.runs === null ? Result.succeed(null) : Result.mapError(runLimitOf(frame.runs), () => `not a number of runs: ${frame.runs}`);
  const cutoff = frame.cutoff === null ? Result.succeed(null) : Result.mapError(cutoffOf(frame.cutoff), () => `not an instant: ${frame.cutoff}`);
  if (Result.isFailure(runs)) return Result.fail(runs.failure);
  if (Result.isFailure(cutoff)) return Result.fail(cutoff.failure);
  return Result.succeed({ enabled: frame.enabled, limits: { runs: runs.success, cutoff: cutoff.success } });
};
/**
 * An item as a tab lists it (issue #120): its id, its title, enough of its text to choose by, and (issue #125) the
 * address of its page in its tracker, null where the tracker gave none. No credential.
 */
export type ListedItem = Readonly<{ id: string; title: string; excerpt: string; url: string | null; sentBack: number }>;
/**
 * The one way the server lists an item (issue #125): the page links to exactly the address the adapter read. Issue #186
 * (F1): `sentBack`, how many times Interloq sent the item back to refinement, counted from its comments.
 */
export const listedItemOf = (item: TrackerItem, sentBack: number): ListedItem => ({ id: item.id, title: item.title, excerpt: excerptOf(item.body), url: Option.getOrNull(item.url), sentBack });
/** A tab's items, or the notice of why the tracker could not list them; never both. */
export type ItemsResult = Readonly<{ _tag: "Listed"; items: readonly ListedItem[] }> | Unavailable;
/** Why the tracker or the configuration could not list a tab's items. */
export type Unavailable = Readonly<{ _tag: "Unavailable"; notice: string }>;
/**
 * The Refinement tab's items (issue #142) carry the configured choice of terms, which the tab's control starts at; read
 * with the configuration at each listing, so an edited file shows on the next one. Unavailable has none, and no
 * refinement starts from it.
 */
export type RefinementItemsResult = Readonly<{ _tag: "Listed"; items: readonly ListedItem[]; terms: S.TermsMode }> | Unavailable;
/** A tab's answer to its items frame, by its mode. */
export type ItemsAnswer = Readonly<{ mode: "refinement"; result: RefinementItemsResult }> | Readonly<{ mode: "implementation"; result: ItemsResult }>;
/** The runs in progress (issue #191): any number of refinement runs, at most one implementation run. */
export type CurrentRuns = Readonly<{ refinement: readonly number[]; implementation: number | null }>;
/** Every id in progress, the refinement runs' first. */
export const currentIds = (current: CurrentRuns): readonly number[] => [...current.refinement, ...(current.implementation === null ? [] : [current.implementation])];
export type ServerMessage =
  | Readonly<{
      type: "hello";
      /** The identification of the server's working directory (issue #29), computed once when the server starts: the one project. */
      location: string;
      /** The runs in progress (issue #191): every refinement run's id, and the implementation run's or null. */
      current: CurrentRuns;
      incarnation: string;
      /** The chain's state (issue #147). */
      chain: ChainState;
    }>
  | Readonly<{ type: "replay"; runs: readonly RunRecord[]; ui: readonly RunUi[] }>
  | Readonly<{ type: "event"; run: number; seq: number; time: string; event: RunEvent }>
  | (Readonly<{ type: "items" }> & ItemsAnswer)
  /** Why an action was not carried out, with the mode of the tab whose action it was, or null where it belongs to none (issue #120). */
  | Readonly<{ type: "refused"; mode: RunMode | null; reason: string }>
  /** The run's whole shared state after a change (issue #87); a tab keeps the state of the higher version. */
  | Readonly<{ type: "ui"; run: number; state: RunUiState }>
  /** The chain's whole state after a change (issue #147); every tab receives it. */
  | Readonly<{ type: "chain"; state: ChainState }>
  /** The server is ending (finding 15 of docs/gui-review.md); the tab's socket is closed after this. */
  | Readonly<{ type: "closing" }>;

const Int = S.NonNegativeInt;
const Str = Schema.String;
const tagged = <const T extends string, F extends Schema.Struct.Fields>(tag: T, fields: F) => Schema.Struct({ _tag: Schema.Literal(tag), ...fields });
const typed = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) => Schema.Struct({ type: Schema.Literal(type), ...fields });

const SubjectIdSchema = Schema.Union([Schema.Literal("questions"), Schema.Literal("terms"), Schema.Literal("requirements"), Schema.Struct({ plan: Int }), Schema.Struct({ work: Int }), Schema.Struct({ decision: Int }), Schema.Struct({ verdict: Int })]);
// Issue #162: the numbered kinds from src/uiEvents.ts, so the protocol and the run cannot disagree on them.
const PhaseSchema = Schema.Union([Schema.Struct({ kind: Schema.Literal("questions") }), Schema.Struct({ kind: Schema.Literals(NUMBERED_PHASE_KINDS), n: Int })]);
const AgentSchema = Schema.Literals(["claude", "codex"]);
const round = { subject: SubjectIdSchema, round: Int };

const withHeading = { heading: Str };
/** QuestionOrigin of src/question.ts, variant by variant (S5). */
const QuestionOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("clarification"), id: Str }),
  Schema.Struct({ kind: Schema.Literal("followUp"), id: Str }),
  Schema.Struct({ kind: Schema.Literal("reply") }),
  Schema.Struct({ kind: Schema.Literal("confirmSummary") }),
  Schema.Struct({ kind: Schema.Literal("planner"), ...withHeading }),
  Schema.Struct({ kind: Schema.Literal("relayed") }),
  Schema.Struct({ kind: Schema.Literal("permission"), tool: Str, input: Str }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literals(["reraised", "secondClarification", "disputedSelfCorrection"]), id: Str }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literal("reversal"), id: Str, reverses: Str }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literal("repeatedUnderNewId"), id: Str, repeats: Str }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literal("unexplained"), fileLabel: Str, round: Int }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literal("identical"), fileLabel: Str }),
  Schema.Struct({ kind: Schema.Literal("pause"), ...withHeading, pause: Schema.Literal("idle"), idle: Int }),
  Schema.Struct({ kind: Schema.Literal("limit"), ...withHeading, limit: Int }),
  Schema.Struct({ kind: Schema.Literal("unchanged"), ...withHeading, fileLabel: Str, accepted: Schema.Array(Str) }),
  Schema.Struct({ kind: Schema.Literal("transport"), agent: AgentSchema, what: Str, attempts: Int, fault: Str }),
  Schema.Struct({ kind: Schema.Literal("tracker"), tracker: Str, what: Str, attempts: Int, fault: Str }),
  Schema.Struct({ kind: Schema.Literal("suiteStopped"), command: Str, suite: Int, stops: Int, reason: Str }),
]);
/** ShownBlock of src/pieces.ts: an agent's block, or the program's own document shown whole. */
const ShownBlockSchema = Schema.Union([S.ParagraphBlock, S.ListBlock, S.CodeBlock, Schema.Struct({ kind: Schema.Literal("document"), markdown: Str })]);
/** A sense of a presented explanation (issue #112): a text with a character other than whitespace, as sensesOf builds it. */
const SenseSchema = Schema.String.check(Schema.isPattern(/\S/u)).pipe(Schema.brand("Sense"));
/** ShownExplanation of src/question.ts: one or more senses, none blank. */
const ShownExplanationSchema = Schema.Struct({ id: Str, term: Str, senses: Schema.NonEmptyArray(SenseSchema) });
/** PresentedQuestion of src/question.ts (S5; S12 of the task of issue #36: blocks, pieces and explanations). */
export const PresentedQuestionSchema = Schema.Struct({
  number: Int,
  origin: QuestionOriginSchema,
  context: Schema.Struct({ blocks: Schema.Array(ShownBlockSchema), by: Schema.Literals(["agent", "program"]) }),
  history: Schema.Array(ShownBlockSchema),
  explanations: Schema.Array(ShownExplanationSchema),
  question: Schema.Array(S.Piece),
  options: Schema.Array(Schema.Struct({ label: Schema.Array(S.Piece), description: Schema.Array(S.Piece), answer: Schema.Union([Schema.Struct({ token: Str }), Schema.Struct({ numeric: Schema.Literal(true) })]) })),
  attached: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(ATTACHED_KINDS), blocks: Schema.NonEmptyArray(ShownBlockSchema) })),
  decision: Schema.NullOr(Int),
});

/** LimitWaitBasis of src/limitReset.ts (issue #170): what a usage limit's wait rests on; a try is counted from 1. */
const LimitWaitBasisSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reset") }),
  Schema.Struct({ kind: Schema.Literal("pastReset"), namedMs: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("noKnownEnd"), attempt: S.PositiveInt }),
]);

/** UiEvent of src/uiEvents.ts, variant by variant. */
export const UiEventSchema = Schema.Union([
  tagged("PhaseBegan", { phase: PhaseSchema }),
  tagged("PhaseEnded", { phase: PhaseSchema, result: Str }),
  tagged("RoundBegan", { ...round, limit: Int }),
  tagged("ReviewReceived", { ...round, review: Schema.Union([S.EffectReview, S.Review]), counted: Int }),
  // The question subject's response is the planner's plus `questions` (defect A of docs/page-question-phase-defects.md).
  // A decision's response carries its amended analysis (W2-R1-1), the plan's the whole plan (issue #6).
  tagged("ResponseReceived", { ...round, response: Schema.Union([S.QuestionListResponse, S.TermsResponse, S.DecisionResponse, S.PlanResponse, S.WorkResponse, S.PlannerResponse]), resultText: Str }),
  tagged("LoopFinished", { subject: SubjectIdSchema, result: Schema.Literals(["converged", "proceed", "revise"]) }),
  tagged("PlanWritten", { phase: Int, resultText: Str }),
  tagged("ExecutionEnded", { phase: Int, outcome: S.ExecOutcome }),
  tagged("AgentCallStarted", { agent: AgentSchema, purpose: Str, callId: Str }),
  tagged("ToolUsed", { agent: AgentSchema, tool: Str, target: Str, callId: Str }),
  tagged("AgentCallEnded", { agent: AgentSchema, ok: Schema.Boolean, callId: Str }),
  tagged("TransportRetrying", { agent: AgentSchema, purpose: Str, attempt: Int, of: Int, delaySeconds: Schema.Finite, fault: Str, fromMs: Schema.Finite, untilMs: Schema.Finite }),
  tagged("TransportRecovered", { agent: AgentSchema }),
  tagged("TrackerRetrying", { tracker: Str, what: Str, attempt: Int, of: Int, delaySeconds: Schema.Finite, fault: Str, fromMs: Schema.Finite, untilMs: Schema.Finite }),
  tagged("TrackerRecovered", { tracker: Str }),
  tagged("UsageLimitWaiting", { agent: AgentSchema, purpose: Str, limitType: Schema.NullOr(Str), basis: LimitWaitBasisSchema, fromMs: Schema.Finite, untilMs: Schema.Finite }),
  tagged("UsageLimitLifted", { agent: AgentSchema, waitedMs: Schema.Finite }),
  tagged("AgentReconnecting", { agent: AgentSchema, by: Schema.Literal("sdk"), attempt: Schema.NullOr(Int), of: Schema.NullOr(Int), delayMs: Schema.NullOr(Int), detail: Str, callId: Str }),
  tagged("InterviewTurn", { heading: Str, message: Str, summary: Schema.NullOr(Str), answered: Int, total: Int }),
  tagged("InterviewCounted", { answered: Int, total: Int }),
  tagged("TermsBegan", {}),
  tagged("InterviewOpened", { heading: Str, stage: Schema.Literals(["clarification", "followUp"]), total: Int }),
  tagged("ClaudeSaid", { text: Str }),
  tagged("QuestionPresented", { question: PresentedQuestionSchema }),
  tagged("QuestionExplained", { question: PresentedQuestionSchema }),
  tagged("AnswerRejected", {}),
  tagged("ModelNamed", { model: Schema.Union([Schema.Struct({ agent: Schema.Literal("claude"), name: Str }), Schema.Struct({ agent: Schema.Literal("codex"), name: Schema.NullOr(Str) })]) }),
  tagged("AnalysisProgress", { decision: Int, question: Schema.NullOr(Int), check: Int }),
  tagged("DecisionAnalyzed", { decision: Int, question: Str, presented: PresentedQuestionSchema, options: Schema.Array(Schema.Struct({ label: Str, description: Str })), analysis: S.DecisionAnalysis }),
  tagged("PhasesForeseen", { phases: Schema.Array(PhaseSchema) }),
  // Issue #53 (G-R1-1): the report of a step that caused it, or null for a plan the program wrote.
  tagged("PlanChanged", { phase: Int, plan: S.RecordedPlan, step: Schema.NullOr(Schema.Struct({ id: Str, status: Schema.Literals(["started", "done"]) })) }),
]);

const ChoiceSchema = Schema.Struct({ label: Str, sends: Str });
export const RunEventSchema = Schema.Union([
  tagged("Started", { project: Str, location: Str, task: Str, mode: RunMode, item: Schema.Struct({ id: Str, title: Str }) }),
  tagged("Said", { text: Str }),
  tagged("Asked", {
    prompt: Int,
    text: Str,
    kind: Schema.Literals(["decision", "limit", "limitNoProceed", "unchanged", "transport", "optionOrText", "permission", "interviewMessage", "confirmSummary", "unknown"]),
    mode: Schema.Literals(["ask", "message"]),
    choices: Schema.Array(ChoiceSchema),
    free: Schema.Literals(["none", "line", "message"]),
    countdown: Schema.NullOr(Schema.Struct({ fromMs: Schema.Finite, untilMs: Schema.Finite, then: OnExpirySchema })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  }),
  tagged("Answered", { prompt: Int, text: Str }),
  tagged("CountdownStopped", { prompt: Int, reason: Schema.Literals(["held", "chainOff"]) }),
  tagged("AnswerExpired", { prompt: Int, seconds: Int, then: OnExpirySchema }),
  tagged("Notified", { event: UiEventSchema }),
  tagged("Ended", { code: Int }),
]);
export const StampedSchema = Schema.Struct({ time: Str, event: RunEventSchema });
const RunRecordSchema = Schema.Struct({ id: Int, events: Schema.Array(StampedSchema) });
const UiScopeSchema = Schema.Union([tagged("DecisionEntry", { decision: Int, entry: Str }), tagged("RailPhase", { phase: Str }), tagged("RailBranch", { phase: Str, branch: Str }), tagged("DecisionSection", { decision: Int, section: Schema.Literals(DECISION_SECTIONS) }), tagged("DashboardAnswers", {})]);
const UiFlagSchema = Schema.Struct({ scope: UiScopeSchema, open: Schema.Boolean });
const RunUiStateSchema = Schema.Struct({ version: Int, choices: Schema.Array(UiFlagSchema) });
const RunUiSchema = Schema.Struct({ run: Int, state: RunUiStateSchema });

/** An item's address as the page receives it: what itemUrlOf accepts, so a frame naming another scheme never decodes. */
const ItemUrlStr = Str.check(Schema.makeFilter((text: string) => Result.isSuccess(itemUrlOf(text)) || "an item's address must be an absolute https address"));
const ListedItemsSchema = Schema.Array(Schema.Struct({ id: Str, title: Str, excerpt: Str, url: Schema.NullOr(ItemUrlStr), sentBack: Int }));
const UnavailableSchema = tagged("Unavailable", { notice: Str });

export const ClientMessageSchema = Schema.Union([
  typed("start", { mode: Schema.Literal("refinement"), item: Str, terms: S.TermsMode }),
  typed("start", { mode: Schema.Literal("implementation"), item: Str }),
  typed("items", { mode: RunMode }),
  typed("answer", { incarnation: Str, run: Int, prompt: Int, text: Str }),
  typed("stop", { incarnation: Str, run: Int }),
  typed("hold", { incarnation: Str, run: Int, prompt: Int }),
  typed("ui", { incarnation: Str, run: Int, flag: UiFlagSchema }),
  typed("chain", {
    settings: Schema.Struct({
      enabled: Schema.Boolean,
      runs: Schema.NullOr(S.PositiveInt),
      cutoff: Schema.NullOr(Str.check(Schema.makeFilter((text: string) => Result.isSuccess(cutoffOf(text)) || "a cutoff must be an ISO instant with its zone"))),
    }),
  }),
]);
const CurrentRunsSchema = Schema.Struct({ refinement: Schema.Array(Int), implementation: Schema.NullOr(Int) });
export const ServerMessageSchema = Schema.Union([
  typed("hello", { location: Str, current: CurrentRunsSchema, incarnation: Str, chain: ChainStateSchema }),
  typed("replay", { runs: Schema.Array(RunRecordSchema), ui: Schema.Array(RunUiSchema) }),
  typed("event", { run: Int, seq: Int, time: Str, event: RunEventSchema }),
  typed("items", { mode: Schema.Literal("refinement"), result: Schema.Union([tagged("Listed", { items: ListedItemsSchema, terms: S.TermsMode }), UnavailableSchema]) }),
  typed("items", { mode: Schema.Literal("implementation"), result: Schema.Union([tagged("Listed", { items: ListedItemsSchema }), UnavailableSchema]) }),
  typed("refused", { mode: Schema.NullOr(RunMode), reason: Str }),
  typed("ui", { run: Int, state: RunUiStateSchema }),
  typed("chain", { state: ChainStateSchema }),
  typed("closing", {}),
]);

// The declared types and the schemas' types are the same: each is assignable to the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T | undefined => undefined;
void same<Same<typeof UiEventSchema.Type, UiEvent>>();
void same<Same<typeof RunEventSchema.Type, RunEvent>>();
void same<Same<typeof StampedSchema.Type, Stamped>>();
void same<Same<typeof RunUiStateSchema.Type, RunUiState>>();
void same<Same<typeof ClientMessageSchema.Type, ClientMessage>>();
void same<Same<typeof ServerMessageSchema.Type, ServerMessage>>();

const strict = { onExcessProperty: "error" as const };
const decodeWith = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownResult(schema, strict);
  return (text: string): Result.Result<A, string> => {
    const json = Result.try({ try: () => JSON.parse(text) as unknown, catch: () => "not JSON" });
    if (Result.isFailure(json)) return Result.fail(json.failure);
    const value = decode(json.success);
    return Result.isSuccess(value) ? Result.succeed(value.success) : Result.fail(value.failure.message);
  };
};
/** A frame of the page, decoded; the reason when it is not a message. */
export const decodeClient: (text: string) => Result.Result<ClientMessage, string> = decodeWith<ClientMessage>(ClientMessageSchema);
/** A frame of the server, decoded; the reason when it is not a message. */
export const decodeServer: (text: string) => Result.Result<ServerMessage, string> = decodeWith<ServerMessage>(ServerMessageSchema);

/** Whether an event is already in the replay: its run is replayed and its seq is below that run's event count (P1-R1-2). */
export const inSnapshot = (runs: readonly RunRecord[], message: Readonly<{ run: number; seq: number }>): boolean =>
  runs.some((r) => r.id === message.run && message.seq < r.events.length);
