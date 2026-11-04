// The questions open beside the run (issue #243), an Effect service of every run: the run's own Scope, in which a
// question that outlives the effect that presented it is forked; the registry of the disputes put to the developer
// (src/openDisputes.ts) with their producers; and the end of the run by such a question (an answer "q" or "/quit", or a
// producer that failed). An edge only in that it holds Refs, a Deferred and a Scope.
import { Deferred, Effect, Fiber, Layer, Ref, Scope } from "effect";
import type { RunError, UserStopped } from "./errors.ts";
import * as R from "./openDisputes.ts";
import type { BesideKey } from "./reviewState.ts";
import { OpenQuestions, type OpenQuestionsShape, type Taken } from "./services.ts";

type Producers = ReadonlyMap<BesideKey, Fiber.Fiber<string, UserStopped | RunError>>;
type Held = Readonly<{ registry: R.Registry; producers: Producers }>;

/** Scoped to the run: closing the run's scope interrupts every question forked in it, cancelling its prompt. */
export const makeOpenQuestions: Effect.Effect<OpenQuestionsShape, never, Scope.Scope> = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
  const ended = yield* Deferred.make<never, UserStopped | RunError>();
  const held = yield* Ref.make<Held>({ registry: R.EMPTY_REGISTRY, producers: new Map() });
  const step = <A>(f: (r: R.Registry) => readonly [A, R.Registry]): Effect.Effect<A> =>
    Ref.modify(held, (h): readonly [A, Held] => {
      const [a, registry] = f(h.registry);
      return [a, { ...h, registry }];
    });
  /** The entries removed in one step, then the producers of those removed interrupted, so no answer can count afterwards. */
  const withdrawing = (f: (r: R.Registry) => readonly [R.Withdrawn, R.Registry]): Effect.Effect<R.Withdrawn> =>
    Effect.gen(function* () {
      const [w, fibers] = yield* Ref.modify(held, (h): readonly [readonly [R.Withdrawn, readonly Fiber.Fiber<string, UserStopped | RunError>[]], Held] => {
        const [withdrawn, registry] = f(h.registry);
        const keys = [...withdrawn.withdrawn.map((d) => d.key), ...withdrawn.answered.map((a) => a.dispute.key)];
        const fibers = keys.flatMap((k) => {
          const fiber = h.producers.get(k);
          return fiber === undefined ? [] : [fiber];
        });
        return [[withdrawn, fibers], { registry, producers: new Map([...h.producers].filter(([k]) => !keys.includes(k))) }];
      });
      for (const fiber of fibers) yield* Fiber.interrupt(fiber);
      return w;
    });
  return {
    scope,
    opened: (dispute) => step((r) => R.opened(r, dispute)),
    answered: (key, text) => step((r) => R.answered(r, key, text)).pipe(Effect.map((r): Taken => (r === "kept" ? "kept" : "refused"))),
    // W7-R1-1: stored where its dispute is still registered, else interrupted at once, decided in one step over the Ref
    // the withdrawal modifies, so whichever reaches it first, the producer is interrupted exactly once.
    attach: (key, fiber) =>
      Ref.modify(held, (h): readonly [boolean, Held] =>
        R.isRegistered(h.registry, key) ? [true, { ...h, producers: new Map(h.producers).set(key, fiber) }] : [false, h],
      ).pipe(Effect.flatMap((stored) => (stored ? Effect.void : Effect.asVoid(Fiber.interrupt(fiber))))),
    peek: (keys) => step((r) => R.peeked(r, keys)),
    acknowledge: (keys) => step((r) => R.acknowledged(r, keys)),
    loopEnded: (keys) => step((r) => R.loopEnded(r, keys)),
    takeAfterLoop: step(R.takenAfterLoop),
    withdrawOwned: (owner) => withdrawing((r) => R.withdrawnOwned(r, owner)),
    withdrawAll: withdrawing(R.withdrawnAll),
    quit: (e) => Effect.asVoid(Deferred.fail(ended, e)),
    fail: (e) => Effect.asVoid(Deferred.fail(ended, e)),
    quitted: Deferred.await(ended),
  };
});

export const openQuestionsLayer: Layer.Layer<OpenQuestions> = Layer.effect(OpenQuestions, makeOpenQuestions);
