import assert from "node:assert/strict";
import { test } from "node:test";
import { renderUsage, summarizeUsage, type LimitWait, type UsageLine, type UsageLines } from "../src/usage.ts";

// Findings 9 and 27 of docs/functional-design-review.md; decision Q8 (unknown sessions counted separately).
const claude = (session: string | null, totalCostUsd: number, turns = 1): UsageLine => ({ agent: "claude", session, turns, totalCostUsd });
const only = (calls: readonly UsageLine[]): UsageLines => ({ calls, waits: [] });
const noWaits = { limitWaits: 0, waitedMs: 0, lastInterrupted: false };
const codex = (inputTokens: number, outputTokens: number): UsageLine => ({ agent: "codex", thread: "t", inputTokens, outputTokens });

test("summarizeUsage: each identified session counts its last running total; Codex tokens add", () => {
  const summary = summarizeUsage(only([claude("s-1", 0.5), codex(10, 5), claude("s-1", 1.25), claude("s-2", 0.25), codex(20, 1)]));
  assert.deepEqual(summary, { claudeCalls: 3, claudeSessions: 2, unidentifiedCalls: 0, costUsd: 1.5, codexTurns: 2, inputTokens: 30, outputTokens: 6, ...noWaits });
});

test("summarizeUsage: lines without a session id are their own sessions and are counted (Q8)", () => {
  const summary = summarizeUsage(only([claude(null, 0.3), claude(null, 0.4), claude("s-1", 1)]));
  assert.equal(summary.unidentifiedCalls, 2);
  assert.equal(summary.claudeSessions, 1);
  assert.equal(summary.costUsd, 1.7);
});

test("renderUsage: the known text, plus the unidentified calls when there are any", () => {
  const known = renderUsage({ claudeCalls: 3, claudeSessions: 2, unidentifiedCalls: 0, costUsd: 1.5, codexTurns: 2, inputTokens: 30, outputTokens: 6, ...noWaits }, "plan-review/usage.jsonl");
  assert.equal(known, "Claude Code: 3 calls in 2 sessions, total_cost_usd = 1.50 (the sessions' last reported running totals, an estimate by the client). Codex: 2 turns, 30 input tokens, 6 output tokens. Details: plan-review/usage.jsonl");
  const unknown = renderUsage({ claudeCalls: 3, claudeSessions: 1, unidentifiedCalls: 2, costUsd: 1.7, codexTurns: 0, inputTokens: 0, outputTokens: 0, ...noWaits }, "plan-review/usage.jsonl");
  assert.match(unknown, /Claude Code: 3 calls in 1 sessions, 2 calls without a session id, total_cost_usd = 1\.70/);
  assert.equal(renderUsage(summarizeUsage(only([])), "plan-review/usage.jsonl"), "Claude Code: 0 calls in 0 sessions, total_cost_usd = 0.00 (the sessions' last reported running totals, an estimate by the client). Codex: 0 turns, 0 input tokens, 0 output tokens. Details: plan-review/usage.jsonl");
});

// Issue #68: the waits for a usage limit count as actually spent.
const wait = (fromMs: number, untilMs: number, endedMs: number, outcome: "lifted" | "interrupted" = "lifted"): LimitWait => ({ agent: "claude", limitType: "five_hour", fromMs, untilMs, endedMs, outcome });
const WEEK = 7 * 24 * 3600 * 1000;

test("summarizeUsage: an interrupted wait for a weekly limit counts the minute it lasted, not the week", () => {
  const summary = summarizeUsage({ calls: [], waits: [wait(0, WEEK, 60_000, "interrupted")] });
  assert.equal(summary.limitWaits, 1);
  assert.equal(summary.waitedMs, 60_000);
  assert.equal(summary.lastInterrupted, true);
});

test("summarizeUsage: a late wakeup counts its actual duration, beyond the scheduled one", () => {
  assert.equal(summarizeUsage({ calls: [], waits: [wait(0, 1000, 1001)] }).waitedMs, 1001);
});

test("renderUsage: the waits, only when there was one, with the last interrupted named", () => {
  const plain = renderUsage(summarizeUsage(only([])), "plan-review/usage.jsonl");
  const two = renderUsage(summarizeUsage({ calls: [], waits: [wait(0, 3_600_000, 3_600_000), wait(0, 1_800_000, 1_800_000)] }), "plan-review/usage.jsonl");
  assert.equal(two, `${plain} Waited for Claude Code's usage limits: 2 times, 1:30:00 in all.`);
  const interrupted = renderUsage(summarizeUsage({ calls: [], waits: [wait(0, WEEK, 60_000, "interrupted")] }), "plan-review/usage.jsonl");
  assert.equal(interrupted, `${plain} Waited for Claude Code's usage limits: 1 time, 1:00 in all (the last interrupted).`);
});
