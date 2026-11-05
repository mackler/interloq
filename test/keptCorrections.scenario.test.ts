// Issue #232: a correction accepted in a review loop stays in the reviewed document after every later response of the
// loop; a response that drops it gets the validation repair turn, and a second drop halts with CorrectionDropped.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { keptCorrectionsRepairPrompt } from "../src/prompts.ts";
import type { SubjectId } from "../src/artifacts.ts";
import * as S from "../src/schema.ts";
import { entryOf, finished, presentedQuestions, issue, respond, runFails, runRefinement, runTask, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const plan = (s1: string, s2: string): S.Plan => ({ stages: [{ number: 1, title: "Plan", steps: [{ id: "S1", number: 1, label: "Retry", text: s1 }, { id: "S2", number: 2, label: "Log", text: s2 }] }] });
type Disposition = [string, "accepted" | "partially_accepted" | "rejected"];
const answer = (dispositions: Disposition[], passages: [string, string[]][], p: S.Plan, reverses: [string, string][] = []) => {
  const base = respond(dispositions);
  return {
    ...base,
    dispositions: base.dispositions.map((d) => ({ ...d, reverses: reverses.find(([by]) => by === d.id)?.[1] ?? "" })),
    [S.CORRECTION_PASSAGES_FIELD]: passages.map(([id, ps]) => ({ id, passages: ps })),
    plan: p,
  };
};
const dropped = keptCorrectionsRepairPrompt([{ kind: "correctionMissing", id: "P1-R1-1", passage: "retry twice" }]);
const keptOf = async (probe: { loadLog: (s?: SubjectId) => Promise<readonly S.LogEntry[]> }, id: string, subject?: SubjectId) => {
  const entry = (await probe.loadLog(subject)).filter((e) => e.id === id && !e.superseded).at(-1);
  return entry === undefined || entry.source === "user" ? null : entry.kept_passages;
};
const round1 = answer([["P1-R1-1", "accepted"]], [["P1-R1-1", ["retry twice"]]], plan("The call will retry twice.", "Nothing is logged."));

test("(a) a later response that rewrites the step for another issue and drops the correction gets the repair turn, which restores it", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: answer([["P1-R2-1", "accepted"]], [["P1-R2-1", ["log each try"]]], plan("The call is retried.", "We log each try.")) },
      { output: answer([["P1-R2-1", "accepted"]], [["P1-R2-1", ["log each try"]]], plan("The call will retry twice.", "We log each try.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[3], dropped);
  assert.match(fs.readFileSync(path.join(probe.dir, "plan.json"), "utf8"), /retry twice/);
  assert.deepEqual(await keptOf(probe, "P1-R1-1"), ["retry twice"]);
  assert.deepEqual(await keptOf(probe, "P1-R2-1"), ["log each try"]);
});

test("(b) a repair reply that drops it again halts with CorrectionDropped, the reply kept in invalid-replies/", async () => {
  const lost = answer([["P1-R2-1", "accepted"]], [["P1-R2-1", ["log each try"]]], plan("The call is retried.", "We log each try."));
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } }, { output: round1 }, { output: lost }, { output: lost }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }],
  });
  await runFails(layer, "CorrectionDropped", /P1-R1-1/, /retry twice/);
  assert.ok(fs.readdirSync(path.join(probe.dir, "invalid-replies")).length > 0);
});

test("(c) a response that rewords the correction and restates it takes no repair turn, and the log keeps the new passage", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: answer([["P1-R2-1", "accepted"]], [["P1-R2-1", ["log each try"]], ["P1-R1-1", ["make two retry attempts"]]], plan("We make two retry attempts.", "We log each try.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(!probe.planner.prompts.includes(dropped));
  assert.deepEqual(await keptOf(probe, "P1-R1-1"), ["make two retry attempts"]);
});

test("(d) a response whose rejection validly reverses the correction takes no repair turn; the reversal pause is asked", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["", "", "", ""],
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: answer([["P1-R2-1", "rejected"]], [], plan("The call fails at once.", "Nothing is logged."), [["P1-R2-1", "P1-R1-1"]]) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.ok(!probe.planner.prompts.includes(dropped));
  assert.ok(presentedQuestions(probe.ui).some((q) => q.origin.kind === "pause" && "pause" in q.origin && q.origin.pause === "reversal"), JSON.stringify(presentedQuestions(probe.ui).map((q) => q.origin)));
});

test("(e) a corrective reply that drops a recorded passage gets the repair turn too", async () => {
  const unchanged = answer([["P1-R2-1", "accepted"]], [["P1-R2-1", []]], plan("The call will retry twice.", "Nothing is logged."));
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: unchanged }, // accepted with plan.json unchanged: the corrective turn follows
      { output: answer([["P1-R2-1", "accepted"]], [["P1-R2-1", []]], plan("The call is retried.", "We log each try.")) },
      { output: answer([["P1-R2-1", "accepted"]], [["P1-R2-1", []]], plan("The call will retry twice.", "We log each try.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.planner.prompts[3] ?? "", /did not change during your response/);
  assert.equal(probe.planner.prompts[4], dropped);
});

test("(f) the question list: a correction in a question's context dropped by a later response is restored by the repair turn", async () => {
  const q = (id: string, context: string): S.QuestionEntry => entryOf({ id, context, question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "A" });
  const list = (context: string, more: S.QuestionEntry[] = []) => [q("Q1", context), ...more];
  const respondQ = (d: Disposition[], passages: [string, string[]][], questions: S.QuestionEntry[]) => ({ ...respond(d), [S.CORRECTION_PASSAGES_FIELD]: passages.map(([id, ps]) => ({ id, passages: ps })), questions });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "A"],
    steps: [
      { output: { questions: list("The store is a file.") } },
      { output: respondQ([["Q-R1-1", "accepted"]], [["Q-R1-1", ["kept in memory"]]], list("The store is kept in memory.")) },
      { output: respondQ([["Q-R2-1", "accepted"]], [["Q-R2-1", []]], list("The store is a file.", [q("Q2", "c")])) },
      { output: respondQ([["Q-R2-1", "accepted"]], [["Q-R2-1", []]], list("The store is kept in memory.", [q("Q2", "c")])) },
    ],
    closings: [{ output: summaryReply("Q1: A") }],
    reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [issue("Q-R2-1")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runRefinement(layer);
  assert.equal(probe.planner.prompts[3], keptCorrectionsRepairPrompt([{ kind: "correctionMissing", id: "Q-R1-1", passage: "kept in memory" }]));
  assert.deepEqual(await keptOf(probe, "Q-R1-1", "questions"), ["kept in memory"]);
});

test("(g) the anchor survives a self-correction of the same id: a later response that drops it gets the repair turn", async () => {
  const selfCorrected = { ...answer([["P1-R2-1", "accepted"]], [["P1-R2-1", []]], plan("The call will retry twice, then stop.", "Nothing is logged.")), self_corrections: [{ id: "P1-R1-1", new_action: "plan_error", explanation: "stop after the second" }] };
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: selfCorrected },
      { output: answer([["P1-R3-1", "accepted"]], [["P1-R3-1", []]], plan("The call is retried.", "We log each try.")) },
      { output: answer([["P1-R3-1", "accepted"]], [["P1-R3-1", []]], plan("The call will retry twice.", "We log each try.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [issue("P1-R3-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.planner.prompts[4], dropped);
});

test("(h) a rejection whose reverses names its own id is no reversal: the drop gets the repair turn", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: answer([["P1-R1-1", "rejected"]], [], plan("The call fails at once.", "Nothing is logged."), [["P1-R1-1", "P1-R1-1"]]) },
      { output: answer([["P1-R1-1", "rejected"]], [], plan("The call will retry twice.", "Nothing is logged.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.planner.prompts[3], dropped);
});

test("(i) a re-raised issue rejected with its correction reworded and restated keeps the new wording, which a later response keeps", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: { ...noQuestions, plan: plan("The call fails at once.", "Nothing is logged.") } },
      { output: round1 },
      { output: answer([["P1-R1-1", "rejected"]], [["P1-R1-1", ["make two retry attempts"]]], plan("We make two retry attempts.", "Nothing is logged.")) },
      { output: answer([["P1-R3-1", "accepted"]], [["P1-R3-1", ["log each try"]]], plan("We make two retry attempts.", "We log each try.")) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R3-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.ok(!probe.planner.prompts.includes(dropped));
  assert.deepEqual(await keptOf(probe, "P1-R1-1"), ["make two retry attempts"]);
});
