// Issue #251: a Codex wait's lines name the agent and its limit, never Claude Code's wording; Claude Code's texts are
// unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { CODEX_CAPACITY_TYPE, CODEX_QUOTA_TYPE, CODEX_RATE_LIMIT_TYPE, CODEX_USAGE_LIMIT_TYPE, type LimitWaitBasis } from "../src/limitReset.ts";
import * as prompts from "../src/prompts.ts";
import { decodeServer } from "../src/protocol.ts";
import { emptyRun, foldEvent, statusText } from "../web/src/state.ts";

const UNTIL = Date.UTC(2026, 10, 3, 20, 14);
const BASES: readonly LimitWaitBasis[] = [{ kind: "reset" }, { kind: "pastReset", namedMs: UNTIL - 60_000 }, { kind: "noKnownEnd", attempt: 2 }];
const CODEX_TYPES = [CODEX_RATE_LIMIT_TYPE, CODEX_CAPACITY_TYPE, CODEX_USAGE_LIMIT_TYPE, CODEX_QUOTA_TYPE];

test("a Codex limit's names: capacity, usage limit and quota", () => {
  assert.equal(prompts.limitName(CODEX_CAPACITY_TYPE), "capacity limit (the model is at capacity)");
  assert.equal(prompts.limitName(CODEX_USAGE_LIMIT_TYPE), "usage limit");
  assert.equal(prompts.limitName(CODEX_QUOTA_TYPE), "quota");
});

test("every Codex wait line names Codex and the limit, and none names Claude", () => {
  for (const limitType of CODEX_TYPES) {
    const name = prompts.limitName(limitType);
    const lines = [
      ...BASES.map((b) => prompts.usageLimitWaitLine("codex", limitType, b, UNTIL)),
      prompts.usageLimitTryingAgainLine("codex", limitType),
      prompts.usageLimitLiftedLine("codex", limitType, 600_000),
      prompts.waitEndedLine({ kind: "usageLimit", agent: "codex", limitType }),
    ];
    for (const line of lines) {
      assert.ok(line.includes("Codex"), line);
      assert.ok(line.includes(name), `${line} does not name ${name}`);
      assert.ok(!line.includes("Claude"), line);
    }
    for (const b of BASES) assert.ok(prompts.usageLimitActivity(limitType, b, UNTIL).includes(name));
  }
});

test("the page's activity line for a Codex wait begins with Codex and names its limit", () => {
  for (const limitType of CODEX_TYPES) {
    const run = foldEvent(emptyRun(1), { time: "2026-11-03T19:13:00.000Z", event: { _tag: "Notified", event: { _tag: "UsageLimitWaiting", agent: "codex", purpose: "review", limitType, basis: { kind: "noKnownEnd", attempt: 1 }, fromMs: UNTIL - 300_000, untilMs: UNTIL, wait: 1 } } });
    const text = statusText(run.dashboard.status);
    assert.ok(text.startsWith("Codex"), text);
    assert.ok(text.includes(prompts.limitName(limitType)), text);
  }
});

test("the refusal line names its agent and the message", () => {
  assert.equal(prompts.limitRefusalLine("codex", "M"), "Codex refused the request: M");
  assert.equal(prompts.limitRefusalLine("claude", "M"), "Claude Code refused the request: M");
});

test("Claude Code's wait lines are unchanged", () => {
  assert.equal(prompts.usageLimitTryingAgainLine("claude", "five_hour"), "Claude Code: trying again after the wait for the usage limit");
  assert.equal(prompts.usageLimitLiftedLine("claude", "five_hour", 9_060_000), "Claude Code: the usage limit has lifted after 2:31:00; continuing");
  assert.equal(prompts.usageLimitLiftedLine("claude", null, 9_060_000), "Claude Code: the usage limit has lifted after 2:31:00; continuing");
  assert.equal(prompts.waitEndedLine({ kind: "usageLimit", agent: "claude", limitType: "seven_day" }), "You ended the wait for Claude Code's usage limit; Interloq is trying the request again now");
});

test("property: a Codex line is Claude Code's with the agent's name replaced, for every limit type and message", () => {
  const types = fc.constantFrom<string | null>(null, "five_hour", "seven_day", "overage", ...CODEX_TYPES);
  fc.assert(
    fc.property(types, fc.string(), fc.nat({ max: 10_000_000 }), (limitType, message, waitedMs) => {
      const same = (claude: string, codex: string) => assert.equal(claude.replaceAll("Claude Code", "Codex"), codex);
      // A Claude Code limit is never of a Codex type, so only the type's name in a Codex line differs from the noun
      // "usage limit" Claude Code's lines keep; both are given the same type here, as the seam test does.
      same(prompts.limitRefusalLine("claude", message), prompts.limitRefusalLine("codex", message));
      for (const b of BASES) same(prompts.usageLimitWaitLine("claude", limitType, b, UNTIL), prompts.usageLimitWaitLine("codex", limitType, b, UNTIL));
      same(prompts.usageLimitTryingAgainLine("claude", limitType), prompts.usageLimitTryingAgainLine("codex", limitType));
      same(prompts.usageLimitLiftedLine("claude", limitType, waitedMs), prompts.usageLimitLiftedLine("codex", limitType, waitedMs));
      same(prompts.waitEndedLine({ kind: "usageLimit", agent: "claude", limitType }), prompts.waitEndedLine({ kind: "usageLimit", agent: "codex", limitType }));
    }),
    { numRuns: 200 },
  );
});

test("a UsageLimitLifted record without limitType decodes with null", () => {
  const frame = JSON.stringify({ type: "event", run: 1, seq: 1, time: "2026-11-03T19:13:00.000Z", event: { _tag: "Notified", event: { _tag: "UsageLimitLifted", agent: "codex", waitedMs: 1 } } });
  const decoded = decodeServer(frame);
  assert.ok(Result.isSuccess(decoded), JSON.stringify(decoded));
  const message = decoded.success;
  assert.ok(message.type === "event" && message.event._tag === "Notified" && message.event.event._tag === "UsageLimitLifted");
  assert.equal(message.event.event.limitType, null);
});
