import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommentKey } from "../src/itemComments.ts";
import { chainContinues, commentAfterParking, labelAfterParking, type ParkedEnding } from "../src/runEnding.ts";

// Issue #186: the three endings that park a run's work differ only in the item's label and the comment.
const ENDINGS: readonly ParkedEnding[] = ["halted", "sentBack", "stoppedUnrefined"];
const key = runCommentKey("r", "verdict-1");

test("each ending's label: a send-back unrefined, a halt and a guard stop unchanged", () => {
  assert.deepEqual(ENDINGS.map(labelAfterParking), [null, "unrefined", null]);
});

test("each ending's comment: a send-back's and a guard stop's with the reason, a halt none", () => {
  assert.equal(commentAfterParking("halted", key, "2026-10-29", "m"), null);
  assert.deepEqual(commentAfterParking("sentBack", key, "2026-10-29", "m"), { _tag: "SentBack", key, date: "2026-10-29", missing: "m" });
  assert.deepEqual(commentAfterParking("stoppedUnrefined", key, "2026-10-29", "m"), { _tag: "StoppedUnrefined", key, date: "2026-10-29", missing: "m" });
});

test("a parking that failed ends the chain, whatever the ending; any other note does not", () => {
  for (const ending of ENDINGS) {
    assert.equal(chainContinues(ending, { _tag: "ParkFailed", message: "x" }), false, ending);
    for (const note of [{ _tag: "Parked", branch: "b", commit: "c" }, { _tag: "NothingParked" }] as const) assert.equal(chainContinues(ending, note), true, ending);
  }
});
