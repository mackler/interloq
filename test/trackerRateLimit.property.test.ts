// Issue #219: the reset a tracker's rate-limit refusal states, and the wait it gives (src/trackerRateLimit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { isGithubRateLimit, rateLimitResetOf, rateLimitUntil, TRACKER_RATE_LIMIT_FALLBACK_SECONDS, TRACKER_RATE_LIMIT_MARGIN_SECONDS } from "../src/trackerRateLimit.ts";

const RUNS = { numRuns: 200, seed: 20261106 };
const arbSeconds = fc.integer({ min: 0, max: 100_000 });
const arbEpochSeconds = fc.integer({ min: 1_600_000_000, max: 2_000_000_000 });
const arbNow = fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 });
const arbReset = fc.oneof(
  arbSeconds.map((seconds) => ({ _tag: "After" as const, seconds })),
  arbEpochSeconds.map((s) => ({ _tag: "At" as const, epochMs: s * 1000 })),
  fc.constant({ _tag: "Unstated" as const }),
);

test("an integer retry-after is After its seconds", () => {
  fc.assert(fc.property(arbSeconds, (s) => assert.deepEqual(rateLimitResetOf({ "retry-after": String(s) }), { _tag: "After", seconds: s })), RUNS);
});

test("retry-after as an HTTP date is At that instant", () => {
  fc.assert(fc.property(arbEpochSeconds, (s) => assert.deepEqual(rateLimitResetOf({ "retry-after": new Date(s * 1000).toUTCString() }), { _tag: "At", epochMs: s * 1000 })), RUNS);
});

test("ratelimit-reset and x-ratelimit-reset in epoch seconds are At, in milliseconds", () => {
  fc.assert(
    fc.property(arbEpochSeconds, (s) => {
      assert.deepEqual(rateLimitResetOf({ "ratelimit-reset": String(s) }), { _tag: "At", epochMs: s * 1000 });
      assert.deepEqual(rateLimitResetOf({ "x-ratelimit-reset": String(s) }), { _tag: "At", epochMs: s * 1000 });
    }),
    RUNS,
  );
});

test("retry-after wins over ratelimit-reset, which wins over x-ratelimit-reset", () => {
  fc.assert(
    fc.property(arbSeconds, arbEpochSeconds, arbEpochSeconds, (a, b, c) => {
      assert.deepEqual(rateLimitResetOf({ "retry-after": String(a), "ratelimit-reset": String(b), "x-ratelimit-reset": String(c) }), { _tag: "After", seconds: a });
      assert.deepEqual(rateLimitResetOf({ "ratelimit-reset": String(b), "x-ratelimit-reset": String(c) }), { _tag: "At", epochMs: b * 1000 });
    }),
    RUNS,
  );
});

test("an unparsable header is skipped, and none is Unstated", () => {
  assert.deepEqual(rateLimitResetOf({}), { _tag: "Unstated" });
  assert.deepEqual(rateLimitResetOf({ "retry-after": "soon", "ratelimit-reset": "-3", "x-ratelimit-reset": "1.5" }), { _tag: "Unstated" });
  assert.deepEqual(rateLimitResetOf({ "retry-after": "soon", "x-ratelimit-reset": "1700000000" }), { _tag: "At", epochMs: 1_700_000_000_000 });
  fc.assert(fc.property(fc.string().filter((t) => !/^\s*\d+\s*$/u.test(t) && Number.isNaN(Date.parse(t))), (t) => assert.deepEqual(rateLimitResetOf({ "ratelimit-reset": t }), { _tag: "Unstated" })), RUNS);
});

test("a stated reset waits until at least now plus the margin; an unstated one exactly the fallback", () => {
  fc.assert(
    fc.property(arbReset, arbNow, (reset, now) => {
      const { untilMs, stated } = rateLimitUntil(reset, now);
      assert.ok(untilMs >= now);
      if (reset._tag === "Unstated") {
        assert.equal(stated, false);
        assert.equal(untilMs, now + TRACKER_RATE_LIMIT_FALLBACK_SECONDS * 1000);
      } else {
        assert.equal(stated, true);
        assert.ok(untilMs >= now + TRACKER_RATE_LIMIT_MARGIN_SECONDS * 1000);
        assert.equal(untilMs, reset._tag === "After" ? now + (reset.seconds + TRACKER_RATE_LIMIT_MARGIN_SECONDS) * 1000 : Math.max(reset.epochMs, now) + TRACKER_RATE_LIMIT_MARGIN_SECONDS * 1000);
      }
    }),
    RUNS,
  );
});

test("GitHub's rate limit: a 429, or a 403 with no remaining requests or a retry-after", () => {
  assert.equal(isGithubRateLimit(429, {}), true);
  assert.equal(isGithubRateLimit(403, { "x-ratelimit-remaining": "0" }), true);
  assert.equal(isGithubRateLimit(403, { "retry-after": "60" }), true);
  assert.equal(isGithubRateLimit(403, {}), false);
  assert.equal(isGithubRateLimit(403, { "x-ratelimit-remaining": "12" }), false);
  assert.equal(isGithubRateLimit(401, { "x-ratelimit-remaining": "0" }), false);
  assert.equal(isGithubRateLimit(500, { "retry-after": "1" }), false);
});
