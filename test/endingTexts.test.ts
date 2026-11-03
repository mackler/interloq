// Issue #44 (S2): one vocabulary of the endings: the line, the details, the mark, the word and the notification.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Ending } from "../src/ending.ts";
import {
  ENDING_MARKS,
  endedTabName,
  endingDetails,
  endingLine,
  endingMarkOf,
  endingWord,
  endNotificationBody,
  endNotificationTitle,
  runEndedText,
  TITLE_ENDED_MARK,
  TITLE_UNFINISHED_MARK,
} from "../src/prompts.ts";
import * as F from "./endingFixtures.ts";
import { arbEnding } from "./endingArbitraries.ts";

const all = (e: Ending): string => [endingLine(e), ...endingDetails(e), endingMarkOf(e), endingWord(e), endNotificationTitle("p", e), runEndedText(e)].join("\n");

test("each ending's mark and word", () => {
  assert.deepEqual(ENDING_MARKS, { Completed: "✓", SentBack: "↩", Halted: "✕", Interrupted: "■", Abandoned: "⧗", Unestablished: "–" });
  assert.equal(ENDING_MARKS.Completed, TITLE_ENDED_MARK);
  assert.equal(ENDING_MARKS.Halted, TITLE_UNFINISHED_MARK);
  const words = [F.COMPLETED, F.SENT_BACK_PARKED, F.HALTED, F.INTERRUPTED, F.ABANDONED, F.UNESTABLISHED_ENDING].map(endingWord);
  assert.deepEqual(words, ["completed", "sent back", "halted", "interrupted", "abandoned", "ended"]);
  assert.equal(new Set(Object.values(ENDING_MARKS)).size, 6);
  assert.equal(endedTabName("x", F.SENT_BACK_PARKED), "↩ x");
  assert.equal(runEndedText(F.SENT_BACK_PARKED), "a run sent back");
  assert.equal(runEndedText(F.UNESTABLISHED_ENDING), "a run ended");
});

test("each ending's line", () => {
  assert.equal(endingLine(F.REFINED), "Completed: the requirements were written back to the item, which is now refined.");
  assert.equal(endingLine(F.OBSOLETE_LABELED), "Completed: Bring Up to Date found the issue already built or replaced, and the item was labeled obsolete.");
  assert.equal(endingLine(F.OBSOLETE_UNLABELED), "Completed: Bring Up to Date found the issue already built or replaced; the item stays unrefined, since no obsolete label is configured.");
  assert.equal(
    endingLine(F.COMPLETED_SUITE),
    'Completed: the execution finished, the code review found nothing left to correct, "npm test" and "npm run test:e2e" passed, every change is committed, and the item is now implemented.',
  );
  assert.equal(
    endingLine(F.COMPLETED),
    "Completed: the execution finished, the code review found nothing left to correct, every change is committed, and the item is now implemented. No suite command is configured, so Interloq ran no test suite.",
  );
  assert.equal(endingLine(F.SENT_BACK_PARKED), "Sent back: the run found the item not refined and returned it to unrefined, with a comment saying what is missing.");
  assert.equal(endingLine(F.HALTED), "Halted: the run could not complete. the tracker step failed.");
  assert.equal(endingLine(F.INTERRUPTED), "Interrupted: you stopped the run.");
  assert.equal(endingLine(F.ABANDONED), "Abandoned: no answer came within the wait. no answer came within 120 seconds.");
  assert.equal(endingLine(F.UNESTABLISHED_ENDING), "Ended: this run was recorded before Interloq kept a run's ending, so how it ended is not known.");
});

test("each ending's details, as confirmed", () => {
  assert.deepEqual(endingDetails(F.SENT_BACK_PARKED), [
    "What is missing: the requirements do not say which tab lists the item",
    "The work was moved to branch interloq/halted/7/runs-x (commit 0123456789ab).",
  ]);
  assert.deepEqual(endingDetails(F.SENT_BACK_NOTHING), ["What is missing: the outcome of a refusal", "There was no work to keep, so no branch was made."]);
  assert.deepEqual(endingDetails(F.HALTED_GUARD), [
    "The work was moved to branch interloq/halted/7/runs-x (commit abcdef012345).",
    "The item was labeled refined again, so it is listed in the Implementation tab.",
    "The records are in /p/plan-review/runs/r.",
  ]);
  assert.deepEqual(endingDetails(F.HALTED_NO_RECORDS), ["No records directory was created."]);
  assert.deepEqual(endingDetails(F.HALTED_NOT_SENT)[0], "The item could not be labeled refined again (git failed); Interloq did not change its label.");
  assert.deepEqual(
    endingDetails(F.HALTED_UNCHECKED)[0],
    "The item could not be confirmed as labeled refined again (timed out), and whether its label changed could not be checked.",
  );
  assert.deepEqual(endingDetails(F.HALTED_HELD)[0], "The item could not be labeled refined again (the tracker refused); after the last attempt it carried the label implementing.");
  assert.deepEqual(endingDetails(F.INTERRUPTED_RETURNED), ["The item was labeled refined again, so it is listed in the Implementation tab."]);
  assert.deepEqual(endingDetails(F.ABANDONED_PARK_FAILED), [
    "The work could not be moved to a branch (the commit was refused) and stays on the working branch.",
    "The item keeps the label implementing, since its work was not moved.",
  ]);
  const abandoned = (label: Extract<Ending, { _tag: "Abandoned" }>["label"]) => endingDetails({ _tag: "Abandoned", reason: "r", park: null, label });
  assert.deepEqual(abandoned({ _tag: "SetRefined" }), ["The item's label was set to refined and confirmed."]);
  assert.deepEqual(abandoned({ _tag: "StillHeld", state: "implementing", cause: "refused" }), ["The item's label could not be set to refined (refused); it still carries implementing."]);
  assert.deepEqual(abandoned({ _tag: "Unconfirmed", cause: "" }), ["The item's label could not be read back after it was set, so whether it is refined is not confirmed."]);
  assert.deepEqual(abandoned({ _tag: "Unchanged" }), ["The item's label was not changed."]);
  assert.deepEqual(abandoned({ _tag: "SendBackUnfinished", step: "comment" }), ["The send-back's comment step was not done, and no label was set after it."]);
  assert.deepEqual(endingDetails(F.COMPLETED), []);
  assert.deepEqual(endingDetails(F.UNESTABLISHED_ENDING), []);
});

test("each ending's notification", () => {
  const titles = [F.COMPLETED, F.SENT_BACK_PARKED, F.HALTED, F.INTERRUPTED, F.ABANDONED, F.UNESTABLISHED_ENDING].map((e) => endNotificationTitle("p", e));
  assert.deepEqual(titles, ["p: the task has completed", "p: the task was sent back", "p: the task has halted", "p: the task was interrupted", "p: the task was abandoned", "p: the task has ended"]);
  for (const e of F.ENDINGS) assert.equal(endNotificationBody(e), endingLine(e));
});

const runs = { numRuns: 300, seed: 20261103 };

test("no text claims what was not observed", () => {
  fc.assert(
    fc.property(arbEnding, (e) => {
      const text = all(e);
      if (e._tag === "Completed" && e.work._tag === "Implemented" && e.work.finalCommands.length === 0) assert.ok(!text.includes("passed"), text);
      if (e._tag === "SentBack" && e.park._tag === "NothingParked") {
        assert.ok(text.includes("There was no work to keep"), text);
        assert.ok(!text.includes("interloq/") && !text.includes("✓"), text);
      }
      if ("park" in e && e.park !== null && (e.park._tag === "ParkFailed" || e.park._tag === "Pending")) assert.ok(!text.includes("moved to branch"), text);
      if ("item" in e && e.item !== null && e.item._tag === "NotReturned") {
        assert.ok(!text.includes("was labeled refined again"), text);
        if (e.item.check._tag !== "Held") assert.ok(!text.includes("carried the label"), text);
      }
      if (e._tag === "Unestablished") assert.ok(!text.includes("✓") && !/completed/i.test(text), text);
    }),
    runs,
  );
});
