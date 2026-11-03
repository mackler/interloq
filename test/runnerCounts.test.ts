// Issue #39 (S3): the readers of each runner's structured output, by example.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { nodeTestCounts, playwrightCounts, tapCounts, vitestCounts } from "../src/runnerCounts.ts";

const ok = <A>(r: Result.Result<A, string>): A => Result.getOrThrow(r);
const fails = (r: Result.Result<unknown, string>): void => assert.ok(Result.isFailure(r) && r.failure.length > 0);

test("Node's summary counts: a cancelled test failed, a todo test skipped", () => {
  assert.deepEqual(ok(nodeTestCounts(JSON.stringify({ passed: 10, failed: 1, cancelled: 2, skipped: 3, todo: 4 }))), { passed: 10, failed: 3, skipped: 7 });
  fails(nodeTestCounts(JSON.stringify({ passed: 10, failed: 1 })));
  fails(nodeTestCounts(JSON.stringify({ passed: -1, failed: 0, cancelled: 0, skipped: 0, todo: 0 })));
});

test("Vitest's JSON report: pending and todo tests skipped", () => {
  const report = {
    numTotalTests: 12,
    numPassedTests: 8,
    numFailedTests: 1,
    numPendingTests: 2,
    numTodoTests: 1,
    success: false,
    testResults: [{ name: "web/src/time.test.ts", status: "failed" }],
  };
  assert.deepEqual(ok(vitestCounts(JSON.stringify(report))), { passed: 8, failed: 1, skipped: 3 });
  fails(vitestCounts("Test Files  1 passed (1)"));
});

test("bats' TAP report: each test line counted once, a skip and a todo skipped, diagnostics ignored", () => {
  const tap = [
    "1..5",
    "ok 1 usage is shown",
    "not ok 2 release refuses a dirty tree",
    "# (in test file test/cli/release.bats, line 12)",
    "#   `false' failed",
    "  ---",
    "  message: 'ok 9 not a test'",
    "  ...",
    "ok 3 docker absent # skip no docker",
    "not ok 4 later # TODO not yet",
    "ok 5 upgrade fast-forwards",
    "    ok 1 an indented subtest",
  ].join("\n");
  assert.deepEqual(ok(tapCounts(tap)), { passed: 2, failed: 1, skipped: 2 });
  assert.deepEqual(ok(tapCounts("1..0\n")), { passed: 0, failed: 0, skipped: 0 });
  fails(tapCounts("hello\n"));
});

test("a malformed TAP report is refused: a plan with trailing text, a plan the test lines disagree with, two plans (W1-R1-2)", () => {
  fails(tapCounts("1..2garbage\nhello\n"));
  fails(tapCounts("1..3\nok 1 a\nok 2 b\n"));
  fails(tapCounts("1..2\nok 1 a\nok 2 b\n1..2\n"));
  assert.deepEqual(ok(tapCounts("1..0 # skip no tests\n")), { passed: 0, failed: 0, skipped: 0 });
});

test("Playwright's outcomes: a flaky test passed", () => {
  assert.deepEqual(playwrightCounts(["expected", "expected", "flaky", "unexpected", "skipped"]), { passed: 3, failed: 1, skipped: 1 });
});
