// The waits with a countdown that the developer may end early (issue #215): a usage-limit wait, the backoff before a
// transport retry, the wait for the network and the wait before a tracker repeat. An Effect module, not pure: a registry
// holds a Ref and one Deferred per open wait.
//
// The registry's state is one Ref of the ids it allocated and the waits now open, each with its Deferred. `open` takes an
// id from the counter the caller shares (one for the whole run manager, so a wait id names exactly one wait of one run:
// P1-R1-1 of the plan review), adds it to both, and removes it from the open waits when its Scope closes. `sleepUntil`
// races a sleep on the Clock with the wait's Deferred; when the sleep wins it removes the id in one step, and reports
// `ranOut` if the id was still open, or `endedEarly` if `end` removed it first. `end` ends an open wait (`ended`), says
// `alreadyEnded` for an id this registry allocated that is no longer open, and `notWaiting` for any other id, an id
// another run's registry allocated included. Whichever of the press and the wait's own end reaches the registry first
// wins, and the other is told so. The sleep stays interruptible, so Stop task still ends it.

import { Clock, Deferred, Duration, Effect, Ref } from "effect";
import type { Scope } from "effect";

/** A wait's id, unique across the run manager. */
export type WaitId = number;
/** What ended one sleep: its own end, or the developer. */
export type WaitEnd = "ranOut" | "endedEarly";
/** What a request to end a wait found. */
export type EndWaitResult = "ended" | "notWaiting" | "alreadyEnded";
/** One wait; its `sleepUntil` is called once. */
export type WaitHandle = Readonly<{ id: WaitId; sleepUntil: (untilMs: number) => Effect.Effect<WaitEnd> }>;
export type Waits = Readonly<{
  open: Effect.Effect<WaitHandle, never, Scope.Scope>;
  end: (id: WaitId) => Effect.Effect<EndWaitResult>;
}>;

type State = Readonly<{ allocated: ReadonlySet<WaitId>; open: ReadonlyMap<WaitId, Deferred.Deferred<void>> }>;

const sleepFor = (untilMs: number): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(untilMs - now, 0)))));

const withoutId = (state: State, id: WaitId): State => {
  const open = new Map(state.open);
  open.delete(id);
  return { allocated: state.allocated, open };
};

/** A counter of wait ids from 1; one is shared by every registry of a run manager. */
export const waitCounter: Effect.Effect<Effect.Effect<WaitId>> = Effect.map(Ref.make(0), (ref) => Ref.updateAndGet(ref, (n) => n + 1));

/** A registry whose ids come from `allocate`. */
export const makeWaits = (allocate: Effect.Effect<WaitId>): Effect.Effect<Waits> =>
  Effect.map(Ref.make<State>({ allocated: new Set(), open: new Map() }), (ref) => {
    const handleOf = (id: WaitId, deferred: Deferred.Deferred<void>): WaitHandle => ({
      id,
      sleepUntil: (untilMs) =>
        Effect.raceFirst(Effect.as(sleepFor(untilMs), "slept" as const), Effect.as(Deferred.await(deferred), "ended" as const)).pipe(
          Effect.flatMap((first) =>
            first === "ended"
              ? Effect.succeed<WaitEnd>("endedEarly")
              : Ref.modify(ref, (state): readonly [WaitEnd, State] => (state.open.has(id) ? ["ranOut", withoutId(state, id)] : ["endedEarly", state])),
          ),
        ),
    });
    const open: Effect.Effect<WaitHandle, never, Scope.Scope> = Effect.acquireRelease(
      Effect.gen(function* () {
        const id = yield* allocate;
        const deferred = yield* Deferred.make<void>();
        yield* Ref.update(ref, (state) => ({ allocated: new Set([...state.allocated, id]), open: new Map([...state.open, [id, deferred]]) }));
        return handleOf(id, deferred);
      }),
      (handle) => Ref.update(ref, (state) => withoutId(state, handle.id)),
    );
    const end = (id: WaitId): Effect.Effect<EndWaitResult> =>
      Effect.uninterruptible(
        Ref.modify(ref, (state): readonly [readonly [EndWaitResult, Deferred.Deferred<void> | null], State] => {
          const deferred = state.open.get(id);
          if (deferred !== undefined) return [["ended", deferred], withoutId(state, id)];
          return [[state.allocated.has(id) ? "alreadyEnded" : "notWaiting", null], state];
        }).pipe(Effect.flatMap(([result, deferred]) => (deferred === null ? Effect.succeed(result) : Effect.as(Deferred.succeed(deferred, undefined), result)))),
      );
    return { open, end };
  });

/** A wait no one can end early (id 0), for the Uis no page reaches: a plain sleep on the Clock. */
export const unendableWait: Effect.Effect<WaitHandle, never, Scope.Scope> = Effect.succeed({
  id: 0,
  sleepUntil: (untilMs: number) => Effect.as(sleepFor(untilMs), "ranOut" as const),
});
