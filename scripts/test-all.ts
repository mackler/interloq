// `npm test` (issue #75): the type check, the unit, CLI and component tests and the build run at once. Each stage's
// output is printed whole when the stage ends, under its name and exit code. The end-to-end tests are not part of it:
// they are `npm run test:e2e`, run as a separate step of .github/workflows/ci.yml (the developer's decision of
// 19 Oct 2026, in the run of issue #179, after a final suite run stopped at the 20-minute ceiling).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Option, Result } from "effect";
import { commandReportsText } from "../src/prompts.ts";
import { nodeTestCounts, STAGE_REPORT_VARIABLE, tapCounts, vitestCounts } from "../src/runnerCounts.ts";
import { type CommandReport, COUNTS_FILE_VARIABLE, type CountsFile, encodeCountsFile, type TestCounts } from "../src/testCounts.ts";

/**
 * Issue #39: which runner's structured report a stage writes into the directory named by INTERLOQ_STAGE_REPORT_DIR, and
 * so which reader of src/runnerCounts.ts applies: none for a stage with nothing to count (a type check, a build).
 */
export type StageReport = Readonly<{ kind: "none" }> | Readonly<{ kind: "nodeTest" }> | Readonly<{ kind: "vitest" }> | Readonly<{ kind: "tap" }>;
export const NO_REPORT: StageReport = { kind: "none" };
export type Stage = Readonly<{ name: string; script: string; report: StageReport }>;
/** A stage that ended: its exit code, its output, and what it reported as a command. */
export type StageResult = Readonly<{ stage: Stage; code: number; output: string; report: CommandReport }>;
/** The process boundary: runs one stage to its end. */
export type StartStage = (stage: Stage) => Promise<StageResult>;
export type Outcome = Readonly<{ results: readonly StageResult[]; code: 0 | 1 }>;
export type NonEmpty<A> = readonly [A, ...A[]];
/**
 * What a runner runs: stages that share nothing, started at once, and optionally one stage after them. A run without a
 * final stage has no final field, so nothing checks whether one is present (issue #105).
 */
export type Stages =
  | Readonly<{ kind: "parallel"; parallel: NonEmpty<Stage> }>
  | Readonly<{ kind: "thenFinal"; parallel: NonEmpty<Stage>; final: Stage }>;

const stage = (script: string, report: StageReport = NO_REPORT): Stage => ({ name: script, script, report });
/**
 * `npm test`'s stages: the type check, the unit, CLI and component tests and the build, run at once, with no final
 * stage. The end-to-end tests are `npm run test:e2e`, a step of their own in .github/workflows/ci.yml (the developer's
 * decision of 19 Oct 2026, in the run of issue #179).
 */
export const testStages: Stages = {
  kind: "parallel",
  parallel: [stage("check"), stage("test:unit", { kind: "nodeTest" }), stage("test:cli", { kind: "tap" }), stage("test:web", { kind: "vitest" }), stage("build")],
};

/** The file a stage's runner writes into the stage's report directory, and its reader. */
const reportFile = (report: Exclude<StageReport, { kind: "none" }>): Readonly<{ file: string; read: (text: string) => Result.Result<TestCounts, string> }> => {
  switch (report.kind) {
    case "nodeTest":
      return { file: "node-test.json", read: nodeTestCounts };
    case "vitest":
      return { file: "vitest.json", read: vitestCounts };
    case "tap":
      return { file: "report.tap", read: tapCounts };
  }
};

/**
 * What a stage reports as a command: `npm run <script>` with its outcome by its exit code, counted where its runner's
 * report reads as counts, and uncounted otherwise: a stage with nothing to count, or a report missing or unreadable, of
 * which no number is shown.
 */
export const stageReport = (s: Stage, code: number, reportText: string | null): CommandReport => {
  const name = `npm run ${s.script}`;
  const outcome = code === 0 ? "passed" : "failed";
  const uncounted: CommandReport = { _tag: "Uncounted", name, outcome };
  if (s.report.kind === "none" || reportText === null) return uncounted;
  return Result.match(reportFile(s.report).read(reportText), {
    onFailure: () => uncounted,
    onSuccess: (counts): CommandReport => ({ _tag: "Counted", name, outcome, scope: "whole", counts }),
  });
};

/** The counts file of a run's stages, in the order they are listed; none for a run of no stage. */
export const countsFileOf = (results: readonly StageResult[]): Option.Option<CountsFile> => {
  const [first, ...rest] = results.map((r) => r.report);
  return first === undefined ? Option.none() : Option.some({ version: 2, commands: [first, ...rest] });
};

/** The pure part of the decision: whether every stage passed. */
export const verdict = (results: readonly StageResult[]): Readonly<{ failed: readonly string[]; passed: boolean }> => {
  const failed = results.filter((r) => r.code !== 0).map((r) => r.stage.name);
  return { failed, passed: failed.length === 0 };
};

/** Runs the parallel stages at once, then the final stage, where there is one, if all of them passed. */
export const runStages = async (stages: Stages, start: StartStage, onEnd: (result: StageResult) => void = () => {}): Promise<Outcome> => {
  const ended = (result: StageResult): StageResult => {
    onEnd(result);
    return result;
  };
  const first = await Promise.all(stages.parallel.map((s) => start(s).then(ended)));
  const results = await (async (): Promise<readonly StageResult[]> => {
    switch (stages.kind) {
      case "parallel":
        return first;
      case "thenFinal":
        return verdict(first).passed ? [...first, ended(await start(stages.final))] : first;
    }
  })();
  return { results, code: verdict(results).passed ? 0 : 1 };
};

/** The text of a stage's runner's report in its directory, or none where it wrote none. */
const readReport = (s: Stage, dir: string | null): string | null => {
  if (dir === null || s.report.kind === "none") return null;
  try {
    return readFileSync(join(dir, reportFile(s.report).file), "utf8");
  } catch {
    return null;
  }
};

/**
 * The edge: `npm run <script>` as a child process, its output buffered, or with `stream` passed through as it comes
 * (the end-to-end tests run alone, so their progress is shown live). Issue #39: a stage that counts tests gets a fresh
 * directory in INTERLOQ_STAGE_REPORT_DIR, read for its runner's report when it ends and then removed.
 */
export const spawnStage =
  (command: string, args: (stage: Stage) => readonly string[], stream: (stage: Stage) => boolean = () => false): StartStage =>
  (s) =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const dir = s.report.kind === "none" ? null : mkdtempSync(join(tmpdir(), "interloq-stage-"));
      const env = dir === null ? process.env : { ...process.env, [STAGE_REPORT_VARIABLE]: dir };
      const child = spawn(command, args(s), { stdio: stream(s) ? "inherit" : ["ignore", "pipe", "pipe"], env });
      child.stdout?.on("data", (c: Buffer) => chunks.push(c));
      child.stderr?.on("data", (c: Buffer) => chunks.push(c));
      const ended = (code: number, output: string): void => {
        const text = readReport(s, dir);
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
        resolve({ stage: s, code, output, report: stageReport(s, code, text) });
      };
      // A child that cannot start is a failed stage with the reason as its output, not an exception.
      child.on("error", (e) => ended(127, `${Buffer.concat(chunks).toString()}${e.message}\n`));
      child.on("close", (code, signal) => ended(code ?? 1, `${Buffer.concat(chunks).toString()}${signal === null ? "" : `killed by ${signal}\n`}`));
    });

/** Prints one stage's output whole, under its name and exit code, when it ends. */
export const report = (r: StageResult): void => {
  process.stdout.write(`\n=== ${r.stage.name}: ${r.code === 0 ? "passed" : `FAILED (exit code ${r.code})`} ===\n${r.output}`);
};

/**
 * A runner's last line: that every stage passed, or which failed, then each command that ran with its counts where its
 * runner gave them (issue #39).
 */
export const summary = (label: string, outcome: Outcome): string => {
  const { failed } = verdict(outcome.results);
  const first = failed.length === 0 ? `${label}: every stage passed.` : `${label}: failed: ${failed.join(", ")}.`;
  return outcome.results.length === 0 ? first : `${first} ${commandReportsText(outcome.results.map((r) => r.report))}`;
};

/** Issue #39: the counts file, written where Interloq names one (a final command's run of npm test). */
export const writeCountsFile = (results: readonly StageResult[], env: NodeJS.ProcessEnv): void => {
  const path = env[COUNTS_FILE_VARIABLE];
  if (path === undefined || path === "") return;
  Option.match(countsFileOf(results), { onNone: () => undefined, onSome: (file) => writeFileSync(path, encodeCountsFile(file)) });
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  void runStages(testStages, spawnStage(npm, (s) => ["run", "--silent", s.script]), report).then((outcome) => {
    process.stdout.write(`\n${summary("npm test", outcome)}\n`);
    writeCountsFile(outcome.results, process.env);
    process.exitCode = outcome.code;
  });
}
