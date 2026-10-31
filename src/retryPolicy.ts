// What a call does when its transport retries are used up (issue #201), and how long it waits between the tries it makes
// with no limit while the network is unreachable. Pure: no I/O, no Effect.
import type { Config } from "./schema.ts";
import type { NetworkCode } from "./transport.ts";

/** The kinds of `Exhaustion` of src/retry.ts: ask the developer, fail at once, or try again in the background. */
export type ExhaustionKind = "ask" | "fail" | "background";

/** What an exhausted retry does next. */
export type ExhaustedStep =
  | Readonly<{ kind: "ask" }>
  | Readonly<{ kind: "fail" }>
  | Readonly<{ kind: "background" }>
  | Readonly<{ kind: "network"; code: NetworkCode }>;

/**
 * The step after the retries are used up: a call that fails at once still fails (the context call of a question, so
 * that its question is never delayed); otherwise a fault carrying a network code waits for the network with nothing
 * asked; otherwise the background policy, while the developer is not waiting, tries again in the background; otherwise
 * the developer is asked. `waiting` matters for the background policy alone.
 */
export const exhaustedStep = (policy: ExhaustionKind, waiting: boolean, code: NetworkCode | null): ExhaustedStep => {
  if (policy === "fail") return { kind: "fail" };
  if (code !== null) return { kind: "network", code };
  return policy === "background" && !waiting ? { kind: "background" } : { kind: "ask" };
};

/** The longest wait between two tries for an unreachable network, in seconds; a constant, not a setting. */
export const NETWORK_RETRY_CEILING_SECONDS = 60;

/**
 * The wait before network try `tries` (1, 2, …) in seconds: the configured backoff doubled on past its last retry, at
 * most the larger of NETWORK_RETRY_CEILING_SECONDS and the last configured delay, so a longer configured delay is never
 * shortened.
 */
export const networkRetryDelaySeconds = (config: Pick<Config, "maxTransportRetries" | "transportRetryDelaySeconds">, tries: number): number => {
  const first = config.transportRetryDelaySeconds;
  const cap = Math.max(NETWORK_RETRY_CEILING_SECONDS, first * 2 ** (config.maxTransportRetries - 1));
  return Math.min(first * 2 ** (config.maxTransportRetries + tries - 1), cap);
};
