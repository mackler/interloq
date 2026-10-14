// Issue #162 (requirements G-R1-1, F1): the whole suite that Interloq runs after a converged work review, as data (pure).
// The runner is the edge src/suiteExec.ts; the port is `SuiteRunner` in src/services.ts.

/** Why a suite run failed: its exit code, the signal that ended it, the bound it exceeded, or the shell not starting. */
export type SuiteFailure =
  | Readonly<{ kind: "exit"; code: number }>
  | Readonly<{ kind: "signal"; signal: string }>
  | Readonly<{ kind: "timedOut"; ms: number }>
  | Readonly<{ kind: "notStarted"; message: string }>;

/** A suite run's result: its output (stdout and stderr in arrival order) and its duration, passed or failed. */
export type SuiteResult =
  | Readonly<{ _tag: "Passed"; output: string; ms: number }>
  | Readonly<{ _tag: "Failed"; reason: SuiteFailure; output: string; ms: number }>;

/** A suite run's result as its PhaseEnded names it, which the page keeps on the phase's entry (issue #162). */
export const SUITE_OUTCOMES = ["passed", "failed"] as const;
export type SuiteOutcome = (typeof SUITE_OUTCOMES)[number];
export const suiteOutcomeOf = (result: SuiteResult): SuiteOutcome => (result._tag === "Passed" ? "passed" : "failed");

/** The lines of a failed suite's output that the revision prompt carries (requirements: the last 200). */
export const SUITE_TAIL_LINES = 200;

/** The last n lines of a text: the whole text when it has n lines or fewer. A final line break ends the last line. */
export const tailLines = (output: string, n: number): string => {
  const ended = output.endsWith("\n");
  const lines = (ended ? output.slice(0, -1) : output).split("\n");
  return lines.length <= n ? output : `${lines.slice(-n).join("\n")}${ended ? "\n" : ""}`;
};
