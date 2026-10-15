import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type ClaudeFailure, classifyClaude, NETWORK_CODES, PERMANENT_ASSISTANT_ERRORS, processEndOf, type Rejection } from "../src/transport.ts";
import { timeOfDayIn } from "../src/limitReset.ts";

// Issue #68 (issue #66 applies): the classification of a failed Claude Code call over arbitrary facts.
const RUNS = { numRuns: 500, seed: 20261007 };

const STOPPING = ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"];
const status = fc.option(fc.oneof(fc.constantFrom(400, 401, 403, 404, 429, 500, 502, 503, 529), fc.integer({ min: 100, max: 599 })), { nil: null });
const assistant = fc.option(fc.constantFrom(...PERMANENT_ASSISTANT_ERRORS, "server_error", "overloaded", "unknown"), { nil: null });
const rejection: fc.Arbitrary<Rejection | null> = fc.option(
  fc.oneof(
    fc.record({ kind: fc.constant("withReset" as const), resetsAtMs: fc.integer({ min: 1, max: 4e12 }), limitType: fc.option(fc.constantFrom("five_hour", "seven_day"), { nil: null }) }),
    fc.record({ kind: fc.constant("withoutReset" as const), limitType: fc.option(fc.constantFrom("five_hour", "seven_day"), { nil: null }) }),
  ),
  { nil: null },
);
const facts: fc.Arbitrary<ClaudeFailure> = fc.record({
  streamCode: fc.option(fc.constantFrom(...NETWORK_CODES, "ERR_OTHER"), { nil: null }),
  apiStatus: status,
  terminalReason: fc.option(fc.constantFrom("api_error", "completed"), { nil: null }),
  assistantError: assistant,
  retrySeen: fc.option(fc.record({ status, error: fc.constantFrom(...PERMANENT_ASSISTANT_ERRORS, "server_error", "unknown") }), { nil: null }),
  subtype: fc.option(fc.constantFrom(...STOPPING, "success", "error_during_execution"), { nil: null }),
  rejection,
  resultText: fc.option(fc.constantFrom("API Error: 503 upstream", "api error", "Request too large for the model", "You've hit your session limit · resets 11:10pm (UTC)"), { nil: null }),
  processEnd: fc.option(fc.oneof(fc.record({ kind: fc.constant("signal" as const), signal: fc.constantFrom("SIGBUS", "SIGKILL", "SIGTERM") }), fc.record({ kind: fc.constant("exit" as const), code: fc.integer({ min: 1, max: 255 }) })), { nil: null }),
});
/** The failures without a process ending (issue #157): the domain of the properties stated before it. */
const before157 = facts.map((x) => ({ ...x, processEnd: null }));

const is4xx = (s: number | null): boolean => s !== null && s >= 400 && s <= 499;
const is5xx = (s: number | null): boolean => s !== null && s >= 500 && s <= 599;
const otherPermanentError = (e: string | null): boolean => e !== null && e !== "rate_limit" && PERMANENT_ASSISTANT_ERRORS.includes(e);
/** Permanent evidence other than the rate limit (a 429 or the rate_limit error). */
const otherPermanent = (x: ClaudeFailure): boolean =>
  (is4xx(x.apiStatus) && x.apiStatus !== 429) ||
  otherPermanentError(x.assistantError) ||
  (x.retrySeen !== null && ((is4xx(x.retrySeen.status) && x.retrySeen.status !== 429) || otherPermanentError(x.retrySeen.error))) ||
  (x.subtype !== null && STOPPING.includes(x.subtype));

/** Issue #170: the error result's text names a reset Interloq reads. */
const hasTextReset = (x: ClaudeFailure): boolean => x.resultText !== null && timeOfDayIn(x.resultText) !== null;
/** Issue #170: any evidence of a rate limit: a rejection, a 429, or the rate_limit error, in the result or an api_retry. */
const rateLimitEvidence = (x: ClaudeFailure): boolean =>
  x.rejection !== null || x.apiStatus === 429 || x.assistantError === "rate_limit" || (x.retrySeen !== null && (x.retrySeen.status === 429 || x.retrySeen.error === "rate_limit"));
const withResetEvent = (x: ClaudeFailure): boolean => x.rejection !== null && x.rejection.kind === "withReset";

/** The oracle: the classification before issue #68, which knew no rejection. */
const transportBefore = (x: ClaudeFailure): boolean => {
  const permanent =
    is4xx(x.apiStatus) ||
    (x.assistantError !== null && PERMANENT_ASSISTANT_ERRORS.includes(x.assistantError)) ||
    (x.retrySeen !== null && (is4xx(x.retrySeen.status) || PERMANENT_ASSISTANT_ERRORS.includes(x.retrySeen.error))) ||
    (x.subtype !== null && STOPPING.includes(x.subtype));
  if (permanent) return false;
  return (
    (x.streamCode !== null && NETWORK_CODES.includes(x.streamCode)) ||
    is5xx(x.apiStatus) ||
    (x.assistantError !== null && ["server_error", "overloaded"].includes(x.assistantError)) ||
    (x.retrySeen !== null && (x.retrySeen.status === null || is5xx(x.retrySeen.status)))
  );
};

test("property: limited if and only if a reset text, or a rate limit without other permanent evidence; the reset by its source", () => {
  fc.assert(
    fc.property(before157, (x) => {
      const kind = classifyClaude(x);
      const expected = hasTextReset(x) || (!otherPermanent(x) && rateLimitEvidence(x));
      assert.equal(kind.kind === "limited", expected);
      if (kind.kind !== "limited") return;
      if (x.rejection !== null && x.rejection.kind === "withReset") assert.deepEqual(kind.reset, { kind: "instant", atMs: x.rejection.resetsAtMs });
      else if (hasTextReset(x)) assert.equal(kind.reset.kind, "timeOfDay");
      else assert.deepEqual(kind.reset, { kind: "unknown" });
      assert.equal(kind.reset.kind === "instant", withResetEvent(x));
      assert.equal(kind.limitType, x.rejection?.limitType ?? null);
    }),
    RUNS,
  );
});

test("property: permanent evidence other than the rate limit always gives permanent", () => {
  fc.assert(
    fc.property(facts.filter((x) => otherPermanent(x) && !hasTextReset(x)), (x) => assert.deepEqual(classifyClaude(x), { kind: "permanent" })),
    RUNS,
  );
});

test("property: without a rejection, a reset text or any rate-limit evidence, the classification is the one before issue #68", () => {
  fc.assert(
    fc.property(before157, (x) => {
      const without = { ...x, rejection: null };
      fc.pre(!rateLimitEvidence(without) && !hasTextReset(without));
      assert.equal(classifyClaude(without).kind, transportBefore(without) ? "transport" : "permanent");
    }),
    RUNS,
  );
});

test("property: a rejection without a reset, and no other permanent evidence or reset text, has no known end", () => {
  fc.assert(
    fc.property(facts, (x) => {
      const without = { ...x, rejection: { kind: "withoutReset" as const, limitType: null } };
      fc.pre(!otherPermanent(without) && !hasTextReset(without));
      assert.deepEqual(classifyClaude(without), { kind: "limited", reset: { kind: "unknown" }, limitType: null });
    }),
    RUNS,
  );
});

// Issue #122: the context-length rejection, recognized from the error result's text whatever the other facts.
const randomCase = (text: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: text.length, maxLength: text.length }).map((upper) => [...text].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join(""));

test("property: an error result whose text says the prompt is too long, in any case, is contextTooLong", () => {
  fc.assert(
    fc.property(facts, fc.string(), randomCase("prompt is too long"), fc.string(), (x, before, phrase, after) => {
      assert.deepEqual(classifyClaude({ ...x, resultText: `${before}${phrase}${after}` }), { kind: "contextTooLong" });
    }),
    RUNS,
  );
});

test("property: a text with neither the phrase nor a reset classifies as no text does, the classification before issue #122", () => {
  fc.assert(
    fc.property(facts.filter((x) => !hasTextReset(x)), (x) => assert.deepEqual(classifyClaude(x), classifyClaude({ ...x, resultText: null }))),
    RUNS,
  );
});

// Issue #157: processEndOf over the SDK's texts with arbitrary stderr tails, and over arbitrary other texts.
const signalName = fc.stringMatching(/^SIG[A-Z0-9]{1,8}$/);
const nonzero = fc.integer({ min: -255, max: 100000 }).filter((n) => n !== 0);
const tail = fc.oneof(fc.constant(""), fc.string().map((s) => `. stderr: ${s}`));

test("an SDK-shaped ending reads back as that ending", () => {
  fc.assert(
    fc.property(signalName, nonzero, tail, (signal, code, t) => {
      assert.deepEqual(processEndOf(new Error(`Claude Code process terminated by signal ${signal}${t}`)), { kind: "signal", signal });
      assert.deepEqual(processEndOf(new Error(`Claude Code process exited with code ${code}${t}`)), { kind: "exit", code });
    }),
    RUNS,
  );
});

// W1-R1-1, W1-S1-1: a suffix whose first character cannot extend the value (P2-R1-1), and which is not the SDK's
// stderr tail, leaves the message no ending.
const suffixAfter = (valueClass: RegExp): fc.Arbitrary<string> =>
  fc
    .tuple(fc.constantFrom(..."._ x:-abcz"), fc.string())
    .map(([first, rest]) => first + rest)
    .filter((s) => !valueClass.test(s.charAt(0)) && !s.startsWith(". stderr: "));

test("an SDK phrase whose value is followed by neither the end nor the stderr tail is no ending", () => {
  fc.assert(
    fc.property(signalName, nonzero, suffixAfter(/[A-Z0-9]/), suffixAfter(/[0-9]/), (signal, code, signalSuffix, exitSuffix) => {
      assert.equal(processEndOf(new Error(`Claude Code process terminated by signal ${signal}${signalSuffix}`)), null);
      assert.equal(processEndOf(new Error(`Claude Code process exited with code ${code}${exitSuffix}`)), null);
    }),
    RUNS,
  );
});

test("a text without the SDK's phrases is no ending", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      fc.pre(!s.includes("Claude Code process"));
      assert.equal(processEndOf(new Error(s)), null);
    }),
    RUNS,
  );
});

// Issue #157: a process ending is classified after the session's length, the permanent evidence and the usage-limit
// rejections, and before the transport evidence.
const CONTEXT = /prompt is too long/i;
const outranks = (x: ClaudeFailure): boolean => otherPermanent(x) || hasTextReset(x) || x.rejection !== null || is4xx(x.apiStatus) && x.apiStatus === 429 || x.assistantError === "rate_limit" || (x.retrySeen !== null && (x.retrySeen.status === 429 || x.retrySeen.error === "rate_limit")) || (x.resultText !== null && CONTEXT.test(x.resultText));

/** A failure with a process ending and, beside it, transport evidence or none, but nothing that outranks it. */
const endedOnly: fc.Arbitrary<ClaudeFailure> = fc.record({
  streamCode: fc.option(fc.constantFrom(...NETWORK_CODES, "ERR_OTHER"), { nil: null }),
  apiStatus: fc.option(fc.integer({ min: 500, max: 599 }), { nil: null }),
  terminalReason: fc.option(fc.constantFrom("api_error", "completed"), { nil: null }),
  assistantError: fc.option(fc.constantFrom("server_error", "overloaded", "unknown"), { nil: null }),
  retrySeen: fc.option(fc.record({ status: fc.option(fc.integer({ min: 500, max: 599 }), { nil: null }), error: fc.constantFrom("server_error", "unknown") }), { nil: null }),
  subtype: fc.option(fc.constantFrom("success", "error_during_execution"), { nil: null }),
  rejection: fc.constant(null),
  resultText: fc.option(fc.constantFrom("API Error: 503 upstream", "api error"), { nil: null }),
  processEnd: fc.oneof(fc.record({ kind: fc.constant("signal" as const), signal: fc.constantFrom("SIGBUS", "SIGKILL") }), fc.record({ kind: fc.constant("exit" as const), code: fc.integer({ min: 1, max: 255 }) })),
});

test("property: a process ending with nothing that outranks it is processEnded with that ending", () => {
  fc.assert(
    fc.property(endedOnly, (x) => {
      assert.equal(outranks(x), false);
      assert.deepEqual(classifyClaude(x), { kind: "processEnded", end: x.processEnd });
    }),
    RUNS,
  );
});

test("property: a process ending never overrides the session's length, permanent evidence or a rejection", () => {
  fc.assert(
    fc.property(facts, (x) => {
      fc.pre(outranks(x));
      assert.deepEqual(classifyClaude(x), classifyClaude({ ...x, processEnd: null }));
    }),
    RUNS,
  );
});

test("property: without its ending, as planning and context calls classify, a failure is never processEnded", () => {
  fc.assert(
    fc.property(facts, (x) => assert.notEqual(classifyClaude({ ...x, processEnd: null }).kind, "processEnded")),
    RUNS,
  );
});
