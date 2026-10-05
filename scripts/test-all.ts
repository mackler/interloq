// `npm test` (issue #75): the type check and the suites that share nothing run together, then the end-to-end tests,
// which need the build. Each stage's output is printed whole when the stage ends, under its name and exit code.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Stage = Readonly<{ name: string; script: string }>;
export type StageResult = Readonly<{ stage: Stage; code: number; output: string }>;
/** The process boundary: runs one stage to its end. */
export type StartStage = (stage: Stage) => Promise<StageResult>;
export type Outcome = Readonly<{ results: readonly StageResult[]; code: 0 | 1 }>;

const stage = (script: string): Stage => ({ name: script, script });
/** The stages that share nothing: run at once. */
export const parallelStages: readonly Stage[] = ["check", "test:unit", "test:cli", "test:web", "build"].map(stage);
/** The end-to-end tests, which need the build: run only when every parallel stage passed. */
export const finalStage: Stage = stage("test:e2e");

/** The pure part of the decision: whether every stage passed. */
export const verdict = (results: readonly StageResult[]): Readonly<{ failed: readonly string[]; passed: boolean }> => {
  const failed = results.filter((r) => r.code !== 0).map((r) => r.stage.name);
  return { failed, passed: failed.length === 0 };
};

/** Runs the parallel stages at once, then the final stage if all of them passed. */
export const runStages = async (start: StartStage, onEnd: (result: StageResult) => void = () => {}): Promise<Outcome> => {
  const ended = (result: StageResult): StageResult => {
    onEnd(result);
    return result;
  };
  const first = await Promise.all(parallelStages.map((s) => start(s).then(ended)));
  const results = verdict(first).passed ? [...first, ended(await start(finalStage))] : first;
  return { results, code: verdict(results).passed ? 0 : 1 };
};

/**
 * The edge: `npm run <script>` as a child process, its output buffered, or with `stream` passed through as it comes
 * (the end-to-end tests run alone, so their progress is shown live).
 */
export const spawnStage =
  (command: string, args: (stage: Stage) => readonly string[], stream: (stage: Stage) => boolean = () => false): StartStage =>
  (s) =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const child = spawn(command, args(s), { stdio: stream(s) ? "inherit" : ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      child.stderr?.on("data", (c: Buffer) => chunks.push(c));
      // A child that cannot start is a failed stage with the reason as its output, not an exception.
      child.on("error", (e) => resolve({ stage: s, code: 127, output: `${Buffer.concat(chunks).toString()}${e.message}\n` }));
      child.on("close", (code, signal) => resolve({ stage: s, code: code ?? 1, output: `${Buffer.concat(chunks).toString()}${signal === null ? "" : `killed by ${signal}\n`}` }));
    });

const report = (r: StageResult): void => {
  process.stdout.write(`\n=== ${r.stage.name}: ${r.code === 0 ? "passed" : `FAILED (exit code ${r.code})`} ===\n${r.output}`);
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  void runStages(spawnStage(npm, (s) => ["run", "--silent", s.script], (s) => s === finalStage), report).then((outcome) => {
    const { failed } = verdict(outcome.results);
    process.stdout.write(failed.length === 0 ? "\nnpm test: every stage passed.\n" : `\nnpm test: failed: ${failed.join(", ")}.\n`);
    process.exitCode = outcome.code;
  });
}
