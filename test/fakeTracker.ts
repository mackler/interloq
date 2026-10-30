// A tracker in memory (issue #120, part 1): the port's fake, for the tests of the tasks that use the tracker. It holds
// states directly, so GitHub's label cases (no stage label, several) belong to the adapter's tests, not to it.
import { Effect, Ref, Result } from "effect";
import { TrackerBodyInvalid, TrackerItemNotFound } from "../src/errors.ts";
import { withRefinement } from "../src/refinement.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import { type CommentId, commentIdOf, type ItemComment, type ItemId, type ItemState, type TrackerItem } from "../src/tracker.ts";

/** An item as the fake holds it: what the port shows, whether it is open in the tracker, and its comments (issue #186; none where absent). */
export type FakeItem = TrackerItem & Readonly<{ open: boolean; comments?: readonly ItemComment[] }>;
/** The instant the fake gives every comment it adds. */
export const FAKE_COMMENT_TIME = "2026-10-29T12:00:00Z";
/** Issue #131: the id a test gives a comment it seeds, distinct from the ids the fake gives the comments it adds. */
export const seededId = (text = "seeded"): CommentId => Result.getOrThrow(commentIdOf(text));
export type TrackerOperation = keyof TrackerShape;
export type FakeTracker = Readonly<{
  tracker: TrackerShape;
  /** The items as they are now, with what was written. */
  items: Effect.Effect<readonly FakeItem[]>;
  /** The ids the tracker was asked to read, in order (issue #120: the seam between the page's item and the run's). */
  reads: Effect.Effect<readonly ItemId[]>;
  /** The next call of `operation` fails with `error`, once; with `state`, only a `setState` to that state matches. */
  failNext: (operation: TrackerOperation, error: TrackerError, state?: ItemState) => Effect.Effect<void>;
  /** Issue #171: the next call of the write `operation` applies its change, then fails with `error`, once (a 500 that applied); with `state`, only a `setState` to that state matches (W1-R1-1). */
  failAfterNext: (operation: "writeRefinement" | "setState" | "comment", error: TrackerError, state?: ItemState) => Effect.Effect<void>;
}>;

/** A scripted failure: before the operation changes anything, or after a write applied its change (issue #171). */
type Scripted = Readonly<{ operation: TrackerOperation; error: TrackerError; when: "before" | "after"; state?: ItemState }>;
type State = Readonly<{ items: readonly FakeItem[]; failures: readonly Scripted[]; reads: readonly ItemId[]; nextComment: number }>;

export const makeFakeTracker = (initial: readonly FakeItem[]): Effect.Effect<FakeTracker> =>
  Effect.map(Ref.make<State>({ items: initial, failures: [], reads: [], nextComment: 1 }), (ref) => {
    /** The scripted failure of this operation at this moment, taken, or none. */
    const scriptedAt = (operation: TrackerOperation, when: Scripted["when"], target?: ItemState): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(
        Ref.modify(ref, (s): readonly [TrackerError | null, State] => {
          const i = s.failures.findIndex((f) => f.operation === operation && f.when === when && (f.state === undefined || f.state === target));
          return i < 0 ? [null, s] : [s.failures[i].error, { ...s, failures: s.failures.filter((_, j) => j !== i) }];
        }),
        (error) => (error === null ? Effect.void : Effect.fail(error)),
      );
    const scripted = (operation: TrackerOperation, target?: ItemState) => scriptedAt(operation, "before", target);
    const after = (operation: TrackerOperation, target?: ItemState) => scriptedAt(operation, "after", target);
    const find = (id: ItemId): Effect.Effect<FakeItem, TrackerError> =>
      Effect.flatMap(Ref.get(ref), (s) => {
        const item = s.items.find((i) => i.id === id);
        return item === undefined ? Effect.fail(new TrackerItemNotFound({ id })) : Effect.succeed(item);
      });
    const replace = (item: FakeItem): Effect.Effect<void> => Ref.update(ref, (s) => ({ ...s, items: s.items.map((i) => (i.id === item.id ? item : i)) }));
    /** Issue #131: the id of a comment the fake adds, `c-1`, `c-2`, …; a seeded comment keeps the id it was given. */
    const newCommentId: Effect.Effect<CommentId> = Ref.modify(ref, (s): readonly [CommentId, State] => [Result.getOrThrow(commentIdOf(`c-${s.nextComment}`)), { ...s, nextComment: s.nextComment + 1 }]);
    const shown = ({ open: _open, comments: _comments, ...item }: FakeItem): TrackerItem => item;
    const tracker: TrackerShape = {
      list: (state) => Effect.andThen(scripted("list"), Effect.map(Ref.get(ref), (s) => s.items.filter((i) => i.open && i.state === state).map(shown))),
      read: (id) => Effect.andThen(Ref.update(ref, (s) => ({ ...s, reads: [...s.reads, id] })), Effect.andThen(scripted("read"), Effect.map(find(id), shown))),
      writeRefinement: (id, refinement) =>
        Effect.gen(function* () {
          yield* scripted("writeRefinement");
          const item = yield* find(id);
          const body = withRefinement(item.body, refinement);
          if (Result.isFailure(body)) return yield* Effect.fail(new TrackerBodyInvalid({ id, message: body.failure.reason }));
          yield* replace({ ...item, body: body.success });
          yield* after("writeRefinement");
        }),
      setState: (id, state) => Effect.andThen(scripted("setState", state), Effect.flatMap(find(id), (item) => Effect.andThen(replace({ ...item, state }), after("setState", state)))),
      comment: (id, text) =>
        Effect.andThen(
          scripted("comment"),
          Effect.flatMap(find(id), (item) =>
            Effect.andThen(
              Effect.flatMap(newCommentId, (commentId) => replace({ ...item, comments: [...(item.comments ?? []), { id: commentId, body: text, created: FAKE_COMMENT_TIME }] })),
              after("comment"),
            ),
          ),
        ),
      comments: (id) => Effect.andThen(scripted("comments"), Effect.map(find(id), (item) => item.comments ?? [])),
    };
    return {
      tracker,
      items: Effect.map(Ref.get(ref), (s) => s.items),
      reads: Effect.map(Ref.get(ref), (s) => s.reads),
      failNext: (operation, error, state) => Ref.update(ref, (s): State => ({ ...s, failures: [...s.failures, { operation, error, when: "before", ...(state === undefined ? {} : { state }) }] })),
      failAfterNext: (operation, error, state) => Ref.update(ref, (s): State => ({ ...s, failures: [...s.failures, { operation, error, when: "after", ...(state === undefined ? {} : { state }) }] })),
    };
  });
