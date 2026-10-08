# Effect v4 API ledger

Every Effect and @effect/platform-node name that the program uses, with its signature as read from
the installed `.d.ts` files. Versions: `effect` 4.0.1, `@effect/platform-node` 4.0.1
(its `peerDependencies` require `effect ^4.0.1`); every line number was read again from the 4.0.1
declarations on 6 Oct 2026, upgraded from 4.0.0-rc.117. Paths are relative to `node_modules/`.
Write code only against names in this file; add an entry (read from the `.d.ts`) before using a
new name. Material online describes v3 in most cases and is not a source.

## Effect (`effect/dist/Effect.d.ts`)

| Name | Line | Signature (abridged) |
|---|---|---|
| `Effect.gen` | 1892 | `gen(f: () => Generator<Eff, AEff, never>): Effect<AEff, E of Eff, R of Eff>`; also `gen({ self }, f)` |
| `Effect.succeed` | 1414 | `<A>(value: A) => Effect<A>` |
| `Effect.fail` | 2056 | `<E>(error: E) => Effect<never, E>` |
| `Effect.sync` | 1578 | `<A>(thunk: LazyArg<A>) => Effect<A>` |
| `Effect.void` | 1579 (`void_ as void`, 1587) | `Effect<void>`: succeeds with nothing; the web server's refusals and the publisher's empty broadcasts |
| `Effect.die` | 2179 | `(defect: unknown) => Effect<never>` |
| `Effect.try` | 2180 (`try_ as try`) | `({ try: LazyArg<A>, catch: (error: unknown) => E }) => Effect<A, E>`. Used where a synchronous call of foreign code may throw (`sdk.query(...)` starting the CLI): a bare call inside `Effect.gen` turns a throw into a defect (found by a Codex review, 25 Sep) |
| `Effect.tryPromise` | 1242 | `({ try: (signal: AbortSignal) => PromiseLike<A>, catch: (error: unknown) => E }) => Effect<A, E>`. The `signal` is aborted when the fiber is interrupted. This is how SDK calls get their abort signal. |
| `Effect.promise` | 1171 | `<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>) => Effect<A>` |
| `Effect.callback` | 1633 | `(register: (resume, signal: AbortSignal) => void \| Effect<void>) => Effect<A, E, R>` (v3 `async`) |
| `Effect.never` | 1650 | `Effect<never>` |
| `Effect.sleep` | 8138 | `(duration: Duration.Input) => Effect<void>` |
| `Effect.mapError` | 5769 | `(f: (e: E) => E2)` |
| `Effect.catchTag` | 4221 | `(k: tag \| tags, f: (e) => Effect, orElse?)` |
| `Effect.orDie` | 6015 | `(self) => Effect<A, never, R>` |
| `Effect.ensuring` | 12336 | `(finalizer: Effect<X, never, R1>)` |
| `Effect.onExit` | 12693 | `(f: (exit: Exit<A, E>) => Effect<void, XE, XR>)` |
| `Effect.onInterrupt` | 13746 | `(finalizer: (interruptors: ReadonlySet<number>) => Effect<void, XE, XR>)` |
| `Effect.interruptible` | 13721 | `(self) => Effect<A, E, R>` |
| `Effect.acquireRelease` | 12124 | `(acquire: Effect<A, E, R>, release: (a: A, exit: Exit) => Effect<unknown, never, R2>, options?)` → requires `Scope` |
| `Effect.scoped` | 12017 | `(self) => Effect<A, E, Exclude<R, Scope>>` |
| `Effect.provide` | 10641 | `(layer \| [layers] \| context)`, data-first and data-last |
| `Effect.provideService` (read 28 Sep 2026, decision support) | 11537 | `provideService(key, implementation)(self)` or `provideService(self, key, implementation)`: one service. A decision loop provides its fresh `Planner` (D4), and the Decider provides itself to the loop it runs |
| `Effect.provideContext` (read 28 Sep 2026, decision support) | 10898 | `provideContext(context)(self)`: the context captured with `Effect.context` when the Decider was built, so that `decide` requires nothing and an SDK callback can run it |
| `Effect.context` | 10549 | `<R>() => Effect<Context.Context<R>, never, R>` (v3 `Effect.context`/`runtime`) |
| `Effect.contextWith` | 10607 | `(f: (context: Context<R>) => Effect)` |
| `Effect.forkChild` | 16373 | `(self) => Effect<Fiber<A, E>, never, R>` (v3 `fork`; there is no `Effect.fork` in v4) |
| `Effect.forkDetach` (read 26 Sep, web GUI stage 3.3) | 16529 | `forkDetach(options?: { startImmediately?, uninterruptible? })` or `forkDetach(effect, options?)` → `Effect<Fiber<A, E>, never, R>`: the fiber is attached to the global scope and outlives the fiber that forked it (the run manager's runs). **Observed**: without `startImmediately: true`, a fiber interrupted before it first ran never runs its `onExit`; the manager starts it at once |
| `Effect.forEach(items, f, { discard: true })` (read 26 Sep, web GUI stage 3.3) | 939 | runs `f` for every item in order; with `discard: true` the result is `void` (the run manager's broadcast) |
| `Effect.asVoid` (read 26 Sep, web GUI stage 3.3) | 3823 | `(self) => Effect<void, E, R>` |
| `Effect.runFork` | 16662 | `(effect: Effect<A, E, never>, options?: RunOptions) => Fiber<A, E>` |
| `Effect.runPromise` | 16833 | `(effect: Effect<A, E>, options?: RunOptions) => Promise<A>` |
| `Effect.runPromiseExit` | 16901 | `(effect, options?) => Promise<Exit<A, E>>` |
| SDK callbacks (verified stage 5.4) | — | `canUseTool` and the hooks are Promise functions; they run their Effects with `Effect.runPromise(effect, { signal: controller.signal })`, where `controller` is the call's `AbortController`. No context is needed, because the adapter captured the services as values when it was built; `runPromiseWith` stays unused. A failure inside a callback is kept, the controller is aborted (so the SDK ends the call), and the call fails with it. |
| `Ref.make` / `Ref.get` / `Ref.set` (verified stage 5.4) | Ref.d.ts:149 / 175 / 210 | the session id, the stop, and the Codex thread |
| `Effect.onExit` (verified 25 Sep, after a Codex review) | 12693 | `(f: (exit: Exit<A, E>) => Effect<void>)`: runs on success, failure and interruption alike; the Claude Code message loop uses it to abort the call and close the stream on every non-success exit, because `onInterrupt` alone left a typed failure (a record that could not be written) without cleanup |
| `Effect.onInterrupt` (verified stage 5.4) | 13746 | data-last `Effect.onInterrupt(() => Effect.sync(() => controller.abort()))` on the message loop: **observed** that the finalizer runs before `Fiber.interrupt` completes, so the fake SDK saw the abort |
| `Effect.tryPromise` signal (verified stage 5.4) | 1242 | `try: (signal) => thread.run(prompt, { …, signal })`: **observed** aborted on interruption of the fiber |
| `Effect.runPromiseWith` | 16868 | `(context: Context<R>) => (effect: Effect<A, E, R>, options?) => Promise<A>`. **Bridge for SDK callbacks** (canUseTool, hooks): capture `yield* Effect.context<R>()` when the layer is built, then run callback Effects with `Effect.runPromiseWith(ctx)(eff, { signal })`. v4 has no `Runtime.runPromise`. |
| `Effect.suspend` | 1538 | `(effect: LazyArg<Effect<A, E, R>>) => Effect<A, E, R>`; used by `lift` to turn a throwing call into a failure or a defect |
| `Effect.catch` (`catch_ as catch`) | 4143 | `(f: (e: E) => Effect<A2, E2, R2>)`: handles every failure (v3 `catchAll`); used by `liftPromise` |
| `Effect.map` | 3568 | data-first and data-last |
| `Effect.runPromise` rejection | 16833 | **Observed**: a typed failure rejects with the error object itself (`instanceof` the tagged class, `_tag` set), so `haltMessage(e)` can recognise it; a defect rejects with the defect |
| `Option.isSome` / `isNone` | Option.d.ts:350 / 324 | type guards; `Cause.findErrorOption(exit.cause)` is `None` for a defect (observed) |
| `Option.some` / `Option.none` / `Option.getOrNull` (read 28 Sep, issue #6) | Option.d.ts:268 / 239 / 1125 | `some(value)`, `none<A>()`; `getOrNull(self): A \| null`. `Store.loadPlan` returns an Option (no plan before the first write); `src/run.ts` and `src/planSteps.ts` take the plan or null |
| `Effect.acquireRelease` (verified stage 5.3) | 12124 | `(acquire, release: (a, exit) => Effect<unknown, never>) => Effect<A, E, R \| Scope>`; the web server's resources and the run manager's subscriptions |
| `Effect.scoped` (verified stage 5.3) | 12017 | closes the scope of `acquireRelease` at the end or on interruption; **observed**: interrupting a fiber that waits in `ask` closes the interface and removes its listeners from the input |
| `Effect.runSync` / `Effect.runFork` | 16998 / 16662 | `runSync(effect): A`; `runFork(effect): Fiber` |
| `Fiber.interrupt` (verified stage 5.3) | Fiber.d.ts:347 | `(fiber) => Effect<void>`, completes after the finalizers ran |
| `Scope.Scope` | index.d.ts:453 (`export * as Scope`) | the requirement added by `acquireRelease` |
| `Effect.exit` (verified stage 6.1) | 3505 | `(self) => Effect<Exit<A, E>, never, R>`. **Observed**: an interruption of the fiber from outside is *not* captured; the code after `exit` does not run and the fiber ends interrupted. The INTERRUPTED output therefore comes from `Effect.onInterrupt` finalizers (which do run), and the exit code from the teardown. |
| `Effect.ensuring` (verified stage 6.1) | 12336 | **observed** to run on interruption |
| `Effect.never` / `Effect.ignore` / `Effect.failCause` | 1650 / 7293 / 2113 | |
| `Exit.succeed` / `Exit.interrupt(fiberId)` / `Exit.die` | Exit.d.ts | constructors, used by the test of `exitCodeOf` |
| `Cause.hasInterruptsOnly` | Cause.d.ts:596 | true when the cause holds interruptions and nothing else: the 130 case |
| `Layer.build` (verified stage 6.1) | Layer.d.ts:622 | `(layer) => Effect<Context<ROut>, E, RIn \| Scope>`: builds the layer once; `Context.get(context, Planner)` then reaches the same planner instance that `run` uses (for the session id at the end) |
| `Runtime.defaultTeardown` (read stage 6.1) | Runtime.d.ts:93 | exit codes: 0 on success, 130 for interruption-only failures, `errorExitCode` of the squashed error when present, otherwise 1 |
| `NodeRuntime.runMain(effect, { disableErrorReporting?, teardown? })` (read stage 6.1) | @effect/platform-node/dist/NodeRuntime.d.ts; implementation in platform-node-shared/dist/NodeRuntime.js | on SIGINT or SIGTERM it calls `fiber.interruptUnsafe(fiber.id)`, so finalizers run; when the fiber ends it removes the handlers and calls `teardown(exit, code => …)`, which calls `process.exit(code)` when a signal was received or the code is not 0. `disableErrorReporting` only silences the automatic log of unreported non-interruption failures; a custom `teardown` decides the code. |
| `RunOptions` | 16627 | `{ signal?: AbortSignal; scheduler?; uninterruptible?; onFiberStart? }` |

## Fiber, Exit, Cause, Ref

| Name | File:line | Signature |
|---|---|---|
| `Fiber.interrupt` | Fiber.d.ts:347 | `(self: Fiber<A, E>) => Effect<void>` |
| `Fiber.join` | Fiber.d.ts:282 | `(self) => Effect<A, E>` |
| `Exit.isSuccess` / `isFailure` | Exit.d.ts:377 / 404 | type guards |
| `Exit.match` | Exit.d.ts:722 | `({ onSuccess, onFailure: (cause) => X })` |
| `Cause.hasInterrupts` | Cause.d.ts:1021 | `(self: Cause<E>) => boolean` |
| `Cause.hasInterruptsOnly` | Cause.d.ts:596 | `(self) => boolean` |
| `Cause.findErrorOption` | Cause.d.ts:927 | `(input: Cause<E>) => Option<E>` (v3 `failureOption`, which no longer exists) |
| `Cause.findError` | Cause.d.ts:903 | `(self) => Result<E, Cause<never>>` |
| `Cause.squash` | Cause.d.ts:827 | `(self) => unknown` |
| `Cause.pretty` | Cause.d.ts:1192 | `(cause) => string` |
| `Ref.make` / `get` / `set` / `update` | Ref.d.ts:149 / 175 / 210 / 587 | `make(value) => Effect<Ref<A>>`; `set(self, value)`; `update(self, f)` |
| `Ref.updateAndGet` (read 29 Sep, S6 of issues #46 and #59) | Ref.d.ts:617 | dual: `(self, f: (a) => A) => Effect<A>`: the new value; the run's question counter in `src/webUi.ts` |
| `Ref.modify` (read 26 Sep, web GUI stage 3.2) | Ref.d.ts:397 | dual: `(self, f: (a) => readonly [B, A]) => Effect<B>`: reads and replaces in one step (the web Ui's prompt table, the run manager's state) |

## Services and Layers

| Name | File:line | Signature |
|---|---|---|
| `Context.Service` (verified 24 Sep, stage 5.1) | Context.d.ts:188 | `Context.Service<Shape>("Key")` (function form) or `class X extends Context.Service<X, Shape>()("Key") {}` (class form). Replaces v3 `Context.Tag` / `Effect.Service`. The key can be yielded in `Effect.gen` to get the service. |
| `Context.make` / `add` / `get` | Context.d.ts:646 / 683 / 1220 | `make(key, service)`; `get(context, key)` |
| `Layer.succeed` | Layer.d.ts:813 | `(key, resource) => Layer<I>` |
| `Layer.sync` | Layer.d.ts:983 | `(key, evaluate) => Layer<I>` |
| `Layer.effect` | Layer.d.ts:1131 | `(key, effect: Effect<S, E, R>) => Layer<I, E, Exclude<R, Scope>>`. Scoped layers go through `Layer.effect` with `acquireRelease` inside (no `Layer.scoped` in v4). |
| `Layer.mergeAll` | Layer.d.ts:1392 | `(...layers) => Layer<…>` |
| `Layer.provide` / `provideMerge` | Layer.d.ts:1704 / 2116 | `(self, that)` / `(that)(self)` |

## Tagged errors

| Name | File:line | Signature |
|---|---|---|
| `Data.TaggedError` | Data.d.ts:966 | `(tag) => new <A>(args: A) => Cause.YieldableError & { _tag: Tag } & Readonly<A>`. Usage: `class X extends Data.TaggedError("X")<{ readonly f: string }> {}`, which is erasable syntax. A value can be yielded in `Effect.gen` to fail with it. |

## Result (`effect/dist/Result.d.ts`; verified 25 Sep, review stage 2)

| Name | Line | Notes |
|---|---|---|
| `Result.succeed` / `Result.fail` | 262 / 288 | `Result<A, E> = Success<A, E> \| Failure<A, E>` (line 57); the value is `.success`, the error `.failure` |
| `Result.isSuccess` / `Result.isFailure` | 668 / 637 | type guards. A `Result` is not yieldable in `Effect.gen`: a failure is lifted with `Effect.fail(result.failure)` |
| `Result.map` (read 28 Sep, issue #37) | 992 | dual: `map(self, f)` or `map(f)(self)`; transforms the success, keeps the failure. `validatingField` in src/subjects.ts |
| `Result.all` (read 8 Oct 2026, W1-R1-2 of issue #112) | 2530 | `all(results)`: an array of Results becomes one Result of the array of successes, or the first failure. `renderTerms` in src/render.ts |
| `Result.try` (read 26 Sep, web GUI stage 3.1) | Result.d.ts:540 (`try_ as try`, 578) | `({ try: LazyArg<A>, catch: (error: unknown) => E }) => Result<A, E>`; `JSON.parse` of a frame in src/protocol.ts |
| `Effect.fromResult` | Effect.d.ts:2355 | `(result: Result<A, E>) => Effect<A, E>`: lifts a decoder's `Result` (src/store.ts, review stage 4.4; replaces the throw-based `lift`) |
| `Effect.result` | Effect.d.ts:3422 | `(self: Effect<A, E, R>) => Effect<Result<A, E>, never, R>`: the typed failure as a value (used in `src/claude.ts` for the synchronous start of a call; review stage 4.3) |

## Deferred (`effect/dist/Deferred.d.ts`; verified 25 Sep, review stage 4.4)

| Name | Line | Notes |
|---|---|---|
| `Deferred.make` | 146 | `<A, E = never>() => Effect<Deferred<A, E>>`; `export * as Deferred` in index.d.ts:121 |
| `Deferred.fail` | 551 | dual: `(self, error: E) => Effect<boolean>` (false when already completed: the first failure wins) |
| `Deferred.isDone` | 1285 | `(self) => Effect<boolean>` |
| `Deferred.succeed` (read 26 Sep, web GUI stage 3.2) | 1363 | dual: `(self, value: A) => Effect<boolean>` (false when already completed: the first answer to a prompt wins) |
| `Deferred.await` | 147 (`_await`, exported as `await` at 183) | `(self) => Effect<A, E>`: fails with the kept error. The typed channel for a callback failure in `src/claude.ts` (finding 10) |
| `Effect.as` / `Effect.andThen` | Effect.d.ts:3726 / 2780 | `as(value)` replaces the success value; `andThen(effect)` sequences |

## Clock (`effect/dist/Clock.d.ts`; verified 25 Sep, review stage 5.3)

| Name | Line | Notes |
|---|---|---|
| `Clock.Clock` | 186 | `Context.Reference<Clock>`: a service with a default, so `Clock.currentTimeMillis` has no requirement; a test overrides it with `Effect.provideService(Clock.Clock, impl)` (Effect.d.ts:11537, data-last `provideService(key)(impl)(self)`) |
| `Clock.currentTimeMillis` | 260 | `Effect<number>`; the store's `now` (init's archive name, usage times, the checkpoint), and the run manager's publication time of every event (`append` and `end`, issue #1; test/runManager.test.ts provides a stepping clock around `start`, which the run's fiber and its `end` inherit) |
| `Clock` interface | 49 | `currentTimeMillisUnsafe()`, `currentTimeMillis`, `currentTimeNanosUnsafe()`, `currentTimeNanos`, `monotonicTimeNanosUnsafe()`, `monotonicTimeNanos`, `sleep(duration)`; a fixed clock in test/state.test.ts implements all seven |
| `TestClock` | effect/dist/testing/TestClock.d.ts:241 (`layer`), 340 (`setTime`) | present in rc.117 and in 4.0.1; not used (a fixed `Clock` value is enough) |
| `Clock` interface, `sleep` | 146 | `sleep(duration: Duration) => Effect<void>`; `Effect.sleep` is `clockWith((clock) => clock.sleep(…))` (effect/dist/internal/effect.js:2919), so a Clock provided with `Effect.provideService(Clock.Clock, …)` replaces every sleep: `steppingClock` of test/helpers.ts records each and advances its time instead of waiting (issue #68). `withTransportRetry` reads `Clock.currentTimeMillis` before and after a usage-limit wait |
| `FileSystem.OpenFlag` | FileSystem.d.ts:321 | includes `"wx"` (create exclusively); `PlatformError.reason._tag === "AlreadyExists"` (PlatformError.d.ts:73) when the file exists |
| `PlatformError` / `PlatformError.SystemError` | PlatformError.d.ts:141 / 95 | `new PlatformError(reason)`, `new SystemError({ _tag, module, method, description })`: the injected failures of test/helpers.ts `faultyPlatform` |
| `FileSystem.make` | FileSystem.d.ts:385 | builds a `FileSystem` from an implementation (`exists`, `readFileString`, `writeFileString`, `stream`, `sink` derived); `rename(oldPath, newPath)` at 221 |

## Duration (`effect/dist/Duration.d.ts`; read 29 Sep 2026, issue #26)

| Name | Line | Signature (abridged) |
|---|---|---|
| `Duration.millis` | 392 | `(millis: number) => Duration`: a usage-limit wait in `src/retry.ts` (issue #68) |
| `Duration.toMillis` | 483 | `(self: Duration.Input) => number`: the stepping Clock of test/helpers.ts reads a sleep's length |
| `Duration.seconds` | 407 | `(seconds: number) => Duration`: the backoff of `withTransportRetry` in `src/retry.ts`, passed to `Effect.sleep` (a bare number as `Duration.Input` is milliseconds, so the constructor makes the unit explicit). `Effect.sleep` sleeps on the Clock and is interruptible: Ctrl+C during a backoff ends the run at once |

## Semaphore (`effect/dist/Semaphore.d.ts`; verified 25 Sep, review stage 4.3)

| Name | Line | Notes |
|---|---|---|
| `Semaphore.make` | 231 | `(permits: number) => Effect<Semaphore>`; `export * as Semaphore` in index.d.ts:465 |
| `Semaphore#withPermits` | 76 | `(permits) => <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>`: acquires before, releases when the effect completes (also on failure or interruption). `withPermits(1)` serializes the page's dialogue in `src/webUi.ts`, the step reports in `src/planSteps.ts` and the publisher in `src/runManager.ts` |

## Schema (`effect/dist/Schema.d.ts`)

| Name | Line | Notes |
|---|---|---|
| `Schema.Struct` | 2886 | `Struct(fields)`; `.fields` for spreading into a new Struct (there is no `extend`; `fieldsAssign` also exists) |
| `Schema.Struct.Fields` (read 26 Sep, web GUI stage 3.1) | 2680 | the type of a struct's field record; the protocol's `tagged`/`typed` helpers take `F extends Schema.Struct.Fields` and spread it after the tag |
| `Schema.String` / `Number` / `Boolean` / `Unknown` | 2454 / 2520 / 2541 / 2407 | constants |
| `Schema.Finite` / `Int` | 5619 / 5876 | Use `Finite` for numbers in agent schemas: `Number` generates `anyOf [number, "Infinity"/"-Infinity"/"NaN"]` (observed in a probe). |
| `Schema.Literal` / `Literals` | 2140 / 4003 | `Literals(["a", "b"])` generates `{type: "string", enum: [...]}` (observed) |
| `Schema.suspend` (read 28 Sep 2026, decision support step 1.2) | 4104 | `suspend(() => schema)`: a recursive schema; `toJsonSchemaDocument` generates a `$defs` definition that refers to itself (observed; `prototypes/proto-recursive-schema.ts`). The recursive `Argument` of `src/schema.ts` annotates the thunk's result as `Schema.Codec<Argument>` |
| `Schema.Codec` (read 28 Sep 2026) | 816 | `interface Codec<T, E = T, RD = never, RE = never>`: the type of a recursive schema's declaration (`const Argument: Schema.Codec<Argument> = …`) |
| `Schema.Array` | 3722 (`ArraySchema as Array`) | `Array(item)` |
| `Schema.NonEmptyArray` | 3778 | `NonEmptyArray(item)`: Type `readonly [T, ...T[]]`, at least one element; the senses of a presented explanation in src/protocol.ts (issue #112). Not sent to the agents, whose schemas keep a plain `Array` |
| `Schema.isPattern` | 5346 | `isPattern(regExp)`: a `Filter<string>` for `.check(...)`; `/\S/u` gives a non-blank string, the sense of a presented explanation in src/protocol.ts (issue #112) |
| `Schema.NullOr` / `Union` | — / 3964 | `Union(members, options?)`; a union of structs tagged by a literal `kind` generates an `anyOf` of closed objects (observed for `Column`, and for `Block` of issue #36, 30 Sep 2026, in `test/jsonSchema.test.ts`) |
| `Schema.Int` / `Schema.NonEmptyString` (verified 25 Sep, review stage 1) | 5876 / 6482 | integers (no NaN/Infinity); non-empty strings. Used for the program's own records only |
| `.check(...checks)` on a schema (verified 25 Sep) | 141 | `check(...checks: [Check<Type>, ...]) => Rebuild`; the filters are `Schema.isGreaterThanOrEqualTo(min)` (5758), `isLessThanOrEqualTo(max)` (5796), `isBetween` (5818), `isGreaterThan` (5739), `isFinite` (5637); they correspond to JSON Schema `minimum`/`maximum`. There is no `greaterThanOrEqualTo` without the `is` prefix in v4. |
| `Schema.brand` | 4200 | `brand(identifier: B & EnsureSingleBrandKey<B>)(schema)` (4.0.1; in rc.117 `identifier: B`, so a single literal key such as `"IssueId"` type checks as before, while a union of keys is now refused): `NonEmptyString.pipe(Schema.brand("IssueId"))` gives `Type = string & Brand<"IssueId">` (no runtime check beyond the schema's); `IssueId` in src/schema.ts (review stage 4.5) |
| `Brand.Branded<A, Key>` | Brand.d.ts:171 | `A & Brand<Key>`; `export * as Brand` in index.d.ts:53. Used for `ProjectPath` / `RecordPath` (review stage 4.7) |
| `Schema.optionalKey` | 1888 | `optionalKey(schema)`: the key may be absent (the `?:` of `LogEntry`) |
| `Schema.declare` | 399 | `declare(is: (u) => u is T, annotations?)`, used for the stage 1 scaffolding |
| `Schema.fromJsonString` | 6876 | `fromJsonString(schema, options?)`: a string decoded as JSON, then as `schema`. Used for Codex's `finalResponse` and for JSON files. Since 30 Sep 2026 also `parseRelayedQuestion` of `src/question.ts`, with `decodeUnknownResult`, over the JSON text of a relayed question (issue #36). |
| `Schema.decodeUnknownEffect` | 1170 | `(schema, options?: ParseOptions) => (input, options?) => Effect<Type, SchemaError, R>` |
| `Schema.decodeUnknownExit` | 1223 | `(schema, options?) => (input) => Exit<Type, SchemaError>` |
| `Schema.decodeUnknownSync` | 1460 | throws `SchemaError` |
| `Schema.SchemaError` | 949 | class, `_tag: "SchemaError"`, `issue: SchemaIssue.Issue`, `message` is the formatted issue with the path (for example `Expected string\n  at ["issues"][0]["id"]`, observed). Use `message` as the formatted parse issue. |
| `Schema.Decoder<T>` | 838 | `interface Decoder<out T> extends Schema<T>` with `Encoded: unknown`: a `Top` (so `toJsonSchemaDocument` accepts it) that also satisfies `ConstraintDecoder<T>` (so `decodeUnknownSync` accepts it). The type of every schema parameter that is both sent to an agent and used to decode its reply (`planningCall`, `decodeWithRepair`, `Subject.respondSchema` / `applyDecisionsSchema`). |
| `Schema.ConstraintDecoder<T>` | 621 | the constraint of `decodeUnknownSync` / `decodeUnknownExit` (`Schema.Top` does not satisfy it); a generic helper that decodes takes `Out extends Schema.ConstraintDecoder<unknown>` and returns `Out["Type"]` |
| `Schema.isSchemaError` | 977 | type guard |
| `Schema.Type` / `Schema.Schema.Type` | — | `typeof S["Type"]` gives the decoded type |
| `Schema.Top` | 540 | the base interface of every schema; a parameter `schema: Schema.Top` accepts any schema, and `Out extends Schema.Top` with `Out["Type"]` gives the decoded type of the schema passed (used by `Planner.planning`, `planningCall`, `Subject.applyDecisionsSchema`) |
| `Schema.Schema<T>` | 714 | `interface Schema<out T> extends Top { Type: T }`: "lightweight structural constraint" for a schema whose decoded type is `T` (used by `Subject.respondSchema`) |
| `Schema.decodeUnknownResult` | 1337 | `(schema, options?) => (input, options?) => Result<Type, SchemaError>` |
| `ParseOptions.errors` | SchemaAST.d.ts (ParseOptions) | `"first"` (default) or `"all"` |
| `ParseOptions.onExcessProperty` | SchemaAST.d.ts:419 | `"ignore"` (default, strips) or `"error"`. Observed message: `Expected no excess property\n  at ["extra"]`. |
| `Schema.isSchemaError` | 977 | type guard, used where a `decodeUnknownSync` throw is turned into `ConfigInvalid` / `StateFileInvalid` |
| `Struct.mapFields` (on a `Schema.Struct`) | 2848 | `mapFields(f: (fields) => To) => Struct<To>`; with `Struct.map(Schema.optionalKey)` every field becomes optional (`PartialConfig`) |
| `Struct.map` | Struct.d.ts:1101 | `Struct.map(lambda)`: applies a lambda to every value of a struct; `Schema.optionalKey` is such a lambda |
| `SchemaIssue.makeFormatterStandardSchemaV1` | SchemaIssue.d.ts:752 | `({ leafHook?, checkHook? }) => (issue) => { issues: [{ path: PropertyKey[] \| PathSegment[], message }] }`. Observed: `{maxRounds:"5"}` → path `["maxRounds"]`, message `Expected number`; an excess key → `Expected no excess property`; `["a", 2]` for an array of strings → path `["ignorePaths", 1]`. Used by `firstIssue` in src/schema.ts. |
| `SchemaIssue.defaultLeafHook` | SchemaIssue.d.ts:667 | the built-in leaf renderer, passed to the formatter above |
| `Schema.encodeSync` | 1820 | `(schema) => (value: Type) => Encoded`; used by the round-trip properties |
| `FileSystem.readLink` / `stat` (verified stage 2) | FileSystem.d.ts:200 / 232 | `stat` follows symbolic links (Node's `fs.stat`), so the snapshot asks `readLink` first; `Info.type` is `"File" \| "Directory" \| "SymbolicLink" \| …` (line 597) |
| `PlatformError.reason._tag` | PlatformError.d.ts:73, 141 | `SystemErrorTag`: `"NotFound"` for ENOENT (platform-node-shared/dist/internal/utils.js), used to tell a missing path from a failure |
| `Schema.toJsonSchemaDocument` | 10794 | `(schema, options?: ToJsonSchemaOptions) => JsonSchema.Document<"draft-2020-12">`, which returns `{ dialect, schema, definitions }`. The JSON Schema to pass to an agent is `.schema` (plus `$defs` if `definitions` is not empty). |
| `ToJsonSchemaOptions.onExcessProperty` | 10673 | with `"error"`, every object gets `additionalProperties: false` (observed); with the default, `additionalProperties: true`. |

Observed in a probe (not a test): with `onExcessProperty: "error"`, `Literals` and non-optional
fields, the generated object has `required` listing all keys and `additionalProperties: false`,
which is the strict form that Codex requires. `definitions` was empty for plain Structs.

## Platform (verified 24 Sep, stage 5.2; module paths and names as imported)

Imports: `import { FileSystem, Path } from "effect"` (namespaces; the service keys are `FileSystem.FileSystem`,
`Path.Path`); `import { ChildProcess, ChildProcessSpawner } from "effect/process"` (namespaces; the
service class is `ChildProcessSpawner.ChildProcessSpawner`); the Node layers from
`@effect/platform-node/NodeFileSystem`, `.../NodePath`, `.../NodeChildProcessSpawner` (package export `./*`).
In 4.0.0-rc.117 the module was `effect/unstable/process` (`dist/unstable/process/`); 4.0.1 moved the
whole `dist/unstable/` tree to `dist/` and exports `./process` in place of `./unstable/process`, with the
declarations unchanged apart from their relative imports and service keys (`"effect/process/…"`).

| Name | File:line | Notes |
|---|---|---|
| `ChildProcess.make("git", args)` | process/ChildProcess.d.ts:478 | the `(command, args, options?)` overload gives a `StandardCommand` with `_tag`, `command`, `args`, `options` (line 23) |
| `ChildProcessSpawner.spawn(command)` | process/ChildProcessSpawner.d.ts:218 | `Effect<ChildProcessHandle, PlatformError, Scope>`; the handle (line 78) has `exitCode: Effect<ExitCode>`, `stdout` / `stderr` / `all: Stream<Uint8Array>`, `kill`. **Observed**: `string` and `lines` do not fail on a non-zero exit (a plain directory gave "" and exit code 128), so the store uses `spawn` and checks `exitCode` itself. |
| `ChildProcessSpawner.make(spawn)` | process/ChildProcessSpawner.d.ts:213 | builds the whole service from a `spawn` function; used by the test's recording spawner |
| `Stream.decodeText(stream)` / `Stream.mkString` / `Stream.make` / `Stream.empty` | Stream.d.ts:12800 / 15488 / — / 585 | bytes → text → one string |
| `Effect.uninterruptible` / `Effect.uninterruptibleMask` (read 26 Sep, gui-review stage C) | Effect.d.ts:13821 / 13853 | `(self) => Effect<A, E, R>`: the ownership transfers of src/runManager.ts (reservation with its fiber, Started, the gate; record-and-offer) and src/webUi.ts (take, Answered, Deferred.succeed) run as one uninterruptible step; an interruption requested meanwhile takes effect after it (**observed** in the interruption-injection tests: `Fiber.interrupt` waits for the region's end) |
| `Effect.orElseSucceed` (read 8 Oct 2026, issue #29) | Effect.d.ts:7636 | `(self, f: (e) => A2) => Effect<A \| A2, never, R>`: a failure becomes a value; src/web.ts reads `/proc/self/mountinfo` and a failed read becomes the empty text |
| `Effect.timeout` (read 26 Sep, gui-review stage C) | Effect.d.ts:7791 | `timeout(duration)`: fails with a `TimeoutError` when the effect has not completed; used in tests to bound a wait |
| `Stream.runDrain` (read 26 Sep, gui-review stage C) | Stream.d.ts:15437 | `(self) => Effect<void, E, R>`; drains the stderr of `git rev-parse` in src/runManager.ts so the child cannot block on a full pipe |
| `Effect.all([a, b], { concurrency: "unbounded" })` | Effect.d.ts:388 | stdout and stderr are drained together |
| `Effect.andThen` / `Effect.flatMap` / `Effect.mapError` / `Effect.tap` | — / 2525 / 5769 / 3161 | `tap` runs a side effect on the success value and keeps it (the repair call of `planningCall` records itself in a `Ref`) |
| `FileSystem` methods used | FileSystem.d.ts:103–285 | `exists`, `makeDirectory(path, { recursive })`, `readDirectory`, `readFileString`, `readFile`, `writeFileString(path, text, { flag: "a" })` (OpenFlag, line 321), `rename`, `stat` → `Info.size: ByteSize` (a branded bigint: compare with `0n`) |
| `PlatformError` | PlatformError.d.ts:141 | `_tag: "PlatformError"`, `message` getter; mapped to `FileSystemError` / `GitError` in src/store.ts |
| `Layer.provide(self, that)` / `Layer.provideMerge` / `Layer.effect(key, effect)` | Layer.d.ts:1704 / 2116 / 1131 | `platformLayer = provideMerge(NodeChildProcessSpawner.layer, mergeAll(NodeFileSystem.layer, NodePath.layer))` |


| Name | File:line | Notes |
|---|---|---|
| `FileSystem.FileSystem` | effect/dist/FileSystem.d.ts:363 | service; methods `exists`, `makeDirectory`, `readDirectory`, `readFileString`, `writeFileString(path, data, { flag?: "a" … })`, `rename`, `stat`, `remove`, `chmod`; errors are `PlatformError` |
| `Path.Path` | effect/dist/Path.d.ts:250 | service; `join`, `resolve`, `sep`, `relative(from, to)` (line 93; used by the converter of review stage 4.5, since removed) |
| `FileSystem.realPath` | FileSystem.d.ts:204 | `(path) => Effect<string, PlatformError>`; the planning hook uses Node's `fs.promises.realpath` directly (review stage 4.7), since the hook is a Promise callback of the SDK without the service |
| `FileSystem.copyFile` / `remove(path, { force })` (read 26 Sep, work review stage 2.3) | FileSystem.d.ts:84 / 208 | `copyFile(from, to) => Effect<void, PlatformError>`; `remove` with `force: true` ignores a missing path. The work-review tree copies the repository index into a temporary index and removes it with `Effect.ensuring` |
| `ChildProcess.make(command, args, { env, extendEnv })` (read 26 Sep, work review stage 2.3) | effect/dist/process/ChildProcess.d.ts:285–316 (`CommandOptions`) | `env` replaces the inherited environment unless `extendEnv: true`, which merges it over `process.env` (without it the child has no `PATH`); the store sets `GIT_INDEX_FILE` and `GIT_LITERAL_PATHSPECS` this way |
| `NodeFileSystem.layer` | @effect/platform-node/dist/NodeFileSystem.d.ts:9 | `Layer<FileSystem>` |
| `NodePath.layer` | @effect/platform-node/dist/NodePath.d.ts:10 | `Layer<Path>` |
| `NodeServices.layer` | @effect/platform-node/dist/NodeServices.d.ts:33 | all Node services |
| `ChildProcess.make` | effect/dist/process/ChildProcess.d.ts:478 | `make(command, args, options?)` or tagged template; `setCwd(cmd, cwd)` at 867. **Module path `effect/process`** since 4.0.1 (`effect/unstable/process` in the release candidates). |
| `ChildProcessSpawner` | effect/dist/process/ChildProcessSpawner.d.ts:257 | service; `string(command)`, `lines(command)`, `exitCode(command)` → `Effect<…, PlatformError>` |
| `NodeChildProcessSpawner.layer` | @effect/platform-node-shared/dist/NodeChildProcessSpawner.d.ts:41 | `Layer<ChildProcessSpawner, never, FileSystem \| Path>` |
| `NodeRuntime.runMain` | @effect/platform-node/dist/NodeRuntime.d.ts:27 | `runMain(effect, { disableErrorReporting?, teardown? })`. Implementation (platform-node-shared/dist/NodeRuntime.js): on SIGINT or SIGTERM it calls `fiber.interruptUnsafe`, so finalizers run; then `teardown(exit, onExit)` decides the exit code, and the process exits when a signal was received or the code is not 0. |
| `Runtime.Teardown` | effect/dist/Runtime.d.ts:46 | `(exit, onExit: (code: number) => void) => void`; `defaultTeardown` at 93. A custom teardown gives exit code 130 on interruption (decision Q3); `disableErrorReporting: true` keeps the output to the program's own lines. |

## SDK options (verified in node_modules)

| Option | File | Notes |
|---|---|---|
| `Options.abortController?: AbortController` | @anthropic-ai/claude-agent-sdk/sdk.d.ts:1454 | aborts a `query` |
| `Options.outputFormat?: OutputFormat` | sdk.d.ts:1885 | `{ type: "json_schema", schema }` |
| `Query.interrupt()` | sdk.d.ts:2685 | not used; abort goes through `abortController` |
| `TurnOptions.signal?: AbortSignal` | @openai/codex-sdk/dist/index.d.ts:173 | aborts `thread.run` |
| `TurnOptions.outputSchema?: unknown` | index.d.ts:171 | JSON Schema per turn |
| `ThreadOptions.sandboxMode`, `approvalPolicy`, `workingDirectory`, `model` | index.d.ts:246–259 | unchanged from src/codex.ts |

## Schema acceptance proof (plan step 0.4, run 24 Sep 2026)

This proof, and its repetition of 28 Sep 2026, ran on `effect` 4.0.0-rc.117. It covers the schemas as they were on 28 Sep 2026; those changed since are listed in CLAUDE.md under "Not yet known". It has not been run on
4.0.1; `node prototypes/proto-schema.ts <project> prototypes/proto-schema-output` in a project
container settles it.

Run in the development container with `node prototypes/proto-schema.ts /workspace <out>`; the
terminal output is kept as `prototypes/proto-schema-output/run.txt`.

**Result: all 28 calls accepted, 0 not accepted, and every reply decoded** with the Effect schema
(7 schemas × {raw, strict} × {Codex `thread.run` with `outputSchema`, Agent SDK `query` with
`outputFormat: { type: "json_schema" }`}). Times per call: Codex 8–17 s, Agent SDK 4–13 s; the whole
run took about 4 minutes.

So Codex's strict structured output and the Agent SDK both accept what
`Schema.toJsonSchemaDocument(s, { onExcessProperty: "error" }).schema` generates. The chosen variant
is **raw**, recorded in `prototypes/proto-schema-output/CHOSEN`.

The two variants were byte-identical for all seven schemas (checked with a JSON comparison), because
`onExcessProperty: "error"` already yields `additionalProperties: false` and a `required` list of every
key, and none of the seven produced a `$ref`/`$defs`. The strict transform therefore stays in the
program as a tested function and as the fallback if a future Effect version generates a looser schema.

No JSON Schema keyword of the generated documents was rejected. `definitions` was empty for all seven,
so nothing had to be inlined.

## HTTP client (read 8 Oct 2026, Effect 4.0.1, issue #120: the tracker port)

Imports: `import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"`
(http/index.d.ts:19, 39, 44, 49, 54). The live client is `FetchHttpClient.layer`, over Node's global `fetch`
(present from Node 22.18); `@effect/platform-node/NodeHttpClient` `layerUndici` (platform-node/dist/NodeHttpClient.d.ts:124)
was read and is not used, since it adds nothing the tracker needs. A client made by `HttpClient.make` does not fail on a
non-2xx status (only `filterStatusOk` does), so the adapter reads `status` itself.

| Name | File:line | Notes |
|---|---|---|
| `HttpClient.HttpClient` | http/HttpClient.d.ts:112 (service), 49 (interface), 73 (`execute`) | `execute(request): Effect<HttpClientResponse, HttpClientError>`; the tracker adapter requires it, so a test provides a stub |
| `HttpClient.make(f)` | http/HttpClient.d.ts:485 | `f: (request, url: URL, signal, fiber) => Effect<HttpClientResponse, HttpClientError>`; `url` carries the request's URL parameters. The test stub is built with it |
| `HttpClientRequest.HttpClientRequest` | http/HttpClientRequest.d.ts:47 | `method` :49, `url` :50, `urlParams` :51, `headers` :53 (`Headers.Headers`, http/Headers.d.ts:53, a record of lower-case names, `Redactable`), `body` :54 (`HttpBody.HttpBody`; a JSON body is `HttpBody.Uint8Array`, http/HttpBody.d.ts:201, with `text` and `body`) |
| `HttpClientRequest.get(url)` / `patch(url)` | http/HttpClientRequest.d.ts:121 / 145 | |
| `HttpClientRequest.setHeader(key, value)` | http/HttpClientRequest.d.ts:248 | dual |
| `HttpClientRequest.bearerToken(token)` | http/HttpClientRequest.d.ts:373 | sets `Authorization: Bearer <token>`; takes a string or a `Redacted` |
| `HttpClientRequest.setUrlParams(input)` | http/HttpClientRequest.d.ts:556 | replaces parameters of the same name |
| `HttpClientRequest.bodyJsonUnsafe(body)` | http/HttpClientRequest.d.ts:773 | synchronous; encoding may throw, which a plain JSON object of strings cannot. `bodyJson` (:739) returns an Effect failing with `HttpBodyError` and is not used |
| `HttpClientResponse.HttpClientResponse` | http/HttpClientResponse.d.ts:66 | `status` :74; `headers`, `json: Effect<Json, HttpClientError>` and `text` from `HttpIncomingMessage` (http/HttpIncomingMessage.d.ts:58, 60, 61) |
| `HttpClientResponse.fromWeb(request, response)` | http/HttpClientResponse.d.ts:85 | a web `Response` as a client response; the test stub's answers |
| `HttpClientError.HttpClientError` | http/HttpClientError.d.ts:23 | `new HttpClientError({ reason })`; `reason: HttpClientErrorReason` (:258), `RequestError` (:242: `TransportError`, `EncodeError`, `InvalidUrlError`) or `ResponseError` (:250: `StatusCodeError`, `DecodeError`, `EmptyBodyError`). Every reason holds the request, whose headers carry the token, so the adapter never copies an `HttpClientError` into its own errors |
| `HttpClientError.TransportError` | http/HttpClientError.d.ts:62 | `{ request, cause?, description? }`; the stub's scripted network failure |
| `HttpClientError.StatusCodeError` / `DecodeError` / `EmptyBodyError` | http/HttpClientError.d.ts:152 / 183 / 214 | read; not raised by a client without `filterStatusOk`, except `DecodeError` from `json` |
| `FetchHttpClient.layer` | http/FetchHttpClient.d.ts:76 | `Layer<HttpClient>`, the live client (`src/trackerLive.ts`) |

## HTTP server and WebSocket (read 26 Sep 2026, web GUI stage 3.4)

Imports: `import { HttpPlatform, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"`
(http/index.d.ts:79–109), `import type { Socket } from "effect/socket"`, `import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"`.
In 4.0.0-rc.117 these modules were `effect/unstable/http` and `effect/unstable/socket`; 4.0.1 exports them as
`./http` and `./socket` (the `dist/unstable/` tree moved to `dist/`), with the declarations unchanged apart from
their relative imports.
`src/webServer.ts` dispatches on the request itself (method and path) rather than through `HttpRouter`, whose
`add` carries `Request.From` requirement types that the three routes do not need.

| Name | File:line | Notes |
|---|---|---|
| `HttpServerRequest.HttpServerRequest` | http/HttpServerRequest.d.ts:100, 72 | service and interface: `url`, `method`, `upgrade: Effect<Socket.Socket, HttpServerError>` |
| `HttpServerResponse.text(body, { status })` / `empty()` / `file(path)` | http/HttpServerResponse.d.ts:145 / 116 / 303 | `file` is `Effect<HttpServerResponse, PlatformError, HttpPlatform>` |
| `HttpServer.serve(app)` / `serveEffect(app)` | http/HttpServer.d.ts:73 / 149 | `serve` gives a `Layer<never, never, HttpServer \| …>`; `serveEffect` the same as a scoped Effect (the tests) |
| `HttpServer.HttpServer` | http/HttpServer.d.ts:26–45 | service with `serve` and `address: NetAddress.SocketAddress` (`InetAddressV4 \| InetAddressV6` with `port`, or `UnixPathAddress`; net/NetAddress.d.ts:183–236) |
| `NodeHttpServer.layer(() => createServer(), { port })` / `layerTest` | platform-node/dist/NodeHttpServer.d.ts:105 / 122 | `layer` provides `HttpServer`, `NodeServices`, `HttpPlatform`, `Etag.Generator`; `layerTest` an ephemeral port plus `FileSystem`, `Path`, `HttpPlatform`, `HttpClient` |
| Shutdown order of `HttpServer.serveEffect` (read 26 Sep, gui-review stage C, finding 15) | http/HttpServer.d.ts:149; NodeHttpServer.js:54–116 (`make`) | `serve` forks a child scope for the request fibers from the caller's scope and then adds a finalizer that detaches the handlers and awaits `preemptiveShutdown`: `server.close()` bounded by `gracefulShutdownTimeout` (default 20 s). Finalizers run in reverse order, so a finalizer the caller adds **after** `serveEffect` runs before that shutdown and while the request fibers still run: src/web.ts registers the web server's `closeAll` there. **Observed** in test/webServer.test.ts: in that order, interrupting the server with a tab connected completes at once; registered before `serveEffect`, it does not complete within 2 s |
| `Effect.addFinalizer` (read 26 Sep, gui-review stage C) | Effect.d.ts:12297 | `(finalizer: (exit) => Effect<void, never, R>) => Effect<void, never, R \| Scope>` |
| `Effect.race` (read 26 Sep, gui-review stage C) | Effect.d.ts:8263 | `race(self, that)`: the first to succeed; the other is interrupted. A tab's session races its read loop with the server's closing signal |
| `Socket.CloseEvent` (read 26 Sep, gui-review stage C) | socket/Socket.d.ts:213 | `new CloseEvent(code?, reason?)`; `writer.write(closeEvent)` closes the WebSocket (1001, "going away", when the server ends) |
| `Socket.Socket` | socket/Socket.d.ts:53, 95–98 | `reader: Effect<Reader, SocketError, Scope>` with `pull: Effect<NonEmptyReadonlyArray<Uint8Array \| string>, SocketError>`; `writer: Effect<Writer, never, Scope>` with `write(chunk \| CloseEvent)`. **Observed** (Socket.js `fromWebSocket`, and a hang in the first server test): the WebSocket upgrade is accepted only when `reader` is acquired, and `write` waits until then, so a session acquires the reader before it writes. Since 4.0.1 (`makeUpgradeHandler` in @effect/platform-node/dist/NodeHttpServer.js), the WebSocket is closed with a code from the exit of the scope that acquired it (1000 on success, 1001 when only interrupted, 1011 otherwise) where rc.117 called `ws.close()` without a code, and a handshake refused before it completes fails the upgrade with a `SocketOpenError` when the connection closes. The program writes its own `CloseEvent` (1001) when the server ends and reads no close code, so neither change alters its behavior |
| `Queue.unbounded` / `offer` / `take` | Queue.d.ts:557 / 590 / 1624 | the per-connection buffer of broadcast events. `offer` is dual since 4.0.1, `offer(self, message)` or `offer(message)(self)` (rc.117 had the data-first form only); the program uses the data-first form |
| `Queue.dropping` / `Queue.size` (read 26 Sep, gui-review stage E, finding 13) | Queue.d.ts:521 / 1877 | `dropping(capacity)`: `offer` never suspends and returns `false` when the queue is full (the message is dropped). A tab's forwarding queue (src/webServer.ts `subscribeBounded`, bound 1,000): a `false` marks the tab overflowed, and the session closes it so that it recovers by replay |
| `Effect.raceAll` (read 26 Sep, gui-review stage E) | Effect.d.ts:8195 | `raceAll(effects)`: the first to succeed, the others interrupted. A tab's session races its read loop, the server's closing and its own overflow |
| `Effect.forkScoped` | Effect.d.ts:16496 | the connection's forwarding fiber and a stop's interruption, ended with the connection's scope |
| `Effect.option` | Effect.d.ts:3464 | `Effect<Option<A>, never, R>`: an upgrade or reader failure ends the session quietly |
