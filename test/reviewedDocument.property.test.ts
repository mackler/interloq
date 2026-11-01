import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { SubjectId } from "../src/artifacts.ts";
import { documentLabel } from "../src/prompts.ts";
import { sameDocument, type ShownDocument } from "../src/reviewedDocument.ts";

// Issue #86: the document under review as the page receives it, and the heading that names it.
const RUNS = { numRuns: 200, seed: 20261101 };
const text = fc.string({ maxLength: 6 });
const analysis = fc.record({
  decision: text,
  columns: fc.array(fc.record({ kind: fc.constant("unclear" as const), option: text, unclear: text }), { maxLength: 2 }),
  recommendation: fc.record({ option: text, reason: text }),
});
const shown: fc.Arbitrary<ShownDocument> = fc.oneof(
  fc.record({ _tag: fc.constant("Markdown" as const), text }),
  fc.record({ _tag: fc.constant("Diff" as const), text }),
  fc.record({ _tag: fc.constant("Analysis" as const), analysis }),
);

test("sameDocument is reflexive over every form", () => {
  fc.assert(fc.property(shown, (d) => sameDocument(d, structuredClone(d))), RUNS);
});

test("sameDocument holds exactly when the form and the content agree", () => {
  fc.assert(
    fc.property(shown, shown, (a, b) => {
      const content = (d: ShownDocument): string => (d._tag === "Analysis" ? JSON.stringify(d.analysis) : d.text);
      assert.equal(sameDocument(a, b), a._tag === b._tag && content(a) === content(b));
    }),
    RUNS,
  );
});

test("a Markdown and a Diff of the same text are different documents", () => {
  assert.equal(sameDocument({ _tag: "Markdown", text: "x" }, { _tag: "Diff", text: "x" }), false);
});

test("documentLabel names each kind of subject, each label distinct", () => {
  const subjects: readonly SubjectId[] = ["questions", "terms", "requirements", { plan: 1 }, { work: 1 }, { decision: 1 }, { verdict: 1 }];
  const labels = subjects.map(documentLabel);
  assert.deepEqual(labels, ["Question list", "Terms", "Requirements", "Plan", "Changes under review", "Draft analysis", "Verdict"]);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(documentLabel({ plan: 3 }), documentLabel({ plan: 1 }));
});
