// The classification of the agents' failures (issue #26): the one place where an SDK's failure is inspected to decide
// whether a retry could fix it. Pure: no I/O, no Effect.

/**
 * What src/claudeEvents.ts keeps of a failed Claude Code call. The terminal facts (the result's status, reason and
 * subtype, the stream error's code) belong to the failure by construction; `assistantError` and `retrySeen` are only
 * what was seen after the last sign of progress.
 */
export type ClaudeFailure = Readonly<{
  streamCode: string | null;
  apiStatus: number | null;
  terminalReason: string | null;
  assistantError: string | null;
  retrySeen: Readonly<{ status: number | null; error: string }> | null;
  subtype: string | null;
  /** The latest usage-limit rejection the stream reported after the last sign of progress (issue #68), or null. */
  rejection: Rejection | null;
  /** The text of the error result (issue #122), or null when the call had no error result (a stream failure, an abort). */
  resultText: string | null;
}>;

/**
 * A usage-limit rejection of Claude Code (issue #68), in its two cases: one that states the instant the limit lifts
 * (milliseconds since the epoch), which the program waits for, and one that does not, which stays permanent.
 */
export type Rejection =
  | Readonly<{ kind: "withReset"; resetsAtMs: number; limitType: string | null }>
  | Readonly<{ kind: "withoutReset"; limitType: string | null }>;

/** The fields of the Agent SDK's SDKRateLimitInfo that the program reads. */
export type RateLimitInfo = Readonly<{ status: string; resetsAt?: number; rateLimitType?: string }>;

/**
 * The rejection a rate-limit event states, or null when its status is not "rejected". `withReset` only for a finite
 * positive `resetsAt` (seconds), so a missing or unusable instant is `withoutReset` by construction.
 */
export const rejectionOf = (info: RateLimitInfo): Rejection | null => {
  if (info.status !== "rejected") return null;
  const limitType = info.rateLimitType ?? null;
  const resetsAt = info.resetsAt;
  return resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0 ? { kind: "withReset", resetsAtMs: resetsAt * 1000, limitType } : { kind: "withoutReset", limitType };
};

/**
 * How the Claude Code process of a call ended abnormally (issue #157): killed by a signal, or exited by itself with a
 * nonzero code. Never both, so a tagged union.
 */
export type ProcessEnd = Readonly<{ kind: "signal"; signal: string }> | Readonly<{ kind: "exit"; code: number }>;

/** The Agent SDK's text for a process killed by a signal, at the start of its error's message. */
export const PROCESS_SIGNAL_PATTERN = /^Claude Code process terminated by signal (SIG[A-Z0-9]+)/;
/** The Agent SDK's text for a process that exited with a code, at the start of its error's message. */
export const PROCESS_EXIT_PATTERN = /^Claude Code process exited with code (-?\d+)\b/;

/** The form of a signal's name; the SDK attaches `signal` only in that form, and "unknown" otherwise. */
const SIGNAL_NAME = /^SIG[A-Z0-9]+$/;

/**
 * The ending of the Claude Code process that a thrown value states, or null. Total. The Agent SDK 0.3.283 throws, from
 * its process transport's `getProcessExitError`, `Error("Claude Code process exited with code N" + tail)` or
 * `Error("Claude Code process terminated by signal SIGX" + tail)`, the tail ". stderr: …" or empty, and attaches to it
 * as own properties `errorClass` with `exitCode` (an integer) or `signal` (a name of the form SIGX, else "unknown").
 * The own fields are read first, then the message; a zero code, a non-integer code and any other text are no ending.
 * test/processEndSeam.test.ts reads both texts and both fields from the SDK's source.
 */
export const processEndOf = (thrown: unknown): ProcessEnd | null => {
  if (typeof thrown !== "object" || thrown === null) return null;
  const own = (key: string): unknown => (Object.hasOwn(thrown, key) ? (thrown as Record<string, unknown>)[key] : undefined);
  const exitCode = own("exitCode");
  if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode !== 0) return { kind: "exit", code: exitCode };
  const signal = own("signal");
  if (typeof signal === "string" && SIGNAL_NAME.test(signal)) return { kind: "signal", signal };
  const message = (thrown as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const bySignal = PROCESS_SIGNAL_PATTERN.exec(message);
  if (bySignal !== null && bySignal[1] !== undefined) return { kind: "signal", signal: bySignal[1] };
  const byExit = PROCESS_EXIT_PATTERN.exec(message);
  const code = byExit === null ? 0 : Number(byExit[1]);
  return Number.isInteger(code) && code !== 0 ? { kind: "exit", code } : null;
};

/** What a failed Claude Code call is (issue #68): permanent, a transport fault, or a usage limit with a stated reset. */
export type FailureKind =
  | Readonly<{ kind: "permanent" }>
  | Readonly<{ kind: "transport" }>
  | Readonly<{ kind: "limited"; resetsAtMs: number; limitType: string | null }>
  | Readonly<{ kind: "contextTooLong" }>;

/**
 * The text of a rejection because the session's history no longer fits Claude Code's context (issue #122). Inferred
 * from the page's message of the run of issue #117, not observed in a record.
 */
export const CONTEXT_TOO_LONG_PATTERN = /prompt is too long/i;

/** The error codes of Node.js that name a dropped, refused or timed-out connection. */
export const NETWORK_CODES: readonly string[] = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"];

/**
 * The HTTP statuses in a message (400 to 599): after "status", "status code" or "HTTP[/version]", or before a reason
 * phrase of capitalized words ("408 Request Timeout", "501 Not Implemented"). Other numbers are not statuses.
 */
const statusesIn = (message: string): readonly number[] => [
  ...[...message.matchAll(/\b(?:status(?: code)?|http(?:\/[\d.]+)?)\s*[:=]?\s*([45]\d\d)\b/gi)].map((m) => Number(m[1])),
  ...[...message.matchAll(/\b([45]\d\d)\s+[A-Z][A-Za-z-]*(?:\s+[A-Z][A-Za-z-]*)*\b/g)].map((m) => Number(m[1])),
];

const codexPermanent = /usage limit|rate limit|quota|invalid_json_schema|outputSchema/i;
const codexTransport = /stream disconnected|connection reset|connection closed|timed out|timeout|WebSocket protocol error|Reconnecting|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN/i;

/** The code of a thrown value (`ECONNRESET`, …), or null: both adapters read it here (W1-R1-2). */
export const errorCode = (e: unknown): string | null => {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
};

/**
 * Whether a failed Codex turn, by its message and the code of the thrown value if any, is a transport fault that a
 * retry could fix; permanent evidence in the message wins.
 */
export const classifyCodex = (message: string, code: string | null = null): boolean => {
  const statuses = statusesIn(message);
  if (codexPermanent.test(message) || statuses.some((s) => s >= 400 && s <= 499)) return false;
  return (code !== null && NETWORK_CODES.includes(code)) || codexTransport.test(message) || statuses.some((s) => s >= 500 && s <= 599);
};

/** The assistant errors of the Agent SDK (SDKAssistantMessageError) that no retry fixes. */
export const PERMANENT_ASSISTANT_ERRORS: readonly string[] = [
  "rate_limit",
  "billing_error",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
  "cloud_credential_error",
];
const RETRYABLE_ASSISTANT_ERRORS: readonly string[] = ["server_error", "overloaded"];
const STOPPING_SUBTYPES: readonly string[] = ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"];
const is4xx = (s: number | null): boolean => s !== null && s >= 400 && s <= 499;
const is5xx = (s: number | null): boolean => s !== null && s >= 500 && s <= 599;

const PERMANENT: FailureKind = { kind: "permanent" };
const TRANSPORT: FailureKind = { kind: "transport" };
const CONTEXT_TOO_LONG: FailureKind = { kind: "contextTooLong" };

/** A rate limit's evidence: a 429, or the rate_limit error. Permanent unless a rejection states its reset (issue #68). */
const isRateLimit = (status: number | null, error: string | null): boolean => status === 429 || error === "rate_limit";
const isOtherPermanentError = (e: string | null): boolean => e !== null && e !== "rate_limit" && PERMANENT_ASSISTANT_ERRORS.includes(e);

/**
 * What a failed Claude Code call is, by the facts kept of it. A rejection because the session is too long is checked
 * first (issue #122), since it usually carries a 4xx status as well; then permanent evidence other than the rate limit;
 * then a usage-limit rejection that states its reset is `limited` (issue #68), whatever else the facts hold; then the
 * rate limit, or a rejection without a reset, is permanent; then the transport evidence. `terminalReason`
 * alone is never sufficient.
 */
export const classifyClaude = (failure: ClaudeFailure | null): FailureKind => {
  if (failure === null) return PERMANENT;
  const { streamCode, apiStatus, assistantError, retrySeen, subtype, rejection, resultText } = failure;
  if (resultText !== null && CONTEXT_TOO_LONG_PATTERN.test(resultText)) return CONTEXT_TOO_LONG;
  const otherPermanent =
    (is4xx(apiStatus) && !isRateLimit(apiStatus, null)) ||
    isOtherPermanentError(assistantError) ||
    (retrySeen !== null && ((is4xx(retrySeen.status) && !isRateLimit(retrySeen.status, null)) || isOtherPermanentError(retrySeen.error))) ||
    (subtype !== null && STOPPING_SUBTYPES.includes(subtype));
  if (otherPermanent) return PERMANENT;
  if (rejection !== null && rejection.kind === "withReset") return { kind: "limited", resetsAtMs: rejection.resetsAtMs, limitType: rejection.limitType };
  const rateLimited = rejection !== null || isRateLimit(apiStatus, assistantError) || (retrySeen !== null && isRateLimit(retrySeen.status, retrySeen.error));
  if (rateLimited) return PERMANENT;
  const transport =
    (streamCode !== null && NETWORK_CODES.includes(streamCode)) ||
    is5xx(apiStatus) ||
    (assistantError !== null && RETRYABLE_ASSISTANT_ERRORS.includes(assistantError)) ||
    (retrySeen !== null && (retrySeen.status === null || is5xx(retrySeen.status)));
  return transport ? TRANSPORT : PERMANENT;
};
