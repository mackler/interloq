// The tracker retry of issue #171: a tracker request that reached no answer, or that the tracker answered with a server
// error, is repeated with backoff; when the repeats run out the developer is asked. This part is pure: the run's
// writes as data, the waits, which failures are repeated, and whether the item already holds a write's outcome.

import { Clock, Data, Deferred, Effect, Fiber, Option, Ref, Result, type Scope } from "effect";
import type { HeldState, RunError, TrackerRateLimited, TrackerUnreachable, UserStopped, WriteCheck } from "./errors.ts";
import type { WaitId, Waits } from "./waits.ts";
import { parseTransportAnswer } from "./input.ts";
import { type BesideQuestion, CLOSED_SLOT, closeSlot, openBeside, type OpenBeside, openBesideUnoffered, openInSlot, programContext, type QuestionDraft, type SlotCell, slotQuestion, trackerOptions } from "./offer.ts";
import { USAGE_LIMIT_RETRY_SECONDS } from "./limitReset.ts";
import { rateLimitUntil } from "./trackerRateLimit.ts";
import type { UiEvent } from "./uiEvents.ts";
import { plainPieces } from "./pieces.ts";
import * as prompts from "./prompts.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import { type ItemText, type Refinement, readRefinement, withoutRefinement } from "./refinement.ts";
import { backoffDelays } from "./retry.ts";
import type { Config } from "./schema.ts";
import { type Decider, RunConfig, Store, type TrackerError, type TrackerShape, Ui, type UiShape } from "./services.ts";
import { keyOf } from "./itemComments.ts";
import type { CitedItem, CommentId, ItemComment, ItemId, ItemState, TrackerItem } from "./tracker.ts";

/** A write of a run to its item: the requirements written back, or the item's state set. */
export type TrackerWrite =
  | Readonly<{ kind: "writeRefinement"; item: ItemId; refinement: Refinement }>
  | Readonly<{ kind: "setState"; item: ItemId; state: ItemState }>
  /** Issue #186: a comment Interloq writes, its `key` the unique key its marker line carries (src/itemComments.ts). */
  | Readonly<{ kind: "comment"; item: ItemId; text: string; key: string }>
  /** Issue #131: the deletion of one of Interloq's own comments, idempotent, since a comment already gone counts as deleted. */
  | Readonly<{ kind: "deleteComment"; item: ItemId; comment: CommentId }>
  /** Issue #216: the developer's title and text brought up to date, written around the section in one request. */
  | Readonly<{ kind: "writeText"; item: ItemId; text: ItemText }>;

/** A request of a run to its tracker: the first read of its item, the read of its comments (issue #186), or one of its writes. */
export type TrackerOperation = Readonly<{ kind: "read"; item: ItemId }> | Readonly<{ kind: "comments"; item: ItemId }> | Readonly<{ kind: "readCited"; item: ItemId }> | TrackerWrite;

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

/** Issue #131: whether a deletion is done, decided by the comment's id: done exactly when no comment of the item has it. */
export const commentDeleted = (id: CommentId, comments: readonly ItemComment[]): Result.Result<void, HeldState> =>
  comments.some((c) => c.id === id) ? Result.fail({ kind: "commentPresent" }) : Result.succeed(undefined);

/** The writes whose outcome a read of the item shows. */
type ItemWrite = Extract<TrackerWrite, { kind: "writeRefinement" | "setState" | "writeText" }>;
/** The writes repeated as they are, read back after a server error: every write but a comment, which is reconciled by its key. */
type RepeatableWrite = Exclude<TrackerWrite, { kind: "comment" }>;

/** Success when the item already holds the write's outcome; otherwise what it held. A malformed section is another section. */
export const landed = (write: ItemWrite, item: TrackerItem): Result.Result<void, HeldState> => {
  switch (write.kind) {
    case "writeRefinement": {
      const section = readRefinement(item.body);
      if (Result.isFailure(section)) return Result.fail({ kind: "otherSection" });
      if (Option.isNone(section.success)) return Result.fail({ kind: "noSection" });
      return section.success.value === write.refinement ? Result.succeed(undefined) : Result.fail({ kind: "otherSection" });
    }
    case "setState":
      return item.state === write.state ? Result.succeed(undefined) : Result.fail({ kind: "state", state: item.state });
    case "writeText": {
      // A malformed section is another text: the write's body would have kept a well-formed one.
      const text = withoutRefinement(item.body);
      return item.title === write.text.title && Result.isSuccess(text) && text.success === write.text.text ? Result.succeed(undefined) : Result.fail({ kind: "otherText" });
    }
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
  /**
   * Issue #243: opens the exhaustion question beside the repeats, in `scope`; `onAccepted` is called in the Ui's take of
   * an answer the question accepts. The repeats go on with no limit while it is open.
   */
  openQuestion: (scope: Scope.Scope, draft: QuestionDraft, onAccepted: () => Effect.Effect<void>) => Effect.Effect<BesideQuestion, RunError>;
  /**
   * Issue #185 (G-R1-1): what the repeats do when they are used up: ask Retry again or Stop, or, after a run was
   * abandoned for want of an answer and the developer is away, stop with no question and no decision recorded.
   */
  exhausted: "ask" | "stop";
}>;

/** Issue #243: the question of an environment that never asks (its repeats stop when used up): never opened. */
export const noTrackerQuestion: TrackerRetryEnv["openQuestion"] = () => Effect.die(new Error("this tracker environment asks no question"));

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
const retrying = <A>(env: TrackerRetryEnv, what: string, attempt: Effect.Effect<Attempted<A>, AttemptFailed | RunError>): Effect.Effect<A, AttemptFailed | RunError> =>
  Effect.suspend(() => {
    const delays = trackerRetryDelays(env.settings);
    const say = (text: string) => env.ui.say(text).pipe(Effect.andThen(env.record(`${text}\n\n`)));
    /** Issue #243: the exhaustion question open beside the repeats, in a Scope of its own, and its answer's signal. */
    const cell: SlotCell = { slot: CLOSED_SLOT };
    const closeQuestion = closeSlot(cell);
    /** Fails at once when the question is answered "q" (its producer fails with UserStopped); otherwise never completes. */
    const quitWatch = (open: OpenBeside): Effect.Effect<never, UserStopped> =>
      Fiber.join(open.handle.fiber).pipe(Effect.matchEffect({ onFailure: (e) => (e._tag === "UserStopped" ? Effect.fail(e) : Effect.never), onSuccess: () => Effect.never }));
    /** The question's answer, read after every attempt and wait: Stop fails with the last failure, Retry again starts afresh. */
    const answeredNow = (tracker: string, last: AttemptFailed | null) =>
      Effect.gen(function* () {
        const question = slotQuestion(cell.slot);
        if (question === null) return "none" as const;
        const answer = yield* question.handle.answer;
        if (Option.isNone(answer)) return "none" as const;
        const choice = parseTransportAnswer(answer.value) ?? "stop";
        yield* env.record(prompts.trackerDecisionLine(choice, tracker, what));
        yield* closeQuestion;
        if (choice === "stop" && last !== null) return yield* Effect.fail(last);
        return choice;
      });
    /**
     * One wait the developer may end early (issue #215), in a Scope of its own: opened, announced by the event `event`
     * builds from its start and id, said and recorded, and slept until `untilMs`. Where the exhaustion question is open
     * beside the repeats (issue #243) its answer, or q, ends the wait too. An early end is notified and said.
     */
    const announcedWait = (event: (fromMs: number, wait: number) => UiEvent, line: string, untilMs: number, tracker: string): Effect.Effect<void, RunError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const fromMs = yield* Clock.currentTimeMillis;
          const handle = yield* env.ui.openWait;
          yield* env.ui.notify(event(fromMs, handle.id));
          yield* say(line);
          const waiting = slotQuestion(cell.slot);
          const ended = waiting === null ? yield* handle.sleepUntil(untilMs) : yield* Effect.raceFirst(Effect.raceFirst(handle.sleepUntil(untilMs), Effect.as(Deferred.await(waiting.answered), "ranOut" as const)), quitWatch(waiting));
          if (ended === "endedEarly") {
            yield* env.ui.notify({ _tag: "WaitEndedEarly", wait: handle.id });
            yield* say(prompts.waitEndedLine({ kind: "tracker", tracker, what }));
          }
        }),
      );
    /**
     * Attempt `n` of the current set (from 1), `total` attempts made before it, the tracker of an earlier failure, and
     * the last failure, which a Stop answered later fails with.
     */
    const step = (n: number, total: number, faulted: string | null, last: AttemptFailed | null): Effect.Effect<A, AttemptFailed | RunError> =>
      Effect.gen(function* () {
        const open = slotQuestion(cell.slot);
        const result = yield* Effect.result(open === null ? attempt : Effect.raceFirst(attempt, quitWatch(open)));
        // A Stop answered while the attempt ran is honored even where it succeeded: the developer chose to stop.
        const before = yield* answeredNow(faulted ?? "", last);
        if (Result.isSuccess(result)) {
          yield* closeQuestion;
          const recovered = result.success.landed ?? faulted;
          if (recovered !== null) yield* env.ui.notify({ _tag: "TrackerRecovered", tracker: recovered });
          return result.success.value;
        }
        const failed = result.failure;
        // Issue #219: a rate limit is waited out until its stated reset and the same attempt made again: it spends
        // none of the repeats, has no limit and opens no question.
        if (failed._tag === "AttemptFailed" && failed.error._tag === "TrackerRateLimited") {
          const limited = failed.error;
          const { untilMs, stated } = rateLimitUntil(limited.reset, yield* Clock.currentTimeMillis);
          yield* announcedWait(
            (fromMs, wait) => ({ _tag: "TrackerRateLimitWaiting", tracker: limited.tracker, what, stated, fromMs, untilMs, wait }),
            prompts.trackerRateLimitLine(limited.tracker, what, untilMs, stated),
            untilMs,
            limited.tracker,
          );
          const answered = before === "none" ? yield* answeredNow(limited.tracker, last) : before;
          if (answered === "retry") return yield* step(1, total, limited.tracker, last);
          return yield* step(n, total, limited.tracker, last);
        }
        if (failed._tag !== "AttemptFailed" || !retryable(failed.error)) return yield* Effect.fail(failed);
        const error = failed.error;
        if (before === "retry") return yield* step(1, total + 1, error.tracker, failed);
        const delay = slotQuestion(cell.slot) === null ? delays[n - 1] : undefined;
        if (delay !== undefined) {
          const fromMs = yield* Clock.currentTimeMillis;
          const untilMs = fromMs + delay * 1000;
          // Issue #215: the developer may end the wait early; the repeat then follows at once, as after a wait that ran out.
          yield* announcedWait(
            (from, wait) => ({ _tag: "TrackerRetrying", tracker: error.tracker, what, attempt: n, of: delays.length, delaySeconds: delay, fault: error.message, fromMs: from, untilMs, wait }),
            prompts.trackerRetryLine(error.tracker, what, n, delays.length, delay, error.message),
            untilMs,
            error.tracker,
          );
          return yield* step(n + 1, total + 1, error.tracker, failed);
        }
        const attempts = total + 1;
        if (env.exhausted === "stop") {
          yield* say(prompts.trackerRepeatsExhaustedLine(error.tracker, what, attempts, error.message));
          return yield* Effect.fail(failed);
        }
        // Issue #243: the question no longer waits. It is opened beside the repeats, which go on every
        // USAGE_LIMIT_RETRY_SECONDS with no limit, each wait one the developer may end early.
        let waiting = slotQuestion(cell.slot);
        if (waiting === null) {
          const origin: QuestionOrigin = { kind: "tracker", tracker: error.tracker, what, attempts, fault: error.message };
          const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.trackerExhaustedQuestion(error.tracker, what)), options: trackerOptions(), attached: attachedOf("fault", prompts.transportDetails(attempts, error.message)), decision: null };
          // W6-R1-1: the Scope is recorded before the question is presented, so the repeats' cleanup closes it whenever they end.
          waiting = yield* openInSlot(cell, (scope, answered) => env.openQuestion(scope, draft, () => Effect.asVoid(Deferred.succeed(answered, undefined))));
        }
        const untilMs = (yield* Clock.currentTimeMillis) + USAGE_LIMIT_RETRY_SECONDS * 1000;
        yield* announcedWait(
          (fromMs, wait) => ({ _tag: "TrackerRetrying", tracker: error.tracker, what, attempt: attempts, of: attempts, delaySeconds: USAGE_LIMIT_RETRY_SECONDS, fault: error.message, fromMs, untilMs, wait }),
          prompts.trackerBesideRetryLine(error.tracker, what, attempts, USAGE_LIMIT_RETRY_SECONDS),
          untilMs,
          error.tracker,
        );
        if ((yield* answeredNow(error.tracker, failed)) === "retry") return yield* step(1, attempts, error.tracker, failed);
        return yield* step(n, attempts, error.tracker, failed);
      });
    return step(1, 0, null, null).pipe(Effect.ensuring(Effect.suspend(() => closeQuestion)));
  });

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

/** Issue #216: an issue the item cites, read whatever its labels, repeated as the first read is. */
export const readCitedWithRetry = (tracker: TrackerShape, item: ItemId, env: TrackerRetryEnv): Effect.Effect<CitedItem, TrackerError | RunError> =>
  readRetried(env, { kind: "readCited", item }, tracker.readCited(item));

/** Issue #186: the item's comments, repeated as the first read is. */
export const readCommentsWithRetry = (tracker: TrackerShape, item: ItemId, env: TrackerRetryEnv): Effect.Effect<readonly ItemComment[], TrackerError | RunError> =>
  readRetried(env, { kind: "comments", item }, tracker.comments(item));

const sent = (tracker: TrackerShape, write: RepeatableWrite): Effect.Effect<void, TrackerError> => {
  switch (write.kind) {
    case "writeRefinement":
      return tracker.writeRefinement(write.item, write.refinement);
    case "setState":
      return tracker.setState(write.item, write.state);
    case "deleteComment":
      return tracker.deleteComment(write.item, write.comment);
    case "writeText":
      return tracker.writeText(write.item, write.text);
  }
};

/** What a read-back after a server error shows of a write: the item for a write to it, its comments for a deletion (issue #131). */
const readBack = (tracker: TrackerShape, write: RepeatableWrite): Effect.Effect<Result.Result<void, HeldState>, TrackerError> =>
  write.kind === "deleteComment" ? Effect.map(tracker.comments(write.item), (comments) => commentDeleted(write.comment, comments)) : Effect.map(tracker.read(write.item), (item) => landed(write, item));

/**
 * One attempt at a write. A server error is followed by a read of the item (requirements Q2): where the item already
 * holds the write's outcome, the write counts as done, said and recorded; otherwise the failure carries what the item
 * held, and a read-back that fails leaves the item unchecked.
 */
const writeAttempt = (tracker: TrackerShape, write: RepeatableWrite, env: TrackerRetryEnv): Effect.Effect<Attempted<void>, AttemptFailed | RunError> =>
  Effect.catch(
    Effect.map(sent(tracker, write), (): Attempted<void> => ({ value: undefined, landed: null })),
    (error): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
      if (!uncertainWrite(error) || error._tag !== "TrackerUnreachable") return Effect.fail(attemptFailed(error, UNCHECKED));
      return Effect.flatMap(Effect.result(readBack(tracker, write)), (read): Effect.Effect<Attempted<void>, AttemptFailed | RunError> => {
        // Issue #219 (P1-R1-1): a read-back refused for the rate limit fails the attempt with that refusal, never hidden
        // behind the server error, so the limit is waited out and the write sent again after it.
        if (Result.isFailure(read)) return Effect.fail(attemptFailed(read.failure._tag === "TrackerRateLimited" ? read.failure : error, UNCHECKED));
        const outcome = read.success;
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
      // Issue #219 (P1-R1-1): a listing refused for the rate limit fails with that refusal, which is waited out, the
      // write still reconciling, so it never POSTs again before a listing shows its key absent.
      if (Result.isFailure(listed)) return Effect.andThen(Ref.set(phase, "reconciling"), Effect.fail(attemptFailed(listed.failure._tag === "TrackerRateLimited" ? listed.failure : (error ?? listed.failure), UNCHECKED)));
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
    openQuestion: (scope, draft, onAccepted) => openBeside(scope, prompts.transportPrompt, draft, acceptable, { offer: false, onAccepted: () => Effect.as(onAccepted(), "kept" as const) }).pipe(Effect.provideContext(context)),
    exhausted: "ask",
  };
});

/**
 * Issue #185 (G-R1-1): the environment's repeats and read-backs, ended with no question when they are used up. Work
 * review 2 of issue #185 (W2-R1-1): a record write that fails is ignored, since the developer is away and nothing he
 * could do depends on the record, so a failed write to conversation.md never cuts the repeats short.
 */
export const unattendedTrackerEnv = (env: TrackerRetryEnv): TrackerRetryEnv => ({
  ...env,
  exhausted: "stop",
  record: (markdown) => env.record(markdown).pipe(Effect.ignore),
});

/**
 * The environment of the run's first read (requirements Q3, the developer's decision of 15 Oct 2026): its lines and its
 * question are held in `held` until conversation.md exists, and the question carries no offer of decision support.
 */
export const heldTrackerEnv = (ui: UiShape, settings: TrackerRetrySettings, held: Ref.Ref<readonly string[]>): TrackerRetryEnv => {
  const record = (markdown: string) => Ref.update(held, (rs) => [...rs, markdown]);
  return { ui, settings, record, openQuestion: (scope, draft, onAccepted) => openBesideUnoffered(scope, { ui, record }, prompts.transportPrompt, draft, acceptable, onAccepted), exhausted: "ask" };
};

const acceptable = (answer: string): boolean => parseTransportAnswer(answer) !== null;

/** Issue #219: a wait of the server's own tracker request for the rate limit, as a listing tells its tab. */
export type RateLimitWait = Readonly<{ tracker: string; fromMs: number; untilMs: number; stated: boolean; wait: WaitId }>;

/**
 * Issue #219: the tracker with every operation waiting out a rate limit, for the server's own requests (a tab's listing,
 * a start's read and comments, the chain's listing, the preparation pass), which are not repeated for any other
 * failure (behavior 11). While an operation fails with TrackerRateLimited it waits until the stated reset (a wait of
 * `waits`, which the developer may end early), told through `onWait`, and calls it again, with no limit; every other
 * failure passes through. The sleep is interruptible, so a closed tab ends it.
 */
export const rateLimitWaiting = (tracker: TrackerShape, waits: Waits, onWait: (wait: RateLimitWait) => Effect.Effect<void>): TrackerShape => {
  const waited = <A>(operation: Effect.Effect<A, TrackerError>): Effect.Effect<A, TrackerError> =>
    Effect.catchIf(
      operation,
      (error): error is TrackerRateLimited => error._tag === "TrackerRateLimited",
      (error) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fromMs = yield* Clock.currentTimeMillis;
            const { untilMs, stated } = rateLimitUntil(error.reset, fromMs);
            const handle = yield* waits.open;
            yield* onWait({ tracker: error.tracker, fromMs, untilMs, stated, wait: handle.id });
            yield* handle.sleepUntil(untilMs);
          }),
        ).pipe(Effect.andThen(Effect.suspend(() => waited(operation)))),
    );
  return {
    list: (state) => waited(tracker.list(state)),
    listMarked: (state) => waited(tracker.listMarked(state)),
    read: (id) => waited(tracker.read(id)),
    readCited: (id) => waited(tracker.readCited(id)),
    writeText: (id, text) => waited(tracker.writeText(id, text)),
    writeRefinement: (id, refinement) => waited(tracker.writeRefinement(id, refinement)),
    setState: (id, state) => waited(tracker.setState(id, state)),
    comment: (id, text) => waited(tracker.comment(id, text)),
    comments: (id) => waited(tracker.comments(id)),
    deleteComment: (id, comment) => waited(tracker.deleteComment(id, comment)),
  };
};
