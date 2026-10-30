// The unattended pass (issue #131, requirements Q4 and F3): while the switch is on, the marked unrefined items are
// prepared one after another, newest first, beside every run. An edge over its dependencies, which the run manager
// gives it; nothing here reads the tracker or the clock. No timer: the pass looks again only when woken.
import { Deferred, Effect, Fiber, Queue, Ref, Result, type Scope, Semaphore } from "effect";
import { keyOf } from "./itemComments.ts";
import type { PreparationOutcome } from "./preparation.ts";
import { digestOf, eligible, preparationOf } from "./preparedComments.ts";
import { failureCounts, isReleased, type PreparationFailure, type PreparationKept, type PreparationRelease, type PreparationStatus } from "./preparationSwitch.ts";
import type { ItemComment, ItemId, TrackerItem } from "./tracker.ts";

/** A marked unrefined item with its comments, as the tracker listed them. */
export type Candidate = Readonly<{ item: TrackerItem; comments: readonly ItemComment[] }>;

export type PassDeps = Readonly<{
  /** The switch, the failures and the releases as the manager holds them now. */
  kept: Effect.Effect<PreparationKept>;
  /** Whether the server is ending after a fault it cannot trace to one run (issue #158). */
  closing: Effect.Effect<boolean>;
  /** The marked unrefined items, newest first, with their comments; a failure is the tracker's notice. */
  candidates: Effect.Effect<Result.Result<readonly Candidate[], string>>;
  /** The items of the refinement runs in progress. */
  refining: Effect.Effect<readonly ItemId[]>;
  /** One preparation (src/preparation.ts), in a scope of its own. */
  prepare: (item: TrackerItem, comments: readonly ItemComment[], generation: number) => Effect.Effect<PreparationOutcome, never, Scope.Scope>;
  /** A NotWritten outcome kept durably (plan-review/chain.json). */
  recordFailure: (failure: PreparationFailure) => Effect.Effect<void>;
  /** The releases that have done their work, removed durably. */
  dropReleases: (items: readonly ItemId[]) => Effect.Effect<void>;
  /** The status shown under the switch. */
  publish: (status: PreparationStatus) => Effect.Effect<void>;
}>;

export type PreparationPass = Readonly<{
  /** Look again: never suspends; any number of wakes leave at most one pending. */
  wake: Effect.Effect<void>;
  /** Refine pressed on the item: its preparation, if it is the one in progress, is stopped; nothing waits for its cleanup. */
  stopItem: (item: ItemId) => Effect.Effect<void>;
  /** The switch turned off: the preparation in progress is stopped; nothing waits for its cleanup. */
  stop: Effect.Effect<void>;
  /** The server ending: no permit taken, nothing waited for, nothing prepared after it, nothing written. */
  shutdown: Effect.Effect<void>;
  status: Effect.Effect<PreparationStatus>;
  current: Effect.Effect<ItemId | null>;
}>;

/**
 * Whether the pass may prepare the item: the comments allow it (eligible), or they hold a set-aside the developer
 * released by pressing Refine (requirements G-R1-1, whether or not its comment's deletion has finished); and in either
 * case no failure of the item counts for its digest now and the switch's generation.
 */
export const candidateEligible = (kept: PreparationKept, item: TrackerItem, comments: readonly ItemComment[]): boolean => {
  const generation = kept.settings.generation;
  const found = preparationOf(comments, item, generation);
  const allowed = eligible(found) || (found._tag === "SetAside" && isReleased(kept, item.id, found.key));
  const digest = digestOf(item);
  return allowed && !kept.failures.some((f) => f.item === item.id && failureCounts(f, digest, generation));
};

/** Whether some comment of the item still carries a preparation's key (its own or one of its questions'). */
const carriesKey = (comments: readonly ItemComment[], key: string): boolean =>
  comments.some((c) => {
    const found = keyOf(c.body);
    return found === key || (found !== null && found.startsWith(`${key}/q-`));
  });

/**
 * The items whose Refine releases have done their work: the item is listed and none of its comments carries the
 * release's key. A release whose item is absent from the marked listing is kept, since its set-aside comment may still
 * be on the item; turning the switch off and on empties the releases (work review 1, W1-R1-2).
 */
export const spentReleases = (released: readonly PreparationRelease[], listed: readonly Candidate[]): readonly ItemId[] =>
  released
    .filter((r) => {
      const candidate = listed.find((c) => c.item.id === r.item);
      return candidate !== undefined && !carriesKey(candidate.comments, r.key);
    })
    .map((r) => r.item as ItemId);

type Running = Readonly<{ item: ItemId; fiber: Fiber.Fiber<unknown, unknown>; done: Deferred.Deferred<void> }>;

/**
 * The pass. The permit is held only for in-memory steps, never across an await of a fiber, a tracker request or any
 * other wait, so stopItem and stop return at once and shutdown takes none. Each preparation's `done`, succeeded by its
 * own end or by the step that takes it out of `current`, releases the loop, never the fiber's end, so a cleanup blocked
 * on the tracker holds nothing back.
 */
export const makePreparationPass = (deps: PassDeps): Effect.Effect<PreparationPass> =>
  Effect.gen(function* () {
    const closed = yield* Ref.make(false);
    const current = yield* Ref.make<Running | null>(null);
    const shown = yield* Ref.make<PreparationStatus>({ _tag: "Off" });
    const permit = yield* Semaphore.make(1);
    const wakes = yield* Queue.sliding<void>(1);
    const publish = (status: PreparationStatus) => Effect.andThen(Ref.set(shown, status), deps.publish(status));
    const interruptDetached = (fiber: Fiber.Fiber<unknown, unknown>) => Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber), { startImmediately: true }));
    const waitForWake = Effect.asVoid(Queue.take(wakes));
    /** Whether a preparation may begin now: the switch on, the server not ending, the pass not shut down. */
    const going = Effect.gen(function* () {
      return (yield* deps.kept).settings.enabled && !(yield* Ref.get(closed)) && !(yield* deps.closing);
    });

    /**
     * Starts the item's preparation if it may begin and its item is not being refined; null otherwise. Atomic under the
     * permit. The candidate is judged again against the switch as it is now: where the generation it was judged at
     * (`judgedAt`) has changed, or the item is no longer eligible, nothing starts, and the next cycle lists afresh
     * (work review 1, W1-R1-1).
     */
    const select = (candidate: Candidate, judgedAt: number) =>
      permit.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* going) || (yield* deps.refining).includes(candidate.item.id)) return null;
          const fresh = yield* deps.kept;
          if (fresh.settings.generation !== judgedAt || !candidateEligible(fresh, candidate.item, candidate.comments)) return null;
          const generation = fresh.settings.generation;
          const done = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const preparation = Effect.gen(function* () {
            yield* Deferred.await(gate);
            const outcome = yield* Effect.scoped(deps.prepare(candidate.item, candidate.comments, generation));
            if (outcome._tag === "NotWritten") yield* deps.recordFailure({ item: candidate.item.id, digest: digestOf(candidate.item), generation, reason: outcome.reason });
          }).pipe(Effect.onExit(() => Deferred.succeed(done, undefined)));
          const fiber = yield* Effect.forkDetach(preparation, { startImmediately: true });
          yield* Ref.set(current, { item: candidate.item.id, fiber, done });
          return { fiber, done, gate } as const;
        }),
      );

    const cycle: Effect.Effect<void> = Effect.gen(function* () {
      const kept = yield* deps.kept;
      if (!kept.settings.enabled) {
        yield* publish({ _tag: "Off" });
        return yield* waitForWake;
      }
      if ((yield* Ref.get(closed)) || (yield* deps.closing)) return yield* waitForWake;
      const listed = yield* deps.candidates;
      if (Result.isFailure(listed)) {
        yield* publish({ _tag: "Unavailable", notice: listed.failure });
        return yield* waitForWake;
      }
      // A release whose item is listed with its preparation's comments all gone has done its work; a later set-aside must count again.
      const spent = spentReleases(kept.released, listed.success);
      if (spent.length > 0) yield* deps.dropReleases(spent);
      const refining = yield* deps.refining;
      const next = listed.success.find((c) => !refining.includes(c.item.id) && candidateEligible(kept, c.item, c.comments));
      if (next === undefined) {
        yield* publish({ _tag: "Idle" });
        return yield* waitForWake;
      }
      const selected = yield* select(next, kept.settings.generation);
      if (selected === null) return;
      yield* publish({ _tag: "Preparing", item: next.item.id, title: next.item.title });
      // A shutdown that began between the check and the setting of `current` may have read `current` before it was set.
      if (yield* Ref.get(closed)) {
        yield* interruptDetached(selected.fiber);
        yield* Deferred.succeed(selected.done, undefined);
        return;
      }
      yield* Deferred.succeed(selected.gate, undefined);
      yield* Deferred.await(selected.done);
      yield* Ref.update(current, (r) => (r?.done === selected.done ? null : r));
    });
    const loop: Effect.Effect<void> = Effect.flatMap(cycle, () => loop);
    // The pass looks first when woken (the switch turned on, a restored switch that is on, a listing, a run's end).
    const loopFiber = yield* Effect.forkDetach(Effect.andThen(waitForWake, loop), { startImmediately: true });

    /** Takes the preparation in progress out of `current` where `which` selects it, and succeeds its `done`; then interrupts it detached. */
    const stopWhere = (which: (r: Running) => boolean) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return;
        const taken = yield* permit.withPermits(1)(
          Effect.gen(function* () {
            const r = yield* Ref.get(current);
            if (r === null || !which(r)) return null;
            yield* Ref.set(current, null);
            yield* Deferred.succeed(r.done, undefined);
            return r;
          }),
        );
        if (taken !== null) yield* interruptDetached(taken.fiber);
      });

    return {
      wake: Effect.flatMap(Ref.get(closed), (c) => (c ? Effect.void : Effect.asVoid(Queue.offer(wakes, undefined)))),
      stopItem: (item) => stopWhere((r) => r.item === item),
      stop: Effect.andThen(stopWhere(() => true), Effect.flatMap(Ref.get(closed), (c) => (c ? Effect.void : Effect.asVoid(Queue.offer(wakes, undefined))))),
      shutdown: Effect.gen(function* () {
        yield* Ref.set(closed, true);
        const r = yield* Ref.get(current);
        if (r !== null) yield* interruptDetached(r.fiber);
        yield* interruptDetached(loopFiber);
      }),
      status: Ref.get(shown),
      current: Effect.map(Ref.get(current), (r) => r?.item ?? null),
    };
  });
