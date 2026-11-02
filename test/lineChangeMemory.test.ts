// The memory of the line diff (issue #216, work review 3, W3-R1-1): every Int32Array the module allocates goes through
// the allocator given, so its bound is asserted on the lengths asked for rather than on a heap sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineChange, lineEdits } from "../src/lineChange.ts";

const counting = () => {
  let total = 0;
  const alloc = (length: number): Int32Array => {
    total += length;
    return new Int32Array(length);
  };
  return { alloc, total: () => total };
};

const textOf = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join("");
const range = (n: number, f: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => f(i));

const cases = [
  { name: "two disjoint texts of 3,000 lines", a: range(3000, (i) => `a${i}`), b: range(3000, (i) => `b${i}`) },
  {
    name: "two texts sharing every other line",
    a: range(3000, (i) => (i % 2 === 0 ? `s${i}` : `a${i}`)),
    b: range(3000, (i) => (i % 2 === 0 ? `s${i}` : `b${i}`)),
  },
];

for (const { name, a, b } of cases) {
  const working = 2 * (a.length + b.length) + 2;
  const before = textOf(a);
  const after = textOf(b);

  test(`lineChange allocates one working array: ${name}`, () => {
    const c = counting();
    const change = lineChange(before, after, c.alloc);
    const shared = a.filter((l) => b.includes(l)).length;
    assert.deepEqual(change, { changed: true, added: b.length - shared, removed: a.length - shared });
    assert.ok(c.total() <= working, `allocated ${c.total()} > ${working}`);
  });

  test(`lineEdits keeps O(D²) of its trace: ${name}`, () => {
    const { added: addedCount, removed: removedCount } = lineChange(before, after);
    const d = addedCount + removedCount;
    const c = counting();
    const edits = lineEdits(before, after, c.alloc);
    assert.deepEqual(edits.removed, a.filter((l) => !b.includes(l)));
    assert.deepEqual(edits.added, b.filter((l) => !a.includes(l)));
    const bound = working + (d + 1) * (d + 1);
    assert.ok(c.total() <= bound, `allocated ${c.total()} > ${bound}`);
  });
}
