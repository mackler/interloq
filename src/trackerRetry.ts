// The tracker retry of issue #171: a tracker request that reached no answer, or that the tracker answered with a server
// error, is repeated with backoff; when the repeats run out the developer is asked. This part is pure: the run's
// writes as data, the waits, which failures are repeated, and whether the item already holds a write's outcome.

import { Clock, Data, Duration, Effect, Option, Ref, Result } from "effect";
import type { HeldState, RunError, TrackerUnreachable, WriteCheck } from "./errors.ts";
import { parseTransportAnswer } from "./input.ts";
import { askOffering, askUnoffered, programContext, type QuestionDraft, trackerOptions } from "./offer.ts";
import { plainPieces } from "./pieces.ts";
import * as prompts from "./prompts.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import { type Refinement, readRefinement } from "./refinement.ts";
import { backoffDelays } from "./retry.ts";
import type { Config } from "./schema.ts";
import { type Decider, RunConfig, Store, type TrackerError, type TrackerShape, Ui, type UiShape } from "./services.ts";
import { keyOf } from "./itemComments.ts";
import type { ItemComment, ItemId, ItemState, TrackerItem } from "./tracker.ts";

/** A write of a run to its item: the requirements written back, or the item's state set. */
export type TrackerWrite =
  | Readonly<{ kind: "writeRefinement"; item: ItemId; refinement: Refinement }>
  | Readonly<{ kind: "setState"; item: ItemId; state: ItemState }>
  /** Issue #186: a comment Interloq writes, its `key` the unique key its marker line carries (src/itemComments.ts). */
  | Readonly<{ kind: "comment"; item: ItemId; text: string; key: string }>;

/** A request of a run to its tracker: the first read of its item, the read of its comments (issue #186), or one of its writes. */
export type TrackerOperation = Readonly<{ kind: "read"; item: ItemId }> | Readonly<{ kind: "comments"; item: ItemId }> | TrackerWrite;

export type TrackerRetrySettings = Pick<Config, "maxTrackerRetries" | "trackerRetryDelaySeconds">;

/** The waits before repeat 1, 2, …, maxTrackerRetries in seconds (requirements Q1: 15, 30, 60, 120, 240 by default). */
export const trackerRetryDelays = (settings: TrackerRetrySettings): readonly number[] => backoffDelays(settings.maxTrackerRetries, settings.trackerRetryDelaySeconds);

/** Whether a failure is repeated: a request that reached no answer, or a server error (behavior 14's principle). */
export const retryable = (error: TrackerError): error is TrackerUnreachable => error._tag === "TrackerUnreachable";

/**
 * Whether a failed write may have been applied: the tracker answered it with a server error (the `iou-notes` case of
 * 14 Oct 2026: `PUT 98` answered 500 and GitLab had applied it), so the item is read back (requirements Q2). A request
 * that reached no answer is repeated directly, which every operation's idempotency makes safe.
 */
export const uncertainWrite = (error: TrackerError): boolean => error._tag === "TrackerUnreachable" && error.status !== null;

/** HeldState and WriteCheck are declared with their schemas in src/errors.ts, where TrackerStepFailed decodes them. */
export type { HeldState, WriteCheck } from "./errors.ts";

/**
 * Issue #186: whether a comment is on the item, decided by its key alone (`keyOf`), never by comparing bodies, so two
 * send-backs with one reason on one day are two comments.
 */
export const commentLanded = (key: string, comments: readonly ItemComment[]): Result.Result<void, HeldState> =>
  comments.some((c) => keyOf(c.body) === key) ? Result.succeed(undefined) : Result.fail({ kind: "noComment" });

/** Success when the item already holds the write's outcome; otherwise what it held. A malformed section is another section. */
export const landed = (write: Exclude<TrackerWrite, { kind: "comment" }>, item: TrackerItem): Result.Result<void, HeldState> => {
  switch (write.kind) {
    case "writeRefinement": {
      const section = readRefinement(item.body);
      if (Result.isFailure(section)) return Result.fail({ kind: "otherSection" });
      if (Option.isNone(section.success)) return Result.fail({ kind: "noSection" });
      return section.success.value === write.refinement ? Result.succeed(undefined) : Result.fail({ kind: "otherSection" });
    }
    case "setState":
      return item.state === write.state ? Result.succeed(undefined) : Result.fail({ kind: "state", state: item.state });
  }
};

// ---- the retry (S9) -------------------------------------------------------------------------------------------------

/** A write of a run that failed: the tracker's failure and what the item held after the last attempt (requirements Q2). */
export class TrackerWriteFailed extends Data.TaggedError("TrackerWriteFailed")<{ readonly error: TrackerError; readonly check: WriteCheck }> {}

/**
 * What the retry needs around it, as a value rather than services, because the run's first read of its item happens
 * before the run's records and services exist (requirements Q3): the Ui, the settings, where its lines are recorded
 * (markdown as conversation.md takes it), and how its exhaustion question is asked.
 */
export type TrackerRetryEnv = Readonly<{
  ui: UiShape;
  settings: TrackerRetrySettings;
  record: (markdown: string) => Effect.Effect<void, RunError>;
  ask: (draft: QuestionDraft) => Effect.Effect<string, RunError>;
}>;

/** One attempt's success: its value, and the tracker whose read-back found a write applied after a server error, or null. */
type Attempted<A> = Readonly<{ value: A; landed: string | null }>;
/** One attempt's failure: the tracker's, and what the item held after it (a read's is never shown). */
type AttemptFailed = Readonly<{ _tag: "AttemptFailed"; error: TrackerError; check: WriteCheck }>;
const attemptFailed = (error: TrackerError, check: WriteCheck): AttemptFailed => ({ _tag: "AttemptFailed", error, check });
const UNCHECKED: WriteCheck = { kind: "unchecked" };

/**
 * Runs `attempt` until it succeeds, repeating it after a retryable failure with the waits of `trackerRetryDelays`: each
 * wait notified (TrackerRetrying, with its start and end read from the Clock), said and recorded, and slept on the Clock,
 * interruptibly, so Stop task ends the run with 130. A permanent failure fails at once. When the waits are used up the
 * developer is asked through `env.ask`: Retry again starts a full new set of waits, Stop fails with the last failure.
 * A success after a failure, or a write the read-back found applied (`landed`), is notified as TrackerRecovered.
 */
const retrying = <A>(env: TrackerRetryEnv, what: string, attempt: Effect.Effect<Attempted<A>, AttemptFailed | RunError>): Effect.Effect<A, AttemptFailed | RunError> => {
  const delays = trackerRetryDelays(env.settings);
  const say = (text: string) => env.ui.say(text).pipe(Effect.andThen(env.record(`${text}\n\n`)));
  /** Attempt `n` of the current set (from 1), `total` attempts made before it, and the tracker of an earlier failure. */
  const step = (n: number, total: number, faulted: string | null): Effect.Effect<A, AttemptFailed | RunError> =>
    Effect.gen(function* () {
      const result = yield* Effect.result(attempt);
      if (Result.isSuccess(result)) {
        const recovered = result.success.landed ?? faulted;
        if (recovered !== null) yield* env.ui.notify({ _tag: "TrackerRecovered", tracker: recovered });
        return result.success.value;
      }
      const failed = result.failure;
      if (failed._tag !== "AttemptFailed" || !retryable(failed.error)) return yield* Effect.fail(failed);
      const error = failed.error;
      const delay = delays[n - 1];
      if (delay !== undefined) {
        const fromMs = yield* Clock.currentTimeMillis;
        const untilMs = fromMs + delay * 1000;
        yield* env.ui.notify({ _tag: "TrackerRetrying", tracker: error.tracker, what, attempt: n, of: delays.length, delaySeconds: delay, fault: error.message, fromMs, untilMs });
        yield* say(prompts.trackerRetryLine(error.tracker, what, n, delays.length, delay, error.message));
        yield* Effect.sleep(Duration.millis(Math.max(untilMs - (yield* Clock.currentTimeMillis), 0)));
        return yield* step(n + 1, total + 1, error.tracker);
      }
      const attempts = total + 1;
      const origin: QuestionOrigin = { kind: "tracker", tracker: error.tracker, what, attempts, fault: error.message };
      const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.trackerExhaustedQuestion(error.tracker, what)), options: trackerOptions(), attached: attachedOf("fault", prompts.transportDetails(attempts, error.message)), decision: null };
      const choice = parseTransportAnswer(yield* env.ask(draft)) ?? "stop";
      yield* env.record(prompts.trackerDecisionLine(choice, error.tracker, what));
      if (choice === "stop") return yield* Effect.fail(failed);
      return yield* step(1, attempts, error.tracker);
    });
  return step(1, 0, null);
};

/** A read of the run's, repeated; fails with the last tracker failure. */
const readRetried = <A>(env: TrackerRetryEnv, op: TrackerOperation, read: Effect.Effect<A, TrackerError>): Effect.Effect<A, TrackerError | RunError> =>
  retrying(
    env,
    prompts.trackerOperationText(op),
    read.pipe(
      Effect.map((value) => ({ value, landed: null })),
      Effect.mapError((error) => attemptFailed(error, UNCHECKED)),
    ),
  ).pipe(Effect.mapError((e) => (e._tag === "AttemptFailed" ? e.error : e)));

/** The run's first read of its item, repeated (requirements Q3); fails with the last tracker failure. */
export const readWithRetry = (tracker: TrackerShape, item: ItemId, env: TrackerRetryEnv): Effect.Effect<TrackerItem, TrackerError | RunError> =>
  readRetried(env, { kind: "read", item }, tracker.read(item));

/** Issue #186: the item's comments, repeated as the first read is. */
export const readCommentsWithRetry = (tracker: TrackerShape, item: ItemId, env: TrackerRetryEnv): Effect.Effect<readonly ItemComment[], TrackerError | RunError> =>
  readRetried(env, { kind: "comments", item }, tracker.comments(item));

const sent = (tracker: TrackerShape, write: Exclude<TrackerWrite, { kind: "comment" }>): Effect.Effect<void, TrackerError> =>
  write.kind === "writeRefinement" ? tracker.writeRefinement(write.item, write.refinement) : tracker.setState(write.item, write.state);

/**
 * One attempt at a write. A server error is followed by a read of the item (requirements Q2): where the item already
 * holds the write's outcome, the write counts as done, said and recorded; otherwise the failure carries what the item
 * held, and a read-back that fails leaves the item unchecked.
 */
const writeAttempt = (tracker: TrackerShape, write: Exclude<TrackerWrite, { kind: "comment" }>, env: TrackerRetryEnv): Effect.Effect<Attempted<void>, AttemptFailed | RunError> =>
  Effect.catch(
    Effect.map(sent(tracker, write), (): Attempted<void> => ({ value: undefined, landed: null })),
    (error): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
      if (!uncertainWrite(error) || error._tag !== "TrackerUnreachable") return Effect.fail(attemptFailed(error, UNCHECKED));
      return Effect.flatMap(Effect.result(tracker.read(write.item)), (read): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
        if (Result.isFailure(read)) return Effect.fail(attemptFailed(error, UNCHECKED));
        const outcome = landed(write, read.success);
        if (Result.isFailure(outcome)) return Effect.fail(attemptFailed(error, { kind: "held", held: outcome.failure }));
        const line = prompts.trackerWriteLandedLine(error.tracker, prompts.trackerOperationText(write));
        return env.ui.say(line).pipe(Effect.andThen(env.record(`${line}\n\n`)), Effect.as({ value: undefined, landed: error.tracker }));
      });
    },
  );

/**
 * Issue #186 (review P1-R1-1): where a comment write is. A POST is not idempotent, so after any retryable failure of
 * one, which may have been applied, the write is `reconciling` until a listing of the item's comments settles it.
 */
type CommentPhase = "posting" | "reconciling";

/**
 * One attempt at a comment write, by its phase. Posting: a POST, and after a retryable failure a listing at once. A
 * listing that finds the key ends the write done; one without it returns to posting (the POST in the same attempt when
 * the attempt began reconciling, after the backoff otherwise); a listing that fails stays reconciling, so the write lists
 * again and never POSTs until a successful listing has shown the key absent. Retry again resumes in the phase it was in.
 */
const commentAttempt = (tracker: TrackerShape, write: Extract<TrackerWrite, { kind: "comment" }>, env: TrackerRetryEnv, phase: Ref.Ref<CommentPhase>): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
  const done: Attempted<void> = { value: undefined, landed: null };
  /** The listing after `error`, the failure that sent the write to reconciling, or null when the attempt began there. */
  const reconcile = (error: TrackerUnreachable | null): Effect.Effect<Attempted<void>, AttemptFailed | RunError> =>
    Effect.flatMap(Effect.result(tracker.comments(write.item)), (listed): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
      if (Result.isFailure(listed)) return Effect.andThen(Ref.set(phase, "reconciling"), Effect.fail(attemptFailed(error ?? listed.failure, UNCHECKED)));
      const outcome = commentLanded(write.key, listed.success);
      if (Result.isFailure(outcome)) return Effect.andThen(Ref.set(phase, "posting"), error === null ? post : Effect.fail(attemptFailed(error, { kind: "held", held: outcome.failure })));
      if (error === null) return Effect.succeed(done);
      const line = prompts.trackerWriteLandedLine(error.tracker, prompts.trackerOperationText(write));
      return env.ui.say(line).pipe(Effect.andThen(env.record(`${line}\n\n`)), Effect.as({ value: undefined, landed: error.tracker }));
    });
  const post: Effect.Effect<Attempted<void>, AttemptFailed | RunError> = Effect.catch(
    Effect.as(tracker.comment(write.item, write.text), done),
    (error): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => (error._tag === "TrackerUnreachable" ? reconcile(error) : Effect.fail(attemptFailed(error, UNCHECKED))),
  );
  return Effect.flatMap(Ref.get(phase), (p) => (p === "posting" ? post : reconcile(null)));
};

/** A write of the run to its item, repeated; fails with the last failure and the item as the last attempt left it. */
export const writeWithRetry = (tracker: TrackerShape, write: TrackerWrite, env: TrackerRetryEnv): Effect.Effect<void, TrackerWriteFailed | RunError> =>
  Effect.flatMap(Ref.make<CommentPhase>("posting"), (phase) => retrying(env, prompts.trackerOperationText(write), write.kind === "comment" ? commentAttempt(tracker, write, env, phase) : writeAttempt(tracker, write, env))).pipe(
    Effect.mapError((e) => (e._tag === "AttemptFailed" ? new TrackerWriteFailed({ error: e.error, check: e.check }) : e)),
  );

/** The environment of a run's tracker requests after its records exist: conversation.md, and the question with the offer of decision support. */
export const runTrackerEnv: Effect.Effect<TrackerRetryEnv, never, Ui | Store | RunConfig | Decider> = Effect.gen(function* () {
  const context = yield* Effect.context<Ui | Store | RunConfig | Decider>();
  const ui = yield* Ui;
  const store = yield* Store;
  const settings = yield* RunConfig;
  return {
    ui,
    settings,
    record: (markdown) => store.converse(markdown),
    ask: (draft) => askOffering((p) => ui.ask(p), prompts.transportPrompt, draft, acceptable).pipe(Effect.provideContext(context)),
  };
});

/**
 * The environment of the run's first read (requirements Q3, the developer's decision of 15 Oct 2026): its lines and its
 * question are held in `held` until conversation.md exists, and the question carries no offer of decision support.
 */
export const heldTrackerEnv = (ui: UiShape, settings: TrackerRetrySettings, held: Ref.Ref<readonly string[]>): TrackerRetryEnv => {
  const record = (markdown: string) => Ref.update(held, (rs) => [...rs, markdown]);
  return { ui, settings, record, ask: (draft) => askUnoffered((p) => ui.ask(p), ui, record, prompts.transportPrompt, draft, acceptable) };
};

const acceptable = (answer: string): boolean => parseTransportAnswer(answer) !== null;
