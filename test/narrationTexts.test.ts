// Issue #40: the note on a message written while Claude Code's commands had not ended. The page renders the lead and the
// names apart while describeEvent uses the joined text, so both are derived from one source here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { runningNote, runningNoteLead } from "../src/prompts.ts";

test("no note where nothing ran", () => {
  assert.equal(runningNote([]), null);
});

test("one command's note and two commands' note, the names in order", () => {
  const one = runningNote(["npm test"]) ?? "";
  assert.ok(one.startsWith(runningNoteLead(1)));
  assert.ok(one.includes("npm test"));
  const two = runningNote(["a", "b"]) ?? "";
  assert.ok(two.startsWith(runningNoteLead(2)));
  assert.ok(two.indexOf("a", runningNoteLead(2).length) < two.indexOf("b", runningNoteLead(2).length));
  assert.notEqual(runningNoteLead(1), runningNoteLead(2));
});

test("property: a note is its lead and the names joined", () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }), (names) => {
      assert.equal(runningNote(names), `${runningNoteLead(names.length)} ${names.join("; ")}`);
    }),
    { numRuns: 200 },
  );
});
