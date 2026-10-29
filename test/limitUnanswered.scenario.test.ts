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

// Work review 1 of issue #185 (W1-R1-3): Help me decide at a round limit, then a question inside the decision loop that
// goes unanswered: only the limit prompt's own expiry extends, so this one ends the run.
test("a question inside decision support at a round limit that goes unanswered ends the run with NoAnswer, no extension written", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    config: { maxRounds: 1, maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 },
    // The limit is answered /decide; the decision's analysis call loses its connection on every attempt, and the
    // exhaustion pause, asked inside the decision loop, goes unanswered.
    answers: ["/decide", { noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }, { fault: "connection reset" }, { fault: "connection reset" }],
    reviews: [{ issues: [issue("P1-R1-1")] }],
  });
  const error = await runFails(layer, "NoAnswer", /no answer came within/);
  assert.equal(error._tag === "NoAnswer" && error.then, "abandon");
  assert.deepEqual(probe.ui.expiries, ["extend", "abandon"]);
  assert.ok(!conversationOf(probe.dir).includes(limitExtendedLine("Planning phase 1", "rounds", 1, true)), conversationOf(probe.dir));
});
