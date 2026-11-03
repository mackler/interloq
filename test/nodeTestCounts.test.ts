// Issue #39 (S4): the seam between Node's test runner and nodeTestCounts: scripts/nodeTestCounts.ts, a Node reporter,
// writes the run's summary counts where INTERLOQ_STAGE_REPORT_DIR names a directory, and nothing where it is unset.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Result } from "effect";
import { nodeTestCounts, STAGE_REPORT_VARIABLE } from "../src/runnerCounts.ts";

const reporter = join(process.cwd(), "scripts/nodeTestCounts.ts");
const FIXTURE = [
  'import { test } from "node:test";',
  'test("passes", () => {});',
  'test("fails", () => { throw new Error("no"); });',
  'test("skipped", { skip: true }, () => {});',
  'test("todo", { todo: true }, () => {});',
].join("\n");

const run = (env: NodeJS.ProcessEnv): { dir: string; reports: string } => {
  const dir = mkdtempSync(join(tmpdir(), "node-counts-"));
  const reports = join(dir, "reports");
  spawnSync("mkdir", [reports]);
  writeFileSync(join(dir, "fixture.test.mjs"), FIXTURE);
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", "fixture.test.mjs"], { cwd: dir, env: childEnv, encoding: "utf8" });
  return { dir, reports };
};

test("the reporter writes the run's counts, which nodeTestCounts reads as 1 passed, 1 failed, 2 skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-counts-out-"));
  try {
    const { dir: work } = run({ [STAGE_REPORT_VARIABLE]: dir });
    rmSync(work, { recursive: true, force: true });
    const text = readFileSync(join(dir, "node-test.json"), "utf8");
    assert.deepEqual(Result.getOrThrow(nodeTestCounts(text)), { passed: 1, failed: 1, skipped: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the variable unset the reporter writes nothing", () => {
  const { dir, reports } = run({ [STAGE_REPORT_VARIABLE]: undefined });
  try {
    assert.ok(!existsSync(join(reports, "node-test.json")));
    assert.ok(!existsSync(join(dir, "node-test.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
