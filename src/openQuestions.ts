// The questions open beside the run (issue #243), an Effect service of every run: the run's own Scope, in which a
// question that outlives the effect that presented it is forked, and the end of the run by such a question (an answer
// "q" or "/quit", or a producer that failed). An edge only in that it holds a Deferred and a Scope.
import { Deferred, Effect, Layer, Scope } from "effect";
import type { RunError, UserStopped } from "./errors.ts";
import { OpenQuestions, type OpenQuestionsShape } from "./services.ts";

/** Scoped to the run: closing the run's scope interrupts every question forked in it, cancelling its prompt. */
export const makeOpenQuestions: Effect.Effect<OpenQuestionsShape, never, Scope.Scope> = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
  const ended = yield* Deferred.make<never, UserStopped | RunError>();
  return {
    scope,
    quit: (e) => Effect.asVoid(Deferred.fail(ended, e)),
    fail: (e) => Effect.asVoid(Deferred.fail(ended, e)),
    quitted: Deferred.await(ended),
  };
});

export const openQuestionsLayer: Layer.Layer<OpenQuestions> = Layer.effect(OpenQuestions, makeOpenQuestions);
