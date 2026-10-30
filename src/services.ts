// The services of the procedure. Every method returns an Effect with its errors in the error channel.
// Tests provide scripted layers; src/web.ts provides the live ones. API names: docs/effect-v4-api.md.

import { Context, Effect } from "effect";
import type { Brand, Option, Schema, Scope } from "effect";
import type { AgentUnreachable, CodexCallFailed, TrackerAuthRefused, TrackerBodyInvalid, TrackerItemNotFound, TrackerRequestRefused, TrackerStateAmbiguous, TrackerUnreachable, FileSystemError, GitError, RunError, StateFileInvalid, TransportFault, UsageLimited, UserStopped, NoAnswer } from "./errors.ts";
import type { OnExpiry } from "./protocol.ts";
import type { RunRoot, SubjectId } from "./artifacts.ts";
import type { RunMode } from "./runMode.ts";
import type { Baseline, CheckpointPoint, RoundRecord, VerdictRecord } from "./records.ts";
import type { EarlierPlan } from "./earlierPlan.ts";
import type { DecisionEvent } from "./reviewState.ts";
import type { SuiteResult } from "./suite.ts";
import type { CommitCheck } from "./commitCheck.ts";
import type { BranchName, GitState, LeftoverCommit, MergeOutcome, ParkRecord } from "./park.ts";
import type { CommandLine, Config, DecisionAnalysis, ExecCallOutcome, ExecOutcome, LogEntry, PlannerResponse, PlanWriteResult, QuestionOption, QuestionsFile, RecordedPlan, Review, TermsWrite } from "./schema.ts";
import type * as SchemaModule from "./schema.ts";
import type { LoopResult, Phase, UiEvent } from "./uiEvents.ts";
import type { ContextRequest } from "./prompts.ts";
import type { ContextWritten } from "./question.ts";
import type { LimitWait, LimitWaitBegan, CallFailure, RateLimitNotice, UsageLine, UsageLines } from "./usage.ts";
import type { AgentSdk } from "./sdk.ts";
import type { CommentId, ItemComment, ItemId, ItemState, TrackerItem } from "./tracker.ts";
import type { Refinement } from "./refinement.ts";
import type { OwnWrite, RecordsSnapshot, Snapshot } from "./snapshot.ts";
import type { OutputEvent } from "./liveOutput.ts";

/** Which reply of a round a raw save holds: the review, the response, or corrective turn k (issue #151). */
export type RawReplyKind = "review" | "response" | Readonly<{ corrective: number }>;
export type StoreError = FileSystemError | StateFileInvalid | GitError;
/** The question a decision analyzes (decision support): its text and options, the phase in which it was asked and that phase's label (W1-R1-2). */
/**
 * What the user was shown with a question beside its text and options (S37, W1-R1-5): its context paragraph, its terms
 * and its details. The analysis prompt carries it; decision-<k>/question.json does not.
 */
export type ShownWithQuestion = Readonly<{ context: string; history: string; terms: string; details: string }>;
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

/**
 * Issue #153: how the answer to a question is read: a one-line prompt (`parseAskLine`, "q" ends the run) or an interview
 * message (`parseMessage`, "/quit" ends the run).
 */
export type AskKind = "line" | "message";
/** Issue #153: what ended a question open beside work: the work, with its value, or the user's answer, first. */
export type DuringAnswer<A> = Readonly<{ _tag: "Done"; value: A }> | Readonly<{ _tag: "Answered"; text: string }>;
/**
 * Issue #153: the handle of one asking of one question (`UiShape.enterQuestion`). `askDuring` shows the prompt `prompt` in
 * the handle's frame while `work` runs, and returns `Done` with work's value when work finishes first, or `Answered` with
 * the user's text when an answer reaches the server first. An answer that ends the run ("q" for `line`, "/quit" for
 * `message`) fails with UserStopped. It never counts down (issue #185): before this change nothing counted down while an
 * analysis was prepared. Once answered, or once work finished, the frame stays, unanswerable, until the handle's Scope
 * closes; a later `askDuring` on the same handle reuses it in place.
 */
export type QuestionFrame = Readonly<{
  askDuring: <A, E, R>(prompt: string, kind: AskKind, work: Effect.Effect<A, E, R>) => Effect.Effect<DuringAnswer<A>, E | UserStopped, R>;
}>;
export interface UiShape {
  readonly say: (text: string) => Effect.Effect<void>;
  /**
   * Reads one line. The answer "q" fails with UserStopped. Issue #185: where the Ui counts the question down (an
   * implementation run in a chain), a wait that runs out fails with NoAnswer carrying `onExpiry` (default "abandon"),
   * what the question's expiry does: end the run, or (a review's limit) extend the review.
   */
  readonly ask: (prompt: string, onExpiry?: OnExpiry) => Effect.Effect<string, UserStopped | NoAnswer>;
  /** Reads one message of the interview (the page's reply field). The message "/quit" fails with UserStopped; NoAnswer as for ask. */
  readonly askMessage: (prompt: string, onExpiry?: OnExpiry) => Effect.Effect<string, UserStopped | NoAnswer>;
  /** A structured event of the run (decision Q5). The page shows it; the records do not depend on it. */
  readonly notify: (event: UiEvent) => Effect.Effect<void>;
  /** The number of the next question the user is asked (S6): one sequence for the run, from 1, whatever produced the question. */
  readonly nextQuestion: Effect.Effect<number>;
  /**
   * Issue #153: pushes a frame for the question numbered `question`, unanswerable, which blocks every frame beneath it, so
   * no question whose decision is being prepared beneath it is shown or answerable until the Scope closes, whatever
   * prompts this question's asking shows. The frame is removed when the Scope closes. Each call makes a distinct frame.
   */
  readonly enterQuestion: (question: number) => Effect.Effect<QuestionFrame, never, Scope.Scope>;
  /**
   * Issue #49: what a running process prints, live only: never recorded, never among the run's events, in its replay or
   * in conversation.md, and dropped where no tab listens.
   */
  readonly output: (event: OutputEvent) => Effect.Effect<void>;
}
export class Ui extends Context.Service<Ui, UiShape>()("plan-review/Ui") {}

/** What a planning call is for, as the activity line names it; the interview also says its tool use. */
/** "context": the call that writes a question's context paragraph and terms (S9), in a fresh session, with the capability "readProject". */
export type PlanningPurpose = "planning" | "interview" | "context";
/**
 * The purpose a Codex review turn and an execution call announce in AgentCallStarted and put on their wait events, so that
 * the page clears a wait only at the waited call's own start or end (W4-R2-1 of issue #184).
 */
export const REVIEW_PURPOSE = "review";
export const EXECUTION_PURPOSE = "execution";
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
  executing(prompt: string, reporter: StepReporter): Effect.Effect<ExecCallOutcome, PlannerError | AgentUnreachable, Decider>;
  readonly sessionId: Effect.Effect<string | null>;
  /** A planner over a new session, with the same hooks and callbacks (a decision loop, D4 of the decision-support plan). */
  readonly fresh: Effect.Effect<PlannerShape>;
}
export class Planner extends Context.Service<Planner, PlannerShape>()("plan-review/Planner") {}

/** One review loop's thread (behaviour 5). Every call goes to the thread the session was started with. */
/**
 * One review turn's reply (issue #165): the text as Codex produced it, which the caller decodes, and the turn's input
 * tokens as Codex reported them (the figure usage.jsonl records), null where Codex reported no usage for the turn.
 */
export type ReviewReply = Readonly<{ text: string; inputTokens: number | null }>;
/** The output schema of a review turn (issue #183): the plan's and the work's reviews state each issue's effect on the work. */
export type ReviewSchema = typeof SchemaModule.Review | typeof SchemaModule.EffectReview;
export interface ReviewSession {
  /** One review turn. Returns the reply with the turn's input tokens; the caller decodes the text. */
  review(prompt: string, schema: ReviewSchema): Effect.Effect<ReviewReply, ReviewerError | TransportFault>;
}
export interface ReviewerShape {
  /** Starts a new thread and returns the session bound to it. Called at the start of every review loop. A start failure is a typed error (finding 11). */
  readonly startPhase: Effect.Effect<ReviewSession, CodexCallFailed>;
}
export class Reviewer extends Context.Service<Reviewer, ReviewerShape>()("plan-review/Reviewer") {}

/** What the tracker port can fail with (issue #120, part 1; the fifth, an ambiguous state, by requirements Q3). */
export type TrackerError = TrackerUnreachable | TrackerRequestRefused | TrackerAuthRefused | TrackerItemNotFound | TrackerBodyInvalid | TrackerStateAmbiguous;
/**
 * The project's issue tracker (issue #120, part 1): its operations are the whole common type (developer's decision).
 * Issue #186 (requirements Q3, the developer's decision in its refinement) adds the comment, and with it the listing
 * of an item's comments, which the send-back's guard, the retry's reconciliation of a comment and the count of
 * send-backs in the lists read; both trackers have both. Nothing here names a label, a list or a status: how a state
 * is stored is the adapter's (GitHub and GitLab: a label name). Beside the services, not one of them.
 */
export interface TrackerShape {
  /** The open items in a state (requirements, Q2: an item closed in the tracker is in no list). */
  list(state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError>;
  /**
   * Issue #131 (requirements Q3, F2): the open items in a state that carry the label that marks an item for
   * preparation, newest first; empty, with no request sent, where no such label is configured. Which label marks an
   * item is the adapter's configuration, as for the states.
   */
  listMarked(state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError>;
  read(id: ItemId): Effect.Effect<TrackerItem, TrackerError>;
  /** Writes the item's `Refined using Interloq` section: appended once, replaced later; the rest of the body is kept. */
  writeRefinement(id: ItemId, refinement: Refinement): Effect.Effect<void, TrackerError>;
  setState(id: ItemId, state: ItemState): Effect.Effect<void, TrackerError>;
  /** Adds a comment to the item (issue #186). Not idempotent: a repeat adds a second comment. */
  comment(id: ItemId, text: string): Effect.Effect<void, TrackerError>;
  /** The item's comments, oldest first (issue #186); a tracker's own notes of a change are not comments. */
  comments(id: ItemId): Effect.Effect<readonly ItemComment[], TrackerError>;
  /**
   * Deletes one of the item's comments (issue #131: Interloq deletes its own preparation's comments). A comment
   * already gone counts as deleted, so the operation is idempotent and the tracker retry may repeat it.
   */
  deleteComment(id: ItemId, comment: CommentId): Effect.Effect<void, TrackerError>;
}
export class Tracker extends Context.Service<Tracker, TrackerShape>()("plan-review/Tracker") {}

/**
 * Issue #162 (requirements G-R1-1, F1): the runner of the project's whole suite after the review of the work finds nothing left to correct. A port
 * beside the services, not one of them, as Tracker is not: the decision loops and the review loop never use it. Every
 * failure of the command is a Failed value; the runner itself never fails.
 */
export interface SuiteRunnerShape {
  /**
   * Runs `command` in `cwd`, a run past `ceilingMs` stopped and failed as timed out (issue #181: the run's own limit).
   * Issue #49: `onOutput` is called with each chunk of stdout or stderr in arrival order while the run lasts, never after
   * it settled; a plain callback, since the runner is an edge in Node's callbacks and a forked Effect per chunk could reorder them.
   */
  run(command: CommandLine, cwd: string, ceilingMs: number, onOutput: (text: string) => void): Effect.Effect<SuiteResult>;
}
export class SuiteRunner extends Context.Service<SuiteRunner, SuiteRunnerShape>()("plan-review/SuiteRunner") {}

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
  /** The run's records directory relative to plan-review/, as allocateRunRoot created it (issue #120). */
  readonly root: RunRoot;
  /** <project>/plan-review/<root>: the run's own records. */
  readonly dir: RecordPath;
  readonly plan: RecordPath;
  readonly questions: RecordPath;
  readonly requirements: RecordPath;
  init(task: string): Effect.Effect<void, StoreError>;
  /**
   * Writes baseline.json, the tree of the project as the run begins (Q7): an implementation run's alone, since only it has
   * a work review (issue #120). Built through a temporary index in the git directory; see workingTree in src/store.ts.
   */
  writeBaseline(): Effect.Effect<void, StoreError>;
  /**
   * The plan this run starts from (issue #180): of the item's earlier implementation runs under plan-review/runs/, newest
   * first, the first whose plan review ended in agreement as its own records show (`latestQualifying`), its plan.json with its
   * statuses carried and its baseline.json; set aside where that baseline or the git tree it names is gone (F1). It reads
   * the earlier run's directory and writes nothing, there or here. No configuration decides it.
   */
  earlierPlan(item: ItemId): Effect.Effect<EarlierPlan, StoreError>;
  /**
   * Writes this run's baseline.json as an earlier run's (issue #180, Q4), in place of writeBaseline: the earlier run's tree
   * and uncommitted paths, with this run's own HEAD as `start_commit` (issue #147), so a halted run returns its working
   * branch to where it began, never to an earlier run's start.
   */
  adoptBaseline(baseline: Baseline): Effect.Effect<void, StoreError>;
  /** This run's baseline.json, or null where it has none yet (issue #147: the parking of a halted run reads it). */
  baseline(): Effect.Effect<Baseline | null, StoreError>;
  /**
   * The commit check (issue #176): the paths git lists now as not committed, less those it listed when writeBaseline ran,
   * less `plan-review/` and `ignorePaths` (a rename's two paths judged each on its own); a file git ignores and does not
   * track is never listed. A missing baseline.json is a StoreError: only an implementation run, which writes one, checks.
   */
  uncommittedSinceStart(): Effect.Effect<CommitCheck, StoreError>;
  // Issue #147 (requirements Q1): git writes of the store's own, used at the one moment after an implementation run
  // halted, to keep its work on a branch. Each is one git command and safe to repeat; when to call each is
  // src/parking.ts's. plan-review/ is gitignored, so none of them touches a run's records.
  /**
   * Commits the paths uncommittedSinceStart reports, and only those (literal pathspecs, so nothing else staged is
   * committed), with --no-verify, skipping the repository's hooks. Nothing left: NothingLeft, so a repeat commits nothing.
   */
  commitLeftovers(message: string): Effect.Effect<LeftoverCommit, StoreError>;
  /** The files of the commits in start..branch whose message carries the trailer, sorted and unique, read from git. */
  parkedPaths(start: string, branch: BranchName, trailer: string): Effect.Effect<readonly string[], StoreError>;
  /** The commit HEAD names, or null on an unborn branch. */
  head(): Effect.Effect<string | null, StoreError>;
  /** The commit the branch names, or null where it does not exist. */
  branchTip(branch: BranchName): Effect.Effect<string | null, StoreError>;
  /**
   * Issue #185 (F1): merges a parked run's branch into the working branch with --no-verify (its commits are that run's
   * unchecked work): Merged, a fast-forward or a merge commit; Conflicted, a content conflict, the merge aborted and the
   * working tree as it was; any other failure, after aborting a merge it left, a GitError.
   */
  mergeParked(branch: string): Effect.Effect<MergeOutcome, StoreError>;
  /** Issue #185 (G-R1-1): whether the repository is on a branch with no rebase, merge, cherry-pick or revert in progress. */
  gitState(): Effect.Effect<GitState, StoreError>;
  /** Creates the branch at HEAD. */
  createBranch(branch: BranchName): Effect.Effect<void, StoreError>;
  /**
   * Returns the working branch to `start` with `git reset --keep`: uncommitted changes in files the reset does not touch
   * are kept, and a reset that would overwrite one is refused (a GitError), so the developer's own work is never lost.
   */
  resetTo(start: string): Effect.Effect<void, StoreError>;
  /** parked.json in the run's records directory: the record of the parking of its work. */
  saveParked(record: ParkRecord): Effect.Effect<void, StoreError>;
  loadParked(): Effect.Effect<ParkRecord | null, StoreError>;
  /** Codex's raw reply of a round (`review-<n>.json`). */
  saveReview(subject: SubjectId, round: number, review: Review): Effect.Effect<void, StoreError>;
  /** Claude Code's raw response of a round (`cc-<n>.json`). */
  saveResponse(subject: SubjectId, round: number, response: PlannerResponse): Effect.Effect<void, StoreError>;
  /** The raw reply of corrective turn `attempt` of a round (issue #30): `<subject dir>/cc-<round>-corrective-<attempt>.json`. */
  saveCorrection(subject: SubjectId, round: number, attempt: number, reply: unknown): Effect.Effect<void, StoreError>;
  /**
   * An agent's reply of a round as it arrived, before it is decoded or validated (issue #151): written to the file the
   * accepted value later replaces, `review-<n>.json`, `cc-<n>.json` or `cc-<n>-corrective-<k>.json`; a text as it is,
   * anything else as JSON. Journaled, like every write of the store, so a read-only call's records guard passes it.
   */
  saveRawReply(subject: SubjectId, round: number, kind: RawReplyKind, raw: unknown): Effect.Effect<void, StoreError>;
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
  /** Issue #162: the whole output of suite run n, in suite-<n>.log. */
  saveSuiteLog(n: number, text: string): Effect.Effect<void, StoreError>;
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
  /**
   * One wait for a usage limit, as actually spent (issue #68), appended to usage.jsonl when the wait ends; then
   * checkpoint.json is replaced with its transition unchanged and `waiting` null (issue #179).
   */
  recordLimitWait(wait: LimitWait): Effect.Effect<void, StoreError>;
  /**
   * The start of a wait for a usage limit (issue #179): appends the usage_limit_wait_began line to usage.jsonl, then
   * replaces checkpoint.json with the last committed transition unchanged and `waiting` set to the wait.
   */
  recordLimitWaitBegan(wait: LimitWaitBegan): Effect.Effect<void, StoreError>;
  /** One rate-limit notice of a Claude Code request, appended to usage.jsonl as it arrives (issue #170). */
  recordRateLimit(notice: RateLimitNotice): Effect.Effect<void, StoreError>;
  /** One failed Claude Code request, its facts appended to usage.jsonl as a claude_call_failed line (issue #192). */
  recordCallFailure(failure: CallFailure): Effect.Effect<void, StoreError>;
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
  /** The text of user-decisions.md, for the prompt of a read-only work response (issue #122; "" when it does not exist). */
  readUserDecisions(): Effect.Effect<string, StoreError>;
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
  /** Issue #186: verdict n as it now stands, its reviewed file (`verdict-<n>/verdict.json`). */
  saveVerdict(verdict: number, record: VerdictRecord): Effect.Effect<void, StoreError>;
  loadVerdict(verdict: number): Effect.Effect<VerdictRecord, StoreError>;
  /** The user's choice after decision k (`decision-<k>/chosen.json`, decision Q4). */
  saveChoice(decision: number, choice: Choice): Effect.Effect<void, StoreError>;
  /** The texts of requirements.md and plan.md, null where one does not exist: the context of a decision (decision Q3). */
  readContext(): Effect.Effect<Readonly<{ requirements: string | null; plan: string | null }>, StoreError>;
  /** Replaces plan-review/checkpoint.json atomically with the last committed transition (Q6). */
  checkpoint(point: CheckpointPoint): Effect.Effect<void, StoreError>;
}
export class Store extends Context.Service<Store, StoreShape>()("plan-review/Store") {}

/** A question a decision analyzes, without its phase: the Decider adds the phase it is bound to. */
export type DecisionRequest = Readonly<{ question: string; options: readonly QuestionOption[]; /** What the user was shown with the question (S37). */ shown?: ShownWithQuestion; /** The displayed number of the question (S21), for the progress the user reads; no record keeps it. */ number?: number | null;
  /** Issue #153: called by the decision loop as soon as the decision's number is allocated, so the asker knows it when it abandons the decision. */
  opened?: (decision: number) => Effect.Effect<void>;
}>;
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

/** The two SDKs (src/sdk.ts): the live binding in src/sdkLive.ts, a fake in the tests. */
export class Sdk extends Context.Service<Sdk, AgentSdk>()("plan-review/Sdk") {}

/**
 * The mode of the run (issue #120), a fact of the whole run like its configuration: planningCall reads it, since a
 * refinement run drops the project snapshot of Claude Code's planning calls (the developer's decision of 8 Oct 2026).
 */
export class RunKind extends Context.Service<RunKind, Readonly<{ mode: RunMode }>>()("plan-review/RunKind") {}

/** Everything the procedure needs. */
export type Services = Ui | Planner | Reviewer | Store | RunConfig | RunKind | Decider;
