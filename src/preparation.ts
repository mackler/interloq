// The unattended preparation of one item's questions (issue #131): an edge like `program`, over its Wiring, so the
// tests run it with scripted agents. It runs the part of the question phase that needs no one (prepareQuestionList) in
// a records directory of its own, with a refinement run's guards, and writes what Codex reviewed to the item as
// comments (src/preparedComments.ts). Since issue #216 (requirements Q3) it first runs Bring Up to Date, and where that
// loop ends in agreement on a correction it writes the item's title and text; it never changes the item's state or
// labels, and asks no one anything.
import { openQuestionsLayer } from "./openQuestions.ts";
import * as path from "node:path";
import { Cause, Clock, Data, Effect, Exit, FileSystem, Layer, Option, Ref, Result, type Scope } from "effect";
import { runRootOf } from "./artifacts.ts";
import { loadConfig } from "./config.ts";
import { deciderLayer } from "./decision.ts";
import { describe, isTrackerError, type NoAnswer, trackerFailureText } from "./errors.ts";
import { prepareQuestionList } from "./interview.ts";
import { commentDateOf, keyOf, parseComment, runCommentKey } from "./itemComments.ts";
import { rootName } from "./park.ts";
import { type PausedPhase, type PreparationCause, type PreparationRecord, digestOf, preparationOf, type PreparedQuestion, preparedComments } from "./preparedComments.ts";
import { unattendedUi } from "./preparationUi.ts";
import { DECISION_FORMAT, defectMessage, refinementTextOf, taskTextOf, type Wiring } from "./program.ts";
import { bringUpToDate } from "./bringUpToDate.ts";
import { refinementTaskText } from "./itemComments.ts";
import { withDeveloperText } from "./refinement.ts";
import { disputeSettledWithoutYouLine, PREPARATION_STOPPED, preparationNotWrittenLine, preparationPreparedLine, preparationSetAsideLine, preparationStartedLine, TRANSPORT_ANSWERS } from "./prompts.ts";
import { Decider, OpenQuestions, RunConfig, RunKind, Sdk, Store, type StoreShape, SuiteRunner, Tracker, type TrackerShape, Ui } from "./services.ts";
import { allocateRunRoot, makeStore } from "./store.ts";
import type { CommentId, ItemComment, TrackerItem } from "./tracker.ts";
import { readCommentsWithRetry, type TrackerRetryEnv, unattendedTrackerEnv, writeWithRetry } from "./trackerRetry.ts";

/** What a preparation came to: its questions written, the item set aside with why, or comments the tracker refused for good. */
export type PreparationOutcome =
  | Readonly<{ _tag: "Prepared"; count: number }>
  | Readonly<{ _tag: "SetAside"; cause: PreparationCause }>
  | Readonly<{ _tag: "NotWritten"; reason: string }>;
/**
 * A pause of the unattended Ui (NoAnswer) with the phase it arose in (work review 4 of issue #216), built where the phase
 * is known: around Bring Up to Date's check, or around the question list's review.
 */
class PreparationPaused extends Data.TaggedError("PreparationPaused")<{ readonly phase: PausedPhase; readonly question: string }> {}
const pausedIn = (phase: PausedPhase) => (e: NoAnswer) => Effect.fail(new PreparationPaused({ phase, question: e.question?.text ?? e.where }));
export type PreparationInput = Readonly<{ project: string; item: TrackerItem; comments: readonly ItemComment[]; generation: number }>;

const notWritten = (reason: string): PreparationOutcome => ({ _tag: "NotWritten", reason });
/** Whether a comment's key is the preparation's own or one of its questions'. */
const ownKey = (key: string, comment: ItemComment): boolean => {
  const found = keyOf(comment.body);
  return found === key || (found !== null && found.startsWith(`${key}/q-`));
};

/**
 * Prepares one item: the configuration and the decision format, the item's task as a refinement run's (its comments,
 * the preparation's own left out), a records directory runs/<time>-preparation-<item>, the services as a refinement
 * run's (RunKind refinement, so no project snapshot is compared for either agent: behavior 3), each Claude Code call in
 * sessions of this preparation's own planner (issue #122), and prepareQuestionList with the terms checked (requirements
 * Q5). A pause (NoAnswer from the unattended Ui) and any other typed error set the item aside; a question whose
 * comment would be too long too. Before writing, every preparation comment already on the item is deleted, then the
 * questions are written in order and the preparation's own comment last (requirements G-R1-2). Every tracker request
 * goes through the tracker retry with no question. An interruption deletes this preparation's comments, uninterruptibly,
 * unless its own comment is already on the item: a complete preparation stays (issue #200's suite run).
 */
export const prepareItem = (input: PreparationInput, wiring: Wiring): Effect.Effect<PreparationOutcome, never, Scope.Scope> =>
  Effect.gen(function* () {
    const project = path.resolve(input.project);
    const item = input.item;
    const config = yield* Effect.result(loadConfig(project, wiring.sharedConfig).pipe(Effect.provide(wiring.platform)));
    if (Result.isFailure(config)) return notWritten(describe(config.failure));
    const settings = config.success;
    const format = yield* Effect.result(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(wiring.decisionFormat ?? DECISION_FORMAT);
      }).pipe(Effect.provide(wiring.platform)),
    );
    if (Result.isFailure(format)) return notWritten(format.failure.message);
    const trackerLayer = wiring.tracker(settings);
    if (Result.isFailure(trackerLayer)) return notWritten(trackerFailureText(trackerLayer.failure));
    const task = taskTextOf("refinement", item, input.comments);
    if (Result.isFailure(task)) return notWritten(task.failure._tag === "BlankTask" ? "the item's title and text are blank" : task.failure.reason);
    const before = refinementTextOf(item);
    if (Result.isFailure(before)) return notWritten(before.failure._tag === "BlankTask" ? "the item's title and text are blank" : before.failure.reason);

    const now = yield* Clock.currentTimeMillis;
    const root = yield* Effect.result(allocateRunRoot(project, runRootOf("preparation", item.id, new Date(now).toISOString())).pipe(Effect.provide(wiring.platform)));
    if (Result.isFailure(root)) return notWritten(describe(root.failure));
    const opened = yield* Effect.result(makeStore(project, root.success, settings.ignorePaths).pipe(Effect.provide(wiring.platform)));
    if (Result.isFailure(opened)) return notWritten(describe(opened.failure));
    const store: StoreShape = (wiring.store ?? ((s: StoreShape) => s))(opened.success);
    const { ui } = yield* unattendedUi;
    const record = (line: string) => store.converse(`${line}\n\n`).pipe(Effect.ignore);
    const env: TrackerRetryEnv = unattendedTrackerEnv({ ui, settings, record: (markdown) => store.converse(markdown), ask: () => Effect.succeed(TRANSPORT_ANSWERS.stop), exhausted: "ask" });
    const withTracker = <A, E>(use: (t: TrackerShape) => Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.flatMap(Tracker, use).pipe(Effect.provide(trackerLayer.success));
    const key = runCommentKey(rootName(root.success));
    const deleteAll = (ids: readonly CommentId[]) => withTracker((t) => Effect.forEach(ids, (comment) => writeWithRetry(t, { kind: "deleteComment", item: item.id, comment }, env), { discard: true }));
    /** Whether the preparation's own comment, the last it writes, is among `comments`: then what it wrote is a whole preparation. */
    const complete = (comments: readonly ItemComment[]): boolean =>
      comments.some((c) => {
        const marker = parseComment(c.body);
        return marker !== null && marker._tag === "Preparation" && marker.key === key;
      });
    /** This preparation's own comments, whatever it managed to write, deleted as far as the tracker allows, unless `keep` holds of the comments read; failures recorded and ignored. */
    const deleteOwnUnless = (keep: (comments: readonly ItemComment[]) => boolean) =>
      withTracker((t) => readCommentsWithRetry(t, item.id, env)).pipe(
        Effect.flatMap((comments) => (keep(comments) ? Effect.void : deleteAll(comments.filter((c) => ownKey(key, c)).map((c) => c.id)))),
        Effect.catchCause((cause) => record(`The comments of this preparation could not all be deleted: ${Cause.pretty(cause)}`)),
      );
    const deleteOwn = deleteOwnUnless(() => false);
    /** An interruption's cleanup: a complete preparation stays, an unfinished one is deleted. */
    const deleteUnfinished = deleteOwnUnless(complete);
    /** Every preparation comment already on the item deleted, then `comments` written in order, the own comment last. */
    const write = (comments: readonly Readonly<{ key: string; text: string }>[]): Effect.Effect<Option.Option<string>> =>
      Effect.gen(function* () {
        const present = yield* withTracker((t) => readCommentsWithRetry(t, item.id, env));
        yield* deleteAll(preparationOf(present, item, null).ids);
        yield* withTracker((t) => Effect.forEach(comments, (c) => writeWithRetry(t, { kind: "comment", item: item.id, text: c.text, key: c.key }, env), { discard: true }));
        return Option.none<string>();
      }).pipe(
        Effect.catch((error) => Effect.as(deleteOwn, Option.some(error._tag === "TrackerWriteFailed" ? trackerFailureText(error.error) : isTrackerError(error) ? trackerFailureText(error) : describe(error)))),
      );

    const body = Effect.gen(function* () {
      yield* store.init(task.success);
      yield* record(preparationStartedLine(item.id, item.title));
      const base = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, settings), Layer.succeed(RunKind, { mode: "refinement" }), Layer.succeed(Sdk, wiring.sdk), Layer.succeed(SuiteRunner, wiring.suite), openQuestionsLayer);
      const context = yield* Layer.build(Layer.provideMerge(deciderLayer(task.success, format.success), Layer.provideMerge(wiring.agents, base)));
      /** The item as the preparation leaves it: as read, or with the title and text Bring Up to Date wrote (issue #216). */
      const written = yield* Ref.make<TrackerItem>(item);
      const phase = yield* Effect.exit(
        Effect.gen(function* () {
          const updated = yield* bringUpToDate(item.id, before.success, env).pipe(Effect.catchTag("NoAnswer", pausedIn("update")), Effect.provide(trackerLayer.success));
          // Q3: an issue found already built or replaced is set aside; the obsolete label is never applied unattended.
          if (updated._tag === "Obsolete") return { _tag: "Obsolete", reason: updated.reason } as const;
          const preparedTask = updated._tag === "Amended" ? refinementTaskText(updated.text, input.comments) : task.success;
          if (updated._tag === "Amended") {
            const write = yield* Effect.result(withTracker((t) => writeWithRetry(t, { kind: "writeText", item: item.id, text: updated.text }, env)));
            if (Result.isFailure(write)) return { _tag: "NotWritten", reason: write.failure._tag === "TrackerWriteFailed" ? trackerFailureText(write.failure.error) : describe(write.failure) } as const;
            yield* Ref.set(written, { ...item, title: updated.text.title, body: Result.getOrElse(withDeveloperText(item.body, updated.text), () => updated.text.text) });
          }
          const decider = yield* Decider;
          yield* prepareQuestionList(preparedTask, "checked").pipe(Effect.catchTag("NoAnswer", pausedIn("questions")), Effect.provideService(Decider, decider.withTask(preparedTask)));
          const agreed = (yield* store.loadQuestions()).questions;
          const terms = agreed.length === 0 ? [] : yield* store.loadTerms();
          return { _tag: "Questions", questions: agreed.map((entry): PreparedQuestion => ({ entry, terms: terms.find((t) => t.id === entry.id) ?? null })) } as const;
        }).pipe(
          // Issue #243: no one answers a preparation, so every disagreement put to the developer beside it is withdrawn on
          // every way it ends, each written to its conversation.md as settled without him.
          Effect.ensuring(
            Effect.gen(function* () {
              const w = yield* (yield* OpenQuestions).withdrawAll;
              for (const d of w.withdrawn) yield* record(disputeSettledWithoutYouLine(d.heading, d.reviewer, d.planner));
            }).pipe(Effect.ignore),
          ),
          Effect.provide(context),
        ),
      );
      if (Exit.isSuccess(phase) && phase.value._tag === "NotWritten") {
        yield* record(preparationNotWrittenLine(item.id, phase.value.reason));
        return notWritten(phase.value.reason);
      }
      const date = commentDateOf(yield* Clock.currentTimeMillis);
      const current = yield* Ref.get(written);
      const setAside = (cause: PreparationCause): PreparationRecord => ({ _tag: "SetAside", key, digest: digestOf(current), generation: input.generation, date, cause });
      const planned: Readonly<{ record: PreparationRecord; questions: readonly PreparedQuestion[] }> = Exit.isSuccess(phase)
        ? phase.value._tag === "Questions"
          ? { record: { _tag: "Prepared", key, digest: digestOf(current), count: phase.value.questions.length, generation: input.generation, date }, questions: phase.value.questions }
          : { record: setAside(phase.value._tag === "Obsolete" ? { _tag: "Obsolete", reason: phase.value.reason } : { _tag: "Failed", reason: phase.value.reason }), questions: [] }
        : {
            record: setAside(
              Option.match(Cause.findErrorOption(phase.cause), {
                onNone: () => ({ _tag: "Failed", reason: defectMessage(Cause.squash(phase.cause)) }),
                onSome: (error): PreparationCause => (error._tag === "PreparationPaused" ? { _tag: "Paused", phase: error.phase, question: error.question } : { _tag: "Failed", reason: describe(error) }),
              }),
            ),
            questions: [],
          };
      const comments = preparedComments(key, planned.questions, planned.record);
      const final = Result.isSuccess(comments)
        ? { record: planned.record, comments: comments.success }
        : (() => {
            const r = setAside(comments.failure._tag === "TooLong" ? comments.failure : { _tag: "Failed", reason: describe(comments.failure) });
            return { record: r, comments: Result.getOrThrow(preparedComments(key, [], r)) };
          })();
      const failed = yield* write(final.comments);
      if (Option.isSome(failed)) {
        yield* record(preparationNotWrittenLine(item.id, failed.value));
        return notWritten(failed.value);
      }
      if (final.record._tag === "Prepared") {
        yield* record(preparationPreparedLine(item.id, final.record.count));
        return { _tag: "Prepared", count: final.record.count } as const;
      }
      yield* record(preparationSetAsideLine(item.id, final.record.cause));
      return { _tag: "SetAside", cause: final.record.cause } as const;
    });
    return yield* body.pipe(
      Effect.catch((error) => Effect.succeed(notWritten(describe(error)))),
      Effect.onInterrupt(() => deleteUnfinished.pipe(Effect.andThen(store.converse(`${PREPARATION_STOPPED}\n`)), Effect.ignore)),
    );
  });
