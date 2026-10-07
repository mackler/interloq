// The usage summary as a pure fold over the lines of usage.jsonl (findings 9 and 27 of the functional design
// review; decision Q8). The store reads the lines; program.ts renders the summary.

/** One line of usage.jsonl, per agent. A Claude Code line's session is null when the SDK reported none. */
export type UsageLine =
  | Readonly<{ agent: "claude"; session: string | null; turns: number | null; totalCostUsd: number | null }>
  | Readonly<{ agent: "codex"; thread: string | null; inputTokens: number; outputTokens: number }>;

/**
 * One wait for a Claude Code usage limit (issue #68): when it began, the end scheduled (the reset plus the margin), when
 * it actually ended and how. Only the actual span counts as waited.
 */
export type LimitWait = Readonly<{ agent: "claude"; limitType: string | null; fromMs: number; untilMs: number; endedMs: number; outcome: "lifted" | "interrupted" }>;

/** The lines of usage.jsonl: the calls' usage and the waits. */
export type UsageLines = Readonly<{ calls: readonly UsageLine[]; waits: readonly LimitWait[] }>;

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

export const summarizeUsage = ({ calls: lines }: UsageLines): UsageSummary => {
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
    limitWaits: 0,
    waitedMs: 0,
    lastInterrupted: false,
  };
};

export const renderUsage = (s: UsageSummary): string => {
  const unidentified = s.unidentifiedCalls > 0 ? `, ${s.unidentifiedCalls} calls without a session id` : "";
  return `Claude Code: ${s.claudeCalls} calls in ${s.claudeSessions} sessions${unidentified}, total_cost_usd = ${s.costUsd.toFixed(2)} (the sessions' last reported running totals, an estimate by the client). Codex: ${s.codexTurns} turns, ${s.inputTokens} input tokens, ${s.outputTokens} output tokens. Details: plan-review/usage.jsonl`;
};
