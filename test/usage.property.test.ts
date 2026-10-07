import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { summarizeUsage, type UsageLine } from "../src/usage.ts";

// Row 7 of the table in recommendation E of docs/functional-design-review.md.
const RUNS = { numRuns: 200, seed: 20260925 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const cost = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });
const arbClaude = (sessions: readonly string[]): fc.Arbitrary<UsageLine> =>
  record({ agent: fc.constant("claude" as const), session: fc.oneof(fc.constantFrom(...sessions), fc.constant(null)), turns: fc.integer({ min: 0, max: 20 }), totalCostUsd: fc.option(cost, { nil: null }) });
const arbCodex: fc.Arbitrary<UsageLine> = record({ agent: fc.constant("codex" as const), thread: fc.option(fc.string(), { nil: null }), inputTokens: fc.nat(1e6), outputTokens: fc.nat(1e6) });
const arbLines = fc.array(fc.oneof(arbClaude(["s-1", "s-2", "s-3"]), arbCodex), { maxLength: 12 });
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("property: the cost is the sum of each identified session's last numeric total plus the unidentified totals; tokens add", () => {
  fc.assert(
    fc.property(arbLines, (lines) => {
      const summary = summarizeUsage({ calls: lines, waits: [] });
      const claude = lines.flatMap((l) => (l.agent === "claude" ? [l] : []));
      const last = new Map<string, number>();
      let unidentified = 0;
      for (const l of claude) {
        if (l.session === null) unidentified += l.totalCostUsd ?? 0;
        else if (l.totalCostUsd !== null) last.set(l.session, l.totalCostUsd);
      }
      close(summary.costUsd, [...last.values()].reduce((a, b) => a + b, 0) + unidentified);
      assert.equal(summary.claudeCalls, claude.length);
      assert.equal(summary.unidentifiedCalls, claude.filter((l) => l.session === null).length);
      const codex = lines.flatMap((l) => (l.agent === "codex" ? [l] : []));
      assert.equal(summary.codexTurns, codex.length);
      assert.equal(summary.inputTokens, codex.reduce((s, l) => s + l.inputTokens, 0));
      assert.equal(summary.outputTokens, codex.reduce((s, l) => s + l.outputTokens, 0));
    }),
    RUNS,
  );
});

test("property: earlier totals of a session do not change the result, and interleaving independent sessions preserves it", () => {
  fc.assert(
    fc.property(arbLines, cost, (lines, earlier) => {
      const withEarlier = lines.flatMap((l) => (l.agent === "claude" && l.session !== null && l.totalCostUsd !== null ? [{ ...l, totalCostUsd: earlier }, l] : [l]));
      close(summarizeUsage({ calls: withEarlier, waits: [] }).costUsd, summarizeUsage({ calls: lines, waits: [] }).costUsd);
    }),
    RUNS,
  );
  fc.assert(
    fc.property(fc.array(arbClaude(["a"]), { maxLength: 6 }), fc.array(arbClaude(["b"]), { maxLength: 6 }), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (a, b, picks) => {
      // Interleave a and b, each in its own order.
      const merged: UsageLine[] = [];
      let i = 0;
      let j = 0;
      for (const pick of picks) {
        if (pick && i < a.length) merged.push(a[i++]);
        else if (j < b.length) merged.push(b[j++]);
        else if (i < a.length) merged.push(a[i++]);
      }
      merged.push(...a.slice(i), ...b.slice(j));
      close(summarizeUsage({ calls: merged, waits: [] }).costUsd, summarizeUsage({ calls: [...a, ...b], waits: [] }).costUsd);
    }),
    RUNS,
  );
});
