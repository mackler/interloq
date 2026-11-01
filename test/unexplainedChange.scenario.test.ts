// Issue #208: a response that changes the plan while accepting no issue, declaring no self-correction and applying no
// decision asks the developer nothing. The change is said and written, and Codex's next review is told of it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { UNEXPLAINED_CHANGE_HEADING, unexplainedChangeLine, unexplainedChangeReviewNote } from "../src/prompts.ts";
import { finished, issue, respond, runTask, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
/** The part of a text before its counts, derived from the function itself so that the test and the program agree. */
const opening = (text: string): string => text.split(" (")[0];
const change = { fileLabel: "plan.json", heading: "Planning phase 1", round: 1, added: 0, removed: 0 };

test("the plan changed silently in round 1 leads to round 2 with nothing asked, the line recorded and the change in Codex's prompt", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.deepEqual(probe.ui.asked, []);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.ok(conversation.includes(`**${UNEXPLAINED_CHANGE_HEADING}** ${opening(unexplainedChangeLine(change))}`), conversation);
  assert.ok(probe.reviewer.prompts.length >= 2);
  assert.ok(!probe.reviewer.prompts[0].includes(opening(unexplainedChangeReviewNote(change))));
  assert.ok(probe.reviewer.prompts[1].includes(opening(unexplainedChangeReviewNote(change))), probe.reviewer.prompts[1]);
});
