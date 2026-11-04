// Issue #162: the check commands an execution phase reported, grouped per step (pure); a step reported in two calls of
// one phase (a continued phase) is one group (P1-R1-1). Issue #245: the groups carry no seconds and no total, since the
// work review raises no point about how long a step's checks took.
import type { StepCheckRun } from "./schema.ts";

/** One step's reported checks: its commands with their selection and counts (issue #39), in report order. */
export type StepCheckGroup = Readonly<{ step: string; commands: ReadonlyArray<Omit<StepCheckRun, "step" | "seconds">> }>;

/** The checks grouped by step id in first-seen order, each step's commands in report order. */
export const checksByStep = (checks: ReadonlyArray<StepCheckRun>): ReadonlyArray<StepCheckGroup> =>
  [...new Set(checks.map((check) => check.step))].map((step) => ({
    step,
    commands: checks.filter((check) => check.step === step).map(({ command, selection, counts }) => ({ command, selection, counts })),
  }));
