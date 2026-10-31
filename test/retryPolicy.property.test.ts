import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { exhaustedStep, type ExhaustionKind, NETWORK_RETRY_CEILING_SECONDS, networkRetryDelaySeconds } from "../src/retryPolicy.ts";
import type { Exhaustion } from "../src/retry.ts";
import { retryDelays } from "../src/retry.ts";
import { NETWORK_CODES } from "../src/transport.ts";
import { defaultConfig } from "../src/schema.ts";

// Issue #201: the step after the retries are used up, and the waits of the tries for an unreachable network.
const RUNS = { numRuns: 300, seed: 20261031 };

/** The policy kinds of src/retry.ts are the policy's kinds, both ways. */
const sameKinds: [Exhaustion["kind"]] extends [ExhaustionKind] ? ([ExhaustionKind] extends [Exhaustion["kind"]] ? true : false) : false = true;
void sameKinds;

const policy = fc.constantFrom<ExhaustionKind>("ask", "fail", "background");
const code = fc.option(fc.constantFrom(...NETWORK_CODES), { nil: null });

test("property: exhaustedStep fails a failing call, waits for the network on a code, backgrounds while not waiting, else asks", () => {
  fc.assert(
    fc.property(policy, fc.boolean(), code, (p, waiting, c) => {
      const step = exhaustedStep(p, waiting, c);
      if (p === "fail") assert.deepEqual(step, { kind: "fail" });
      else if (c !== null) assert.deepEqual(step, { kind: "network", code: c });
      else if (p === "background" && !waiting) assert.deepEqual(step, { kind: "background" });
      else assert.deepEqual(step, { kind: "ask" });
    }),
    RUNS,
  );
});

const config = fc.record({ maxTransportRetries: fc.integer({ min: 1, max: 40 }), transportRetryDelaySeconds: fc.double({ min: 0.01, max: 1000, noNaN: true }) });
const lastDelay = (c: { maxTransportRetries: number; transportRetryDelaySeconds: number }): number => retryDelays(c).at(-1)!;
const cap = (c: { maxTransportRetries: number; transportRetryDelaySeconds: number }): number => Math.max(NETWORK_RETRY_CEILING_SECONDS, lastDelay(c));

test("property: the network waits never decrease, never pass the cap, and the first doubles the last configured delay", () => {
  fc.assert(
    fc.property(config, fc.integer({ min: 1, max: 2000 }), (c, k) => {
      const d = networkRetryDelaySeconds(c, k);
      assert.ok(d > 0 && d <= cap(c));
      assert.ok(networkRetryDelaySeconds(c, k + 1) >= d);
      assert.equal(networkRetryDelaySeconds(c, 1), Math.min(2 * lastDelay(c), cap(c)));
    }),
    RUNS,
  );
});

test("the network waits of the default configuration are 40, 60, 60, 60 seconds", () => {
  assert.deepEqual([1, 2, 3, 4].map((k) => networkRetryDelaySeconds(defaultConfig, k)), [40, 60, 60, 60]);
});
