import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { correctivePrompt } from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer, currentOf, entryOf } from "./helpers.ts";

// Issue #30 (plan step S11): scenario tests of the corrective turn over the test layers, which issue #30 names as
// missing: a corrective turn that succeeds, one that changes its dispositions, and the guards around it.
const noQuestions = { questions_for_user: [] };
const CORRECTIVE = /did not change during your response to the review of cycle 1/;
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

test("(a) the plan: an accepted issue with plan.json unchanged gets a corrective turn that applies the amendment", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]) }, // accepted, and the plan returned unchanged
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }, // the corrective turn applies it
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[2], correctivePrompt("plan.json", 1, ["P1-R1-1"]));
  assert.match(read(probe.dir, "plan.md"), /v2/);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "cc-1-corrective-1.json")));
  const [entry] = await probe.loadLog();
  assert.equal(entry?.action, "accepted");
  assert.equal(entry !== undefined && "file_change" in entry ? entry.file_change?.changed : undefined, true);
  assert.match(read(probe.dir, "conversation.md"), /\*\*Corrective turn 1, cycle 1\*\*/);
  assert.deepEqual(probe.ui.asked, []);
});

test("(b) a corrective turn that changes accepted to rejected: the loop continues and the log holds the new disposition", async () => {
  const rejected = { dispositions: [{ id: "P1-R1-1", action: "rejected" as const, rationale: "on reflection, the plan is right", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]) }, { output: rejected }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  const log = await probe.loadLog();
  assert.equal(log.length, 1, JSON.stringify(log));
  assert.equal(log[0]?.action, "rejected");
  assert.equal(log[0]?.rationale, "on reflection, the plan is right");
  assert.equal("file_change" in log[0]! ? log[0].file_change?.changed : undefined, false);
});

test("(d) a corrective reply that fails its schema gets its own repair turn; (budgets) the response's repair took none of it", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: { dispositions: "x" } }, // the response fails its schema: behaviour 10's repair
      { output: respond([["P1-R1-1", "accepted"]]) }, // repaired, but the plan is unchanged
      { output: { dispositions: "y" } }, // the corrective reply fails its schema: its own repair
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.planner.prompts[2] ?? "", /did not match the required schema/);
  assert.match(probe.planner.prompts[3] ?? "", CORRECTIVE);
  assert.match(probe.planner.prompts[4] ?? "", /did not match the required schema/);
  assert.match(read(probe.dir, "plan.md"), /v2/);
});

test("(e) a corrective turn that changes the project outside plan-review/ halts with ProjectChanged", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]) }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2", touchProject: true }],
    reviews: [{ issues: [issue("P1-R1-1")] }],
  });
  await runFails(layer, "ProjectChanged", /a\.txt/);
});

test("a corrective reply that changes a disposition it may not gets a validation repair, then is used", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"], ["P1-R1-2", "rejected"]]) },
      { output: respond([["P1-R1-1", "accepted"], ["P1-R1-2", "accepted"]]), plan: "v2" }, // changed P1-R1-2
      { output: respond([["P1-R1-1", "accepted"], ["P1-R1-2", "rejected"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("P1-R1-1"), issue("P1-R1-2")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.planner.prompts[3] ?? "", /changed the dispositions of P1-R1-2, which it was not allowed to change/);
});

test("(f) the question list: an accepted issue with questions.json unchanged gets a corrective turn", async () => {
  const q = (id: string): typeof S.QuestionEntry.Type => entryOf({ id, context: "c", question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "A" });
  const turn = (message: string, answered: string[], summary = "") => ({ message_to_user: message, current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: answered, answered_ids: answered, complete: summary !== "", summary });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1")] } }, // accepted, list unchanged
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } }, // the corrective turn
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1", "Q2"], "Q1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(probe.planner.prompts[2], correctivePrompt("questions.json", 1, ["Q-R1-1"]));
  assert.deepEqual(JSON.parse(read(probe.dir, "questions.json")).questions.map((x: { id: string }) => x.id), ["Q1", "Q2"]);
});
