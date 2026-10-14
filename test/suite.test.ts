// Issue #162: the pure part of the whole suite's run: the tail of its output that the revision prompt carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { tailLines } from "../src/suite.ts";

test("tailLines keeps the last n lines, and the whole text when it has fewer", () => {
  assert.equal(tailLines("a\nb\nc\nd\n", 2), "c\nd\n");
  assert.equal(tailLines("a\nb\nc", 2), "b\nc");
  assert.equal(tailLines("a\nb", 5), "a\nb");
  assert.equal(tailLines("", 3), "");
});

test("property: the tail is a suffix of the output with at most n lines, the whole output when it has n or fewer", () => {
  const output = fc.array(fc.string({ unit: fc.constantFrom("x", "y", " ") }), { maxLength: 30 }).chain((lines) => fc.boolean().map((end) => lines.join("\n") + (end ? "\n" : "")));
  fc.assert(
    fc.property(output, fc.integer({ min: 1, max: 10 }), (text, n) => {
      const tail = tailLines(text, n);
      assert.ok(text.endsWith(tail));
      const lines = (t: string): number => (t === "" ? 0 : t.replace(/\n$/u, "").split("\n").length);
      assert.ok(lines(tail) <= n);
      if (lines(text) <= n) assert.equal(tail, text);
      else assert.equal(lines(tail), n);
    }),
    { numRuns: 300 },
  );
});
