import assert from "node:assert/strict";
import { test } from "node:test";
import { type CodeReviewRecord, diffSections, fileOf, lateFindings } from "../src/lateFindings.ts";

// Issue #252, S8: the late-findings measure, as a pure function over a run's code reviews.

const section = (file: string, body: string): string => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n x\n${body}\n`;
const record = (review: number, diff: string, ...findings: [string, string][]): CodeReviewRecord => ({ review, diff, findings: findings.map(([id, location]) => ({ id, location })) });

test("S8: a finding of review 2 on a file unchanged since review 1 is late", () => {
  const a = section("src/a.ts", "+one");
  const result = lateFindings([record(1, a + section("src/b.ts", "+b1"), ["W1-R1-1", "src/b.ts:3"]), record(2, a + section("src/b.ts", "+b2"), ["W2-R1-1", "src/a.ts:12"], ["W2-R1-2", "src/b.ts"])]);
  assert.deepEqual(result, { late: ["W2-R1-1"], total: 3 });
});

test("S8: a finding of review 1 is never late, and a location naming a step id names no file but is counted", () => {
  const a = section("src/a.ts", "+one");
  assert.deepEqual(lateFindings([record(1, a, ["W1-R1-1", "src/a.ts"]), record(2, a, ["W2-R1-1", "S3"])]), { late: [], total: 2 });
});

test("S8: a path Git quotes is decoded", () => {
  const diff = 'diff --git "a/sp\\303\\251c.ts" "b/sp\\303\\251c.ts"\nindex 1..2 100644\n--- "a/sp\\303\\251c.ts"\n+++ "b/sp\\303\\251c.ts"\n@@ -1 +1 @@\n-x\n+y\n';
  assert.deepEqual([...diffSections(diff).keys()], ["spéc.ts"]);
});

test("S8: a path with ' b/' in it is read from its +++ line, and from its header where it has none", () => {
  const content = "diff --git a/dir b/file.ts b/dir b/file.ts\nindex 1..2 100644\n--- a/dir b/file.ts\t\n+++ b/dir b/file.ts\t\n@@ -1 +1 @@\n-x\n+y\n";
  const mode = "diff --git a/dir b/file.ts b/dir b/file.ts\nold mode 100644\nnew mode 100755\n";
  assert.deepEqual([...diffSections(content).keys()], ["dir b/file.ts"]);
  assert.deepEqual([...diffSections(mode).keys()], ["dir b/file.ts"]);
});

test("S8: a deleted file is keyed by its --- path, and a rename by its rename to", () => {
  const deleted = "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
  const renamed = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
  assert.deepEqual([...diffSections(deleted + renamed).keys()], ["gone.ts", "new.ts"]);
});

test("S8: a location names the longest path it contains at a boundary", () => {
  assert.equal(fileOf("src/a.tsx", ["src/a.ts"]), null);
  assert.equal(fileOf("src/a.ts:12", ["src/a.ts"]), "src/a.ts");
  assert.equal(fileOf("in (src/a.ts, line 3)", ["src/a.ts", "a.ts"]), "src/a.ts");
  assert.equal(fileOf("S3", ["src/a.ts"]), null);
});
