// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import { Effect, Ref, Result, Schema } from "effect";
import { type SubjectId, subjectDir } from "./artifacts.ts";
import { AgentReplyInvalid, ProjectChanged, RecordsChanged, ReviewedFileChanged, type RunError } from "./errors.ts";
import type { LoopResult } from "./uiEvents.ts";
import { pauseOriginOf, type Question, type QuestionOrigin, validateQuestions } from "./question.ts";
import { piecesText, plainPieces } from "./pieces.ts";
import { pauseProse } from "./render.ts";
import * as prompts from "./prompts.ts";
import { questionRepairPrompt, correctivePrompt, transportReviewWhat, transportWhat, repairReplyPrompt, type RespondContext } from "./prompts.ts";
import { correctiveValidation } from "./round.ts";
import { agentContext, askOffering, limitOptions, numberedOptions, programContext, type QuestionDraft, unchangedOptions } from "./offer.ts";
import { answerOf, parseUnchangedAnswer } from "./input.ts";
import { advance, type Asks, initialState, type Option, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, type Transition } from "./reviewState.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, Review, UserQuestion } from "./schema.ts";
import { type Decider, Planner, type PlanningCapability, type PlanningPurpose, type PlanningResult, Reviewer, RunConfig, type Services, Store, type StoreError, Ui } from "./services.ts";
import { compareJournaled, compareSnapshots } from "./snapshot.ts";
import { withTransportRetry } from "./retry.ts";

/** Codex's reply text, decoded as JSON and then as a review; text that is not JSON is a decode failure. */
const ReviewText = Schema.fromJsonString(S.Review);

/** One planning call of a subject: its prompt, the schema of its output, and what is done with the output. */
export type Operation<T> = Readonly<{
  prompt: (round: number, context: RespondContext) => string;
  schema: Schema.Decoder<T>;
  /** Runs after every such call, for output that the program writes to the file; null when there is nothing to do. */
  after: ((output: T) => Effect.Effect<void, RunError, Store | Ui>) | null;
  /** What the call may do (finding 1 of docs/gui-review.md): "readOnly" for a work response, "records" otherwise. */
  capability: PlanningCapability;
  /** The validation beyond the schema, with its repair turn (issue #37); null when there is none. */
  validate: Validation<T> | null;
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
  reviewPrompt: (round: number) => string;
  /** Claude Code's response to a review. */
  respond: Operation<R>;
  /** The call that applies the user's decisions; its prompt does not depend on the round. */
  applyDecisions: Readonly<{ prompt: string; schema: Schema.Decoder<D>; after: ((output: D) => Effect.Effect<void, RunError, Store | Ui>) | null; validate: Validation<D> | null }>;
  /** After the response of a round, an amendment that requires the user (the requirements); null otherwise. */
  amend: ((review: Review, response: R, round: number) => Effect.Effect<void, RunError, Services>) | null;
  /** Text of the "p" choice at the round limit; null: no such choice (the work review, Q13). */
  proceed: string | null;
  /** Q14: a round with a correction due ends the loop with "revise" before the observation. */
  leaveOnAcceptance: boolean;
  /** G-R1-1: a non-empty decision at a pause ends the loop with "revise" instead of a planning call. */
  leaveOnDecision: boolean;
  /**
   * Issue #30: what follows a response that accepted an issue and left the reviewed file unchanged: a corrective turn,
   * the pause at once (the requirements, G-R1-1), or null where the condition cannot arise (the work review, Q7). A
   * subject with a value has its file's change measured in the issue log (issue #31).
   */
  onUnchanged: "corrective" | "pause" | null;
  /** A decision's subject: the number of the question its analysis is for (S21), which its progress names; absent otherwise. */
  question?: number | null;
  /** Run before every round's Codex turn, before its guard's snapshot (the work review rewrites changes.diff); null otherwise. */
  prepare: Effect.Effect<void, RunError, Services> | null;
}>;

/**
 * The question a decision of a review loop asks (S7): a pause of behaviour 7 with its fixed question and the
 * program's context, or Claude Code's question with its own; `decision` is k inside decision k (issue #57).
 */
export const decisionDraft = (heading: string, asks: Asks, options: readonly Option[], decision: number | null): QuestionDraft => {
  if (asks.kind === "planner") return plannerDraft(asks.question, heading, decision);
  const pause = pauseOriginOf(asks.facts);
  const origin: QuestionOrigin = { kind: "pause", heading, ...pause };
  // S12: Claude Code writes the context from the pause's facts, which the user reads beside it as prose (S11).
  return { origin, context: programContext(origin), explanations: [], question: plainPieces(prompts.pauseQuestion(pause)), options: numberedOptions(options), details: pauseProse(asks.facts), explain: "", decision };
};
/** A question Claude Code returned with a plan or a response (S7): its context, terms and options as it wrote them. */
export const plannerDraft = (question: UserQuestion, heading: string, decision: number | null): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "planner", heading };
  return { origin, context: agentContext(question.context, origin), explanations: question.explanations, question: question.question, options: numberedOptions(question.options), decision };
};

/** Asks one decision (S7): the question presented, the offer where it has options; an answer that is an option's number stands for that option. */
export const askDecisionQuestion = (draft: QuestionDraft): Effect.Effect<string, RunError, Ui | Store | Decider> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const answer = yield* askOffering((p) => ui.ask(p), prompts.decisionPrompt, draft);
    return answerOf(answer, draft.options);
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

/** The text kept for an invalid reply. Total: a reply that JSON cannot represent is kept as a note of that failure. */
export const serializeReply = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (e) {
    return `<reply not serializable: ${e instanceof Error ? e.message : String(e)}>`;
  }
};

/**
 * A second turn spent on a defective reply, in the same session or thread (decision S2 of issues #26, #30 and #31):
 * `schema` (behaviour 10), `validation` (issue #37) or `corrective` (issue #30, an accepted issue left the reviewed file
 * unchanged). Each kind has its own budget, and its prompt comes from src/prompts.ts. A dropped connection is not a
 * Repair: it repeats a call that produced no reply (src/retry.ts).
 */
export type Repair = Readonly<{ kind: "schema" | "validation" | "corrective"; prompt: string }>;

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

/**
 * The program's validation of a decoded reply beyond its schema (issue #37, decision Q1): the value to use with the notes
 * to record in conversation.md, or the error that ends the run and the prompt of the repair turn.
 */
export type Validation<T> = (output: T) => Result.Result<Readonly<{ value: T; notes: readonly string[] }>, Readonly<{ error: RunError; repair: string }>>;

/** The decoded output of a planning call, the free text and cost of the call that produced it, and whether a repair turn was needed. */
export type PlanningCall<Out> = Readonly<{ output: Out; reply: unknown; resultText: string; costUsd: number | null; repaired: boolean }>;

/**
 * A call in which Claude Code may write only under plan-review/ ("records"), or change nothing ("readOnly", a work
 * response; "readProject", the context call of a question, which may read the project). Halts if the project changed;
 * a call that may change nothing, its repair turn included, also halts if a guarded record under plan-review/ changed (RecordsChanged; the program's own writes are not guarded, src/artifacts.ts).
 */
export const planningCall = <Out extends Schema.Decoder<unknown>>(prompt: string, schema: Out, purpose: PlanningPurpose = "planning", capability: PlanningCapability = "records", validate: Validation<Out["Type"]> | null = null): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner | Decider | Ui | RunConfig> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const planner = yield* Planner;
    /**
     * One call, retried after a transport fault (issue #26). The baselines are taken once, before the first attempt, and
     * every attempt, failed ones included, and every retry is checked against them; the records guard of a read-only
     * call replays the program's own writes since then (the Store's journal).
     */
    const call = (text: string) =>
      Effect.gen(function* () {
        const before = yield* store.projectSnapshot();
        const recordsBefore = capability !== "records" ? yield* store.recordsSnapshot() : null;
        const mark = yield* store.journalMark;
        const check = Effect.gen(function* () {
          const changes = compareSnapshots(before, yield* store.projectSnapshot());
          if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes }));
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
        // S10: the context call of a question does not ask a question of its own when its retries are exhausted.
        return yield* withTransportRetry("claude", transportWhat(purpose), attempt, check, purpose === "context" ? "fail" : "ask");
      });
    const first = yield* call(prompt);
    const repairCall = yield* Ref.make<PlanningResult | null>(null);
    const repair = (r: Repair) => call(r.prompt).pipe(Effect.tap((result) => Ref.set(repairCall, result)), Effect.map((result) => result.output));
    const { value: output, notes } = yield* decodeValidating("claude", schema, first.output, repair, validate);
    for (const note of notes) yield* store.converse(note);
    const second = yield* Ref.get(repairCall);
    const used = second ?? first;
    return { output, reply: used.output, resultText: used.resultText, costUsd: used.costUsd, repaired: second !== null };
  });

/**
 * The corrective turn (issue #30) as a Repair of its own: a planning call in the current session whose reply has fresh
 * schema and validation budgets, so it takes neither's turn and neither takes its.
 */
export const repairTurn = <Out extends Schema.Decoder<unknown>>(repair: Repair, schema: Out, capability: PlanningCapability, validate: Validation<Out["Type"]> | null): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner | Decider | Ui | RunConfig> =>
  planningCall(repair.prompt, schema, "planning", capability, validate);

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

export const applyDecisions = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const call = yield* planningCall(subject.applyDecisions.prompt, subject.applyDecisions.schema, "planning", "records", subject.applyDecisions.validate);
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
/** How a review loop ended, and in which round. */
export type LoopEnd = Readonly<{ result: LoopResult; round: number }>;

export const reviewLoop = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<LoopEnd, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const reviewer = yield* Reviewer;
    const { id, heading, fileLabel } = subject;
    const phase = subject.phase;
    /** The decision this loop works out, whose questions belong to it (issue #57); null for the other subjects. */
    const within = typeof id === "object" && "decision" in id ? id.decision : null;
    // One thread per review loop (behaviour 5): the session is held by this loop, not by the adapter.
    const session = yield* reviewer.startPhase;

    // Codex runs without a sandbox, so the project and the reviewed file are compared after every turn,
    // including a repair turn.
    const reviewCall = (text: string) =>
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
          if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "review", fileLabel, changes }));
        });
        const attempt = () =>
          Effect.gen(function* () {
            const reply = yield* Effect.result(session.review(text));
            yield* check;
            return yield* Effect.fromResult(reply);
          });
        return yield* withTransportRetry("codex", transportReviewWhat(heading), attempt, check);
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
          case "AskLimit": {
            // The limit is a choice between options (decision Q6), so it carries the offer; the answer is passed on as typed.
            const { proceed } = state.setup;
            const origin: QuestionOrigin = { kind: "limit", heading, limit: command.limit };
            const draft: QuestionDraft = { origin, context: programContext(origin), explanations: [], question: plainPieces(prompts.limitQuestion(heading, command.limit)), options: limitOptions(proceed), explain: prompts.limitFacts(heading, command.limit, state.counts), decision: within };
            return { kind: "LimitAnswer", answer: yield* askOffering((p) => ui.ask(p), proceed === null ? prompts.limitNoProceedPrompt : prompts.limitPrompt, draft) };
          }
          case "AskUnchanged": {
            // Issue #30: Retry, Proceed or Stop, with the offer of decision support; an answer that is none of them is asked again.
            const origin: QuestionOrigin = { kind: "unchanged", heading, fileLabel, accepted: command.accepted };
            const draft: QuestionDraft = { origin, context: programContext(origin), explanations: [], question: plainPieces(prompts.unchangedQuestion(heading, fileLabel)), options: unchangedOptions(command.retry === "interview"), explain: prompts.unchangedFacts(heading, fileLabel, command.accepted), decision: within };
            const answer = yield* askOffering((p) => ui.ask(p), prompts.unchangedPrompt, draft, (a) => parseUnchangedAnswer(a) !== null);
            return { kind: "UnchangedAnswer", answer: parseUnchangedAnswer(answer)! };
          }
          case "AskDecision":
            return { kind: "DecisionGiven", text: yield* askDecisionQuestion(decisionDraft(heading, command.asks, command.options, within)) };
          case "CallReviewer": {
            // Before the turn's guard takes its snapshot, so that it is not counted as a change during the turn.
            if (subject.prepare !== null) yield* subject.prepare;
            const review: Review = yield* decodeWithRepair("codex", ReviewText, yield* reviewCall(subject.reviewPrompt(command.round)), (r) => reviewCall(r.prompt));
            return { kind: "ReviewDecoded", review };
          }
          case "CallPlanner": {
            // A read-only response cannot read the records, so they are in its prompt (decision Q1 of the stage-A task).
            const changes = typeof id === "object" && "work" in id && subject.respond.capability === "readOnly" ? yield* store.readChangeRecord(id.work) : null;
            const context: RespondContext = { review: state.current.review!, log: state.log, changes };
            const call = yield* planningCall(subject.respond.prompt(command.round, context), subject.respond.schema, "planning", subject.respond.capability, subject.respond.validate);
            return { kind: "ResponseDecoded", response: call.output, resultText: call.resultText, costUsd: call.costUsd };
          }
          case "CallCorrective": {
            // Issue #30: the corrective turn, a Repair of its own in the same session, validated against the reply it
            // corrects and then by the subject's own validation; its raw reply is kept, and its output written.
            const previous = state.current.response!;
            const acceptedIds = state.current.round!.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
            const validate = bothValidations(correctiveValidation<R>(previous, acceptedIds), subject.respond.validate);
            const repair: Repair = { kind: "corrective", prompt: correctivePrompt(fileLabel, command.round, acceptedIds) };
            const call = yield* repairTurn(repair, subject.respond.schema, subject.respond.capability, validate);
            yield* store.saveCorrection(id, command.round, command.attempt, call.reply);
            if (subject.respond.after !== null) yield* subject.respond.after(call.output);
            return { kind: "CorrectionDecoded", response: call.output, resultText: call.resultText, costUsd: call.costUsd };
          }
          case "ApplyDecisions":
            yield* applyDecisions(subject as Subject<PlannerResponse, D>);
            return { kind: "DecisionsApplied" };
          case "Amend":
            if (subject.amend !== null) yield* subject.amend(state.current.review!, state.current.response as R, command.round);
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
          return yield* interpret(advance(transition.state, outcome));
        }
        return yield* Effect.die(new Error("the review loop ended a batch without an event"));
      });

    const setup: ReviewSetup = { subject: id, heading, fileLabel, dirName: subjectDir(id), phase, idNumber: typeof id === "object" && "decision" in id ? id.decision : phase, proceed: subject.proceed, hasAmend: subject.amend !== null, leaveOnAcceptance: subject.leaveOnAcceptance, leaveOnDecision: subject.leaveOnDecision, onUnchanged: subject.onUnchanged, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor };
    const begun = yield* store.observeFile(id);
    return yield* interpret(advance(initialState(setup, config), { kind: "Begin", hash: begun.hash, text: begun.text, log: yield* store.loadLog(id) }));
  });
