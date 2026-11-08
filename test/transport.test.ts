import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_TOO_LONG_PATTERN, type ClaudeFailure, classifyClaude, classifyCodex, processEndOf, rejectionOf } from "../src/transport.ts";
import { CODEX_CAPACITY_TYPE, CODEX_QUOTA_TYPE, CODEX_RATE_LIMIT_TYPE, CODEX_USAGE_LIMIT_TYPE, timeOfDayIn } from "../src/limitReset.ts";
import { exitText, recordedFailureText } from "../src/codexArgs.ts";

const isRetried = (failure: ClaudeFailure | null): boolean => classifyClaude(failure).kind === "transport";

// Issue #26: only positive transport evidence belonging to the failure is retried, and known permanent evidence wins.

const issue26 = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";

test("Codex: the message of #26 is a transport fault", () => {
  assert.equal(classifyCodex(issue26).kind === "transport", true);
});

test("Codex: transport patterns are retried", () => {
  for (const m of ["stream disconnected before completion", "read ECONNRESET", "connect ETIMEDOUT 1.2.3.4:443", "socket hang up", "request timed out", "unexpected status 503 Service Unavailable", "getaddrinfo EAI_AGAIN api.openai.com", "connection closed before message completed"]) {
    assert.equal(classifyCodex(m).kind === "transport", true, m);
  }
});

test("Codex: permanent evidence is not retried, and wins over transport evidence", () => {
  for (const m of ["unexpected status 400 Bad Request: invalid_json_schema", "Invalid outputSchema", "unexpected status 401 Unauthorized", "stream disconnected: unexpected status 403 Forbidden"]) {
    assert.deepEqual(classifyCodex(m), { kind: "permanent" }, m);
  }
});

// Issue #233 (the developer's decision of 2 Nov 2026): a 429 waits and tries again; a quota stays permanent.
const limited = (limitType: string, reset: unknown = { kind: "unknown" }) => ({ kind: "limited", reset, limitType });
test("Codex: a 429 or a rate limit is limited with the rate type", () => {
  for (const m of ["exceeded retry limit, last status: 429 Too Many Requests", "stream disconnected: unexpected status 429 Too Many Requests", "rate limit reached", "Too Many Requests", "Codex Exec exited with code 1: exceeded retry limit, last status: 429 Too Many Requests"]) {
    assert.deepEqual(classifyCodex(m), limited(CODEX_RATE_LIMIT_TYPE), m);
  }
});

// Issue #251 (the developer's instruction of 3 Nov 2026): every Codex refusal a later attempt can succeed past waits.
const CAPACITY = "Selected model is at capacity. Please try a different model.";
test("Codex: a model at capacity or overloaded is limited with the capacity type", () => {
  for (const m of [CAPACITY, `${CAPACITY} (Codex Exec exited with code 1: Reading prompt from stdin...)`, "The server is overloaded, please try again", "unexpected status 503: model overloaded"]) {
    assert.deepEqual(classifyCodex(m), limited(CODEX_CAPACITY_TYPE), m);
  }
});

test("Codex: a usage limit and a quota are limited with their types, a 429 naming one included", () => {
  for (const m of ["You've hit your usage limit. Upgrade to Pro", "You've hit your usage limit. Try again later.", "429 Too Many Requests: usage limit reached"]) {
    assert.deepEqual(classifyCodex(m), limited(CODEX_USAGE_LIMIT_TYPE), m);
  }
  for (const m of ["exceeded your current quota", "Quota exceeded. Check your plan and billing details.", "status 429: insufficient_quota", "rate limit: you exceeded your current quota"]) {
    assert.deepEqual(classifyCodex(m), limited(CODEX_QUOTA_TYPE), m);
  }
});

test("Codex: the session file's reset is kept for a usage limit, a quota and a rate limit, never for capacity", () => {
  const reset = { kind: "instant", atMs: Date.UTC(2026, 10, 3, 20) } as const;
  assert.deepEqual(classifyCodex("You've hit your usage limit.", null, reset), limited(CODEX_USAGE_LIMIT_TYPE, reset));
  assert.deepEqual(classifyCodex("exceeded your current quota", null, reset), limited(CODEX_QUOTA_TYPE, reset));
  assert.deepEqual(classifyCodex("429 Too Many Requests", null, reset), limited(CODEX_RATE_LIMIT_TYPE, reset));
  assert.deepEqual(classifyCodex(CAPACITY, null, reset), limited(CODEX_CAPACITY_TYPE));
});

test("Codex: a refusal no wait can fix stays permanent whatever limit words it holds", () => {
  for (const m of [
    "unexpected status 401 Unauthorized",
    "unexpected status 401 Unauthorized: usage limit",
    "invalid_json_schema: quota",
    "Invalid outputSchema",
    "model_not_found: The model `gpt-9` does not exist or you do not have access to it.",
    "unknown model gpt-9",
    "invalid api key",
    "You are not logged in. Please log in again.",
    "To use Codex with your ChatGPT plan, upgrade to Plus",
  ]) {
    assert.deepEqual(classifyCodex(m), { kind: "permanent" }, m);
  }
});

test("Codex: an unrecognized failure is not retried", () => {
  assert.equal(classifyCodex("something went wrong").kind === "transport", false);
  assert.equal(classifyCodex("no reply").kind === "transport", false);
});

test("Codex: an exec exit is retried only when its stderr shows a transport fault and nothing permanent", () => {
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: stream disconnected before completion").kind === "transport", true);
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: unknown flag").kind === "transport", false);
  assert.equal(classifyCodex("Codex Exec exited with code 1: stream disconnected; usage limit").kind === "transport", false);
  assert.equal(classifyCodex("Codex Exec exited with code 1: stream disconnected; invalid_json_schema").kind === "transport", false);
});

const none: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null };
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
  for (const m of ["408 Request Timeout", "unexpected status 408 Request Timeout", "status 418"]) assert.equal(classifyCodex(m).kind === "transport", false, m);
  for (const m of ["501 Not Implemented", "504 Gateway Timeout"]) assert.equal(classifyCodex(m).kind === "transport", true, m);
  assert.equal(classifyCodex("retry 2 of 500 items").kind === "transport", false);
  assert.equal(classifyCodex("line 404 of the diff").kind === "transport", false);
  assert.equal(classifyCodex("stream disconnected at line 404 of the diff").kind === "transport", true);
});

// W1-R1-2: the code of the thrown value is evidence too; permanent evidence in the text still wins.
test("Codex: a network code classifies as a transport fault unless the text is permanent", () => {
  assert.equal(classifyCodex("x", "ECONNRESET").kind === "transport", true);
  assert.equal(classifyCodex("usage limit", "ECONNRESET").kind === "transport", false);
  assert.equal(classifyCodex("x", "ENOENT").kind === "transport", false);
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

test("Claude: a rejection with a reset beside the rate_limit error is limited, with the instant; without a reset it has no known end", () => {
  const withReset = f({ assistantError: "rate_limit", terminalReason: "api_error", rejection: limitedAt(RESET_S) });
  assert.deepEqual(classifyClaude(withReset), { kind: "limited", reset: { kind: "instant", atMs: RESET_S * 1000 }, limitType: "five_hour" });
  assert.deepEqual(classifyClaude(f({ assistantError: "rate_limit", rejection: { kind: "withoutReset", limitType: "five_hour" } })), { kind: "limited", reset: { kind: "unknown" }, limitType: "five_hour" });
  assert.deepEqual(classifyClaude(f({ assistantError: "rate_limit" })), { kind: "limited", reset: { kind: "unknown" }, limitType: null });
  assert.deepEqual(classifyClaude(f({ apiStatus: 429, rejection: limitedAt(RESET_S) })).kind, "limited");
});

test("Claude: other permanent evidence wins over a rejection with a reset; a network fault or a 5xx beside it does not", () => {
  for (const e of ["billing_error", "authentication_failed"]) assert.deepEqual(classifyClaude(f({ assistantError: e, rejection: limitedAt(RESET_S) })), { kind: "permanent" }, e);
  assert.deepEqual(classifyClaude(f({ apiStatus: 401, rejection: limitedAt(RESET_S) })), { kind: "permanent" });
  assert.equal(classifyClaude(f({ streamCode: "ECONNRESET", rejection: limitedAt(RESET_S) })).kind, "limited");
  assert.equal(classifyClaude(f({ apiStatus: 503, rejection: limitedAt(RESET_S) })).kind, "limited");
});

// Issue #170: the reset the error result's text names, with no rate-limit event, and a rate limit with no known end.
const TEXT_15_OCT = "You've hit your session limit · resets 11:10pm (UTC)";
const AT_15_OCT = timeOfDayIn(TEXT_15_OCT);

test("Claude: the text of 15 Oct 2026 with no event is limited by its time of day, whatever the status and assistant error", () => {
  assert.ok(AT_15_OCT !== null);
  for (const apiStatus of [null, 429, 400])
    for (const assistantError of [null, "rate_limit"])
      assert.deepEqual(classifyClaude(f({ resultText: TEXT_15_OCT, apiStatus, assistantError, terminalReason: "api_error" })), { kind: "limited", reset: { kind: "timeOfDay", at: AT_15_OCT }, limitType: null }, `${apiStatus} ${assistantError}`);
});

test("Claude: an event with a reset beside the text gives the event's instant", () => {
  assert.deepEqual(classifyClaude(f({ resultText: TEXT_15_OCT, assistantError: "rate_limit", rejection: limitedAt(RESET_S) })), { kind: "limited", reset: { kind: "instant", atMs: RESET_S * 1000 }, limitType: "five_hour" });
});

test("Claude: a rate limit with no usable reset has no known end; other permanent evidence without a reset text stays permanent", () => {
  const unknown = (limitType: string | null) => ({ kind: "limited", reset: { kind: "unknown" }, limitType });
  assert.deepEqual(classifyClaude(f({ rejection: { kind: "withoutReset", limitType: "seven_day" } })), unknown("seven_day"));
  assert.deepEqual(classifyClaude(f({ apiStatus: 429 })), unknown(null));
  assert.deepEqual(classifyClaude(f({ assistantError: "rate_limit" })), unknown(null));
  assert.deepEqual(classifyClaude(f({ retrySeen: { status: 429, error: "rate_limit" } })), unknown(null));
  assert.deepEqual(classifyClaude(f({ assistantError: "billing_error", resultText: "You've hit your session limit" })), { kind: "permanent" });
  assert.deepEqual(classifyClaude(f({ apiStatus: 400, assistantError: "rate_limit" })), { kind: "permanent" });
});

// Issue #122: a rejection because the session's history is too long is a kind of its own, checked first.
test("Claude: an error result saying the prompt is too long is contextTooLong, with a 400 status or none", () => {
  assert.deepEqual(classifyClaude(f({ resultText: "Prompt is too long", apiStatus: 400, terminalReason: "api_error", subtype: "success" })), { kind: "contextTooLong" });
  assert.deepEqual(classifyClaude(f({ resultText: "Prompt is too long" })), { kind: "contextTooLong" });
  assert.match("Prompt is too long", CONTEXT_TOO_LONG_PATTERN);
  assert.deepEqual(classifyClaude(f({ resultText: "API Error: 400 bad request", apiStatus: 400 })), { kind: "permanent" });
});

// Issue #157: the ending of the Claude Code process, read from the error the Agent SDK throws.

test("processEndOf: the SDK's signal text, with and without a stderr tail", () => {
  assert.deepEqual(processEndOf(new Error("Claude Code process terminated by signal SIGBUS")), { kind: "signal", signal: "SIGBUS" });
  assert.deepEqual(processEndOf(new Error("Claude Code process terminated by signal SIGKILL. stderr: out of memory")), { kind: "signal", signal: "SIGKILL" });
});

test("processEndOf: the SDK's exit text, with and without a stderr tail", () => {
  assert.deepEqual(processEndOf(new Error("Claude Code process exited with code 1")), { kind: "exit", code: 1 });
  assert.deepEqual(processEndOf(new Error("Claude Code process exited with code 137. stderr: killed")), { kind: "exit", code: 137 });
});

test("processEndOf: a value followed by neither the end nor the SDK's stderr tail is no ending (W1-R1-1, W1-S1-1)", () => {
  assert.equal(processEndOf(new Error("Claude Code process exited with code 1.5")), null);
  assert.equal(processEndOf(new Error("Claude Code process exited with code 1x")), null);
  assert.equal(processEndOf(new Error("Claude Code process terminated by signal SIGBUSx")), null);
  assert.equal(processEndOf(new Error("Claude Code process terminated by signal SIGBUS1.5")), null);
});

test("processEndOf: the own fields the SDK sets, whatever the message", () => {
  assert.deepEqual(processEndOf(Object.assign(new Error("something else"), { signal: "SIGTERM" })), { kind: "signal", signal: "SIGTERM" });
  assert.deepEqual(processEndOf(Object.assign(new Error("something else"), { exitCode: 2 })), { kind: "exit", code: 2 });
});

test("processEndOf: no ending for a zero code, another text or a value that is no error", () => {
  assert.equal(processEndOf(new Error("Claude Code process exited with code 0")), null);
  assert.equal(processEndOf(Object.assign(new Error("x"), { exitCode: 0 })), null);
  assert.equal(processEndOf(Object.assign(new Error("x"), { exitCode: 1.5 })), null);
  assert.equal(processEndOf(Object.assign(new Error("x"), { signal: "unknown" })), null);
  assert.equal(processEndOf(new Error("read ECONNRESET")), null);
  assert.equal(processEndOf("Claude Code process terminated by signal SIGBUS"), null);
  assert.equal(processEndOf(null), null);
  assert.equal(processEndOf(42), null);
});

// Issue #157: where a process ending stands in the evidence order.
const bus = { kind: "signal" as const, signal: "SIGBUS" };

test("Claude: a process ending alone is processEnded", () => {
  assert.deepEqual(classifyClaude(f({ processEnd: bus })), { kind: "processEnded", end: bus });
  assert.deepEqual(classifyClaude(f({ processEnd: { kind: "exit", code: 1 } })), { kind: "processEnded", end: { kind: "exit", code: 1 } });
});

test("Claude: permanent evidence, a rejection and the session's length win over a process ending", () => {
  assert.equal(classifyClaude(f({ processEnd: bus, apiStatus: 401 })).kind, "permanent");
  assert.equal(classifyClaude(f({ processEnd: bus, assistantError: "billing_error" })).kind, "permanent");
  assert.equal(classifyClaude(f({ processEnd: bus, subtype: "error_max_turns" })).kind, "permanent");
  assert.equal(classifyClaude(f({ processEnd: bus, rejection: { kind: "withReset", resetsAtMs: 5000, limitType: null } })).kind, "limited");
  assert.equal(classifyClaude(f({ processEnd: bus, rejection: { kind: "withoutReset", limitType: null } })).kind, "limited");
  assert.equal(classifyClaude(f({ processEnd: bus, resultText: "Prompt is too long" })).kind, "contextTooLong");
});

test("Claude: a process ending wins over transport evidence", () => {
  assert.equal(classifyClaude(f({ processEnd: bus, assistantError: "overloaded" })).kind, "processEnded");
  assert.equal(classifyClaude(f({ processEnd: bus, retrySeen: { status: 503, error: "server_error" } })).kind, "processEnded");
  assert.equal(classifyClaude(f({ processEnd: bus, streamCode: "ECONNRESET" })).kind, "processEnded");
});

// Issue #201: the codes a disconnected machine gives are transport evidence for both agents, and an error result whose
// text names a network code (the incident of 30 Oct 2026) is a transport fault unless permanent evidence wins.
const INCIDENT_TEXT = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";

test("Claude: the codes of an unreachable network are retried (issue #201)", () => {
  for (const code of ["ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]) assert.equal(isRetried(f({ streamCode: code })), true, code);
});

test("Codex: the codes of an unreachable network are retried, by code or in the message (issue #201)", () => {
  assert.equal(classifyCodex("the connection failed", "ENETUNREACH").kind === "transport", true);
  assert.equal(classifyCodex("getaddrinfo ENOTFOUND api.openai.com").kind === "transport", true);
  assert.equal(classifyCodex("connect EHOSTUNREACH 1.2.3.4:443").kind === "transport", true);
  assert.equal(classifyCodex("ENETDOWN").kind === "transport", true);
});

test("Claude: an error result naming a network code is retried; a 401 beside it is not (issue #201)", () => {
  assert.equal(isRetried(f({ resultText: INCIDENT_TEXT })), true);
  assert.equal(isRetried(f({ resultText: INCIDENT_TEXT, apiStatus: 401 })), false);
  assert.equal(isRetried(f({ resultText: "API Error: XEAI_AGAINY" })), false);
});

// Issue #262: the Codex CLI's refusal to resume a thread, recognized only on a turn that resumed.
const RESUME_HALT = "Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: list_turns is not supported yet (code -32601)";
test("Codex: a resumed turn's refusal to resume is resumeFailed, in the exit's text and in a recorded cause", () => {
  assert.deepEqual(classifyCodex(RESUME_HALT, null, { kind: "unknown" }, true), { kind: "resumeFailed" });
  const recorded = recordedFailureText("thread/resume failed: list_turns is not supported yet (code -32601)", exitText({ code: 1, signal: null }, "Reading prompt from stdin...") ?? "");
  assert.deepEqual(classifyCodex(recorded, null, { kind: "unknown" }, true), { kind: "resumeFailed" });
  assert.deepEqual(classifyCodex("Error: list_turns is not supported yet", null, { kind: "unknown" }, true), { kind: "resumeFailed" });
});
test("Codex: the resume text classifies by the ordinary rules on a turn that did not resume", () => {
  assert.deepEqual(classifyCodex("thread/resume failed: connection reset"), { kind: "transport" });
  assert.deepEqual(classifyCodex("thread/resume failed: usage limit"), { kind: "limited", reset: { kind: "unknown" }, limitType: CODEX_USAGE_LIMIT_TYPE });
  assert.deepEqual(classifyCodex(RESUME_HALT), { kind: "permanent" });
});
test("Codex: a refused credential beside the resume text stays permanent, and the bare JSON-RPC code is not a refused resume", () => {
  assert.deepEqual(classifyCodex(`${RESUME_HALT} 401 Unauthorized`, null, { kind: "unknown" }, true), { kind: "permanent" });
  assert.deepEqual(classifyCodex(`${RESUME_HALT} unauthorized`, null, { kind: "unknown" }, true), { kind: "permanent" });
  assert.deepEqual(classifyCodex("Error: method not found (code -32601)", null, { kind: "unknown" }, true), { kind: "permanent" });
});
