// The services of the procedure. Every method returns an Effect with its errors in the error channel.
// Tests provide scripted layers; main.ts provides the live ones. API names: docs/effect-v4-api.md.

import { Context, Effect } from "effect";
import type { Brand, Option, Schema } from "effect";
import type { AgentUnreachable, CodexCallFailed, FileSystemError, GitError, RunError, StateFileInvalid, TransportFault, UsageLimited, UserStopped } from "./errors.ts";
import type { SubjectId } from "./artifacts.ts";
import type { CheckpointPoint, RoundRecord } from "./records.ts";
import type { DecisionEvent } from "./reviewState.ts";
import type { Config, DecisionAnalysis, ExecOutcome, Explanation, LogEntry, PlannerResponse, PlanWriteResult, QuestionOption, QuestionsFile, RecordedPlan, Review, TermsWrite } from "./schema.ts";
import type { LoopResult, Phase, UiEvent } from "./uiEvents.ts";
import type { ContextRequest } from "./prompts.ts";
import type { ContextWritten } from "./question.ts";
import type { LimitWait, UsageLine, UsageLines } from "./usage.ts";
import type { AgentSdk } from "./sdk.ts";
import type { OwnWrite, RecordsSnapshot, Snapshot } from "./snapshot.ts";

export type StoreError = FileSystemError | StateFileInvalid | GitError;
/** The question a decision analyzes (decision support): its text and options, the phase in which it was asked and that phase's label (W1-R1-2). */
/**
 * What the user was shown with a question beside its text and options (S37, W1-R1-5): its context paragraph, its terms
 * and its details. The analysis prompt carries it; decision-<k>/question.json does not.
 */
export type ShownWithQuestion = Readonly<{ context: string; explanations: readonly Explanation[]; details: string }>;
export type DecisionQuestion = Readonly<{ phase: Phase; label: string; question: string; options: readonly QuestionOption[]; shown?: ShownWithQuestion }>;
/** The user's answer after an analysis, and the option it chose (null for free text; decision Q4). */
export type Choice = Readonly<{ answer: string; option: string | null }>;
/** A planning or execution call can also end in a decision loop's error: a relayed question or a permission request carries the offer. */
export type PlannerError = RunError;
/** What report_step answers Claude Code (issue #6, Q2 and Q3): a text, and whether it is an error (an id not in the plan). */
export type StepReply = Readonly<{ text: string; isError: boolean }>;
/** Records one report of report_step during an execution call; a failure to write the plan ends the call. */
export type StepReporter = (id: string, status: "started" | "done") => Effect.Effect<StepReply, RunError>;
export type ReviewerError = CodexCallFailed | StoreError;

export interface UiShape {
  readonly say: (text: string) => Effect.Effect<void>;
  /** Reads one line. The answer "q" fails with UserStopped. */
  readonly ask: (prompt: string) => Effect.Effect<string, UserStopped>;
  /** Reads one message of the interview (see TerminalUi). The message "/quit" fails with UserStopped. */
  readonly askMessage: (prompt: string) => Effect.Effect<string, UserStopped>;
  /** A structured event of the run (decision Q5). The terminal prints nothing for it; the records do not depend on it. */
  readonly notify: (event: UiEvent) => Effect.Effect<void>;
  /** The number of the next question the user is asked (S6): one sequence for the run, from 1, whatever produced the question. */
  readonly nextQuestion: Effect.Effect<number>;
}
export class Ui extends Context.Service<Ui, UiShape>()("plan-review/Ui") {}

/** What a planning call is for, as the activity line names it; the interview also prints its tool use in the terminal. */
/** "context": the call that writes a question's context paragraph and terms (S9), in a fresh session, with the capability "readProject". */
export type PlanningPurpose = "planning" | "interview" | "context";
export type PlanningResult = Readonly<{ output: unknown; resultText: string; costUsd: number | null }>;
/**
 * What a planning call may do (finding 1 of docs/gui-review.md): "records" may edit only under plan-review/ (behaviour 3);
 * "readOnly" may call no tool but the structured output (a work response, behaviour 12), its repair turn included;
 * "readProject" may read the project with Read, Grep and Glob and change nothing (the context call of a question, S33).
 */
export type PlanningCapability = "records" | "readOnly" | "readProject";
export interface PlannerShape {
  /**
   * A call in which Claude Code may write only under plan-review/ ("records", the default), or call no tool but the
   * structured output ("readOnly"). The output is returned as produced; the caller decodes it.
   */
  planning(prompt: string, schema: Schema.Top, purpose?: PlanningPurpose, capability?: PlanningCapability): Effect.Effect<PlanningResult, PlannerError | TransportFault | UsageLimited, Decider>;
  /** A call in which Claude Code implements the plan. */
  /** An execution call; `reporter` answers its report_step calls (issue #6, Q2). */
  /** Declares no TransportFault (issue #26): the adapter retries a transport fault itself, and exhaustion is AgentUnreachable. */
  executing(prompt: string, reporter: StepReporter): Effect.Effect<ExecOutcome, PlannerError | AgentUnreachable, Decider>;
  readonly sessionId: Effect.Effect<string | null>;
  /** A planner over a new session, with the same hooks and callbacks (a decision loop, D4 of the decision-support plan). */
  readonly fresh: Effect.Effect<PlannerShape>;
}
export class Planner extends Context.Service<Planner, PlannerShape>()("plan-review/Planner") {}

/** One review loop's thread (behaviour 5). Every call goes to the thread the session was started with. */
export interface ReviewSession {
  /** One review turn. Returns the reply text as Codex produced it; the caller decodes it. */
  review(prompt: string): Effect.Effect<string, ReviewerError | TransportFault>;
}
export interface ReviewerShape {
  /** Starts a new thread and returns the session bound to it. Called at the start of every review loop. A start failure is a typed error (finding 11). */
  readonly startPhase: Effect.Effect<ReviewSession, CodexCallFailed>;
}
export class Reviewer extends Context.Service<Reviewer, ReviewerShape>()("plan-review/Reviewer") {}

/** An absolute path inside the project (finding 21): the root the change detection watches. */
export type ProjectPath = Brand.Branded<string, "ProjectPath">;
/** An absolute path under <project>/plan-review/: where the program and the planning calls may write. */
export type RecordPath = Brand.Branded<string, "RecordPath">;

/**
 * The records in <project>/plan-review/ and the comparison of the project state: one domain operation per
 * artifact of src/artifacts.ts (finding 27, recommendation D). The path fields are read-only values for messages and tests.
 */
export interface StoreShape {
  readonly project: ProjectPath;
  readonly dir: RecordPath;
  readonly plan: RecordPath;
  readonly questions: RecordPath;
  readonly requirements: RecordPath;
  init(task: string): Effect.Effect<void, StoreError>;
  /** Codex's raw reply of a round (`review-<n>.json`). */
  saveReview(subject: SubjectId, round: number, review: Review): Effect.Effect<void, StoreError>;
  /** Claude Code's raw response of a round (`cc-<n>.json`). */
  saveResponse(subject: SubjectId, round: number, response: PlannerResponse): Effect.Effect<void, StoreError>;
  /** The raw reply of corrective turn `attempt` of a round (issue #30): `<subject dir>/cc-<round>-corrective-<attempt>.json`. */
  saveCorrection(subject: SubjectId, round: number, attempt: number, reply: unknown): Effect.Effect<void, StoreError>;
  /** The program's validated record of a round (`round-<n>.json`, version 2). */
  saveRound(subject: SubjectId, record: RoundRecord): Effect.Effect<void, StoreError>;
  /** The output of the call that wrote or revised the plan (`planning-<k>/cc-0.json`). */
  savePlanWrite(phase: number, result: PlanWriteResult): Effect.Effect<void, StoreError>;
  /** The outcome of an execution phase (`execution-<k>/result.json`). */
  saveExecution(phase: number, outcome: ExecOutcome): Effect.Effect<void, StoreError>;
  /** The agreed question list as the program records it (`questions.json`, version 2). */
  saveQuestions(task: string, questions: QuestionsFile["questions"]): Effect.Effect<void, StoreError>;
  loadQuestions(): Effect.Effect<QuestionsFile, StoreError>;
  writeRequirements(text: string): Effect.Effect<void, StoreError>;
  /** Writes plan.json (issue #6, F1), then plan.md rendered from it (F2). */
  savePlan(plan: RecordedPlan): Effect.Effect<void, StoreError>;
  /** The plan of plan.json; none before the first plan is written. */
  loadPlan(): Effect.Effect<Option.Option<RecordedPlan>, StoreError>;
  loadLog(subject: SubjectId): Effect.Effect<readonly LogEntry[], StoreError>;
  saveLog(subject: SubjectId, log: readonly LogEntry[]): Effect.Effect<void, StoreError>;
  /** One decision of the user: the line in user-decisions.md and the transcript line derive from the one event. */
  appendDecision(event: DecisionEvent): Effect.Effect<void, StoreError>;
  recordFeedback(subject: SubjectId, round: number, text: string): Effect.Effect<void, StoreError>;
  converse(markdown: string): Effect.Effect<void, StoreError>;
  recordUsage(line: UsageLine): Effect.Effect<void, StoreError>;
  usageLines(): Effect.Effect<UsageLines, StoreError>;
  /** One wait for a usage limit, as actually spent (issue #68), appended to usage.jsonl when the wait ends. */
  recordLimitWait(wait: LimitWait): Effect.Effect<void, StoreError>;
  /**
   * The hash of what a subject's rounds observe (behaviour 7): the reviewed file's content; for a work review the
   * diff recomputed from the baseline and the current tree (Q14). "" when it does not exist.
   */
  fileHash(subject: SubjectId): Effect.Effect<string, StoreError>;
  /**
   * The reviewed file observed once (issue #31): its hash, as fileHash gives it, and its text from the same read, from
   * which the change during a response is measured. The work review is not measured (Q7): its text is "".
   */
  observeFile(subject: SubjectId): Effect.Effect<Readonly<{ hash: string; text: string }>, StoreError>;
  /** The hash of the bytes of the reviewed artifact on disk (the guard of behaviour 5); equal to fileHash but for a work review. */
  recordHash(subject: SubjectId): Effect.Effect<string, StoreError>;
  /** Writes work-review-<phase>/changes.diff: the diff of the project from the baseline tree to the current one (Q7). */
  changeRecord(phase: number): Effect.Effect<void, StoreError>;
  /** The text of work-review-<phase>/changes.diff, for the prompt of a read-only work response ("" when it does not exist). */
  readChangeRecord(phase: number): Effect.Effect<string, StoreError>;
  saveInvalidReply(agent: "claude" | "codex", content: string): Effect.Effect<string, StoreError>;
  projectSnapshot(): Effect.Effect<Snapshot, StoreError>;
  /** The guarded records under plan-review/ (src/artifacts.ts guardedRecord): the second check of a read-only call. */
  recordsSnapshot(): Effect.Effect<RecordsSnapshot, StoreError>;
  /** The position of the journal of the program's own writes to guarded records (issue #26). */
  readonly journalMark: Effect.Effect<number>;
  /** The program's own writes to guarded records since a mark, in order, each with its preimage. */
  ownWritesSince(mark: number): Effect.Effect<readonly OwnWrite[]>;
  /** Allocates the next decision number k by creating decision-<k>/, and writes decision-<k>/question.json. */
  openDecision(question: DecisionQuestion): Effect.Effect<number, StoreError>;
  /** The raw output of decision k's analysis call (`decision-<k>/cc-0.json`). */
  saveAnalysisWrite(decision: number, output: unknown): Effect.Effect<void, StoreError>;
  /** The validated analysis of decision k, its reviewed file (`decision-<k>/analysis.json`). */
  saveAnalysis(decision: number, analysis: DecisionAnalysis): Effect.Effect<void, StoreError>;
  /** plan-review/terms.json (S17): the explanations of the agreed questions' terms, the terms subject's reviewed file. */
  saveTerms(entries: TermsWrite["entries"]): Effect.Effect<void, StoreError>;
  /** The explanations of terms.json; none when the file does not exist (an empty agreed list, or no question phase). */
  loadTerms(): Effect.Effect<TermsWrite["entries"], StoreError>;
  loadAnalysis(decision: number): Effect.Effect<DecisionAnalysis, StoreError>;
  /** The user's choice after decision k (`decision-<k>/chosen.json`, decision Q4). */
  saveChoice(decision: number, choice: Choice): Effect.Effect<void, StoreError>;
  /** The texts of requirements.md and plan.md, null where one does not exist: the context of a decision (decision Q3). */
  readContext(): Effect.Effect<Readonly<{ requirements: string | null; plan: string | null }>, StoreError>;
  /** Replaces plan-review/checkpoint.json atomically with the last committed transition (Q6). */
  checkpoint(point: CheckpointPoint): Effect.Effect<void, StoreError>;
}
export class Store extends Context.Service<Store, StoreShape>()("plan-review/Store") {}

/** A question a decision analyzes, without its phase: the Decider adds the phase it is bound to. */
export type DecisionRequest = Readonly<{ question: string; options: readonly QuestionOption[]; /** What the user was shown with the question (S37). */ shown?: ShownWithQuestion; /** The displayed number of the question (S21), for the progress the user reads; no record keeps it. */ number?: number | null }>;
/** How a decision loop ended: its number, the analysis as it stands, and the loop's result. */
export type DecisionOutcome = Readonly<{ decision: number; analysis: DecisionAnalysis; result: LoopResult }>;
/**
 * Decision support (D3 of the decision-support plan): runs a decision loop for a question, over the services of the run,
 * from any place a prompt is asked, SDK callbacks included (its `decide` requires nothing). An instance is bound to the
 * phase in which the question is asked, and to that phase's label as the run names it (W1-R1-2: "Planning", or
 * "Planning 2" once the run holds two); `at` gives the instance of another phase.
 */
export interface DeciderShape {
  at(phase: Phase, label: string): DeciderShape;
  decide(request: DecisionRequest): Effect.Effect<DecisionOutcome, RunError>;
  /**
   * Writes the context paragraph and terms of a question the program composed (S9), in a fresh session over the run's
   * services, from any place a prompt is asked; the program's own paragraph when that cannot be done (S10).
   */
  explain(request: ContextRequest): Effect.Effect<ContextWritten, RunError>;
}
export class Decider extends Context.Service<Decider, DeciderShape>()("plan-review/Decider") {}

/** The configuration of the run (schema Config). */
export class RunConfig extends Context.Service<RunConfig, Config>()("plan-review/RunConfig") {}

/** The two SDKs (src/sdk.ts): the live binding in main.ts, a fake in the tests. */
export class Sdk extends Context.Service<Sdk, AgentSdk>()("plan-review/Sdk") {}

/** Everything the procedure needs. */
export type Services = Ui | Planner | Reviewer | Store | RunConfig | Decider;
