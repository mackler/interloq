// Issue #39 (S4): the stages of npm test write their runners' structured reports through the scripts in package.json,
// and the hand-run CLI check uses the same flags.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STAGE_REPORT_VARIABLE } from "../src/runnerCounts.ts";

const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
export const BATS_REPORT_FLAGS = `--report-formatter tap --output "$${STAGE_REPORT_VARIABLE}"`;

test("test:unit adds the counts reporter beside the spec reporter", () => {
  assert.match(scripts["test:unit"], /--test-reporter=spec --test-reporter-destination=stdout/u);
  assert.match(scripts["test:unit"], /--test-reporter=\.\/scripts\/nodeTestCounts\.ts/u);
  assert.match(scripts["test:unit"], / test\/\*\.test\.ts$/u);
});

test("test:cli writes bats' TAP report only where the variable is set", () => {
  assert.ok(scripts["test:cli"].includes(`\${${STAGE_REPORT_VARIABLE}:+${BATS_REPORT_FLAGS}}`), scripts["test:cli"]);
});
