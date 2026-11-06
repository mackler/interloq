import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type CodeReviewRecord, diffSections, lateFindings } from "../src/lateFindings.ts";

// Issue #252, S8: a finding on a file whose section is unchanged since an earlier review counts as late, and one whose
// section changed does not.

const fileName = fc.stringMatching(/^[a-z]{1,8}\/[a-z]{1,8}\.ts$/);
const body = fc.array(fc.stringMatching(/^[a-z ]{0,12}$/), { minLength: 1, maxLength: 4 }).map((lines) => lines.map((l) => `+${l}`).join("\n"));
const section = (file: string, text: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n${text}\n`;

test("S8 (property): unchanged since an earlier review is late; altered in review k is not", () => {
  fc.assert(
    fc.property(fileName, body, fc.integer({ min: 2, max: 5 }), (file, text, k) => {
      const earlier = section(file, text);
      const same: CodeReviewRecord[] = [{ review: 1, diff: earlier, findings: [] }, { review: k, diff: earlier, findings: [{ id: "late", location: `${file}:1` }] }];
      const altered: CodeReviewRecord[] = [same[0]!, { review: k, diff: section(file, `${text}\n+altered`), findings: [{ id: "new", location: file }] }];
      assert.deepEqual(lateFindings(same), { late: ["late"], total: 1 });
      assert.deepEqual(lateFindings(altered), { late: [], total: 1 });
    }),
    { numRuns: 200 },
  );
});

test("S8 (property): late findings never outnumber the findings", () => {
  const finding = fc.record({ id: fc.stringMatching(/^W[0-9]-R1-[0-9]$/), location: fc.oneof(fileName, fc.constant("S1")) });
  const rec = fc.record({ diff: fc.array(fc.tuple(fileName, body), { maxLength: 3 }).map((xs) => xs.map(([f, t]) => section(f, t)).join("")), findings: fc.array(finding, { maxLength: 3 }) });
  fc.assert(
    fc.property(fc.array(rec, { maxLength: 4 }), (recs) => {
      const records = recs.map((r, i) => ({ ...r, review: i + 1 }));
      const result = lateFindings(records);
      return result.late.length <= result.total && result.total === records.reduce((n, r) => n + r.findings.length, 0);
    }),
    { numRuns: 200 },
  );
});

// S13 (W1-R1-2): any path, written in Git's C-quoted form, keys its section by the original path.
test("S13 (property): a C-quoted path of arbitrary code points keys its section by the path", () => {
  const quote = (p: string): string => `"${p.replace(/[\\"\t\n]/gu, (c) => ({ "\\": "\\\\", '"': '\\"', "\t": "\\t", "\n": "\\n" })[c]!)}"`;
  const pathArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }).filter((p) => !p.includes("\n") && !p.includes("\r") && p.trim() === p && p.length > 0);
  fc.assert(
    fc.property(pathArb, (p) => {
      const a = quote(`a/${p}`);
      const b = quote(`b/${p}`);
      const diff = `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n@@ -0,0 +1 @@\n+x\n`;
      assert.deepEqual([...diffSections(diff).keys()], [p]);
    }),
    { numRuns: 300 },
  );
});
