// Issue #18: the run time's text, one source for the program's closing line and the page's ended line.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { durationText, runTimeText } from "../src/prompts.ts";

test("the run time is written as the rail writes a duration", () => {
  assert.equal(runTimeText(0), "Run time: 0:00");
  assert.equal(runTimeText(59_999), "Run time: 0:59");
  assert.equal(runTimeText(3_725_000), "Run time: 1:02:05");
});

test("the run time's format is durationText's, the seam with the rail", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 * 24 * 3_600_000 }), (ms) => runTimeText(ms) === `Run time: ${durationText(ms)}`),
    { numRuns: 200 },
  );
});
