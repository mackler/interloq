// Issue #39 (S3): properties of the readers of each runner's structured output: a report generated from counts reads
// back as those counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { nodeTestCounts, playwrightCounts, tapCounts, vitestCounts } from "../src/runnerCounts.ts";

const RUNS = { numRuns: 200, seed: 20261103 };
const n = fc.nat({ max: 10_000 });

test("Vitest: a report generated from counts reads back as them", () => {
  fc.assert(
    fc.property(n, n, n, n, (passed, failed, pending, todo) => {
      const text = JSON.stringify({ numTotalTests: passed + failed + pending + todo, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending, numTodoTests: todo, testResults: [] });
      assert.deepEqual(Result.getOrThrow(vitestCounts(text)), { passed, failed, skipped: pending + todo });
    }),
    RUNS,
  );
});

type Kind = "pass" | "fail" | "skip" | "todo";
const line = (kind: Kind, i: number): string =>
  kind === "pass" ? `ok ${i} test ${i}` : kind === "fail" ? `not ok ${i} test ${i}\n# (in test file x.bats)` : kind === "skip" ? `ok ${i} test ${i} # skip why` : `not ok ${i} test ${i} # TODO later`;

test("TAP: a report of a sequence of tests reads back as the sequence's counts", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom<Kind>("pass", "fail", "skip", "todo"), { maxLength: 40 }), (kinds) => {
      const text = [`1..${kinds.length}`, ...kinds.map((k, i) => line(k, i + 1))].join("\n");
      const count = (k: Kind) => kinds.filter((x) => x === k).length;
      assert.deepEqual(Result.getOrThrow(tapCounts(text)), { passed: count("pass"), failed: count("fail"), skipped: count("skip") + count("todo") });
    }),
    RUNS,
  );
});

test("Node: cancelled counts as failed, todo as skipped, and nothing is lost", () => {
  fc.assert(
    fc.property(n, n, n, n, n, (passed, failed, cancelled, skipped, todo) => {
      const c = Result.getOrThrow(nodeTestCounts(JSON.stringify({ passed, failed, cancelled, skipped, todo })));
      assert.equal(c.failed, failed + cancelled);
      assert.equal(c.skipped, skipped + todo);
      assert.equal(c.passed + c.failed + c.skipped, passed + failed + cancelled + skipped + todo);
    }),
    RUNS,
  );
});

test("Playwright: the three counts sum to the tests", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("expected", "unexpected", "flaky", "skipped" as const)), (outcomes) => {
      const c = playwrightCounts(outcomes);
      assert.equal(c.passed + c.failed + c.skipped, outcomes.length);
      assert.equal(c.passed, outcomes.filter((o) => o === "expected" || o === "flaky").length);
      assert.equal(c.failed, outcomes.filter((o) => o === "unexpected").length);
    }),
    RUNS,
  );
});

test("a text that is not the runner's shape is a failure for every text reader", () => {
  fc.assert(
    fc.property(fc.string().filter((s) => !/^\s*\d+\.\.\d+/mu.test(s) && !/^(not )?ok\b/mu.test(s)), (text) => {
      for (const read of [nodeTestCounts, vitestCounts, tapCounts]) assert.ok(Result.isFailure(read(text)));
    }),
    RUNS,
  );
});
