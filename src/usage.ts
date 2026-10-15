// The usage summary as a pure fold over the lines of usage.jsonl (findings 9 and 27 of the functional design
// review; decision Q8). The store reads the lines; program.ts renders the summary.

import type { LimitWaitBasis } from "./limitReset.ts";
import { durationText } from "./prompts.ts";

/** One line of usage.jsonl, per agent. A Claude Code line's session is null when the SDK reported none. */
export type UsageLine =
  | Readonly<{ agent: "claude"; session: string | null; turns: number | null; totalCostUsd: number | null }>
  | Readonly<{ agent: "codex"; thread: string | null; inputTokens: number; outputTokens: number }>;

/**
 * One wait for a Claude Code usage limit (issue #68): when it began, the end scheduled (the reset plus the margin), when
 * it actually ended and how. Only the actual span counts as waited.
 */
export type LimitWait = Readonly<{
  agent: "claude";
  limitType: string | null;
  /** What the wait rested on (issue #170). */
  basis: LimitWaitBasis["kind"];
  fromMs: number;
  untilMs: number;
  endedMs: number;
  outcome: "lifted" | "elapsed" | "interrupted";
}>;

/**
 * One rate-limit notice of a Claude Code request (issue #170, requirement Q3): the session it arrived in, and the SDK's
 * rate_limit_info as the SDK gave it, whole, so that a field a later SDK adds is kept too.
 */
export type RateLimitNotice = Readonly<{ session: string | null; info: Readonly<Record<string, unknown>> }>;

/** The lines of usage.jsonl: the calls' usage, the waits, and the rate-limit notices (issue #170). */
export type UsageLines = Readonly<{ calls: readonly UsageLine[]; waits: readonly LimitWait[]; notices: readonly RateLimitNotice[] }>;

export type UsageSummary = Readonly<{
  claudeCalls: number;
  claudeSessions: number;
  /** Claude Code calls without a session id; each counts as its own session (Q8). */
  unidentifiedCalls: number;
  /** The sum of each identified session's last reported running total, plus the totals of the unidentified calls. */
  costUsd: number;
  codexTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** The waits for a usage limit, and the time they actually took (issue #68). */
  limitWaits: number;
  waitedMs: number;
  /** Whether the last wait was interrupted. */
  lastInterrupted: boolean;
}>;

/** The summary of the calls and the waits; the rate-limit notices count for nothing in it (issue #170). */
export const summarizeUsage = ({ calls: lines, waits }: Pick<UsageLines, "calls" | "waits">): UsageSummary => {
  const claude = lines.flatMap((l) => (l.agent === "claude" ? [l] : []));
  const codex = lines.flatMap((l) => (l.agent === "codex" ? [l] : []));
  // The Agent SDK's total is the running total of a session, so a session counts its last value;
  // a call without a session id is its own session (Q8).
  const lastOfSession = new Map<string, number>();
  let unidentifiedCost = 0;
  let unidentifiedCalls = 0;
  for (const line of claude) {
    if (line.session === null) {
      unidentifiedCalls++;
      unidentifiedCost += line.totalCostUsd ?? 0;
    } else if (line.totalCostUsd !== null) {
      lastOfSession.set(line.session, line.totalCostUsd);
    }
  }
  const sessions = new Set(claude.flatMap((l) => (l.session === null ? [] : [l.session])));
  return {
    claudeCalls: claude.length,
    claudeSessions: sessions.size,
    unidentifiedCalls,
    costUsd: [...lastOfSession.values()].reduce((sum, v) => sum + v, 0) + unidentifiedCost,
    codexTurns: codex.length,
    inputTokens: codex.reduce((sum, l) => sum + l.inputTokens, 0),
    outputTokens: codex.reduce((sum, l) => sum + l.outputTokens, 0),
    limitWaits: waits.length,
    waitedMs: waits.reduce((sum, w) => sum + (w.endedMs - w.fromMs), 0),
    lastInterrupted: waits.at(-1)?.outcome === "interrupted",
  };
};

/** The cost of one Claude Code call (issue #122): its session, and the growth of the session's running total it caused. */
export type CallCost = Readonly<{ session: string | null; costUsd: number | null }>;

/**
 * The cost of each Claude Code call in order (issue #122), Codex's lines skipped. The Agent SDK's total is the running
 * total of a session, so a call of an identified session costs its total less the session's previous numeric total (its
 * whole total for the session's first). A call without a session is its own session (Q8) and costs its total. A call
 * whose total is null costs null, and the session's next call is measured from its last number.
 */
export const callCosts = (lines: readonly UsageLine[]): readonly CallCost[] =>
  lines.reduce<Readonly<{ last: ReadonlyMap<string, number>; costs: readonly CallCost[] }>>(
    ({ last, costs }, line) => {
      if (line.agent !== "claude") return { last, costs };
      const { session, totalCostUsd: total } = line;
      if (total === null) return { last, costs: [...costs, { session, costUsd: null }] };
      if (session === null) return { last, costs: [...costs, { session, costUsd: total }] };
      return { last: new Map([...last, [session, total]]), costs: [...costs, { session, costUsd: total - (last.get(session) ?? 0) }] };
    },
    { last: new Map(), costs: [] },
  ).costs;

/**
 * The cost of the last call of `session` if it is more than `thresholdUsd`, else null (issue #122): the session's own
 * last line, not the file's, since another session may append a line between the record and the read.
 */
export const costWarningOf = (lines: readonly UsageLine[], session: string | null, thresholdUsd: number): number | null => {
  const cost = callCosts(lines).filter((c) => c.session === session).at(-1)?.costUsd ?? null;
  return cost !== null && cost > thresholdUsd ? cost : null;
};

/** The summary as the end of a run says it; `details` is the run's usage.jsonl as the run names it (issue #120: the run's own). */
export const renderUsage = (s: UsageSummary, details: string): string => {
  const unidentified = s.unidentifiedCalls > 0 ? `, ${s.unidentifiedCalls} calls without a session id` : "";
  const waited =
    s.limitWaits === 0 ? "" : ` Waited for Claude Code's usage limits: ${s.limitWaits} ${s.limitWaits === 1 ? "time" : "times"}, ${durationText(s.waitedMs)} in all${s.lastInterrupted ? " (the last interrupted)" : ""}.`;
  return `Claude Code: ${s.claudeCalls} calls in ${s.claudeSessions} sessions${unidentified}, total_cost_usd = ${s.costUsd.toFixed(2)} (the sessions' last reported running totals, an estimate by the client). Codex: ${s.codexTurns} turns, ${s.inputTokens} input tokens, ${s.outputTokens} output tokens. Details: ${details}${waited}`;
};
