// The transport retry of issue #26: a call that produced no reply, because of a transport fault, is made again with
// backoff; when the retries are exhausted the user decides.

import { Clock, Deferred, Duration, Effect, Exit, Fiber, Option, Result, Scope } from "effect";
import { AgentUnreachable, type ProcessEnded, type RunError, type TransportFault, type UsageLimited, type UserStopped } from "./errors.ts";
import { parseTransportAnswer } from "./input.ts";
import { type BesideQuestion, openBeside, programContext, type QuestionDraft, transportOptions } from "./offer.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import * as prompts from "./prompts.ts";
import { plainPieces } from "./pieces.ts";
import type { Config } from "./schema.ts";
import { exhaustedStep, networkRetryDelaySeconds } from "./retryPolicy.ts";
import type { LimitWait, LimitWaitBegan } from "./usage.ts";
import { type Decider, RunConfig, Store, Ui } from "./services.ts";

/** The waits before repeat 1, 2, …, count in seconds: the first wait, doubled on each further repeat (issues #26, #171). */
export const backoffDelays = (count: number, firstSeconds: number): readonly number[] =>
  Array.from({ length: count }, (_, k) => firstSeconds * 2 ** k);

/** The waits before retry 1, 2, …, maxTransportRetries in seconds: the configured delay, doubled on each retry. */
export const retryDelays = (config: Pick<Config, "maxTransportRetries" | "transportRetryDelaySeconds">): readonly number[] =>
  backoffDelays(config.maxTransportRetries, config.transportRetryDelaySeconds);

import { type LimitWaitState, NO_LIMIT_WAIT, planLimitWait, USAGE_LIMIT_MARGIN_SECONDS, USAGE_LIMIT_RETRY_SECONDS } from "./limitReset.ts";
export { USAGE_LIMIT_MARGIN_SECONDS };

/**
 * What a call does when its transport retries are used up, unless the last fault carries a network code (issue #201:
 * then every policy but "fail" tries again with no limit and nothing asked, `exhaustedStep` of src/retryPolicy.ts):
 * "ask" the exhaustion pause; "fail" AgentUnreachable at once,
 * for a call whose failure the caller handles (the context call of a question, S10: it must not ask a question of its
 * own before the question it explains); "background" (issue #184, decision G-R1-1) try again every
 * USAGE_LIMIT_RETRY_SECONDS with no limit and nothing asked while `waiting` is false, the developer still answering the
 * interview's agreed questions, and ask as "ask" does once it is true; `untilWaiting` ends a try's sleep at once when the
 * developer reaches the point where he waits for Claude Code.
 */
export type Exhaustion =
  | Readonly<{ kind: "ask" }>
  | Readonly<{ kind: "fail" }>
  | Readonly<{ kind: "background"; waiting: Effect.Effect<boolean>; untilWaiting: Effect.Effect<void> }>;
export const ASK: Exhaustion = { kind: "ask" };
export const FAIL: Exhaustion = { kind: "fail" };

const isFault = (e: unknown): e is TransportFault => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "TransportFault";
const isUserStopped = (e: unknown): e is UserStopped => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "UserStopped";
const isProcessEnded = (e: unknown): e is ProcessEnded => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "ProcessEnded";
const isLimited = (e: unknown): e is UsageLimited => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "UsageLimited";

/**
 * Runs `attempt(1)`, and on a TransportFault runs it again with backoff (`retryDelays`): each retry is notified, said and
 * recorded in conversation.md, waits on the Clock (interruptible), and runs `beforeRetry`, the caller's guard, before
 * `attempt(n + 1)`. When the retries are exhausted the user decides, with decision support's offer: another set of
 * retries (the backoff starts again), or a stop, which fails with AgentUnreachable; except that a fault carrying a
 * network code (issue #201) is tried again with no limit and nothing asked, waits doubling on to
 * NETWORK_RETRY_CEILING_SECONDS, each try notified (NetworkRetrying), said and written, until the call succeeds, fails
 * otherwise, or is interrupted (Stop task); "fail" is never waited for. A ProcessEnded (issue #157, an
 * execution call's Claude Code process that ended) is retried in the same way under the same budget, and when the
 * retries are used up it passes through as it is, with no pause, whatever `onExhausted` says. Any other failure passes
 * through. A UsageLimited (issues #68 and #170) is waited out for as long as planLimitWait decides, with no question
 * and without spending the transport budget, then `beforeRetry` and the next attempt. `purpose` is the purpose the call
 * announces in its AgentCallStarted, put on both wait events, so that the page knows which call's start ends the wait
 * (W4-R2-1 of issue #184).
 */
export const withTransportRetry = <A, E, R>(
  agent: "claude" | "codex",
  purpose: string,
  what: string,
  attempt: (n: number) => Effect.Effect<A, E | TransportFault | UsageLimited, R>,
  beforeRetry: Effect.Effect<void, RunError, R>,
  onExhausted: Exhaustion = ASK,
): Effect.Effect<A, Exclude<E, TransportFault | UsageLimited> | AgentUnreachable | RunError, R | Ui | Decider | Store | RunConfig> =>
  Effect.suspend(() => {
    /** Issue #243: the exhaustion question open beside the call, closed (its prompt cancelled) however the call ends. */
    const held: { close: Effect.Effect<void> } = { close: Effect.void };
    return retrying(agent, purpose, what, attempt, beforeRetry, onExhausted, held).pipe(Effect.ensuring(Effect.suspend(() => held.close)));
  });

const retrying = <A, E, R>(
  agent: "claude" | "codex",
  purpose: string,
  what: string,
  attempt: (n: number) => Effect.Effect<A, E | TransportFault | UsageLimited, R>,
  beforeRetry: Effect.Effect<void, RunError, R>,
  onExhausted: Exhaustion,
  held: { close: Effect.Effect<void> },
): Effect.Effect<A, Exclude<E, TransportFault | UsageLimited> | AgentUnreachable | RunError, R | Ui | Decider | Store | RunConfig> =>
  Effect.gen(function* () {
    const config = yield* RunConfig;
    const ui = yield* Ui;
    const store = yield* Store;
    const delays = retryDelays(config);
    const say = (text: string) => ui.say(text).pipe(Effect.andThen(store.converse(`${text}\n\n`)));
    let retried = 0;
    /** What the usage-limit waits of this call carry to its next refusal (issue #170); a transport fault clears it. */
    let limitState: LimitWaitState = NO_LIMIT_WAIT;
    /** Whether the last failure was a transport fault, so that a success is a recovered connection. */
    let faulted = false;
    /** The background tries of this call since its retries were last used up (issue #184). */
    let tries = 0;
    /** The tries for an unreachable network since the retries were last used up (issue #201). */
    let networkTries = 0;
    /**
     * Issue #215: a wait the developer may end early. Opens it, announces it with its id (`announce`), sleeps until
     * `untilMs` (interruptible, so Stop task ends it), and where the developer ended it, notifies the early end and says
     * and writes it. The code after the wait is the same either way, so the next attempt is the one a wait that ran out
     * would make.
     */
    const endableWait = <AE>(untilMs: number, subject: prompts.WaitSubject, announce: (wait: number) => Effect.Effect<void, AE>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ui.openWait;
          yield* announce(handle.id);
          const end = yield* handle.sleepUntil(untilMs);
          if (end === "endedEarly") yield* reportEarlyEnd(handle.id, subject);
        }),
      );
    const reportEarlyEnd = (wait: number, subject: prompts.WaitSubject) => ui.notify({ _tag: "WaitEndedEarly", wait }).pipe(Effect.andThen(say(prompts.waitEndedLine(subject))));
    /**
     * Issue #243: the exhaustion question, open beside the call while Interloq keeps trying, in a Scope of its own: its
     * handle, and a Deferred its answer completes (set in the Ui's take, so the wait before the next try ends at once).
     */
    let question: Readonly<{ handle: BesideQuestion; scope: Scope.Closeable; answered: Deferred.Deferred<void> }> | null = null;
    const closeQuestion = Effect.suspend(() => {
      const open = question;
      question = null;
      return open === null ? Effect.void : Scope.close(open.scope, Exit.void);
    });
    held.close = closeQuestion;
    /** Fails at once when the question is answered "q" (its producer fails with UserStopped); otherwise never completes. */
    const quitWatch = (open: NonNullable<typeof question>): Effect.Effect<never, UserStopped> =>
      Fiber.join(open.handle.fiber).pipe(
        Effect.matchEffect({ onFailure: (e) => (e._tag === "UserStopped" ? Effect.fail(e) : Effect.never), onSuccess: () => Effect.never }),
      );
    /** The answer the question holds now, read after every attempt and every wait: Stop fails, Retry again starts afresh. */
    const answeredNow = (n: number, lastFault: string) =>
      Effect.gen(function* () {
        if (question === null) return "none" as const;
        const answer = yield* question.handle.answer;
        if (Option.isNone(answer)) return "none" as const;
        const choice = parseTransportAnswer(answer.value) ?? "stop";
        yield* store.converse(prompts.transportDecisionLine(choice, agent, what));
        yield* closeQuestion;
        if (choice === "stop") return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault }));
        retried = 0;
        tries = 0;
        networkTries = 0;
        return "retry" as const;
      });
    let lastFault = "";
    for (let n = 1; ; n++) {
      const open = question;
      const result = yield* Effect.result(open === null ? attempt(n) : Effect.raceFirst(attempt(n), quitWatch(open)));
      // A Stop answered while the attempt ran is honored even where the attempt succeeded: the developer chose to stop.
      yield* answeredNow(n, lastFault);
      if (Result.isSuccess(result)) {
        yield* closeQuestion;
        if (faulted) yield* ui.notify({ _tag: "TransportRecovered", agent });
        return result.success;
      }
      const error = result.failure;
      if (isLimited(error)) {
        // Issues #68 and #170: a usage limit is waited out on the Clock, never asked, for as long as planLimitWait
        // decides from its reset; the wait is recorded when it begins (issue #179: its start, scheduled end and basis,
        // so that a process killed during it leaves the record) and as actually spent when it ends, an interrupted one
        // included (P1-R1-1), before the program prints the summary. Only a stated reset's end is said to lift the
        // limit; nothing written when the wait begins claims it.
        faulted = false;
        const fromMs = yield* Clock.currentTimeMillis;
        const { basis, untilMs, next } = planLimitWait(error.reset, fromMs, limitState);
        limitState = next;
        const ranOut = basis.kind === "reset" ? "lifted" : "elapsed";
        const began: LimitWaitBegan = { agent: error.agent, limitType: error.limitType, basis: basis.kind, fromMs, untilMs };
        const record = (outcome: LimitWait["outcome"]) => Clock.currentTimeMillis.pipe(Effect.flatMap((endedMs) => store.recordLimitWait({ ...began, endedMs, outcome })));
        // Issue #215: the developer may end the wait early; it is recorded as `ended`, and nothing says the limit lifted.
        const end = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* ui.openWait;
            // Issue #233: the failure Codex recorded is said and written, so the real cause is seen, not only the wait.
            if (error.agent === "codex") yield* say(prompts.codexRefusalLine(error.message));
            yield* ui.notify({ _tag: "UsageLimitWaiting", agent: error.agent, purpose, limitType: error.limitType, basis, fromMs, untilMs, wait: handle.id });
            yield* say(prompts.usageLimitWaitLine(error.agent, error.limitType, basis, untilMs));
            // One uninterruptible step from the begin record to the finalizer's attachment, so that an interruption between
            // them takes effect only in the sleep, and the finalizer always clears the checkpoint's note.
            const end = yield* Effect.uninterruptibleMask((restore) =>
              store.recordLimitWaitBegan(began).pipe(Effect.andThen(restore(handle.sleepUntil(untilMs)).pipe(Effect.onExit((exit) => record(Exit.isSuccess(exit) ? (exit.value === "endedEarly" ? "ended" : ranOut) : "interrupted"))))),
            );
            if (end === "endedEarly") yield* reportEarlyEnd(handle.id, { kind: "usageLimit", agent: error.agent, limitType: error.limitType });
            return end;
          }),
        );
        // A wait the developer ended was said above, and never said to lift the limit; a refusal after it is planned
        // from `limitState`, as any refusal is.
        if (end === "ranOut" && basis.kind === "reset") {
          const waitedMs = (yield* Clock.currentTimeMillis) - fromMs;
          yield* ui.notify({ _tag: "UsageLimitLifted", agent: error.agent, waitedMs });
          yield* say(prompts.usageLimitLiftedLine(error.agent, waitedMs));
        } else if (end === "ranOut") yield* say(prompts.usageLimitTryingAgainLine(error.agent, error.limitType));
        yield* beforeRetry;
        continue;
      }
      limitState = NO_LIMIT_WAIT;
      if (isUserStopped(error)) return yield* Effect.fail(error);
      const ended = isProcessEnded(error);
      if (!isFault(error) && !ended) return yield* Effect.fail(error as Exclude<E, TransportFault | UsageLimited>);
      faulted = true;
      const delay = delays[retried];
      if (delay === undefined && ended) return yield* Effect.fail(error as Exclude<E, TransportFault | UsageLimited>);
      if (delay !== undefined) {
        retried++;
        // Issue #63: the wait is announced with its start and end, and kept to that end, so that the page can count it
        // down and its countdown ends when the wait does.
        const fromMs = yield* Clock.currentTimeMillis;
        const untilMs = fromMs + delay * 1000;
        yield* endableWait(untilMs, { kind: "retry", agent }, (wait) =>
          ui.notify({ _tag: "TransportRetrying", agent, purpose, attempt: retried, of: delays.length, delaySeconds: delay, fault: error.message, fromMs, untilMs, wait }).pipe(Effect.andThen(say(prompts.transportRetryLine(agent, retried, delays.length, delay, error.message)))),
        );
        yield* beforeRetry;
        continue;
      }
      // The retries are used up; a ProcessEnded has passed through above, so the failure is a TransportFault.
      const fault = error as TransportFault;
      lastFault = fault.message;
      const waiting = onExhausted.kind === "background" ? yield* onExhausted.waiting : false;
      const step = exhaustedStep(onExhausted.kind, waiting, fault.networkCode);
      switch (step.kind) {
        case "network": {
          // Issue #201: the network is unreachable; the call is tried again with no limit and nothing asked, the waits
          // doubling on to NETWORK_RETRY_CEILING_SECONDS. NetworkRetrying, not TransportRetrying, whose "retry n of m"
          // would claim a bound there is not. Only Stop task ends it.
          networkTries++;
          const delaySeconds = networkRetryDelaySeconds(config, networkTries);
          const fromMs = yield* Clock.currentTimeMillis;
          const untilMs = fromMs + delaySeconds * 1000;
          yield* endableWait(untilMs, { kind: "network", agent }, (wait) =>
            ui.notify({ _tag: "NetworkRetrying", agent, purpose, what, attempt: networkTries, code: step.code, delaySeconds, fault: fault.message, fromMs, untilMs, wait }).pipe(Effect.andThen(say(prompts.networkRetryLine(agent, what, step.code, networkTries, delaySeconds)))),
          );
          break;
        }
        case "background": {
          // Issue #184 (G-R1-1): while the developer answers agreed questions nothing is asked; the call is tried again
          // every USAGE_LIMIT_RETRY_SECONDS with no limit. No TransportRetrying is sent, whose "retry n of m" would claim
          // a bound there is not. The sleep ends at once when the developer comes to wait for Claude Code.
          tries++;
          yield* say(prompts.backgroundRetryLine(agent, what, tries, USAGE_LIMIT_RETRY_SECONDS));
          if (onExhausted.kind === "background") yield* Effect.raceFirst(Effect.sleep(Duration.seconds(USAGE_LIMIT_RETRY_SECONDS)), onExhausted.untilWaiting);
          break;
        }
        case "fail":
          return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault: fault.message }));
        case "ask": {
          // Issue #243: the question no longer waits. It is opened beside the call (where none is open), and the call is
          // tried again every USAGE_LIMIT_RETRY_SECONDS with no limit; the answer is read after every attempt and wait.
          if (question === null) {
            const origin: QuestionOrigin = { kind: "transport", agent, what, attempts: n, fault: fault.message };
            // S10 (G-R1-1): the context of a pause for Claude Code is the program's own at once, since a context call would
            // need the agent that cannot be reached; a pause for Codex gets its context from Claude Code (S12).
            const facts = prompts.transportFacts(agent, what, n, fault.message);
            const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.transportExhaustedQuestion(agent, what)), options: transportOptions(), attached: attachedOf("fault", prompts.transportDetails(n, fault.message)), ...(agent === "codex" ? { explain: facts } : {}), decision: null };
            const scope = yield* Scope.make();
            const answered = yield* Deferred.make<void>();
            const handle = yield* openBeside(scope, prompts.transportPrompt, draft, (a) => parseTransportAnswer(a) !== null, { offer: false, onAccepted: () => Effect.as(Deferred.succeed(answered, undefined), "kept" as const) });
            question = { handle, scope, answered };
          }
          tries++;
          yield* say(prompts.transportBesideLine(agent, what, tries, USAGE_LIMIT_RETRY_SECONDS));
          const open = question;
          yield* Effect.raceFirst(Effect.raceFirst(Effect.sleep(Duration.seconds(USAGE_LIMIT_RETRY_SECONDS)), Deferred.await(open.answered)), quitWatch(open));
          yield* answeredNow(n, fault.message);
          break;
        }
      }
      yield* beforeRetry;
    }
  });
