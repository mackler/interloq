// A tracker's refusal for its rate limit (pure; issue #219): when the tracker says the limit resets, read from the
// answer's headers, and how long a request waits before it is made again.

/** When a rate-limited request may be made again, as the tracker's answer states it. */
export type RateLimitReset =
  | Readonly<{ _tag: "After"; seconds: number }>
  | Readonly<{ _tag: "At"; epochMs: number }>
  | Readonly<{ _tag: "Unstated" }>;

export type Headers = Readonly<Record<string, string | undefined>>;

/** The seconds added after a stated reset, so the request does not arrive before the tracker's window turns. */
export const TRACKER_RATE_LIMIT_MARGIN_SECONDS = 1;
/** The wait where no reset is stated: GitLab's window is one minute. A constant, not a setting. */
export const TRACKER_RATE_LIMIT_FALLBACK_SECONDS = 60;

const WHOLE_SECONDS = /^\s*(\d+)\s*$/u;
/** A non-negative whole number of seconds, or null. */
const secondsOf = (text: string | undefined): number | null => {
  const match = text === undefined ? null : WHOLE_SECONDS.exec(text);
  return match === null || match[1] === undefined ? null : Number(match[1]);
};

/** `retry-after`: seconds (After) or an HTTP date (At); null where it is absent or neither. */
const retryAfterOf = (text: string | undefined): RateLimitReset | null => {
  const seconds = secondsOf(text);
  if (seconds !== null) return { _tag: "After", seconds };
  if (text === undefined) return null;
  const epochMs = Date.parse(text);
  return Number.isNaN(epochMs) ? null : { _tag: "At", epochMs };
};

/** An instant in epoch seconds (GitLab's `ratelimit-reset`, GitHub's `x-ratelimit-reset`), or null. */
const epochOf = (text: string | undefined): RateLimitReset | null => {
  const seconds = secondsOf(text);
  return seconds === null ? null : { _tag: "At", epochMs: seconds * 1000 };
};

/**
 * The reset the answer's headers state (their names lower-case, as Effect's HttpClientResponse gives them): `retry-after`
 * first, then GitLab's `ratelimit-reset`, then GitHub's `x-ratelimit-reset`; an unparsable header is skipped.
 */
export const rateLimitResetOf = (headers: Headers): RateLimitReset =>
  retryAfterOf(headers["retry-after"]) ?? epochOf(headers["ratelimit-reset"]) ?? epochOf(headers["x-ratelimit-reset"]) ?? { _tag: "Unstated" };

/** The instant the request is made again, and whether the tracker stated it; never before now. */
export const rateLimitUntil = (reset: RateLimitReset, nowMs: number): Readonly<{ untilMs: number; stated: boolean }> => {
  const margin = TRACKER_RATE_LIMIT_MARGIN_SECONDS * 1000;
  switch (reset._tag) {
    case "After":
      return { untilMs: nowMs + reset.seconds * 1000 + margin, stated: true };
    case "At":
      return { untilMs: Math.max(reset.epochMs, nowMs) + margin, stated: true };
    case "Unstated":
      return { untilMs: nowMs + TRACKER_RATE_LIMIT_FALLBACK_SECONDS * 1000, stated: false };
  }
};

/**
 * Whether GitHub's answer is its rate limit: a 429, or a 403 with no requests remaining or a `retry-after` (GitHub
 * answers its primary and secondary rate limits with either status), so a limit is never read as a refused credential.
 */
export const isGithubRateLimit = (status: number, headers: Headers): boolean =>
  status === 429 || (status === 403 && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined));
