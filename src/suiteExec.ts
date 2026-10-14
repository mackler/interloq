// Issue #162 (requirements G-R1-1, F1): the whole suite run by Interloq itself, an edge like src/codexExec.ts and tested
// against real child processes (test/suiteExec.test.ts). The command runs through a shell in the project's directory
// with the environment Interloq was started with, in a process group of its own, so that the bound, an interruption
// (Stop task) and the end of the shell kill everything the suite started. Every stream has an 'error' listener,
// attached before anything else and never removed (issue #158: a stream error with no listener ended the server).
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { Effect, Result } from "effect";
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

/** How long the runner waits for the output streams to close after the shell has exited, before it stops reading:
 * a descendant that left the shell's process group survives the group's kill and may hold the output open (W2-R1-1).
 * Fixed in the code, not a setting. */
export const SUITE_CLOSE_GRACE_MS = 2000;

/** How a run ended: the shell's exit, with its code or signal, or the ceiling. */
type RunEnd =
  | Readonly<{ kind: "exited"; code: number | null; signal: NodeJS.Signals | null }>
  | Readonly<{ kind: "timedOut"; ms: number }>;

/** The result of a run's end, with its output and duration: the one function the close, the grace and the ceiling share. */
const resultOf = (end: RunEnd, output: string, ms: number): SuiteResult => {
  if (end.kind === "timedOut") return { _tag: "Failed", reason: { kind: "timedOut", ms: end.ms }, output, ms };
  if (end.code === 0) return { _tag: "Passed", output, ms };
  const reason: SuiteFailure = end.code !== null ? { kind: "exit", code: end.code } : { kind: "signal", signal: end.signal ?? "unknown" };
  return { _tag: "Failed", reason, output, ms };
};

/** The live runner: a command through a shell in `cwd`, with `env`, bounded by `ceilingMs`, a run past it a failure.
 * At the ceiling it stops reading at once; after the shell's exit it waits at most `SUITE_CLOSE_GRACE_MS` for the
 * output to close, so a descendant outside the group that holds the output cannot delay the result; on interruption it
 * stops reading at once too (W3-R1-2). */
export const suiteRunner = (env: Readonly<Record<string, string | undefined>>, ceilingMs: number): SuiteRunnerShape => ({
  run: (command: CommandLine, cwd: string): Effect.Effect<SuiteResult> =>
    Effect.callback<SuiteResult>((resume) => {
      const started = Date.now();
      const chunks: string[] = [];
      let settled = false;
      let exited: RunEnd | null = null;
      let grace: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      // spawn throws synchronously on an argument it refuses (W2-R1-2); the run then did not start, and the edge stays total.
      const spawned = ((): Result.Result<ChildProcessByStdio<null, Readable, Readable>, string> => {
        try {
          return Result.succeed(spawn(command, { shell: true, cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }));
        } catch (e) {
          return Result.fail(e instanceof Error ? e.message : String(e));
        }
      })();
      if (Result.isFailure(spawned)) {
        resume(Effect.succeed({ _tag: "Failed", reason: { kind: "notStarted", message: spawned.failure }, output: "", ms: Date.now() - started }));
        return Effect.void;
      }
      const child = spawned.success;
      const stopReading = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const settle = (result: SuiteResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resume(Effect.succeed(result));
      };
      const settleEnd = (end: RunEnd): void => settle(resultOf(end, chunks.join(""), Date.now() - started));
      child.on("error", (e) => {
        killGroup(child.pid);
        settle({ _tag: "Failed", reason: { kind: "notStarted", message: e.message }, output: chunks.join(""), ms: Date.now() - started });
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("error", () => undefined);
        stream.setEncoding("utf8");
        stream.on("data", (text: string) => void chunks.push(text));
      }
      timer = setTimeout(() => {
        killGroup(child.pid);
        stopReading();
        settleEnd({ kind: "timedOut", ms: ceilingMs });
      }, ceilingMs);
      // The shell has ended: what it left running in its group is killed, so the streams close and the output is whole;
      // a descendant outside the group may keep them open, so the result waits for them only for the grace.
      child.on("exit", (code, signal) => {
        const end: RunEnd = { kind: "exited", code, signal };
        exited = end;
        killGroup(child.pid);
        // A path that settled first (an interruption, the ceiling, an error) may have left a stream open; destroy is idempotent.
        if (settled) {
          stopReading();
          return;
        }
        grace = setTimeout(() => {
          stopReading();
          settleEnd(end);
        }, SUITE_CLOSE_GRACE_MS);
      });
      child.on("close", (code, signal) => settleEnd(exited ?? { kind: "exited", code, signal }));
      return Effect.sync(() => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        killGroup(child.pid);
        // A descendant outside the group may hold the output open; the server outlives the run, so it stops reading (W3-R1-2).
        stopReading();
      });
    }),
});
