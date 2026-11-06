// The one wait for a refusal for a limit, for every agent (issue #251), an Effect over the Ui, the Store and the Clock:
// planned by planLimitWait from the refusal's reset (issues #68 and #170), recorded when it begins and when it ends
// (issue #179), endable early (issue #215), the refusal's own text said first (issue #233). It reads the agent only as
// data to put on its events, records and lines, and compares no agent by name, so adding an agent changes nothing here.
import { Clock, Effect, Exit } from "effect";
import type { UsageLimited, UserStopped } from "./errors.ts";
import { type LimitWaitState, planLimitWait } from "./limitReset.ts";
import * as prompts from "./prompts.ts";
import { Store, type StoreError, type StoreShape, Ui, type UiShape } from "./services.ts";
import type { LimitWait, LimitWaitBegan } from "./usage.ts";

/** How a wait of the retry loop ended: it ran its course with its value, or the open exhaustion question was answered (issue #243). */
export type WaitOutcome<W> = Readonly<{ _tag: "Waited"; value: W }> | Readonly<{ _tag: "Answered" }>;
export const ANSWERED: Readonly<{ _tag: "Answered" }> = { _tag: "Answered" };
/** The loop's runner of a wait, which also ends it when the open exhaustion question is answered. */
export type ObservedWait = <W, WE>(wait: Effect.Effect<W, WE>) => Effect.Effect<WaitOutcome<W>, WE | UserStopped>;

/** A line said on the page and written to conversation.md. */
export const sayAndWrite = (ui: UiShape, store: StoreShape) => (text: string): Effect.Effect<void, StoreError> =>
  ui.say(text).pipe(Effect.andThen(store.converse(`${text}\n\n`)));
/** Issue #215: the developer ended a wait early: the event, and the line said and written. */
export const reportEarlyEnd = (ui: UiShape, store: StoreShape) => (wait: number, subject: prompts.WaitSubject): Effect.Effect<void, StoreError> =>
  ui.notify({ _tag: "WaitEndedEarly", wait }).pipe(Effect.andThen(sayAndWrite(ui, store)(prompts.waitEndedLine(subject))));

/**
 * Waits out one refusal for a limit, for as long as planLimitWait decides from its reset, and returns what the call's
 * next refusal is planned from and whether the open exhaustion question ended the wait. The wait is recorded when it
 * begins (its start, scheduled end and basis, so that a process killed during it leaves the record) and as actually
 * spent when it ends, an interrupted one included, before the program prints the summary. Only a stated reset's end is
 * said to lift the limit; nothing written when the wait begins claims it.
 */
export const waitOutLimit = (
  error: UsageLimited,
  purpose: string,
  state: LimitWaitState,
  observedWait: ObservedWait,
): Effect.Effect<Readonly<{ next: LimitWaitState; answered: boolean }>, UserStopped | StoreError, Ui | Store> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const say = sayAndWrite(ui, store);
    const { agent, limitType } = error;
    const fromMs = yield* Clock.currentTimeMillis;
    const { basis, untilMs, next } = planLimitWait(error.reset, fromMs, state);
    const ranOut = basis.kind === "reset" ? "lifted" : "elapsed";
    const began: LimitWaitBegan = { agent, limitType, basis: basis.kind, fromMs, untilMs };
    const record = (outcome: LimitWait["outcome"]) => Clock.currentTimeMillis.pipe(Effect.flatMap((endedMs) => store.recordLimitWait({ ...began, endedMs, outcome })));
    // Issue #215: the developer may end the wait early; it is recorded as `ended`, and nothing says the limit lifted.
    const observed = yield* observedWait(Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ui.openWait;
        // Issues #233 and #251: the refusal's own text is said and written, so the real cause is seen, not only the wait.
        yield* say(prompts.limitRefusalLine(agent, error.message));
        yield* ui.notify({ _tag: "UsageLimitWaiting", agent, purpose, limitType, basis, fromMs, untilMs, wait: handle.id });
        yield* say(prompts.usageLimitWaitLine(agent, limitType, basis, untilMs));
        // One uninterruptible step from the begin record to the finalizer's attachment, so that an interruption between
        // them takes effect only in the sleep, and the finalizer always clears the checkpoint's note.
        const end = yield* Effect.uninterruptibleMask((restore) =>
          store.recordLimitWaitBegan(began).pipe(Effect.andThen(restore(handle.sleepUntil(untilMs)).pipe(Effect.onExit((exit) => record(Exit.isSuccess(exit) ? (exit.value === "endedEarly" ? "ended" : ranOut) : "interrupted"))))),
        );
        if (end === "endedEarly") yield* reportEarlyEnd(ui, store)(handle.id, { kind: "usageLimit", agent, limitType });
        return end;
      }),
    ));
    // An answer that ended the wait interrupted its sleep, which the finalizer recorded as interrupted; nothing says the
    // limit lifted, and the caller reads the answer before the next attempt.
    if (observed._tag === "Answered") return { next, answered: true };
    // A wait the developer ended was said above, and never said to lift the limit; a refusal after it is planned from
    // `next`, as any refusal is.
    if (observed.value === "ranOut" && basis.kind === "reset") {
      const waitedMs = (yield* Clock.currentTimeMillis) - fromMs;
      yield* ui.notify({ _tag: "UsageLimitLifted", agent, limitType, waitedMs });
      yield* say(prompts.usageLimitLiftedLine(agent, limitType, waitedMs));
    } else if (observed.value === "ranOut") yield* say(prompts.usageLimitTryingAgainLine(agent, limitType));
    return { next, answered: false };
  });
