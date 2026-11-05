import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import * as K from "../src/keptCorrections.ts";
import type { IssueId } from "../src/schema.ts";

const word = fc.stringMatching(/^[a-z]{1,6}$/);
const words = fc.array(word, { minLength: 1, maxLength: 5 });
const space = fc.constantFrom(" ", "  ", "\n", "\t", " \n ");
const spaced = (ws: readonly string[], seps: readonly string[]) => ws.map((w, i) => (i === 0 ? w : seps[i % seps.length] + w)).join("");

test("occursInTexts is invariant under any re-spacing of the passage and the text", () => {
  fc.assert(
    fc.property(words, words, words, fc.array(space, { minLength: 1, maxLength: 3 }), fc.array(space, { minLength: 1, maxLength: 3 }), (before, passage, after, s1, s2) => {
      const text = [...before, ...passage, ...after];
      assert.equal(K.occursInTexts(spaced(passage, s1), [spaced(text, s2)]), true);
      assert.equal(K.occursInTexts(passage.join(" "), [text.join(" ")]), K.occursInTexts(spaced(passage, s2), [spaced(text, s1)]));
    }),
    { numRuns: 200 },
  );
});

const corrections = fc.uniqueArray(fc.stringMatching(/^P1-R[1-9]-[1-9]$/), { maxLength: 4 }).chain((ids) =>
  fc.tuple(...ids.map((i) => fc.uniqueArray(words.map((w) => `${i} ${w.join(" ")} .`), { minLength: 1, maxLength: 2 }).map((passages) => ({ id: i, passages })))),
);

test("a reply keeping every baseline passage, with an entry per accepted disposition found in it, has no problems", () => {
  fc.assert(
    fc.property(corrections, fc.uniqueArray(fc.stringMatching(/^P1-R9-[1-9]$/), { maxLength: 3 }), (baseline, accepted) => {
      const texts = [...baseline.flatMap((c) => c.passages.map((p) => `before ${p} after`)), ...accepted.map((a) => `new ${a} text`)];
      const problems = K.keptCorrectionProblems({
        baseline,
        restatable: new Set(baseline.map((c) => c.id)),
        dispositions: accepted.map((a) => ({ id: a as IssueId, action: "accepted" as const, reverses: null })),
        entries: accepted.map((a) => ({ id: a, passages: [`${a} text`] })),
        texts,
      });
      assert.deepEqual(problems, []);
    }),
    { numRuns: 200 },
  );
});

test("removing one baseline passage gives one correctionMissing for its id, none where it is reversed or restated", () => {
  fc.assert(
    fc.property(corrections.filter((c) => c.length > 0), fc.nat(), fc.constantFrom("none", "reversed", "restated"), (baseline, pick, exemption) => {
      const dropped = baseline[pick % baseline.length];
      const gone = dropped.passages[0];
      const texts = baseline.flatMap((c) => c.passages).filter((p) => p !== gone);
      const problems = K.keptCorrectionProblems({
        baseline,
        restatable: new Set(baseline.map((c) => c.id)),
        dispositions: exemption === "reversed" ? [{ id: "P1-R9-9" as IssueId, action: "rejected", reverses: dropped.id as IssueId }] : [],
        entries: exemption === "restated" ? [{ id: dropped.id, passages: [] }] : [],
        texts,
      });
      const missing = problems.filter((p) => p.kind === "correctionMissing");
      if (exemption === "none") {
        assert.deepEqual(missing.map((p) => p.id), [dropped.id]);
        assert.equal(missing[0].passage, gone);
      } else assert.deepEqual(missing, []);
    }),
    { numRuns: 200 },
  );
});
