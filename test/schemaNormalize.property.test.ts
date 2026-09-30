import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { normalizeQuestionList } from "../src/schemaNormalize.ts";
import { entryOf } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";

// Row 5 of the table in recommendation E (moved to step 4.6): the question-list normalisation.
const RUNS = { numRuns: 200, seed: 20260925 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const label = fc.stringMatching(/^[a-z]{1,4}$/);
const arbQuestion = record({
  id: fc.oneof({ weight: 6, arbitrary: fc.stringMatching(/^Q[0-9]{1,2}$/) }, { weight: 1, arbitrary: fc.constant("") }),
  context: fc.string(),
  question: fc.string(),
  reason: fc.string(),
  proposed_answers: fc.array(record({ label, description: fc.string() }), { maxLength: 3 }),
  default_answer: fc.oneof(label, fc.constant("")),
}).map(entryOf);

test("property: a default is kept exactly when it names a proposed answer, else it is null with one note; ids are unique or the list is invalid", () => {
  fc.assert(
    fc.property(fc.array(arbQuestion, { maxLength: 5 }), (questions) => {
      const result = normalizeQuestionList({ questions });
      const ids = questions.map((q) => q.id);
      const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      const empty = ids.filter((id) => id === "").length;
      if (duplicates.length > 0 || empty > 0) {
        assert.ok(Result.isFailure(result));
        assert.deepEqual(result.failure.duplicateIds, duplicates.filter((id) => id !== ""));
        assert.equal(result.failure.emptyIds, empty);
        return;
      }
      assert.ok(Result.isSuccess(result));
      let notes = 0;
      result.success.questions.forEach((normalized, i) => {
        const original = questions[i];
        assert.deepEqual({ ...normalized, default_answer: original.default_answer }, original);
        if (original.proposed_answers.some((a) => piecesText(a.label) === original.default_answer)) assert.equal(normalized.default_answer, original.default_answer);
        else {
          assert.equal(normalized.default_answer, null);
          notes++;
        }
      });
      assert.equal(result.success.notes.length, notes);
    }),
    RUNS,
  );
});
