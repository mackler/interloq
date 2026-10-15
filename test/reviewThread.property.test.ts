import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { largestInput, threadAfter } from "../src/reviewThread.ts";

// Issue #165 (requirements Q1): a round whose Codex turn passed the limit is followed by a round in a new thread.
const RUNS = { numRuns: 300, seed: 20261015 };
const limit = fc.integer({ min: 1, max: 5_000_000 });
const input = fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null });

test("inputs at or under the limit, or unreported, continue the thread", () => {
  fc.assert(
    fc.property(limit, fc.array(fc.option(fc.nat(), { nil: null })), (l, raw) => {
      const inputs = raw.map((n) => (n === null ? null : n % (l + 1)));
      return threadAfter(inputs, l) === "continued";
    }),
    RUNS,
  );
});

test("any input above the limit starts a new thread", () => {
  fc.assert(
    fc.property(limit, fc.array(input), fc.array(input), fc.integer({ min: 1, max: 1_000_000 }), (l, before, after, excess) =>
      threadAfter([...before, l + excess, ...after], l) === "new"),
    RUNS,
  );
});

test("raising one input never turns a new thread into a continued one, and order does not matter", () => {
  fc.assert(
    fc.property(limit, fc.array(input, { minLength: 1 }), fc.nat(), fc.nat(), (l, inputs, at, raise) => {
      const i = at % inputs.length;
      const raised = inputs.map((n, j) => (j === i ? (n ?? 0) + raise : n));
      const monotone = threadAfter(inputs, l) === "continued" || threadAfter(raised, l) === "new";
      return monotone && threadAfter([...inputs].reverse(), l) === threadAfter(inputs, l);
    }),
    RUNS,
  );
});

test("largestInput is the maximum of the reported inputs, null where none was reported", () => {
  fc.assert(
    fc.property(fc.array(input), (inputs) => {
      const reported = inputs.filter((n): n is number => n !== null);
      return largestInput(inputs) === (reported.length === 0 ? null : Math.max(...reported));
    }),
    RUNS,
  );
});

test("the examples of the four-round loop of 14 Oct 2026", () => {
  assert.equal(threadAfter([826_111], 500_000), "new");
  assert.equal(threadAfter([451_938], 500_000), "continued");
  assert.equal(threadAfter([500_000], 500_000), "continued");
  assert.equal(threadAfter([], 500_000), "continued");
  assert.equal(largestInput([null, 826_111, 1_000]), 826_111);
});
