import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type ClaudeFailure, classifyClaude, NETWORK_CODES, PERMANENT_ASSISTANT_ERRORS, type Rejection } from "../src/transport.ts";

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
});

const is4xx = (s: number | null): boolean => s !== null && s >= 400 && s <= 499;
const is5xx = (s: number | null): boolean => s !== null && s >= 500 && s <= 599;
const otherPermanentError = (e: string | null): boolean => e !== null && e !== "rate_limit" && PERMANENT_ASSISTANT_ERRORS.includes(e);
/** Permanent evidence other than the rate limit (a 429 or the rate_limit error). */
const otherPermanent = (x: ClaudeFailure): boolean =>
  (is4xx(x.apiStatus) && x.apiStatus !== 429) ||
  otherPermanentError(x.assistantError) ||
  (x.retrySeen !== null && ((is4xx(x.retrySeen.status) && x.retrySeen.status !== 429) || otherPermanentError(x.retrySeen.error))) ||
  (x.subtype !== null && STOPPING.includes(x.subtype));

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

test("property: limited if and only if the rejection carries a reset and no permanent evidence but the rate limit is present", () => {
  fc.assert(
    fc.property(facts, (x) => {
      const kind = classifyClaude(x);
      const expected = x.rejection !== null && x.rejection.kind === "withReset" && !otherPermanent(x);
      assert.equal(kind.kind === "limited", expected);
      if (kind.kind === "limited" && x.rejection?.kind === "withReset") {
        assert.equal(kind.resetsAtMs, x.rejection.resetsAtMs);
        assert.equal(kind.limitType, x.rejection.limitType);
      }
    }),
    RUNS,
  );
});

test("property: permanent evidence other than the rate limit always gives permanent", () => {
  fc.assert(
    fc.property(facts.filter(otherPermanent), (x) => assert.deepEqual(classifyClaude(x), { kind: "permanent" })),
    RUNS,
  );
});

test("property: without a rejection, the classification is the one before issue #68", () => {
  fc.assert(
    fc.property(facts, (x) => {
      const without = { ...x, rejection: null };
      assert.equal(classifyClaude(without).kind, transportBefore(without) ? "transport" : "permanent");
    }),
    RUNS,
  );
});

test("property: a rejection without a reset is never retried nor waited for", () => {
  fc.assert(
    fc.property(facts, (x) => {
      const without = { ...x, rejection: { kind: "withoutReset" as const, limitType: null } };
      assert.deepEqual(classifyClaude(without), { kind: "permanent" });
    }),
    RUNS,
  );
});
