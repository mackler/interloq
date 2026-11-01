// Issue #208: the line said and written for an unexplained change of the reviewed file, and the sentence the next round's
// review prompt carries. Both are derived from one value, so the developer and Codex read of the same change.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { cycleHeading, unexplainedChangeLine, unexplainedChangeReviewNote } from "../src/prompts.ts";
import type { UnexplainedChange } from "../src/prompts.ts";

const run206: UnexplainedChange = { fileLabel: "plan.json", heading: "Planning phase 2", round: 1, added: 1, removed: 1 };

test("the line names the file, the cycle, the counts, that nothing was accepted, and the next cycle's review", () => {
  const line = unexplainedChangeLine(run206);
  assert.ok(line.includes("plan.json"), line);
  assert.ok(line.includes(cycleHeading("Planning phase 2", 1)), line);
  assert.match(line, /1 line added/u);
  assert.match(line, /1 removed/u);
  assert.match(line, /accepted no point/u);
  assert.match(line, /corrected nothing of its own/u);
  assert.match(line, /no decision of yours to apply/u);
  assert.match(line, /not put to you/u);
  assert.match(line, /Codex reviews the change in cycle 2/u);
});

test("the review note names the file, the round, the counts, and asks Codex to examine the change", () => {
  const note = unexplainedChangeReviewNote(run206);
  assert.ok(note.includes("plan.json"), note);
  assert.match(note, /round 1\b/u);
  assert.match(note, /1 line added/u);
  assert.match(note, /1 removed/u);
  assert.match(note, /accepted no issue/u);
  assert.match(note, /declared no self-correction/u);
  assert.match(note, /no decision of the user's to apply/u);
  assert.match(note, /Examine that change in this review/u);
  assert.match(note, /raise an issue for any part of it that is not justified/u);
});

test("both texts name the same file and counts, and neither is blank (property)", () => {
  const nonBlank = fc.string({ minLength: 1 }).filter((t) => t.trim() !== "");
  fc.assert(
    fc.property(nonBlank, nonBlank, fc.integer({ min: 1, max: 1000 }), fc.nat(10_000), fc.nat(10_000), (fileLabel, heading, round, added, removed) => {
      const c: UnexplainedChange = { fileLabel, heading, round, added, removed };
      for (const text of [unexplainedChangeLine(c), unexplainedChangeReviewNote(c)]) {
        assert.ok(text.trim() !== "");
        assert.ok(text.includes(fileLabel));
        assert.ok(text.includes(`${added} ${added === 1 ? "line" : "lines"} added`));
        assert.ok(text.includes(`${removed} removed`));
      }
    }),
    { numRuns: 200 },
  );
});
