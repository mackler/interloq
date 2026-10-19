// Issue #162 (requirements G-R1-1, F1): the whole suite that Interloq runs after the review of the work finds nothing left to correct, as data (pure).
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

/** Issue #181 (requirements Q2): a failure that is the work's fault, a nonzero exit or a signal; the plan is revised from it. */
export type WorkFailure = Extract<SuiteFailure, { kind: "exit" | "signal" }>;
/** Issue #181 (requirements Q1): a stop that is not the work's fault, the limit or a shell that could not start; never revised from. */
export type OutsideStop = Extract<SuiteFailure, { kind: "timedOut" | "notStarted" }>;

/** A suite run's result as the run acts on it (issue #181): passed, failed by the work, or stopped outside it. */
export type SuiteVerdict =
  | Readonly<{ _tag: "Passed" }>
  | Readonly<{ _tag: "WorkFailed"; reason: WorkFailure }>
  | Readonly<{ _tag: "Stopped"; reason: OutsideStop }>;

export const suiteVerdictOf = (result: SuiteResult): SuiteVerdict => {
  if (result._tag === "Passed") return { _tag: "Passed" };
  const reason = result.reason;
  switch (reason.kind) {
    case "exit":
    case "signal":
      return { _tag: "WorkFailed", reason };
    case "timedOut":
    case "notStarted":
      return { _tag: "Stopped", reason };
  }
};
