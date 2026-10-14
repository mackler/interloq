// Issue #162: the check commands an execution phase reported, grouped per step (pure). The work review's criterion
// judges a step by the total of its checks, not by any one command, and a step reported in two calls of one phase
// (a continued phase) is one group (P1-R1-1).
import type { StepCheckRun } from "./schema.ts";

/** One step's reported checks: its commands with their seconds, in order, and their sum. */
export type StepCheckTotal = Readonly<{ step: string; commands: ReadonlyArray<Readonly<{ command: string; seconds: number }>>; seconds: number }>;

/** The checks grouped by step id in first-seen order, with each step's commands and the sum of their seconds. */
export const checkTotals = (checks: ReadonlyArray<StepCheckRun>): ReadonlyArray<StepCheckTotal> =>
  [...new Set(checks.map((check) => check.step))].map((step) => {
    const commands = checks.filter((check) => check.step === step).map(({ command, seconds }) => ({ command, seconds }));
    return { step, commands, seconds: commands.reduce((sum, c) => sum + c.seconds, 0) };
  });
