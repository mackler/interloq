// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import { Effect, Fiber, Ref, Result, Schema } from "effect";
import { type RunRoot, type SubjectId, subjectDir } from "./artifacts.ts";
import { AgentReplyInvalid, ProjectChanged, RecordsChanged, ReviewedFileChanged, type RunError, type UserStopped } from "./errors.ts";
import type { LoopResult } from "./uiEvents.ts";
import { largestInput, threadAfter, type ReviewThread } from "./reviewThread.ts";
import { attachedOf, pauseOriginOf, type Question, taskDisputeOf, type QuestionOrigin, validateQuestions } from "./question.ts";
import { piecesText, plainBlocks, plainPieces } from "./pieces.ts";
import { pauseProse } from "./render.ts";
import { serializeReply } from "./records.ts";
import * as prompts from "./prompts.ts";
import { questionRepairPrompt, correctivePrompt, transportReviewWhat, transportWhat, repairReplyPrompt, type RespondContext } from "./prompts.ts";
import { correctiveValidation, investigationValidation, partCollisionValidation, reviewValidation, roundValidation, validateReview } from "./round.ts";
import { agentContext, askOffering, type BesideQuestion as BesideHandle, byLine, decisionAnswerOf, limitOptions, numberedOptions, openBeside, positionOptions, programContext, type QuestionDraft, unchangedOptions } from "./offer.ts";
import type { OpenDispute } from "./openDisputes.ts";
import { parseUnchangedAnswer } from "./input.ts";
import { advance, type Asks, type Beside, type BesideKey, subjectOf, type DisputesSettledBy, idPrefixOf, initialState, type OnAcceptance, roundCheckOf, type Option, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, type Transition } from "./reviewState.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, Review, UserQuestion } from "./schema.ts";
import { type Decider, OpenQuestions, Planner, type PlanningCapability, type PlanningPurpose, type PlanningResult, type RawReplyKind, REVIEW_PURPOSE, Reviewer, type ReviewSchema, type ReviewSession, RunConfig, RunKind, type Services, Store, type StoreError, type Taken, Ui } from "./services.ts";
import { compareJournaled, compareSnapshots } from "./snapshot.ts";
import { ASK, type Exhaustion, FAIL, withTransportRetry } from "./retry.ts";
import { guardsPlanningProject, guardsReviewProject } from "./runMode.ts";
import { sameDocument, type ShownDocument } from "./reviewedDocument.ts";
import { keptBaselineOf, keptCorrectionsValidation, restatable } from "./keptCorrections.ts";

/** Codex's reply text, decoded as JSON and then as a review; text that is not JSON is a decode failure. */

/** One planning call of a subject: its prompt, the schema of its output, and what is done with the output. */
export type Operation<T> = Readonly<{
  /** Its prompt, naming the run's own records (issue #120: the run's root). */
  prompt: (root: RunRoot, round: number, context: RespondContext) => string;
  schema: Schema.Decoder<T>;
  /** Runs after every such call, for output that the program writes to the file; null when there is nothing to do. */
  after: ((output: T) => Effect.Effect<void, RunError, Store | Ui>) | null;
  /** What the call may do (finding 1 of docs/gui-review.md): "readOnly" for a work response, "records" otherwise. */
  capability: PlanningCapability;
  /** The validation beyond the schema, with its repair turn (issue #37); null when there is none. */
  validate: ValidationSource<T>;
}>;

/** What the review procedure is applied to. `R` is the response to a review, `D` the output of applying decisions (finding 12). */
export type Subject<R extends PlannerResponse = PlannerResponse, D = unknown> = Readonly<{
  /** The subject's identity: its files, phase and directory come from src/artifacts.ts. */
  id: SubjectId;
  /** The phase its loop records in log entries, round records and checkpoints: a decision's is the phase in which it took place. */
  phase: number;
  /** Heading in conversation.md and in the page, for example "Planning phase 2". */
  heading: string;
  /** Name of the reviewed file as used in messages, for example "plan.md". */
  fileLabel: string;
  /** Codex's review prompt, naming the run's own records (issue #120: the run's root). */
  /** The review's prompt for a round, by the Codex thread it is sent to (issue #165). */
  reviewPrompt: (root: RunRoot, round: number, thread: ReviewThread) => string;
  /** Claude Code's response to a review. */
  respond: Operation<R>;
  /** The call that applies the user's decisions; its prompt does not depend on the round. */
  applyDecisions: Readonly<{ prompt: (root: RunRoot) => string; schema: Schema.Decoder<D>; after: ((output: D) => Effect.Effect<void, RunError, Store | Ui>) | null; validate: ValidationSource<D> }>;
  /** After the response of a round, an amendment that requires the user (the requirements); null otherwise. */
  amend: ((review: Review, response: R, round: number) => Effect.Effect<void, RunError, Services>) | null;
  /** Text of the "p" choice at the round limit; null: no such choice (the work review, Q13). */
  proceed: string | null;
  /** What a round with a correction due does (Q14; issue #252): continue, leave, or collect until a review raises no counted issue. */
  onAcceptance: OnAcceptance;
  /** G-R1-1: a non-empty decision at a pause ends the loop with "revise" instead of a planning call. */
  leaveOnDecision: boolean;
  /**
   * Issue #30: what follows a response that accepted an issue and left the reviewed file unchanged: a corrective turn,
   * the pause at once (the requirements, G-R1-1), or null where the condition cannot arise (the work review, Q7). A
   * subject with a value has its file's change measured in the issue log (issue #31).
   */
  onUnchanged: "corrective" | "pause" | null;
  /**
   * Issue #112: who settles a disagreement between the agents over an issue: the user at a pause, or the agents (Claude
   * Code's disposition stands), except one Claude Code marks as about what the task requires, which the user settles
   * (issue #156); or, in the plan and the work, the agents where both state the disagreement changes nothing in the
   * work, the user otherwise (issue #183).
   */
  disputesSettledBy: DisputesSettledBy;
  /** The schema of Codex's review (issue #183): S.EffectReview for the plan and the work, S.Review otherwise. */
  reviewSchema: ReviewSchema;
  /**
   * Issue #252 (requirements Q2): the parts of each cycle's review, one Codex request each, all at once, the whole part
   * first, resolved once at the loop's start; null for one review from `reviewPrompt` (every subject but the work).
   */
  reviewParts: Effect.Effect<readonly ReviewPartPrompt[], RunError, Services> | null;
  /** A decision's subject: the number of the question its analysis is for (S21), which its progress names; absent otherwise. */
  question?: number | null;
  /** Run before every round's Codex turn, before its guard's snapshot (the work review rewrites changes.diff); null otherwise. */
  prepare: Effect.Effect<void, RunError, Services> | null;
  /** The document under review as it now stands, which the page shows (issue #86); null where its file is absent. */
  document: Effect.Effect<ShownDocument | null, RunError, Services>;
  /**
   * Issue #232: how a response of a subject that rewrites its reviewed file whole is held to the corrections accepted
   * earlier in its loop (src/keptCorrections.ts): the texts of the file it returns and its correction_passages; null for
   * a subject whose response is not so held.
   */
  keepsCorrections: KeepsCorrections<R> | null;
}>;
/** Two validations of one reply, the second only where the first passes (issue #252: a repaired part's review). */
const bothChecks =
  <T>(first: Validation<T>, second: Validation<T>): Validation<T> =>
  (reply) => {
    const a = first(reply);
    return Result.isFailure(a) ? a : second(a.success.value);
  };
/** Issue #252: a part of a code review's cycle with its prompt for a round and the thread it is sent to. */
export type ReviewPartPrompt = Readonly<{ part: prompts.ReviewPart; prompt: (root: RunRoot, round: number, thread: ReviewThread) => string }>;
const SEVERITY_RANK: Readonly<Record<Review["issues"][number]["severity"], number>> = { minor: 0, major: 1, blocking: 2 };
/**
 * Issue #252: the parts' reviews of one cycle merged, in part order. An id already in the log as the cycle began is kept
 * once, under its id: the first part's issue, at the highest severity any part gave it, with each later part's evidence
 * appended. New ids are unique across the parts by then (the collision repair turn).
 */
export const mergePartReviews = <T extends Review>(logIds: ReadonlySet<string>, parts: readonly Readonly<{ key: string; review: T }>[]): T => {
  const issues: T["issues"][number][] = [];
  for (const { key, review } of parts) {
    for (const i of review.issues) {
      const at = logIds.has(i.id) ? issues.findIndex((m) => m.id === i.id) : -1;
      if (at < 0) {
        issues.push(i);
        continue;
      }
      const kept = issues[at]!;
      issues[at] = { ...kept, severity: SEVERITY_RANK[i.severity] > SEVERITY_RANK[kept.severity] ? i.severity : kept.severity, evidence: `${kept.evidence}\nAlso raised by ${key}: ${i.evidence}` };
    }
  }
  return { ...parts[0]!.review, issues } as T;
};
export type KeepsCorrections<R> = Readonly<{ textsOf: (response: R) => readonly string[]; entriesOf: (response: R) => readonly S.CorrectionPassages[] }>;

/** Notifies the page of a subject's document as it now stands (issue #86), for a document written outside a review loop. */
export const showDocument = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const document = yield* subject.document;
    if (document !== null) yield* (yield* Ui).notify({ _tag: "DocumentShown", subject: subject.id, document });
  });

/**
 * The question a decision of a review loop asks (S7): a pause of behaviour 7 with its fixed question and the
 * program's context, or Claude Code's question with its own; `decision` is k inside decision k (issue #57).
 */
export const decisionDraft = (heading: string, asks: Asks, options: readonly Option[], decision: number | null, pass: prompts.PassNoun): QuestionDraft => {
  if (asks.kind === "planner") return plannerDraft(asks.question, heading, decision);
  const pause = pauseOriginOf(asks.facts);
  const origin: QuestionOrigin = { kind: "pause", heading, pass, ...pause };
  // S12: Claude Code writes the context from the pause's facts, which the user reads beside it as prose (S11).
  // Issue #156: a disagreement Claude Code marked asks which reading of the task the work should follow.
  const taskDispute = taskDisputeOf(asks.facts);
  const context = taskDispute ? { blocks: plainBlocks(prompts.taskDisputeContext(heading)), by: "program" as const } : programContext(origin);
  const question = taskDispute ? prompts.TASK_DISPUTE_QUESTION : prompts.pauseQuestion(pause, pass);
  return { origin, context, history: [], explanations: [], question: plainPieces(question), options: prompts.isDisputedKind(pause.pause) ? positionOptions(pause.pause, options, pass) : numberedOptions(options), attached: attachedOf("reviewFacts", pauseProse(asks.facts)), explain: taskDispute ? prompts.TASK_DISPUTE_CONTEXT_FACTS : "", decision };
};
/** A question Claude Code returned with a plan or a response (S7): its context, terms and options as it wrote them. */
export const plannerDraft = (question: UserQuestion, heading: string, decision: number | null): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "planner", heading };
  return { origin, context: agentContext(question.context, origin), history: question.history, explanations: question.explanations, question: question.question, options: numberedOptions(question.options), decision };
};

/** Asks one decision (S7): the question presented, the offer where it has options; an answer that is an option's number stands for that option. */
export const askDecisionQuestion = (draft: QuestionDraft): Effect.Effect<string, RunError, Ui | Store | Decider> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    // Issue #159: resolved on the options as shown, after the context call, so a label it wrote stands for its position.
    return yield* askOffering(byLine((p) => ui.ask(p)), prompts.decisionPrompt, draft, undefined, null, decisionAnswerOf);
  });


/** Reads one decision on a question of the plan writer, outside a review loop. An empty answer records nothing and returns "". */
export const askPlannerQuestion = (question: UserQuestion, heading: string, phase: number, round: number): Effect.Effect<string, RunError, Ui | Store | Decider> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const decision = yield* askDecisionQuestion(plannerDraft(question, heading, null));
    if (decision !== "") yield* store.appendDecision({ subject: prompts.recordSubject({ kind: "planner", heading }, piecesText(question.question)), id: null, decision, phase, round });
    return decision;
  });

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * A second turn spent on a defective reply, in the same session or thread (decision S2 of issues #26, #30 and #31):
 * `schema` (behaviour 10), `validation` (issue #37) or `corrective` (issue #30, an accepted issue left the reviewed file
 * unchanged). Each kind has its own budget, and its prompt comes from src/prompts.ts. A dropped connection is not a
 * Repair: it repeats a call that produced no reply (src/retry.ts).
 */
export type Repair = Readonly<{ kind: "schema" | "validation" | "corrective" | "investigation"; prompt: string }>;

/**
 * Decodes an agent's reply with its schema. A reply that does not match is kept on disk and the agent
 * gets one repair turn in the same session or thread; a second mismatch fails with AgentReplyInvalid.
 * Excess properties are ignored: they break no assumption of the program.
 */
export const decodeWithRepair = <Out extends Schema.Decoder<unknown>, E, R>(
  agent: keyof typeof AGENT_LABEL,
  schema: Out,
  reply: unknown,
  repair: (repair: Repair) => Effect.Effect<unknown, E, R>,
): Effect.Effect<Out["Type"], E | RunError, R | Store> => decodeValidating(agent, schema, reply, repair, null).pipe(Effect.map((r) => r.value));

/**
 * Decodes a reply and, when a validation is given, validates it (issue #37, decision Q1). Each kind of failure has its
 * own budget of one repair turn in the same session or thread: a schema mismatch gets repairReplyPrompt, a validation
 * failure the validation's own prompt; every rejected reply is kept on disk. A second schema mismatch fails with
 * AgentReplyInvalid naming both kept files, a second validation failure with the validation's error. The notes of the
 * accepted value are returned, not recorded.
 */
export const decodeValidating = <Out extends Schema.Decoder<unknown>, E, R>(
  agent: keyof typeof AGENT_LABEL,
  schema: Out,
  reply: unknown,
  repair: (repair: Repair) => Effect.Effect<unknown, E, R>,
  validate: Validation<Out["Type"]> | null,
  onReply: OnReply | null = null,
): Effect.Effect<Readonly<{ value: Out["Type"]; notes: readonly string[] }>, E | RunError, R | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const decode = (value: unknown): { ok: true; value: Out["Type"] } | { ok: false; issue: string } => {
      try {
        return { ok: true, value: Schema.decodeUnknownSync(schema, { errors: "all" })(value) };
      } catch (e) {
        if (Schema.isSchemaError(e)) return { ok: false, issue: e.message };
        throw e;
      }
    };
    const keep = (value: unknown): Effect.Effect<string, StoreError> => store.saveInvalidReply(agent, serializeReply(value));
    // At most three steps: the reply, one schema repair and one validation repair.
    const step = (value: unknown, schemaFile: string | null, validationUsed: boolean): Effect.Effect<Readonly<{ value: Out["Type"]; notes: readonly string[] }>, E | RunError, R | Store> =>
      Effect.gen(function* () {
        if (onReply !== null) yield* onReply(value);
        const decoded = decode(value);
        if (!decoded.ok) {
          const file = yield* keep(value);
          if (schemaFile !== null) return yield* Effect.fail(new AgentReplyInvalid({ agent: AGENT_LABEL[agent], issue: decoded.issue, files: [schemaFile, file] }));
          return yield* step(yield* repair({ kind: "schema", prompt: repairReplyPrompt(decoded.issue) }), file, validationUsed);
        }
        if (validate === null) return { value: decoded.value, notes: [] };
        const validated = validate(decoded.value);
        if (Result.isSuccess(validated)) return validated.success;
        yield* keep(value);
        if (validationUsed) return yield* Effect.fail(validated.failure.error);
        return yield* step(yield* repair({ kind: "validation", prompt: validated.failure.repair }), schemaFile, true);
      });
    return yield* step(reply, null, false);
  });

/** What is done with every reply of a call as it arrived, the first and each repair turn's, before it is decoded (issue #151): the raw save of a review loop's reply. */
export type OnReply = (raw: unknown) => Effect.Effect<void, StoreError>;

/**
 * The program's validation of a decoded reply beyond its schema (issue #37, decision Q1): the value to use with the notes
 * to record in conversation.md, or the error that ends the run and the prompt of the repair turn.
 */
export type Validation<T> = (output: T) => Result.Result<Readonly<{ value: T; notes: readonly string[] }>, Readonly<{ error: RunError; repair: string }>>;
/**
 * Where a subject's validation comes from (issue #216, review P1-R1-1 and P1-R1-2): a validation fixed when the subject
 * is built, none, or one built from the records as they stand at each call (`Loaded`), which the interpreter resolves
 * immediately before each response, corrective turn and application of decisions.
 */
export type ValidationSource<T> = Validation<T> | null | Readonly<{ _tag: "Loaded"; load: Effect.Effect<Validation<T>, RunError, Services> }>;
/** The validation of a source at this call. */
export const resolveValidation = <T>(source: ValidationSource<T>): Effect.Effect<Validation<T> | null, RunError, Services> =>
  source === null || typeof source === "function" ? Effect.succeed(source) : source.load;

/** The decoded output of a planning call, the free text and cost of the call that produced it, and whether a repair turn was needed. */
export type PlanningCall<Out> = Readonly<{ output: Out; reply: unknown; resultText: string; costUsd: number | null; repaired: boolean }>;

/**
 * A call in which Claude Code may write only under plan-review/ ("records"), or change nothing ("readOnly", a work
 * response; "readProject", the context call of a question, which may read the project). Halts if the project changed;
 * a call that may change nothing, its repair turn included, also halts if a guarded record under plan-review/ changed (RecordsChanged; the program's own writes are not guarded, src/artifacts.ts).
 */
export const planningCall = <Out extends Schema.Decoder<unknown>>(prompt: string, schema: Out, purpose: PlanningPurpose = "planning", capability: PlanningCapability = "records", validate: Validation<Out["Type"]> | null = null, onReply: OnReply | null = null, exhaustion: Exhaustion = purpose === "context" ? FAIL : ASK): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner | Decider | Ui | RunConfig | RunKind> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const planner = yield* Planner;
    // Issue #120 (the developer's decision of 8 Oct 2026): a refinement run takes no project snapshot around Claude Code's
    // planning calls, whose hook still denies a write outside the run's records before it happens (behavior 3), so that an
    // implementation run beside it may commit. The records guard of a read-only call stays; Codex's turns keep their own.
    const projectGuarded = guardsPlanningProject((yield* RunKind).mode);
    /**
     * One call, retried after a transport fault (issue #26). The baselines are taken once, before the first attempt, and
     * every attempt, failed ones included, and every retry is checked against them; the records guard of a read-only
     * call replays the program's own writes since then (the Store's journal).
     */
    const call = (text: string) =>
      Effect.gen(function* () {
        const before = projectGuarded ? yield* store.projectSnapshot() : null;
        const recordsBefore = capability !== "records" ? yield* store.recordsSnapshot() : null;
        const mark = yield* store.journalMark;
        const check = Effect.gen(function* () {
          if (before !== null) {
            const changes = compareSnapshots(before, yield* store.projectSnapshot());
            if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes }));
          }
          if (recordsBefore !== null) {
            const records = compareJournaled(recordsBefore, yield* store.ownWritesSince(mark), yield* store.recordsSnapshot());
            if (records.length > 0) return yield* Effect.fail(new RecordsChanged({ changes: records }));
          }
        });
        const attempt = () =>
          Effect.gen(function* () {
            const result = yield* Effect.result(planner.planning(text, schema, purpose, capability));
            yield* check;
            return yield* Effect.fromResult(result);
          });
        // S10: the context call of a question does not ask a question of its own when its retries are exhausted (FAIL, the
        // default for it); issue #184: the first interview's requests try again in the background while the developer answers.
        return yield* withTransportRetry("claude", purpose, transportWhat(purpose), attempt, check, exhaustion);
      });
    const first = yield* call(prompt);
    const repairCall = yield* Ref.make<PlanningResult | null>(null);
    const repair = (r: Repair) => call(r.prompt).pipe(Effect.tap((result) => Ref.set(repairCall, result)), Effect.map((result) => result.output));
    const { value: output, notes } = yield* decodeValidating("claude", schema, first.output, repair, validate, onReply);
    for (const note of notes) yield* store.converse(note);
    const second = yield* Ref.get(repairCall);
    const used = second ?? first;
    return { output, reply: used.output, resultText: used.resultText, costUsd: used.costUsd, repaired: second !== null };
  });

/**
 * The corrective turn (issue #30) as a Repair of its own: a planning call in the current session whose reply has fresh
 * schema and validation budgets, so it takes neither's turn and neither takes its.
 */
export const repairTurn = <Out extends Schema.Decoder<unknown>>(repair: Repair, schema: Out, capability: PlanningCapability, validate: Validation<Out["Type"]> | null, onReply: OnReply | null = null): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner | Decider | Ui | RunConfig | RunKind> =>
  planningCall(repair.prompt, schema, "planning", capability, validate, onReply);

/**
 * The validation of the questions a reply puts to the user (S2): `questionsOf` names each with where it is; a failure
 * gets the validation repair turn, whose prompt cites the rules broken.
 */
export const questionsValidation =
  <T>(questionsOf: (output: T) => readonly Readonly<{ where: string; question: Question }>[]): Validation<T> =>
  (output) => {
    const validated = validateQuestions(questionsOf(output));
    return Result.isFailure(validated) ? Result.fail({ error: validated.failure, repair: questionRepairPrompt(validated.failure.questions) }) : Result.succeed({ value: output, notes: [] });
  };

/** The validation of a reply's questions_for_user (S16, Q12): each question under the rules, named by its position. */
export const userQuestionsValidation = <T extends Readonly<{ questions_for_user: readonly UserQuestion[] }>>(): Validation<T> =>
  questionsValidation((output: T) => output.questions_for_user.map((question, i) => ({ where: `questions_for_user ${i + 1}`, question })));

/** Two validations in turn: the second sees the first's value, and the notes of both are kept. */
export const bothValidations =
  <T>(first: Validation<T>, second: Validation<T> | null): Validation<T> =>
  (output) => {
    const a = first(output);
    if (Result.isFailure(a) || second === null) return a;
    return Result.map(second(a.success.value), (b) => ({ value: b.value, notes: [...a.success.notes, ...b.notes] }));
  };

/**
 * Issue #232: a response held to the corrections accepted earlier in its loop, judged against the log as the round began
 * and the round's validated dispositions, whose reverses validateRound normalized, so that only a reversal the loop will
 * pause on exempts a dropped passage. It runs after the round's validation; a reply whose round fails gets that failure.
 */
const keptCheckOf = <R extends PlannerResponse>(
  kept: KeepsCorrections<R>,
  state: ReviewState,
  check: ReturnType<typeof roundCheckOf>,
  roundCheck: Validation<R>,
): Validation<R> => {
  const log = state.current.startLog;
  const validation = keptCorrectionsValidation<R>(
    { baseline: keptBaselineOf(log, state.setup.phase), restatable: restatable(log, state.setup.phase), dispositionsOf: (reply) => Result.getOrElse(Result.map(check(reply), (r) => r.dispositions), () => []) },
    kept.textsOf,
    kept.entriesOf,
  );
  return (reply) => (Result.isFailure(check(reply)) ? roundCheck(reply) : validation(reply));
};

export const applyDecisions = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const call = yield* planningCall(subject.applyDecisions.prompt((yield* Store).root), subject.applyDecisions.schema, "planning", "records", yield* resolveValidation(subject.applyDecisions.validate));
    if (subject.applyDecisions.after !== null) yield* subject.applyDecisions.after(call.output);
  });

/** The one status of an analysis being prepared (S21, Q4): notified for the page, and said as a line the page absorbs. */
export const analysisProgress = (decision: number, question: number | null, check: number): Effect.Effect<void, never, Ui> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    yield* ui.notify({ _tag: "AnalysisProgress", decision, question, check });
    yield* ui.say(prompts.analysisProgressLine(decision, question, check));
  });

/**
 * The review procedure, as the interpreter of src/reviewState.ts: every command of a transition is executed
 * against the services, and the command that yields an event (the last of its batch) drives the next
 * transition. The pauses, the log update and the progress checks are all in `advance`.
 */
/** W2-R2-1: the answers to a loop's own beside questions, and whether it still accepts one. */
type LoopAnswers = Readonly<{ accepting: boolean; answers: ReadonlyMap<BesideKey, string> }>;

/** How a review loop ended, and in which round. */
export type LoopEnd = Readonly<{ result: LoopResult; round: number }>;

/**
 * Issue #243: `continueFrom`, the end of a loop of the same subject that ran before in this phase, whose round numbers
 * this loop continues, so no round file of it is overwritten. The questions this loop opens beside the review (its
 * limits and unchanged files) live in the loop's own scope and are cancelled when it ends; a dispute's question lives in
 * the run's scope (OpenQuestions), since its answer applies after the loop too.
 */
export const reviewLoop = <R extends PlannerResponse, D>(subject: Subject<R, D>, continueFrom: LoopEnd | null = null): Effect.Effect<LoopEnd, RunError, Services> =>
  Effect.scoped(Effect.gen(function* () {
    const loopScope = yield* Effect.scope;
    const openQuestions = yield* OpenQuestions;
    /** This loop's questions open beside the review (limits, idle, unchanged), by key. */
    const besides = yield* Ref.make<ReadonlyMap<string, BesideHandle>>(new Map());
    /**
     * W2-R2-1: the answers to this loop's own questions (limits, idle, unchanged), each accepted or refused in one step
     * with `accepting`, which the final boundary's read turns off, so no answer is taken that nothing will read.
     */
    const loopAnswers = yield* Ref.make<LoopAnswers>({ accepting: true, answers: new Map() });
    /** The keys of this loop's disputes, in the run's registry. */
    const disputeKeys = yield* Ref.make<readonly BesideKey[]>([]);
    yield* Effect.addFinalizer(() => Ref.get(disputeKeys).pipe(Effect.flatMap((keys) => openQuestions.loopEnded(keys))));
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const reviewer = yield* Reviewer;
    const { id, heading, fileLabel } = subject;
    const pass = prompts.passNoun(id);
    // Issue #183: Codex's reply is decoded with the subject's review schema, the one its turns are given.
    const reviewText = Schema.fromJsonString(subject.reviewSchema);
    const phase = subject.phase;
    /** The decision this loop works out, whose questions belong to it (issue #57); null for the other subjects. */
    const within = typeof id === "object" && "decision" in id ? id.decision : null;
    /** The number in the subject's generated ids: the decision's or the verdict's number, the phase otherwise. */
    const idNumber = typeof id === "object" && "decision" in id ? id.decision : typeof id === "object" && "verdict" in id ? id.verdict : phase;
    // One thread per review loop (behaviour 5): the session is held by this loop, not by the adapter. Issue #165: until a
    // turn's input passes codexTurnInputLimit, after which the next round starts a new thread.
    // Issue #252: the parts of each cycle, resolved once, since the plan does not change during a code review; each part
    // holds its own thread and the input tokens of its current round's turns (issue #165).
    const partPrompts: readonly ReviewPartPrompt[] = subject.reviewParts === null ? [{ part: { _tag: "Whole" }, prompt: subject.reviewPrompt }] : yield* subject.reviewParts;
    /** One part a cycle: its raw reply in review-<n>.json and its restart line naming no part, as before issue #252. */
    const single = partPrompts.length === 1;
    type PartThread = Readonly<{ part: prompts.ReviewPart; prompt: ReviewPartPrompt["prompt"]; key: string; session: Ref.Ref<ReviewSession>; inputs: Ref.Ref<readonly (number | null)[]> }>;
    const parts: PartThread[] = [];
    for (const p of partPrompts) parts.push({ part: p.part, prompt: p.prompt, key: prompts.reviewPartKey(p.part), session: yield* Ref.make(yield* reviewer.startPhase), inputs: yield* Ref.make<readonly (number | null)[]>([]) });
    /**
     * The document this loop last showed (issue #86). It is shown before every review, so a loop's first proposal is on
     * the page before Codex's first review and the diff shown is the one Codex reviews, and after every step that may
     * amend it; only a changed document is published, so an unchanged diff is not repeated in the run's events.
     */
    const lastShown = yield* Ref.make<ShownDocument | null>(null);
    const publishDocument = Effect.gen(function* () {
      const document = yield* subject.document;
      const last = yield* Ref.get(lastShown);
      if (document === null || (last !== null && sameDocument(last, document))) return;
      yield* Ref.set(lastShown, document);
      yield* ui.notify({ _tag: "DocumentShown", subject: id, document });
    });

    // Codex runs without a sandbox, so the project and the reviewed file are compared after every turn,
    // including a repair turn. A refinement run compares the reviewed file alone (the developer's instruction of
    // 11 Oct 2026): an implementation run beside it commits to the project, and a commit landing during a Codex turn
    // halted a refinement mid-review.
    const reviewProjectGuarded = guardsReviewProject((yield* RunKind).mode);
    const reviewCall = (thread: PartThread, text: string) =>
      Effect.gen(function* () {
        const projectBefore = yield* store.projectSnapshot();
        const fileBefore = yield* store.fileHash(id);
        // The bytes of the reviewed artifact too: a work review's fileHash is recomputed from the project and
        // does not see an edit of changes.diff itself (P1-R2-2).
        const recordBefore = yield* store.recordHash(id);
        // The baselines hold across the retries of a transport fault (issue #26): every attempt, failed ones included,
        // and every retry is compared with them.
        const check = Effect.gen(function* () {
          const changes = compareSnapshots(projectBefore, yield* store.projectSnapshot());
          // The artifact's bytes, or the observed hash without a visible project change (a work review's diff also
          // changes with a commit); a change of the project itself is reported as ProjectChanged below. For the
          // other subjects both hashes are the file's content, as before.
          const recordChanged = (yield* store.recordHash(id)) !== recordBefore;
          const fileChanged = recordChanged || ((yield* store.fileHash(id)) !== fileBefore && changes.length === 0);
          if (fileChanged) return yield* Effect.fail(new ReviewedFileChanged({ fileLabel, changes: [...changes, { kind: "content_changed", path: fileLabel }] }));
          if (reviewProjectGuarded && changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "review", fileLabel, changes }));
        });
        const attempt = () =>
          Effect.gen(function* () {
            const reply = yield* Effect.result((yield* Ref.get(thread.session)).review(text, subject.reviewSchema));
            yield* check;
            const accepted = yield* Effect.fromResult(reply);
            yield* Ref.update(thread.inputs, (inputs) => [...inputs, accepted.inputTokens]);
            return accepted;
          });
        return yield* withTransportRetry("codex", REVIEW_PURPOSE, transportReviewWhat(heading, prompts.passNoun(subject.id)), attempt, check);
      });

    /**
     * The thread of a round's review (issue #165, requirements Q1): round 1 is the loop's first thread; a later round
     * starts a new thread when a Codex turn of the round before it passed the limit, said on the page and written to
     * conversation.md, asking nothing. The inputs counted start afresh with every round.
     */
    const roundThread = (part: PartThread, round: number) =>
      Effect.gen(function* () {
        const inputs = yield* Ref.getAndSet(part.inputs, []);
        if (round === 1) return "new" satisfies ReviewThread;
        const thread = threadAfter(inputs, config.codexTurnInputLimit);
        if (thread === "new") {
          yield* Ref.set(part.session, yield* reviewer.startPhase);
          const line = prompts.threadRestartLine(heading, round, largestInput(inputs) ?? 0, config.codexTurnInputLimit, single ? null : part.part);
          yield* ui.say(line);
          yield* store.converse(line);
        }
        return thread;
      });

    /** Every reply of a round as it arrived, written to the round's file before it is decoded or validated (issue #151). */
    const rawSave = (round: number, kind: RawReplyKind): OnReply => (raw) => store.saveRawReply(id, round, kind, raw);
    /**
     * The round's validation of a response in the state it answers (issue #151): `after` appends it to the subject's own
     * validation, so that it sees the value the loop records and shares the call's one validation repair turn; `of` gives
     * the validated round of the accepted reply, which that validation has already accepted.
     */
    const roundOf = (state: ReviewState) => {
      const check = roundCheckOf(state);
      const roundCheck = roundValidation<R>(check, state.current.review!.issues.map((i) => i.id));
      // Issue #232: after the round's validation, the corrections accepted earlier in the loop, judged against the
      // validated dispositions, whose reverses validateRound normalized; a round that fails is the round's failure.
      const validation = bothValidations(roundCheck, subject.keepsCorrections === null ? null : keptCheckOf(subject.keepsCorrections, state, check, roundCheck));
      return {
        after: (first: Validation<R> | null): Validation<R> => (first === null ? validation : bothValidations(first, validation)),
        of: (response: PlannerResponse) => Effect.fromResult(check(response)),
      };
    };

    /**
     * Issue #243: a question opened beside the review: the limit, idle and unchanged questions in this loop's scope with
     * Help me decide (they live only while their loop runs, when no agent writes to the project); a dispute in the run's
     * registry and scope, without the offer, since its question may outlive the loop.
     */
    const openBesideQuestion = (beside: Beside, state: ReviewState): Effect.Effect<void, RunError, Services> =>
      Effect.gen(function* () {
        const q = beside.question;
        const loopScoped = (hint: string, draft: QuestionDraft, acceptable: (a: string) => boolean) =>
          Effect.gen(function* () {
            const onAccepted = (text: string) =>
              Ref.modify(loopAnswers, (l): readonly [Taken, LoopAnswers] => (l.accepting ? ["kept", { ...l, answers: new Map(l.answers).set(beside.key, text) }] : ["refused", l]));
            const handle = yield* openBeside(loopScope, hint, draft, acceptable, { offer: true, onAccepted });
            yield* Ref.update(besides, (m) => new Map(m).set(beside.key, handle));
          });
        switch (q.kind) {
          case "limit": {
            const { proceed } = state.setup;
            const origin: QuestionOrigin = { kind: "limit", heading, pass, limit: q.limit };
            const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.limitQuestion(heading, q.limit)), options: limitOptions(proceed), explain: prompts.limitFacts(heading, q.limit, state.counts, pass), decision: within };
            return yield* loopScoped(proceed === null ? prompts.limitNoProceedPrompt : prompts.limitPrompt, draft, () => true);
          }
          case "idle":
            return yield* loopScoped(prompts.decisionPrompt, decisionDraft(heading, { kind: "pause", facts: q.facts }, [], within, pass), () => true);
          case "unchanged": {
            const origin: QuestionOrigin = { kind: "unchanged", heading, pass, fileLabel, accepted: q.accepted };
            const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.unchangedQuestion(heading, fileLabel)), options: unchangedOptions(q.retry === "interview", pass), explain: prompts.unchangedFacts(heading, fileLabel, q.accepted, pass), decision: within };
            return yield* loopScoped(prompts.unchangedPrompt, draft, (a) => parseUnchangedAnswer(a) !== null);
          }
          case "dispute": {
            const d = q.dispute;
            const dispute: OpenDispute = {
              key: beside.key,
              heading,
              subject: id,
              phase,
              round: q.round,
              id: d.id,
              recordSubject: subjectOf(heading, d.asks),
              reviewer: d.options.find((o) => o.label === prompts.REVIEWER_POSITION)?.description ?? "",
              planner: d.options.find((o) => o.label === prompts.PLANNER_POSITION)?.description ?? "",
              options: d.options,
              owner: within === null ? { _tag: "Run" } : { _tag: "Decision", decision: within },
            };
            yield* openQuestions.opened(dispute);
            yield* Ref.update(disputeKeys, (keys) => [...keys, beside.key]);
            // W1-R1-1: the registry decides in one step between this answer and a withdrawal; one it refuses is not taken.
            const onAccepted = (text: string) => openQuestions.answered(beside.key, text);
            // W7-R1-1: the producer is attached as it is forked, so a withdrawal while it is presented interrupts it.
            const onForked = (fiber: Fiber.Fiber<string, UserStopped | RunError>) => openQuestions.attach(beside.key, fiber);
            yield* openBeside(openQuestions.scope, prompts.decisionPrompt, decisionDraft(heading, d.asks, d.options, within, pass), () => true, { offer: false, resolve: decisionAnswerOf, onAccepted, onForked });
            return;
          }
        }
      });

    type Outcome = ReviewEvent | { finished: LoopResult };
    /** Executes one command; the commands that yield an event return it. */
    const execute = (command: ReviewCommand, state: ReviewState): Effect.Effect<Outcome | null, RunError, Services> =>
      Effect.gen(function* () {
        switch (command.kind) {
          case "Say":
            // S21: a decision's loop says the analysis's progress instead of its cycles.
            if (command.status !== true || within === null) yield* ui.say(command.text);
            return null;
          case "Notify":
            yield* ui.notify(command.event);
            if (within !== null && command.event._tag === "RoundBegan") yield* analysisProgress(within, subject.question ?? null, command.event.round);
            return null;
          case "Converse":
            yield* store.converse(command.markdown);
            return null;
          case "RecordDecision":
            yield* store.appendDecision(command.decision);
            return null;
          case "RecordFeedback":
            yield* store.recordFeedback(id, command.round, command.text);
            return null;
          case "SaveReview":
            yield* store.saveReview(id, command.round, command.review);
            return null;
          case "SaveResponse":
            yield* store.saveResponse(id, command.round, command.response);
            if (subject.respond.after !== null) yield* subject.respond.after(command.response as R);
            yield* publishDocument;
            return null;
          case "SaveLog":
            yield* store.saveLog(id, command.log);
            return null;
          case "SaveRound":
            yield* store.saveRound(id, command.record);
            return null;
          case "Checkpoint":
            yield* store.checkpoint(command.point);
            return null;
          case "Halt":
            return yield* Effect.fail(command.error);
          case "Finish":
            return { finished: command.result };
          case "AskDecision":
            // Issue #243: Claude Code's own questions are the one ask of a loop that still waits.
            return { kind: "DecisionGiven", text: yield* askDecisionQuestion(decisionDraft(heading, command.asks, command.options, within, pass)) };
          case "OpenBeside":
            yield* openBesideQuestion(command.beside, state);
            return null;
          case "CloseBeside": {
            const handle = (yield* Ref.get(besides)).get(command.key);
            yield* Ref.update(besides, (m) => new Map([...m].filter(([k]) => k !== command.key)));
            if (handle !== undefined) yield* Fiber.interrupt(handle.fiber);
            return null;
          }
          case "AcknowledgeDisputes":
            yield* openQuestions.acknowledge(command.keys);
            return null;
          case "AwaitBoundary": {
            // The answers taken so far, each stored in the Ui's own take, so none is missed; nothing is waited for. At the
            // loop's final boundary the read closes acceptance in the same step (W2-R2-1): a later answer is refused.
            const finishing = state.step.name === "finishingAtBoundary";
            const read = yield* Ref.modify(loopAnswers, (l): readonly [ReadonlyMap<BesideKey, string>, LoopAnswers] => [l.answers, { accepting: l.accepting && !finishing, answers: new Map() }]);
            const answers: { key: string; text: string }[] = [...read].map(([key, text]) => ({ key, text }));
            yield* Ref.update(besides, (m) => new Map([...m].filter(([k]) => !read.has(k as BesideKey))));
            for (const a of yield* openQuestions.peek(yield* Ref.get(disputeKeys))) answers.push({ key: a.dispute.key, text: a.text });
            return { kind: "BoundaryReached", answers };
          }
          case "CallReviewer": {
            const threads: ReviewThread[] = [];
            for (const part of parts) threads.push(yield* roundThread(part, command.round));
            // Before the turn's guard takes its snapshot, so that it is not counted as a change during the turn.
            if (subject.prepare !== null) yield* subject.prepare;
            yield* publishDocument;
            // Issue #252: every part at once, each in its own thread with its own guard and transport retry; a failure of
            // one interrupts the others.
            const replies = yield* Effect.forEach(
              parts,
              (part, i) =>
                Effect.gen(function* () {
                  // Issue #208: the previous response's unexplained change, which this review examines, follows the prompt.
                  const base = part.prompt(store.root, command.round, threads[i]!);
                  const prompt = command.unexplained === null ? base : `${base}\n\n${prompts.unexplainedChangeReviewNote(command.unexplained)}`;
                  const call = (text: string) => reviewCall(part, text).pipe(Effect.map((reply) => reply.text));
                  // Issue #151: the review's validation with its repair turn in the part's thread, every reply saved first.
                  const { value } = yield* decodeValidating("codex", reviewText, yield* call(prompt), (r) => call(r.prompt), reviewValidation, rawSave(command.round, single ? "review" : { reviewPart: part.key }));
                  return { part, call, review: value };
                }),
              { concurrency: "unbounded" },
            );
            // Issue #252: a new id an earlier part of the cycle raised gets one collision repair turn in its part's thread.
            const logIds = new Set(state.current.startLog.map((e) => e.id as string));
            const used = new Set<string>();
            const merged: { key: string; review: (typeof replies)[number]["review"] }[] = [];
            for (const { part, call, review } of replies) {
              const collides = review.issues.some((i) => !logIds.has(i.id) && used.has(i.id));
              const repaired = collides
                ? (yield* decodeValidating("codex", reviewText, JSON.stringify(review), (r) => call(r.prompt), bothChecks(reviewValidation, partCollisionValidation(new Set(used), prompts.idForm(`${idPrefixOf(id)}${idNumber}`, command.round, part.part))), rawSave(command.round, { reviewPart: part.key }))).value
                : review;
              for (const i of repaired.issues) if (!logIds.has(i.id)) used.add(i.id);
              merged.push({ key: part.key, review: repaired });
            }
            const review = mergePartReviews(logIds, merged);
            return { kind: "ReviewDecoded", review, validated: yield* Effect.fromResult(validateReview(review)) };
          }
          case "CallPlanner": {
            // A read-only response cannot read the records, so they are in its prompt (decision Q1 of the stage-A task).
            // Issue #122 (G-R1-1): with requirements.md and user-decisions.md, read every round, since a decision taken at
            // a pause of the work review is appended between rounds.
            const records =
              typeof id === "object" && "work" in id && subject.respond.capability === "readOnly"
                ? { changes: yield* store.readChangeRecord(id.work), requirements: (yield* store.readContext()).requirements, decisions: yield* store.readUserDecisions() }
                : null;
            const context: RespondContext = { review: state.current.review!, log: state.log, records };
            const round = roundOf(state);
            // Issue #38: a round whose review raised a disputed point again asks first for a resolution of both concerns.
            const respondPrompt = subject.respond.prompt(store.root, command.round, context);
            const call = yield* planningCall(command.investigating.length === 0 ? respondPrompt : `${respondPrompt}\n\n${prompts.investigationNote(command.investigating)}`, subject.respond.schema, "planning", subject.respond.capability, round.after(yield* resolveValidation(subject.respond.validate)), rawSave(command.round, "response"));
            return { kind: "ResponseDecoded", response: call.output, round: yield* round.of(call.output), resultText: call.resultText, costUsd: call.costUsd };
          }
          case "CallCorrective": {
            // Issue #30: the corrective turn, a Repair of its own in the same session, validated against the reply it
            // corrects and then by the subject's own validation; its raw reply is kept, and its output written.
            const previous = state.current.response!;
            const acceptedIds = state.current.round!.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
            const round = roundOf(state);
            const validate = round.after(bothValidations(correctiveValidation<R>(previous, acceptedIds), yield* resolveValidation(subject.respond.validate)));
            const repair: Repair = { kind: "corrective", prompt: correctivePrompt(store.root, fileLabel, command.round, acceptedIds) };
            const call = yield* repairTurn(repair, subject.respond.schema, subject.respond.capability, validate, rawSave(command.round, { corrective: command.attempt }));
            yield* store.saveCorrection(id, command.round, command.attempt, call.reply);
            if (subject.respond.after !== null) yield* subject.respond.after(call.output);
            yield* publishDocument;
            return { kind: "CorrectionDecoded", response: call.output, round: yield* round.of(call.output), resultText: call.resultText, costUsd: call.costUsd };
          }
          case "CallInvestigation": {
            // Issue #38: the investigation turn, built as the corrective turn is: validated against the reply it follows,
            // then by the subject's own validation and the round's, its raw reply kept and its output written.
            const previous = state.current.response!;
            const round = roundOf(state);
            const validate = round.after(bothValidations(investigationValidation<R>(previous, command.ids), yield* resolveValidation(subject.respond.validate)));
            const repair: Repair = { kind: "investigation", prompt: prompts.investigationPrompt(store.root, fileLabel, command.round, command.ids) };
            const call = yield* repairTurn(repair, subject.respond.schema, subject.respond.capability, validate, rawSave(command.round, { investigation: command.attempt }));
            yield* store.saveInvestigation(id, command.round, command.attempt, call.reply);
            if (subject.respond.after !== null) yield* subject.respond.after(call.output);
            yield* publishDocument;
            return { kind: "InvestigationDecoded", response: call.output, round: yield* round.of(call.output), resultText: call.resultText, costUsd: call.costUsd };
          }
          case "ApplyDecisions":
            yield* applyDecisions(subject as Subject<PlannerResponse, D>);
            yield* publishDocument;
            return { kind: "DecisionsApplied" };
          case "Amend":
            if (subject.amend !== null) yield* subject.amend(state.current.review!, state.current.response as R, command.round);
            yield* publishDocument;
            return { kind: "Amended" };
          case "ObserveFile":
            return { kind: "FileObserved", ...(yield* store.observeFile(id)) };
        }
      });

    const interpret = (transition: Transition): Effect.Effect<LoopEnd, RunError, Services> =>
      Effect.gen(function* () {
        for (const command of transition.commands) {
          const outcome = yield* execute(command, transition.state);
          if (outcome === null) continue;
          if ("finished" in outcome) return { result: outcome.finished, round: transition.state.round };
          const next = advance(transition.state, outcome);
          // P3-R1-1: a final boundary whose answers resume the loop reopens acceptance for the rounds that follow.
          if (transition.state.step.name === "finishingAtBoundary" && !next.commands.some((c) => c.kind === "Finish" || c.kind === "Halt"))
            yield* Ref.update(loopAnswers, (l) => ({ ...l, accepting: true }));
          return yield* interpret(next);
        }
        return yield* Effect.die(new Error("the review loop ended a batch without an event"));
      });

    const setup: ReviewSetup = { subject: id, heading, fileLabel, dirName: subjectDir(id), phase, idNumber, proceed: subject.proceed, hasAmend: subject.amend !== null, onAcceptance: subject.onAcceptance, leaveOnDecision: subject.leaveOnDecision, onUnchanged: subject.onUnchanged, disputesSettledBy: subject.disputesSettledBy, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor };
    const begun = yield* store.observeFile(id);
    return yield* interpret(advance(initialState(setup, config, continueFrom), { kind: "Begin", hash: begun.hash, text: begun.text, log: yield* store.loadLog(id) })).pipe(
      // W2-R2-1: however the loop ends, no answer is accepted once it has, before its scope cancels its questions.
      Effect.ensuring(Ref.update(loopAnswers, (l) => ({ ...l, accepting: false }))),
    );
  }));
