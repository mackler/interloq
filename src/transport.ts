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
export const rejectionOf = (_info: RateLimitInfo): Rejection | null => null;

/** What a failed Claude Code call is (issue #68): permanent, a transport fault, or a usage limit with a stated reset. */
export type FailureKind =
  | Readonly<{ kind: "permanent" }>
  | Readonly<{ kind: "transport" }>
  | Readonly<{ kind: "limited"; resetsAtMs: number; limitType: string | null }>;

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

/**
 * What a failed Claude Code call is, by the facts kept of it: a transport fault that a retry could fix, or permanent.
 * Permanent evidence is checked first; `terminalReason` alone is never sufficient.
 */
export const classifyClaude = (failure: ClaudeFailure | null): FailureKind => (isTransport(failure) ? TRANSPORT : PERMANENT);

const isTransport = (failure: ClaudeFailure | null): boolean => {
  if (failure === null) return false;
  const { streamCode, apiStatus, assistantError, retrySeen, subtype } = failure;
  const permanent =
    is4xx(apiStatus) ||
    (assistantError !== null && PERMANENT_ASSISTANT_ERRORS.includes(assistantError)) ||
    (retrySeen !== null && (is4xx(retrySeen.status) || PERMANENT_ASSISTANT_ERRORS.includes(retrySeen.error))) ||
    (subtype !== null && STOPPING_SUBTYPES.includes(subtype));
  if (permanent) return false;
  return (
    (streamCode !== null && NETWORK_CODES.includes(streamCode)) ||
    is5xx(apiStatus) ||
    (assistantError !== null && RETRYABLE_ASSISTANT_ERRORS.includes(assistantError)) ||
    (retrySeen !== null && (retrySeen.status === null || is5xx(retrySeen.status)))
  );
};
