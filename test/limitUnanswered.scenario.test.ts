// Issue #185 (requirements Q3's exception, G-R1-3): the scenarios over testLayer of a review limit whose question goes
// unanswered: the review goes on, later limits are extended without a question, each extension written to
// conversation.md; any other question that goes unanswered ends the run with NoAnswer.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { limitExtendedLine } from "../src/prompts.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const conversationOf = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");

test("an unanswered round limit extends the plan review, the next limit is extended without a question, and the review converges", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ noAnswer: true }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: respond([["B", "accepted"]]), plan: "v3" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 1);
  assert.deepEqual(probe.ui.expiries, ["extend"]);
  const conversation = conversationOf(probe.dir);
  assert.ok(conversation.includes(limitExtendedLine("Planning phase 1", "rounds", 1, true)), conversation);
  assert.ok(conversation.includes(limitExtendedLine("Planning phase 1", "rounds", 1, false)), conversation);
  assert.match(conversation, /The review of plan.json has converged/);
});

test("an unanswered idle limit extends the plan review without recording a decision, and the next idle limit asks nothing", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "rejected"]]) }, { output: respond([["B", "rejected"]]) }],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 1 },
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 1);
  assert.deepEqual(probe.ui.expiries, ["extend"]);
  const conversation = conversationOf(probe.dir);
  assert.ok(conversation.includes(limitExtendedLine("Planning phase 1", "idle", 1, true)), conversation);
  assert.ok(conversation.includes(limitExtendedLine("Planning phase 1", "idle", 1, false)), conversation);
  assert.ok(!(await probe.loadLog()).some((e) => e.action === "decided_by_user"));
});

test("a disputed pause that goes unanswered ends the run with NoAnswer", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" }, { output: respond([["B", "rejected"]]) }],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }],
  });
  const error = await runFails(layer, "NoAnswer", /no answer came within 2:00/);
  assert.equal(error._tag === "NoAnswer" && error.then, "abandon");
  assert.deepEqual(probe.ui.expiries, ["abandon"]);
});
