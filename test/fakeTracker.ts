// A tracker in memory (issue #120, part 1): the port's fake, for the tests of the tasks that use the tracker. It holds
// states directly, so GitHub's label cases (no stage label, several) belong to the adapter's tests, not to it.
import { Effect, Ref, Result } from "effect";
import { TrackerBodyInvalid, TrackerItemNotFound } from "../src/errors.ts";
import { withRefinement } from "../src/refinement.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import type { ItemId, TrackerItem } from "../src/tracker.ts";

/** An item as the fake holds it: what the port shows, and whether it is open in the tracker. */
export type FakeItem = TrackerItem & Readonly<{ open: boolean }>;
export type TrackerOperation = keyof TrackerShape;
export type FakeTracker = Readonly<{
  tracker: TrackerShape;
  /** The items as they are now, with what was written. */
  items: Effect.Effect<readonly FakeItem[]>;
  /** The next call of `operation` fails with `error`, once. */
  failNext: (operation: TrackerOperation, error: TrackerError) => Effect.Effect<void>;
}>;

type State = Readonly<{ items: readonly FakeItem[]; failures: readonly (readonly [TrackerOperation, TrackerError])[] }>;

export const makeFakeTracker = (initial: readonly FakeItem[]): Effect.Effect<FakeTracker> =>
  Effect.map(Ref.make<State>({ items: initial, failures: [] }), (ref) => {
    /** The scripted failure of this operation, taken, or none. */
    const scripted = (operation: TrackerOperation): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(
        Ref.modify(ref, (s): readonly [TrackerError | null, State] => {
          const i = s.failures.findIndex(([op]) => op === operation);
          return i < 0 ? [null, s] : [s.failures[i][1], { ...s, failures: s.failures.filter((_, j) => j !== i) }];
        }),
        (error) => (error === null ? Effect.void : Effect.fail(error)),
      );
    const find = (id: ItemId): Effect.Effect<FakeItem, TrackerError> =>
      Effect.flatMap(Ref.get(ref), (s) => {
        const item = s.items.find((i) => i.id === id);
        return item === undefined ? Effect.fail(new TrackerItemNotFound({ id })) : Effect.succeed(item);
      });
    const replace = (item: FakeItem): Effect.Effect<void> => Ref.update(ref, (s) => ({ ...s, items: s.items.map((i) => (i.id === item.id ? item : i)) }));
    const shown = ({ open: _open, ...item }: FakeItem): TrackerItem => item;
    const tracker: TrackerShape = {
      list: (state) => Effect.andThen(scripted("list"), Effect.map(Ref.get(ref), (s) => s.items.filter((i) => i.open && i.state === state).map(shown))),
      read: (id) => Effect.andThen(scripted("read"), Effect.map(find(id), shown)),
      writeRefinement: (id, refinement) =>
        Effect.gen(function* () {
          yield* scripted("writeRefinement");
          const item = yield* find(id);
          const body = withRefinement(item.body, refinement);
          if (Result.isFailure(body)) return yield* Effect.fail(new TrackerBodyInvalid({ id, message: body.failure.reason }));
          yield* replace({ ...item, body: body.success });
        }),
      setState: (id, state) => Effect.andThen(scripted("setState"), Effect.flatMap(find(id), (item) => replace({ ...item, state }))),
    };
    return {
      tracker,
      items: Effect.map(Ref.get(ref), (s) => s.items),
      failNext: (operation, error) => Ref.update(ref, (s) => ({ ...s, failures: [...s.failures, [operation, error] as const] })),
    };
  });
