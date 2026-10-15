import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { newThreadSentence, threadRestartLine } from "../src/prompts.ts";
import { subjectHeading } from "../src/render.ts";
import { finished, issue, respond, runTask, tempRepo, testLayer, TEST_ROOT } from "./helpers.ts";

// Issue #165 (requirements Q1): a review loop keeps one Codex thread until a turn's input passes codexTurnInputLimit,
// and the next round of that loop starts a new thread, asking nothing.
const noQuestions = { questions_for_user: [] };
const conversation = (dir: string): string => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const SAME_RULES = "under the same rules as before";

test("the four-round plan review of 14 Oct 2026: the round after the 826,111-token turn starts a new thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
      { output: respond([["P1-R2-1", "accepted"]]), plan: "v3" },
      { output: respond([["P1-R3-1", "accepted"]]), plan: "v4" },
    ],
    reviews: [
      { issues: [issue("P1-R1-1")], inputTokens: 236_893 },
      { issues: [issue("P1-R2-1")], inputTokens: 451_938 },
      { issues: [issue("P1-R3-1")], inputTokens: 826_111 },
      { issues: [], inputTokens: 300_000 },
      { issues: [] },
    ],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  // The plan review's rounds 1 to 3 in one thread, its round 4 in a new one, then the work review in its own.
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 1, 2, 3]);
  const [, , third, fourth] = probe.reviewer.prompts;
  assert.ok(third!.includes(SAME_RULES), "round 3 lost the later-round text");
  assert.ok(fourth!.startsWith(newThreadSentence(TEST_ROOT, "issue-log.json", 4)), "round 4 does not open with the new-thread sentence");
  assert.ok(!fourth!.includes(SAME_RULES));
  assert.ok(fourth!.includes("P1-R4-1"), "round 4 lacks its own id form");
  const line = threadRestartLine(subjectHeading({ plan: 1 }), 4, 826_111, 500_000);
  assert.ok(conversation(probe.dir).includes(line), "conversation.md lacks the restart");
  assert.ok(probe.ui.said.includes(line), "the page was not told");
  assert.deepEqual(probe.ui.asked, []);
});

test("a loop whose turns stay under the limit keeps one thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")], inputTokens: 400_000 }, { issues: [], inputTokens: 500_000 }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2]);
  assert.ok(!conversation(probe.dir).includes("starts a new Codex thread"));
});

test("a configured limit: a new thread whose own turn passes it is replaced again", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    config: { codexTurnInputLimit: 150_000 },
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
      { output: respond([["P1-R2-1", "accepted"]]), plan: "v3" },
    ],
    reviews: [{ issues: [issue("P1-R1-1")], inputTokens: 200_000 }, { issues: [issue("P1-R2-1")], inputTokens: 200_000 }, { issues: [], inputTokens: 100 }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 2, 3, 4]);
  assert.ok(conversation(probe.dir).includes(threadRestartLine(subjectHeading({ plan: 1 }), 2, 200_000, 150_000)));
  assert.ok(conversation(probe.dir).includes(threadRestartLine(subjectHeading({ plan: 1 }), 3, 200_000, 150_000)));
});

test("a schema repair turn runs in the review's thread, and its input counts toward the next round's thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [], raw: "not json", inputTokens: 100_000 }, { issues: [issue("P1-R1-1")], inputTokens: 600_000 }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 3]);
  assert.ok(conversation(probe.dir).includes(threadRestartLine(subjectHeading({ plan: 1 }), 2, 600_000, 500_000)));
});

test("the work review follows the same rule", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")], inputTokens: 700_000 }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 2, 3]);
  assert.ok(probe.reviewer.prompts[2]!.startsWith(newThreadSentence(TEST_ROOT, "work-review-log.json", 2)));
  assert.ok(conversation(probe.dir).includes(threadRestartLine("Work review 1", 2, 700_000, 500_000)));
  assert.deepEqual(probe.ui.asked, []);
});
