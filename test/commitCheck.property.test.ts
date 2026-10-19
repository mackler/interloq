import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { commitCheckOf, uncommittedPaths } from "../src/commitCheck.ts";
import { excluded, type StatusRecord } from "../src/snapshot.ts";

// Issue #176: the commit check's pure core.

const RUNS = { numRuns: 200, seed: 20261019 };
const arbPath = fc.constantFrom("a.txt", "b.txt", "c/d.ts", "ign/x", "ign/y", "plan-review/r.json", "z");
const paths = fc.array(arbPath, { maxLength: 8 });
const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

const changed = (path: string): StatusRecord => ({ kind: "changed", xy: ".M", sub: "N...", mH: "100644", mI: "100644", mW: "100644", hH: "0", hI: "0", path });
const renamed = (origPath: string, path: string): StatusRecord => ({
  kind: "renamed", xy: "R.", sub: "N...", mH: "100644", mI: "100644", mW: "100644", hH: "0", hI: "0", score: "R100", path, origPath,
});
const arbRecord: fc.Arbitrary<StatusRecord> = fc.oneof(
  arbPath.map(changed),
  fc.tuple(arbPath, arbPath).map(([o, p]) => renamed(o, p)),
  arbPath.map((path): StatusRecord => ({ kind: "unmerged", xy: "UU", sub: "N...", path })),
  arbPath.map((path): StatusRecord => ({ kind: "untracked", path })),
);
const isExcluded = (p: string): boolean => excluded(p, ["ign"]);
const reportedOf = (c: ReturnType<typeof commitCheckOf>): readonly string[] => (c._tag === "Committed" ? [] : c.paths);

test("commitCheckOf reports exactly the paths of now not at the start, sorted, whatever the order or repetition", () => {
  fc.assert(
    fc.property(paths, paths, (a, n) => {
      const check = commitCheckOf(a, n);
      const expected = sortedUnique(n.filter((p) => !a.includes(p)));
      assert.deepEqual([...reportedOf(check)], expected);
      assert.equal(check._tag === "Committed", n.every((p) => a.includes(p)));
      assert.deepEqual(commitCheckOf([...a].reverse().concat(a), [...n].reverse().concat(n)), check);
    }),
    RUNS,
  );
});

test("uncommittedPaths is every record's path and every rename's source not excluded, each judged on its own", () => {
  fc.assert(
    fc.property(fc.array(arbRecord, { maxLength: 8 }), (records) => {
      const all = records.flatMap((r) => (r.kind === "renamed" ? [r.path, r.origPath] : [r.path]));
      assert.deepEqual([...uncommittedPaths(records, isExcluded)], sortedUnique(all.filter((p) => !isExcluded(p))));
    }),
    RUNS,
  );
});

test("a file dirty at the start and changed again is not reported; a new untracked file and a deleted tracked file are", () => {
  const atStart = uncommittedPaths([changed("dirty.txt")], isExcluded);
  const now = uncommittedPaths(
    [changed("dirty.txt"), { kind: "untracked", path: "new.txt" }, { kind: "changed", xy: ".D", sub: "N...", mH: "100644", mI: "100644", mW: "000000", hH: "0", hI: "0", path: "gone.txt" }],
    isExcluded,
  );
  assert.deepEqual(commitCheckOf(atStart, now), { _tag: "Uncommitted", paths: ["gone.txt", "new.txt"] });
  assert.deepEqual(commitCheckOf(atStart, atStart), { _tag: "Committed" });
});

test("a rename into an excluded directory reports its source, and one out of it its destination", () => {
  assert.deepEqual(uncommittedPaths([renamed("a.txt", "ign/a.txt")], isExcluded), ["a.txt"]);
  assert.deepEqual(uncommittedPaths([renamed("ign/b.txt", "b.txt")], isExcluded), ["b.txt"]);
});
