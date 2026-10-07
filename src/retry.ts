// The transport retry of issue #26: a call that produced no reply, because of a transport fault, is made again with
// backoff; when the retries are exhausted the user decides.

import { Clock, Duration, Effect, Exit, Result } from "effect";
import { AgentUnreachable, type RunError, type TransportFault, type UsageLimited } from "./errors.ts";
import { parseTransportAnswer } from "./input.ts";
import { askOffering, programContext, type QuestionDraft, transportOptions } from "./offer.ts";
import type { QuestionOrigin } from "./question.ts";
import * as prompts from "./prompts.ts";
import { plainPieces } from "./pieces.ts";
import type { Config } from "./schema.ts";
import { type Decider, RunConfig, Store, Ui } from "./services.ts";

/** The waits before retry 1, 2, …, maxTransportRetries in seconds: the configured delay, doubled on each retry. */
export const retryDelays = (config: Pick<Config, "maxTransportRetries" | "transportRetryDelaySeconds">): readonly number[] =>
  Array.from({ length: config.maxTransportRetries }, (_, k) => config.transportRetryDelaySeconds * 2 ** k);

/**
 * The margin added to a usage limit's stated reset (issue #68): the wait lasts until the reset plus this, and never less
 * than this, so that a reset stated in the past or a clock behind the server's cannot make the program call again at
 * once. Neither a threshold nor a setting.
 */
export const USAGE_LIMIT_MARGIN_SECONDS = 60;

const isFault = (e: unknown): e is TransportFault => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "TransportFault";
const isLimited = (e: unknown): e is UsageLimited => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "UsageLimited";

/**
 * Runs `attempt(1)`, and on a TransportFault runs it again with backoff (`retryDelays`): each retry is notified, said and
 * recorded in conversation.md, waits on the Clock (interruptible), and runs `beforeRetry`, the caller's guard, before
 * `attempt(n + 1)`. When the retries are exhausted the user decides, with decision support's offer: another set of
 * retries (the backoff starts again), or a stop, which fails with AgentUnreachable. Any other failure passes through.
 */
export const withTransportRetry = <A, E, R>(
  agent: "claude" | "codex",
  what: string,
  attempt: (n: number) => Effect.Effect<A, E | TransportFault | UsageLimited, R>,
  beforeRetry: Effect.Effect<void, RunError, R>,
  /**
   * "ask": the exhaustion pause; "fail": AgentUnreachable at once, for a call whose failure the caller handles (the
   * context call of a question, S10: it must not ask a question of its own before the question it explains).
   */
  onExhausted: "ask" | "fail" = "ask",
): Effect.Effect<A, Exclude<E, TransportFault | UsageLimited> | AgentUnreachable | RunError, R | Ui | Decider | Store | RunConfig> =>
  Effect.gen(function* () {
    const config = yield* RunConfig;
    const ui = yield* Ui;
    const store = yield* Store;
    const delays = retryDelays(config);
    const say = (text: string) => ui.say(text).pipe(Effect.andThen(store.converse(`${text}\n\n`)));
    let retried = 0;
    /** Whether the last failure was a transport fault, so that a success is a recovered connection. */
    let faulted = false;
    for (let n = 1; ; n++) {
      const result = yield* Effect.result(attempt(n));
      if (Result.isSuccess(result)) {
        if (faulted) yield* ui.notify({ _tag: "TransportRecovered", agent });
        return result.success;
      }
      const error = result.failure;
      if (isLimited(error)) {
        // Issue #68: a usage limit with a stated reset is waited out on the Clock, never asked; the wait is recorded
        // as actually spent when it ends, an interrupted one included (P1-R1-1), before the program prints the summary.
        faulted = false;
        const fromMs = yield* Clock.currentTimeMillis;
        const untilMs = Math.max(error.resetsAtMs, fromMs) + USAGE_LIMIT_MARGIN_SECONDS * 1000;
        yield* ui.notify({ _tag: "UsageLimitWaiting", agent: error.agent, limitType: error.limitType, fromMs, untilMs });
        yield* say(prompts.usageLimitWaitLine(error.agent, error.limitType, untilMs));
        const record = (outcome: "lifted" | "interrupted") =>
          Clock.currentTimeMillis.pipe(Effect.flatMap((endedMs) => store.recordLimitWait({ agent: error.agent, limitType: error.limitType, fromMs, untilMs, endedMs, outcome })));
        yield* Effect.sleep(Duration.millis(untilMs - fromMs)).pipe(Effect.onExit((exit) => record(Exit.isSuccess(exit) ? "lifted" : "interrupted")));
        const waitedMs = (yield* Clock.currentTimeMillis) - fromMs;
        yield* ui.notify({ _tag: "UsageLimitLifted", agent: error.agent, waitedMs });
        yield* say(prompts.usageLimitLiftedLine(error.agent, waitedMs));
        yield* beforeRetry;
        continue;
      }
      if (!isFault(error)) return yield* Effect.fail(error as Exclude<E, TransportFault | UsageLimited>);
      faulted = true;
      const delay = delays[retried];
      if (delay !== undefined) {
        retried++;
        // Issue #63: the wait is announced with its start and end, and kept to that end, so that the page can count it
        // down and its countdown ends when the wait does.
        const fromMs = yield* Clock.currentTimeMillis;
        const untilMs = fromMs + delay * 1000;
        yield* ui.notify({ _tag: "TransportRetrying", agent, attempt: retried, of: delays.length, delaySeconds: delay, fault: error.message, fromMs, untilMs });
        yield* say(prompts.transportRetryLine(agent, retried, delays.length, delay, error.message));
        yield* Effect.sleep(Duration.millis(Math.max(untilMs - (yield* Clock.currentTimeMillis), 0)));
      } else if (onExhausted === "fail") {
        return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault: error.message }));
      } else {
        const origin: QuestionOrigin = { kind: "transport", agent, what, attempts: n, fault: error.message };
        // S10 (G-R1-1): the context of a pause for Claude Code is the program's own at once, since a context call would
        // need the agent that cannot be reached; a pause for Codex gets its context from Claude Code (S12).
        const facts = prompts.transportFacts(agent, what, n, error.message);
        const draft: QuestionDraft = { origin, context: programContext(origin), explanations: [], question: plainPieces(prompts.transportExhaustedQuestion(agent, what)), options: transportOptions(), details: prompts.transportDetails(n, error.message), ...(agent === "codex" ? { explain: facts } : {}), decision: null };
        const answer = yield* askOffering((p) => ui.ask(p), prompts.transportPrompt, draft, (a) => parseTransportAnswer(a) !== null);
        const choice = parseTransportAnswer(answer) ?? "stop";
        yield* store.converse(prompts.transportDecisionLine(choice, agent, what));
        if (choice === "stop") return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault: error.message }));
        retried = 0;
      }
      yield* beforeRetry;
    }
  });
