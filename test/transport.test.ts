import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClaudeFailure, classifyClaude, classifyCodex, rejectionOf } from "../src/transport.ts";

const isRetried = (failure: ClaudeFailure | null): boolean => classifyClaude(failure).kind === "transport";

// Issue #26: only positive transport evidence belonging to the failure is retried, and known permanent evidence wins.

const issue26 = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";

test("Codex: the message of #26 is a transport fault", () => {
  assert.equal(classifyCodex(issue26), true);
});

test("Codex: transport patterns are retried", () => {
  for (const m of ["stream disconnected before completion", "read ECONNRESET", "connect ETIMEDOUT 1.2.3.4:443", "socket hang up", "request timed out", "unexpected status 503 Service Unavailable", "getaddrinfo EAI_AGAIN api.openai.com", "connection closed before message completed"]) {
    assert.equal(classifyCodex(m), true, m);
  }
});

test("Codex: permanent evidence is not retried, and wins over transport evidence", () => {
  for (const m of ["You've hit your usage limit. Upgrade to Pro", "rate limit reached", "exceeded your current quota", "unexpected status 400 Bad Request: invalid_json_schema", "Invalid outputSchema", "unexpected status 401 Unauthorized", "stream disconnected: unexpected status 429 Too Many Requests"]) {
    assert.equal(classifyCodex(m), false, m);
  }
});

test("Codex: an unrecognized failure is not retried", () => {
  assert.equal(classifyCodex("something went wrong"), false);
  assert.equal(classifyCodex("no reply"), false);
});

test("Codex: an exec exit is retried only when its stderr shows a transport fault and nothing permanent", () => {
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: stream disconnected before completion"), true);
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: unknown flag"), false);
  assert.equal(classifyCodex("Codex Exec exited with code 1: stream disconnected; usage limit"), false);
});

const none: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null };
const f = (over: Partial<ClaudeFailure>): ClaudeFailure => ({ ...none, ...over });

test("Claude: no facts, or api_error without a status or other evidence, is not retried", () => {
  assert.equal(isRetried(null), false);
  assert.equal(isRetried(none), false);
  assert.equal(isRetried(f({ terminalReason: "api_error" })), false);
});

test("Claude: api_error with 400 is not retried, with 503 it is", () => {
  assert.equal(isRetried(f({ terminalReason: "api_error", apiStatus: 400 })), false);
  assert.equal(isRetried(f({ terminalReason: "api_error", apiStatus: 503 })), true);
});

test("Claude: a stream error with a network code is retried", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]) assert.equal(isRetried(f({ streamCode: code })), true, code);
  assert.equal(isRetried(f({ streamCode: "ERR_SOMETHING" })), false);
});

test("Claude: server_error with status 401 is not retried: permanent evidence wins", () => {
  assert.equal(isRetried(f({ assistantError: "server_error", apiStatus: 401 })), false);
});

test("Claude: an assistant server_error or overloaded with no progress after it is retried", () => {
  assert.equal(isRetried(f({ assistantError: "server_error" })), true);
  assert.equal(isRetried(f({ assistantError: "overloaded" })), true);
});

test("Claude: permanent assistant errors are not retried, even with a network code", () => {
  for (const e of ["rate_limit", "billing_error", "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "invalid_request", "model_not_found", "max_output_tokens", "cloud_credential_error"]) {
    assert.equal(isRetried(f({ assistantError: e, streamCode: "ECONNRESET" })), false, e);
  }
});

test("Claude: an api_retry with status null or 5xx, and no progress after it, is retried", () => {
  assert.equal(isRetried(f({ retrySeen: { status: null, error: "unknown" } })), true);
  assert.equal(isRetried(f({ retrySeen: { status: 503, error: "server_error" } })), true);
});

test("Claude: an api_retry with a 4xx status or a permanent error wins over a network code (P1-R1-2)", () => {
  assert.equal(isRetried(f({ retrySeen: { status: 429, error: "rate_limit" }, streamCode: "ECONNRESET" })), false);
  assert.equal(isRetried(f({ retrySeen: { status: null, error: "rate_limit" }, streamCode: "ECONNRESET" })), false);
});

test("Claude: the stopping subtypes are not retried", () => {
  for (const s of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
    assert.equal(isRetried(f({ subtype: s, streamCode: "ECONNRESET" })), false, s);
  }
});

// W1-R1-1: any 4xx or 5xx status with its reason phrase, not only the listed ones; permanent evidence still first.
test("Codex: every 4xx with its reason phrase is permanent, every 5xx retryable; other numbers are not statuses", () => {
  for (const m of ["408 Request Timeout", "unexpected status 408 Request Timeout", "status 418"]) assert.equal(classifyCodex(m), false, m);
  for (const m of ["501 Not Implemented", "504 Gateway Timeout"]) assert.equal(classifyCodex(m), true, m);
  assert.equal(classifyCodex("retry 2 of 500 items"), false);
  assert.equal(classifyCodex("line 404 of the diff"), false);
  assert.equal(classifyCodex("stream disconnected at line 404 of the diff"), true);
});

// W1-R1-2: the code of the thrown value is evidence too; permanent evidence in the text still wins.
test("Codex: a network code classifies as a transport fault unless the text is permanent", () => {
  assert.equal(classifyCodex("x", "ECONNRESET"), true);
  assert.equal(classifyCodex("usage limit", "ECONNRESET"), false);
  assert.equal(classifyCodex("x", "ENOENT"), false);
});

// Issue #68: a usage-limit rejection with a stated reset is a third kind of failure, waited out; without one it stays permanent.
const RESET_S = 1_791_400_000;
const limitedAt = (resetsAt: number) => ({ kind: "withReset" as const, resetsAtMs: resetsAt * 1000, limitType: "five_hour" });

test("rejectionOf: a rejection with a finite positive reset carries it in milliseconds; otherwise it has none; other statuses are none", () => {
  assert.deepEqual(rejectionOf({ status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour" }), limitedAt(RESET_S));
  assert.deepEqual(rejectionOf({ status: "rejected", rateLimitType: "seven_day" }), { kind: "withoutReset", limitType: "seven_day" });
  for (const resetsAt of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) assert.deepEqual(rejectionOf({ status: "rejected", resetsAt }), { kind: "withoutReset", limitType: null }, String(resetsAt));
  assert.equal(rejectionOf({ status: "allowed", resetsAt: RESET_S }), null);
  assert.equal(rejectionOf({ status: "allowed_warning", resetsAt: RESET_S }), null);
});

test("Claude: a rejection with a reset beside the rate_limit error is limited, with the instant; without a reset it is permanent", () => {
  const withReset = f({ assistantError: "rate_limit", terminalReason: "api_error", rejection: limitedAt(RESET_S) });
  assert.deepEqual(classifyClaude(withReset), { kind: "limited", resetsAtMs: RESET_S * 1000, limitType: "five_hour" });
  assert.deepEqual(classifyClaude(f({ assistantError: "rate_limit", rejection: { kind: "withoutReset", limitType: "five_hour" } })), { kind: "permanent" });
  assert.deepEqual(classifyClaude(f({ assistantError: "rate_limit" })), { kind: "permanent" });
  assert.deepEqual(classifyClaude(f({ apiStatus: 429, rejection: limitedAt(RESET_S) })).kind, "limited");
});

test("Claude: other permanent evidence wins over a rejection with a reset; a network fault or a 5xx beside it does not", () => {
  for (const e of ["billing_error", "authentication_failed"]) assert.deepEqual(classifyClaude(f({ assistantError: e, rejection: limitedAt(RESET_S) })), { kind: "permanent" }, e);
  assert.deepEqual(classifyClaude(f({ apiStatus: 401, rejection: limitedAt(RESET_S) })), { kind: "permanent" });
  assert.equal(classifyClaude(f({ streamCode: "ECONNRESET", rejection: limitedAt(RESET_S) })).kind, "limited");
  assert.equal(classifyClaude(f({ apiStatus: 503, rejection: limitedAt(RESET_S) })).kind, "limited");
});
