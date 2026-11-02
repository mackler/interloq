import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { lineChange, lineEdits } from "../src/lineChange.ts";

// Issue #216 (W2-R1-1): the lines of a shortest edit script, which the change report of Bring Up to Date shows, agree
// with lineChange's counts, and replaying them turns one text into the other.

const linesOf = (text: string): readonly string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};
// A small alphabet of lines, so that reorderings and repeats occur often.
const textArb = fc.array(fc.constantFrom("a", "b", "c", "d", ""), { maxLength: 12 }).chain((lines) => fc.constantFrom(lines.join("\n"), `${lines.join("\n")}\n`));

/**
 * Whether the lines of `a` can be split into `removed` (a subsequence) and kept lines, and those of `b` into `added` and
 * kept lines, with the two kept sequences equal: an exact search, memoized, over the small texts the property draws.
 */
const replays = (a: readonly string[], b: readonly string[], removed: readonly string[], added: readonly string[]): boolean => {
  const memo = new Map<string, boolean>();
  const go = (i: number, p: number, j: number, q: number): boolean => {
    if (i === a.length && j === b.length) return p === removed.length && q === added.length;
    const key = `${i},${p},${j},${q}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result =
      (i < a.length && p < removed.length && a[i] === removed[p] && go(i + 1, p + 1, j, q)) ||
      (j < b.length && q < added.length && b[j] === added[q] && go(i, p, j + 1, q + 1)) ||
      (i < a.length && j < b.length && a[i] === b[j] && go(i + 1, p, j + 1, q));
    memo.set(key, result);
    return result;
  };
  return go(0, 0, 0, 0);
};

test("lineEdits: its counts are lineChange's", () => {
  fc.assert(
    fc.property(textArb, textArb, (a, b) => {
      const e = lineEdits(a, b);
      const c = lineChange(a, b);
      assert.equal(e.added.length, c.added);
      assert.equal(e.removed.length, c.removed);
    }),
    { numRuns: 500 },
  );
});

test("lineEdits: the lines kept are a common subsequence, each list a subsequence of its text", () => {
  fc.assert(
    fc.property(textArb, textArb, (a, b) => {
      const e = lineEdits(a, b);
      assert.ok(replays(linesOf(a), linesOf(b), e.removed, e.added));
    }),
    { numRuns: 500 },
  );
});

test("lineEdits of a text with itself is empty", () => {
  fc.assert(fc.property(textArb, (a) => assert.deepEqual(lineEdits(a, a), { removed: [], added: [] })), { numRuns: 200 });
});

test("lineEdits of a reordering: one line removed, one added", () => {
  const e = lineEdits("First\nSecond", "Second\nFirst");
  assert.equal(e.removed.length, 1);
  assert.deepEqual(e.added, e.removed);
});
