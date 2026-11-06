// The transport retry of issue #26: a call that produced no reply, because of a transport fault, is made again with
// backoff; when the retries are exhausted the user decides.

import type { Agent } from "./agents.ts";
import { ANSWERED, reportEarlyEnd, sayAndWrite, type WaitOutcome, waitOutLimit } from "./limitWait.ts";
import { Clock, Deferred, Duration, Effect, Fiber, Option, Result } from "effect";
import { AgentUnreachable, type ProcessEnded, type RunError, type TransportFault, type UsageLimited, type UserStopped } from "./errors.ts";
import { parseTransportAnswer } from "./input.ts";
import { CLOSED_SLOT, closeSlot, openBeside, type OpenBeside, openInSlot, programContext, type QuestionDraft, type SlotCell, slotQuestion, transportOptions } from "./offer.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import * as prompts from "./prompts.ts";
import { plainPieces } from "./pieces.ts";
import type { Config } from "./schema.ts";
import { exhaustedStep, networkRetryDelaySeconds } from "./retryPolicy.ts";
import { type Decider, RunConfig, Store, Ui } from "./services.ts";

/** The waits before repeat 1, 2, …, count in seconds: the first wait, doubled on each further repeat (issues #26, #171). */
export const backoffDelays = (count: number, firstSeconds: number): readonly number[] =>
  Array.from({ length: count }, (_, k) => firstSeconds * 2 ** k);

/** The waits before retry 1, 2, …, maxTransportRetries in seconds: the configured delay, doubled on each retry. */
export const retryDelays = (config: Pick<Config, "maxTransportRetries" | "transportRetryDelaySeconds">): readonly number[] =>
  backoffDelays(config.maxTransportRetries, config.transportRetryDelaySeconds);

import { type LimitWaitState, NO_LIMIT_WAIT, USAGE_LIMIT_MARGIN_SECONDS, USAGE_LIMIT_RETRY_SECONDS } from "./limitReset.ts";
export { USAGE_LIMIT_MARGIN_SECONDS };

/**
 * What a call does when its transport retries are used up, unless the last fault carries a network code (issue #201:
 * then every policy but "fail" tries again with no limit and nothing asked, `exhaustedStep` of src/retryPolicy.ts):
 * "ask" the exhaustion pause; "fail" AgentUnreachable at once,
 * for a call whose failure the caller handles (the context call of a question, S10: it must not ask a question of its
 * own before the question it explains); "background" (issue #184, decision G-R1-1) try again every
 * USAGE_LIMIT_RETRY_SECONDS with no limit and nothing asked while `waiting` is false, the developer still answering the
 * clarification's agreed questions, and ask as "ask" does once it is true; `untilWaiting` ends a try's sleep at once when the
 * developer reaches the point where he waits for Claude Code.
 */
export type Exhaustion =
  | Readonly<{ kind: "ask" }>
  | Readonly<{ kind: "fail" }>
  | Readonly<{ kind: "background"; waiting: Effect.Effect<boolean>; untilWaiting: Effect.Effect<void> }>;
export const ASK: Exhaustion = { kind: "ask" };
export const FAIL: Exhaustion = { kind: "fail" };

/** How a wait of the loop ended: by itself, or by the open exhaustion question's answer (W1-R1-1). */


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
  agent: Agent,
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
  agent: Agent,
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
    const say = sayAndWrite(ui, store);
    const earlyEnd = reportEarlyEnd(ui, store);
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
          if (end === "endedEarly") yield* earlyEnd(handle.id, subject);
        }),
      );
    /**
     * Issue #243: the exhaustion question, open beside the call while Interloq keeps trying, in a Scope of its own: its
     * handle, and a Deferred its answer completes (set in the Ui's take, so the wait before the next try ends at once).
     */
    const cell: SlotCell = { slot: CLOSED_SLOT };
    const closeQuestion = closeSlot(cell);
    held.close = closeQuestion;
    /** Fails at once when the question is answered "q" (its producer fails with UserStopped); otherwise never completes. */
    const quitWatch = (open: OpenBeside): Effect.Effect<never, UserStopped> =>
      Fiber.join(open.handle.fiber).pipe(
        Effect.matchEffect({ onFailure: (e) => (e._tag === "UserStopped" ? Effect.fail(e) : Effect.never), onSuccess: () => Effect.never }),
      );
    /** The answer the question holds now, read after every attempt and every wait: Stop fails, Retry again starts afresh. */
    const answeredNow = (n: number, lastFault: string) =>
      Effect.gen(function* () {
        const question = slotQuestion(cell.slot);
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
    /**
     * W1-R1-1 (work review 1 of the run of 5 Nov 2026): runs a wait; while the exhaustion question is open, the wait also
     * ends when the question is answered (`Answered`), and fails with UserStopped when it is answered q. Every wait of
     * the loop goes through it, so the answer is read before the next attempt however long the wait would have lasted.
     */
    const observedWait = <W, WE>(wait: Effect.Effect<W, WE>): Effect.Effect<WaitOutcome<W>, WE | UserStopped> => {
      const open = slotQuestion(cell.slot);
      const waited = Effect.map(wait, (value): WaitOutcome<W> => ({ _tag: "Waited", value }));
      if (open === null) return waited;
      const answered = Effect.as(Deferred.await(open.answered), ANSWERED as WaitOutcome<W>);
      return Effect.raceFirst(waited, Effect.raceFirst(answered, quitWatch(open)));
    };
    let lastFault = "";
    for (let n = 1; ; n++) {
      const open = slotQuestion(cell.slot);
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
        // Issues #68, #170, #179, #215, #233 and #251: a refusal for a limit, of any agent, is waited out by the one wait
        // of src/limitWait.ts; an answer that ended it, and a wait that ran out, both go on to the next attempt.
        faulted = false;
        limitState = (yield* waitOutLimit(error, purpose, limitState, observedWait)).next;
        yield* answeredNow(n, lastFault);
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
        yield* observedWait(
          endableWait(untilMs, { kind: "retry", agent }, (wait) =>
            ui.notify({ _tag: "TransportRetrying", agent, purpose, attempt: retried, of: delays.length, delaySeconds: delay, fault: error.message, fromMs, untilMs, wait }).pipe(Effect.andThen(say(prompts.transportRetryLine(agent, retried, delays.length, delay, error.message)))),
          ),
        );
        yield* answeredNow(n, error.message);
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
          yield* observedWait(
            endableWait(untilMs, { kind: "network", agent }, (wait) =>
              ui.notify({ _tag: "NetworkRetrying", agent, purpose, what, attempt: networkTries, code: step.code, delaySeconds, fault: fault.message, fromMs, untilMs, wait }).pipe(Effect.andThen(say(prompts.networkRetryLine(agent, what, step.code, networkTries, delaySeconds)))),
            ),
          );
          yield* answeredNow(n, fault.message);
          break;
        }
        case "background": {
          // Issue #184 (G-R1-1): while the developer answers agreed questions nothing is asked; the call is tried again
          // every USAGE_LIMIT_RETRY_SECONDS with no limit. No TransportRetrying is sent, whose "retry n of m" would claim
          // a bound there is not. The sleep ends at once when the developer comes to wait for Claude Code.
          tries++;
          yield* say(prompts.backgroundRetryLine(agent, what, tries, USAGE_LIMIT_RETRY_SECONDS));
          if (onExhausted.kind === "background") yield* observedWait(Effect.raceFirst(Effect.sleep(Duration.seconds(USAGE_LIMIT_RETRY_SECONDS)), onExhausted.untilWaiting));
          yield* answeredNow(n, fault.message);
          break;
        }
        case "fail":
          return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault: fault.message }));
        case "ask": {
          // Issue #243: the question no longer waits. It is opened beside the call (where none is open), and the call is
          // tried again every USAGE_LIMIT_RETRY_SECONDS with no limit; the answer is read after every attempt and wait.
          let open = slotQuestion(cell.slot);
          if (open === null) {
            const origin: QuestionOrigin = { kind: "transport", agent, what, attempts: n, fault: fault.message };
            // S10 (G-R1-1): the context of a pause for Claude Code is the program's own at once, since a context call would
            // need the agent that cannot be reached; a pause for Codex gets its context from Claude Code (S12).
            const facts = prompts.transportFacts(agent, what, n, fault.message);
            const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.transportExhaustedQuestion(agent, what)), options: transportOptions(), attached: attachedOf("fault", prompts.transportDetails(n, fault.message)), ...(agent === "codex" ? { explain: facts } : {}), decision: null };
            // W6-R1-1: the Scope is recorded before the question is presented, so the call's cleanup closes it whenever it ends.
            open = yield* openInSlot(cell, (scope, answered) => openBeside(scope, prompts.transportPrompt, draft, (a) => parseTransportAnswer(a) !== null, { offer: false, onAccepted: () => Effect.as(Deferred.succeed(answered, undefined), "kept" as const) }));
          }
          tries++;
          yield* say(prompts.transportBesideLine(agent, what, tries, USAGE_LIMIT_RETRY_SECONDS));
          yield* observedWait(Effect.sleep(Duration.seconds(USAGE_LIMIT_RETRY_SECONDS)));
          yield* answeredNow(n, fault.message);
          break;
        }
      }
      yield* beforeRetry;
    }
  });
