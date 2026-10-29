// Issue #179: the record of a usage-limit wait written when it begins, in usage.jsonl and in checkpoint.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result, Schema } from "effect";
import fc from "fast-check";
import { platformLayer } from "../src/platform.ts";
import { Checkpoint, readUsage } from "../src/records.ts";
import * as S from "../src/schema.ts";
import { makeStore } from "../src/store.ts";
import { callCosts, summarizeUsage } from "../src/usage.ts";
import { TEST_ROOT, tempRepo } from "./helpers.ts";

const RUNS = { numRuns: 50, seed: 20261019 };
const instant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) });
const iso = instant.map((ms) => new Date(ms).toISOString());
const limitType = fc.option(fc.string(), { nil: null });
const basis = fc.constantFrom(...S.LIMIT_WAIT_BASES);

test("property: a usage_limit_wait_began line decodes to itself and changes neither the summary nor the costs", async () => {
  const s = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 1 }));
  await Effect.runPromise(s.recordLimitWait({ agent: "claude", limitType: null, basis: "reset", fromMs: 0, untilMs: 60_000, endedMs: 60_000, outcome: "lifted" }));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 2, totalCostUsd: 3 }));
  const base = await Effect.runPromise(s.usageLines());
  await fc.assert(
    fc.asyncProperty(limitType, basis, instant, instant, async (limit_type, b, fromMs, untilMs) => {
      const line = { version: 2 as const, kind: "usage_limit_wait_began" as const, agent: "claude" as const, time: new Date(fromMs).toISOString(), limit_type, basis: b, from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() };
      const decoded = readUsage("usage.jsonl", JSON.stringify(line) + "\n");
      assert.ok(Result.isSuccess(decoded));
      assert.deepEqual(decoded.success, [line]);
      await Effect.runPromise(s.recordLimitWaitBegan({ agent: "claude", limitType: limit_type, basis: b, fromMs, untilMs }));
      const read = await Effect.runPromise(s.usageLines());
      assert.deepEqual(read.began.at(-1), { agent: "claude", limitType: limit_type, basis: b, fromMs, untilMs });
      assert.deepEqual(summarizeUsage(read), summarizeUsage(base));
      assert.deepEqual(callCosts(read.calls), callCosts(base.calls));
    }),
    RUNS,
  );
});

test("property: a checkpoint with any waiting note, or none, decodes to itself", () => {
  const note = fc.option(fc.record({ agent: fc.constant("claude" as const), limit_type: limitType, basis, from: iso, until: iso }, { noNullPrototype: true }), { nil: null });
  fc.assert(
    fc.property(note, iso, (waiting, time) => {
      const checkpoint = { version: 2 as const, subject: "planning-1", phase: 1, round: 12, stage: "reviewed" as const, time, waiting };
      assert.deepEqual(Schema.decodeUnknownSync(Checkpoint)(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
    }),
    RUNS,
  );
});

// Issue #192: a claude_call_failed line changes neither the summary nor the costs.
test("property: claude_call_failed lines between call lines change neither the summary nor the costs", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.nat({ max: 3 }), fc.option(fc.integer({ min: 400, max: 599 }), { nil: null })), { maxLength: 4 }), async (failures) => {
      const s = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
      await Effect.runPromise(s.init("task"));
      const calls = [1, 2, 3].map((n) => ({ agent: "claude" as const, session: "s", turns: 1, totalCostUsd: n }));
      for (const [i, call] of calls.entries()) {
        for (const [at, status] of failures) {
          if (at === i) await Effect.runPromise(s.recordCallFailure({ session: "s", purpose: "planning", callId: `claude-${i}`, message: "failed", failure: status === null ? null : { streamCode: null, apiStatus: status, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null } }));
        }
        await Effect.runPromise(s.recordUsage(call));
      }
      const read = await Effect.runPromise(s.usageLines());
      assert.equal(read.failures.length, failures.filter(([at]) => at < 3).length);
      assert.deepEqual(summarizeUsage(read), summarizeUsage({ calls, waits: [] }));
      assert.deepEqual(callCosts(read.calls), callCosts(calls));
    }),
    { numRuns: 10, seed: 20261029 },
  );
});
