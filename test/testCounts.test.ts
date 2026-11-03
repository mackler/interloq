// Issue #39 (S1): the counts file a final command writes, decoded and refused by example; the counts that fell.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { type CommandReport, COUNTS_FILE_VARIABLE, decodeCountsFile, encodeCountsFile, fallenCounts } from "../src/testCounts.ts";

const counted = (name: string, passed: number, failed = 0, skipped = 0): CommandReport => ({
  _tag: "Counted",
  name,
  outcome: failed === 0 ? "passed" : "failed",
  scope: "whole",
  counts: { passed, failed, skipped },
});
const build: CommandReport = { _tag: "Uncounted", name: "npm run build", outcome: "passed" };

test("a counts file is decoded as it was encoded", () => {
  const file = { version: 2 as const, commands: [counted("npm run test:unit", 812, 1, 3), build] as const };
  const text = encodeCountsFile(file);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(Result.getOrThrow(decodeCountsFile(text)), file);
});

const refused = (value: unknown): string => {
  const decoded = decodeCountsFile(typeof value === "string" ? value : JSON.stringify(value));
  assert.ok(Result.isFailure(decoded), `expected a refusal of ${JSON.stringify(value)}`);
  assert.ok(decoded.failure.length > 0);
  return decoded.failure;
};

test("a negative count, a fractional count, counts on an uncounted command, no command and invalid JSON are refused", () => {
  refused({ version: 2, commands: [counted("npm run test:unit", -1)] });
  refused({ version: 2, commands: [counted("npm run test:unit", 1.5)] });
  refused({ version: 2, commands: [{ ...build, counts: { passed: 1, failed: 0, skipped: 0 } }] });
  refused({ version: 2, commands: [] });
  refused({ version: 2, commands: [{ ...build, name: "  " }] });
  refused({ version: 1, commands: [build] });
  refused("{ not json");
});

test("the counts file's variable is Interloq's own name", () => {
  assert.equal(COUNTS_FILE_VARIABLE, "INTERLOQ_TEST_COUNTS_FILE");
});

test("fallenCounts names the counted commands whose passed count fell, and nothing else", () => {
  const before = [counted("npm run test:unit", 812), counted("npm run test:web", 300), build];
  const after = [counted("npm run test:unit", 790), counted("npm run test:web", 301), { ...build, outcome: "failed" as const }];
  assert.deepEqual(fallenCounts(before, after), [{ name: "npm run test:unit", before: 812, after: 790 }]);
  assert.deepEqual(fallenCounts(before, [{ _tag: "Uncounted", name: "npm run test:unit", outcome: "passed" }]), []);
});
