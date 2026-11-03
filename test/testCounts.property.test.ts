// Issue #39 (S1): properties of the counts file and of fallenCounts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { type CommandReport, type CountsFile, decodeCountsFile, encodeCountsFile, fallenCounts } from "../src/testCounts.ts";

const RUNS = { numRuns: 200, seed: 20261103 };
const arbName = fc.constantFrom("npm run test:unit", "npm run test:web", "npm run test:cli", "npm run build", "npx playwright test");
const arbCount = fc.nat({ max: 100_000 });
const arbReport: fc.Arbitrary<CommandReport> = fc.oneof(
  fc.record({
    _tag: fc.constant("Counted" as const),
    name: arbName,
    outcome: fc.constantFrom("passed" as const, "failed" as const),
    scope: fc.constantFrom("whole" as const, "selection" as const),
    counts: fc.record({ passed: arbCount, failed: arbCount, skipped: arbCount }, { noNullPrototype: true }),
  }, { noNullPrototype: true }),
  fc.record({ _tag: fc.constant("Uncounted" as const), name: arbName, outcome: fc.constantFrom("passed" as const, "failed" as const) }, { noNullPrototype: true }),
);
const arbFile: fc.Arbitrary<CountsFile> = fc
  .tuple(arbReport, fc.array(arbReport, { maxLength: 6 }))
  .map(([first, rest]) => ({ version: 2 as const, commands: [first, ...rest] }));

test("an encoded counts file decodes to itself", () => {
  fc.assert(fc.property(arbFile, (file) => assert.deepEqual(Result.getOrThrow(decodeCountsFile(encodeCountsFile(file))), file)), RUNS);
});

/** The reference: for each name counted in both lists (the first occurrence of each), a fall of its passed count. */
const reference = (before: readonly CommandReport[], after: readonly CommandReport[]) =>
  after.flatMap((a, i) => {
    if (a._tag !== "Counted" || after.findIndex((x) => x.name === a.name) !== i) return [];
    const b = before.find((x) => x.name === a.name);
    return b !== undefined && b._tag === "Counted" && a.counts.passed < b.counts.passed ? [{ name: a.name, before: b.counts.passed, after: a.counts.passed }] : [];
  });

test("fallenCounts agrees with the reference model", () => {
  const arbList = fc.uniqueArray(arbReport, { selector: (r) => r.name, maxLength: 5 });
  fc.assert(fc.property(arbList, arbList, (before, after) => assert.deepEqual(fallenCounts(before, after), reference(before, after))), RUNS);
});
