// The unattended preparation of one item's questions (issue #131): an edge like `program`, over its Wiring, so the
// tests run it with scripted agents. It runs the part of the question phase that needs no one (prepareQuestionList) in
// a records directory of its own, with a refinement run's guards, and writes what Codex reviewed to the item as
// comments (src/preparedComments.ts). It never changes the item's state, body or labels, and asks no one anything.
import * as path from "node:path";
import { Cause, Clock, Effect, Exit, FileSystem, Layer, Option, Result, type Scope } from "effect";
import { runRootOf } from "./artifacts.ts";
import { loadConfig } from "./config.ts";
import { deciderLayer } from "./decision.ts";
import { describe, isTrackerError, trackerFailureText } from "./errors.ts";
import { prepareQuestionList } from "./interview.ts";
import { commentDateOf, keyOf, runCommentKey } from "./itemComments.ts";
import { rootName } from "./park.ts";
import { type PreparationCause, type PreparationRecord, digestOf, preparationOf, type PreparedQuestion, preparedComments } from "./preparedComments.ts";
import { unattendedUi } from "./preparationUi.ts";
import { DECISION_FORMAT, defectMessage, taskTextOf, type Wiring } from "./program.ts";
import { PREPARATION_STOPPED, preparationNotWrittenLine, preparationPreparedLine, preparationSetAsideLine, preparationStartedLine, TRANSPORT_ANSWERS } from "./prompts.ts";
import { RunConfig, RunKind, Sdk, Store, type StoreShape, SuiteRunner, Tracker, type TrackerShape, Ui } from "./services.ts";
import { allocateRunRoot, makeStore } from "./store.ts";
import type { CommentId, ItemComment, TrackerItem } from "./tracker.ts";
import { readCommentsWithRetry, type TrackerRetryEnv, unattendedTrackerEnv, writeWithRetry } from "./trackerRetry.ts";

/** What a preparation came to: its questions written, the item set aside with why, or comments the tracker refused for good. */
export type PreparationOutcome =
  | Readonly<{ _tag: "Prepared"; count: number }>
  | Readonly<{ _tag: "SetAside"; cause: PreparationCause }>
  | Readonly<{ _tag: "NotWritten"; reason: string }>;
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
 * goes through the tracker retry with no question. An interruption deletes this preparation's comments, uninterruptibly.
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
    /** This preparation's own comments, whatever it managed to write, deleted as far as the tracker allows; failures recorded and ignored. */
    const deleteOwn = withTracker((t) => readCommentsWithRetry(t, item.id, env)).pipe(
      Effect.flatMap((comments) => deleteAll(comments.filter((c) => ownKey(key, c)).map((c) => c.id))),
      Effect.catchCause((cause) => record(`The comments of this preparation could not all be deleted: ${Cause.pretty(cause)}`)),
    );
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
      const base = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, settings), Layer.succeed(RunKind, { mode: "refinement" }), Layer.succeed(Sdk, wiring.sdk), Layer.succeed(SuiteRunner, wiring.suite));
      const context = yield* Layer.build(Layer.provideMerge(deciderLayer(task.success, format.success), Layer.provideMerge(wiring.agents, base)));
      const phase = yield* Effect.exit(
        Effect.gen(function* () {
          yield* prepareQuestionList(task.success, "checked");
          const agreed = (yield* store.loadQuestions()).questions;
          const terms = agreed.length === 0 ? [] : yield* store.loadTerms();
          return agreed.map((entry): PreparedQuestion => ({ entry, terms: terms.find((t) => t.id === entry.id) ?? null }));
        }).pipe(Effect.provide(context)),
      );
      const date = commentDateOf(yield* Clock.currentTimeMillis);
      const setAside = (cause: PreparationCause): PreparationRecord => ({ _tag: "SetAside", key, digest: digestOf(item), generation: input.generation, date, cause });
      const planned: Readonly<{ record: PreparationRecord; questions: readonly PreparedQuestion[] }> = Exit.isSuccess(phase)
        ? { record: { _tag: "Prepared", key, digest: digestOf(item), count: phase.value.length, generation: input.generation, date }, questions: phase.value }
        : {
            record: setAside(
              Option.match(Cause.findErrorOption(phase.cause), {
                onNone: () => ({ _tag: "Failed", reason: defectMessage(Cause.squash(phase.cause)) }),
                onSome: (error): PreparationCause => (error._tag === "NoAnswer" ? { _tag: "Paused", question: error.question?.text ?? error.where } : { _tag: "Failed", reason: describe(error) }),
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
      Effect.onInterrupt(() => deleteOwn.pipe(Effect.andThen(store.converse(`${PREPARATION_STOPPED}\n`)), Effect.ignore)),
    );
  });
