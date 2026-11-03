// Issue #39 (S6): the Playwright reporter that writes the end-to-end command's counts file, and the command's name as
// it was invoked.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Result } from "effect";
import CountsReporter, { commandNameOf, scopeOf } from "../e2e/countsReporter.ts";
import { COUNTS_FILE_VARIABLE, decodeCountsFile } from "../src/testCounts.ts";

const PLAYWRIGHT = ["/usr/bin/node", "/workspace/node_modules/.bin/playwright", "test"];

test("under npm run the name is the script, with the arguments npm passed on", () => {
  assert.equal(commandNameOf({ npm_lifecycle_event: "test:e2e" }, PLAYWRIGHT), "npm run test:e2e");
  assert.equal(commandNameOf({ npm_lifecycle_event: "test:e2e" }, [...PLAYWRIGHT, "-g", "x"]), "npm run test:e2e -- -g x");
});

test("under npx, or with no npm event, the name is npx playwright test with its arguments, a selector quoted", () => {
  const argv = [...PLAYWRIGHT, "e2e/run.spec.ts", "-g", "\\(7\\)"];
  for (const env of [{ npm_lifecycle_event: "npx" }, {}]) assert.equal(commandNameOf(env, argv), "npx playwright test e2e/run.spec.ts -g '\\(7\\)'");
  assert.equal(commandNameOf({}, [...PLAYWRIGHT, "-g", "it's"]), "npx playwright test -g 'it'\\''s'");
});

test("the scope is a selection for E2E_SCENARIOS, a file or a selector, and whole otherwise", () => {
  assert.equal(scopeOf({}, PLAYWRIGHT), "whole");
  assert.equal(scopeOf({}, [...PLAYWRIGHT, "--workers", "2"]), "whole");
  assert.equal(scopeOf({ E2E_SCENARIOS: "tabs" }, PLAYWRIGHT), "selection");
  assert.equal(scopeOf({}, [...PLAYWRIGHT, "e2e/run.spec.ts"]), "selection");
  assert.equal(scopeOf({}, [...PLAYWRIGHT, "-g", "x"]), "selection");
  assert.equal(scopeOf({}, [...PLAYWRIGHT, "--project=chromium"]), "selection");
});

test("only an option Playwright gives a value consumes the next argument, and every selecting option is a selection (W1-R1-1)", () => {
  const scope = (...args: string[]) => scopeOf({}, [...PLAYWRIGHT, ...args]);
  assert.equal(scope("--headed", "e2e/run.spec.ts"), "selection");
  assert.equal(scope("--workers", "2"), "whole");
  assert.equal(scope("--workers=2"), "whole");
  assert.equal(scope("--reporter", "list", "e2e/run.spec.ts"), "selection");
  assert.equal(scope("--headed"), "whole");
  for (const args of [["-G", "slow"], ["--shard", "1/2"], ["--shard=1/2"], ["--last-failed"], ["--test-list", "tests.txt"], ["--only-changed"]]) {
    assert.equal(scope(...args), "selection", args.join(" "));
  }
  assert.equal(scope("-x"), "whole");
  assert.equal(scope("--max-failures", "1"), "whole");
});

test("onEnd writes one counted command from the tests' outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-counts-"));
  const saved = { file: process.env[COUNTS_FILE_VARIABLE], scenarios: process.env.E2E_SCENARIOS };
  try {
    const path = join(dir, "counts.json");
    process.env[COUNTS_FILE_VARIABLE] = path;
    process.env.E2E_SCENARIOS = "tabs";
    const outcomes = ["expected", "expected", "flaky", "unexpected", "skipped"] as const;
    const reporter = new CountsReporter();
    reporter.onBegin({}, { allTests: () => outcomes.map((o) => ({ outcome: () => o })) });
    reporter.onEnd({ status: "failed" });
    const file = Result.getOrThrow(decodeCountsFile(readFileSync(path, "utf8")));
    assert.deepEqual(file.commands, [
      { _tag: "Counted", name: commandNameOf(process.env, process.argv), outcome: "failed", scope: "selection", counts: { passed: 3, failed: 1, skipped: 1 } },
    ]);
  } finally {
    for (const [key, value] of [[COUNTS_FILE_VARIABLE, saved.file], ["E2E_SCENARIOS", saved.scenarios]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
