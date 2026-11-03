// Issue #39 (S2): the words of a command report, the single source the suite's lines, the rail and npm test's summary use.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { commandReportsText, commandReportText, fallenCountsText } from "../src/prompts.ts";
import type { CommandReport } from "../src/testCounts.ts";

const unit: CommandReport = { _tag: "Counted", name: "npm run test:unit", outcome: "passed", scope: "whole", counts: { passed: 812, failed: 0, skipped: 3 } };

test("a counted report names its command and its three counts", () => {
  assert.equal(commandReportText(unit), "npm run test:unit: 812 passed, 0 failed, 3 skipped");
});

test("a selection says so", () => {
  assert.equal(commandReportText({ ...unit, scope: "selection" }), "npm run test:unit: 812 passed, 0 failed, 3 skipped (a selection)");
});

test("an uncounted command says whether it succeeded, with no number and nothing about a count", () => {
  for (const outcome of ["passed", "failed"] as const) {
    const text = commandReportText({ _tag: "Uncounted", name: "npm run build", outcome });
    assert.doesNotMatch(text, /\d/u);
    assert.doesNotMatch(text, /count|unknown|not available|missing/iu);
    assert.ok(text.startsWith("npm run build "));
  }
  assert.equal(commandReportText({ _tag: "Uncounted", name: "npm run build", outcome: "passed" }), "npm run build succeeded");
  assert.equal(commandReportText({ _tag: "Uncounted", name: "npm run build", outcome: "failed" }), "npm run build failed");
});

test("the reports are joined in the order given and end with a full stop", () => {
  assert.equal(
    commandReportsText([{ _tag: "Uncounted", name: "npm run check", outcome: "passed" }, unit]),
    "npm run check succeeded; npm run test:unit: 812 passed, 0 failed, 3 skipped.",
  );
});

test("a fall is stated as a change, one sentence each, and nothing for none", () => {
  assert.equal(fallenCountsText([], "Full test suite 1"), "");
  assert.equal(
    fallenCountsText([{ name: "npm run test:unit", before: 812, after: 790 }], "Full test suite 1"),
    "The passed count of npm run test:unit fell from 812 in Full test suite 1 to 790.",
  );
});

test("for any counted report the three counts appear in the text in order", () => {
  fc.assert(
    fc.property(fc.nat(), fc.nat(), fc.nat(), (passed, failed, skipped) => {
      const text = commandReportText({ ...unit, name: "npm run test:web", counts: { passed, failed, skipped } });
      assert.deepEqual(text.match(/\d+/gu)?.map(Number), [passed, failed, skipped]);
    }),
    { numRuns: 100, seed: 20261103 },
  );
});
