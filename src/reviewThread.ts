/**
 * Which Codex thread the next round of a review loop uses (pure; issue #165, requirements Q1).
 *
 * Codex keeps one thread per review loop until a turn's input passes `codexTurnInputLimit`; the next round of that loop
 * starts a new thread. A new thread whose own turn passes the limit is replaced again for the following round, with no
 * bound on how often (the requirements' open point).
 */

/** The thread a review turn is sent to: the loop's thread that holds its earlier rounds, or one started for this round. */
export type ReviewThread = "continued" | "new";

/**
 * The thread of the next round, given the input tokens of every Codex turn of the round just ended (its review turn and
 * any repair turn of that review; null for a turn Codex reported no usage for).
 */
export const threadAfter = (inputs: readonly (number | null)[], limit: number): ReviewThread =>
  inputs.some((n) => n !== null && n > limit) ? "new" : "continued";

/** The largest input among a round's turns, the figure the restart line names; null where none was reported. */
export const largestInput = (inputs: readonly (number | null)[]): number | null =>
  inputs.reduce<number | null>((max, n) => (n === null || (max !== null && max >= n) ? max : n), null);
