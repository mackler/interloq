// Issue #162 (requirements G-R1-1, F1): the whole suite run by Interloq itself, an edge like src/codexExec.ts and tested
// against real child processes (test/suiteExec.test.ts). The command runs through a shell in the project's directory
// with the environment Interloq was started with, in a process group of its own, so that the bound, an interruption
// (Stop task) and the end of the shell kill everything the suite started. Every stream has an 'error' listener,
// attached before anything else and never removed (issue #158: a stream error with no listener ended the server).
import { spawn } from "node:child_process";
import { Effect } from "effect";
import type { CommandLine } from "./schema.ts";
import type { SuiteRunnerShape } from "./services.ts";
import type { SuiteFailure, SuiteResult } from "./suite.ts";

/** Kills a process group, which may already be gone. */
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has ended: nothing is left to kill.
  }
};

/** The live runner: a command through a shell in `cwd`, with `env`, bounded by `ceilingMs`, a run past it a failure. */
export const suiteRunner = (env: Readonly<Record<string, string | undefined>>, ceilingMs: number): SuiteRunnerShape => ({
  run: (command: CommandLine, cwd: string): Effect.Effect<SuiteResult> =>
    Effect.callback<SuiteResult>((resume) => {
      const started = Date.now();
      const chunks: string[] = [];
      let settled = false;
      let timedOut = false;
      let ended: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
      const child = spawn(command, { shell: true, cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const settle = (result: SuiteResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resume(Effect.succeed(result));
      };
      const failed = (reason: SuiteFailure): SuiteResult => ({ _tag: "Failed", reason, output: chunks.join(""), ms: Date.now() - started });
      child.on("error", (e) => {
        killGroup(child.pid);
        settle(failed({ kind: "notStarted", message: e.message }));
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("error", () => undefined);
        stream.setEncoding("utf8");
        stream.on("data", (text: string) => void chunks.push(text));
      }
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, ceilingMs);
      // The shell has ended: what it left running in its group is killed, so the streams close and the output is whole.
      child.on("exit", (code, signal) => {
        ended = { code, signal };
        killGroup(child.pid);
      });
      child.on("close", (code, signal) => {
        const end = ended ?? { code, signal };
        if (timedOut) return settle(failed({ kind: "timedOut", ms: ceilingMs }));
        if (end.code === 0) return settle({ _tag: "Passed", output: chunks.join(""), ms: Date.now() - started });
        return settle(failed(end.code !== null ? { kind: "exit", code: end.code } : { kind: "signal", signal: end.signal ?? "unknown" }));
      });
      return Effect.sync(() => {
        settled = true;
        clearTimeout(timer);
        killGroup(child.pid);
      });
    }),
});
