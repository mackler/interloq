// Issue #151: a review or a response that matches its schema but fails the round's validation (RoundInvalid) gets one
// validation repair turn in the same thread or session (behavior 10), and a second failure halts. Every reply of a review
// loop is written to its round file before it is decoded or validated. Every expected prompt is derived from the failure.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Result } from "effect";
import { reviewRepairPrompt, roundRepairPrompt } from "../src/prompts.ts";
import { serializeReply } from "../src/records.ts";
import { correctiveValidation, validateReview, validateRound } from "../src/round.ts";
import type { LogEntry, PlannerResponse, Review } from "../src/schema.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer, unmarked, type ScriptedPlanner } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const exists = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name));
const planLog = (dir: string) => json(dir, "issue-log.json").entries as LogEntry[];

/** The failure validateRound gives a response to a review with `issues` in round 1 of planning phase 1, as the loop computes it. */
const roundFailure = (issues: Review["issues"], response: PlannerResponse, log: readonly LogEntry[] = [], round = 1) => {
  const reviewed = validateReview({ issues });
  assert.ok(Result.isSuccess(reviewed));
  const checked = validateRound(reviewed.success, response, log, 1, round, "P");
  assert.ok(Result.isFailure(checked), "the scripted response was expected to be invalid");
  return checked.failure;
};
const reviewFailure = (review: Review) => {
  const checked = validateReview(review);
  assert.ok(Result.isFailure(checked), "the scripted review was expected to be invalid");
  return checked.failure;
};
/** The session on which a prompt was sent (issue #122: a planning phase has a session of its own). */
const sessionOf = (planner: ScriptedPlanner, prompt: string): string => {
  const found = [...planner.history.entries()].filter(([, prompts]) => prompts.includes(prompt)).map(([session]) => session);
  assert.equal(found.length, 1, `the prompt was sent on ${found.length} sessions`);
  return found[0];
};

/** Each response defect of RoundInvalid, with a review, a refused response and its repair. */
const RESPONSE_CASES: readonly Readonly<{ name: string; issues: Review["issues"]; refused: PlannerResponse; repaired: PlannerResponse }>[] = [
  { name: "missing", issues: [issue("P1-R1-1"), issue("P1-R1-2")], refused: respond([["P1-R1-1", "accepted"]]), repaired: respond([["P1-R1-1", "accepted"], ["P1-R1-2", "rejected"]]) },
  { name: "duplicateDispositions", issues: [issue("P1-R1-1")], refused: respond([["P1-R1-1", "rejected"], ["P1-R1-1", "accepted"]]), repaired: respond([["P1-R1-1", "accepted"]]) },
  { name: "unknownDispositions", issues: [issue("P1-R1-1")], refused: respond([["P1-R1-1", "accepted"], ["P1-R1-9", "accepted"]]), repaired: respond([["P1-R1-1", "accepted"]]) },
  { name: "emptyIds", issues: [issue("P1-R1-1")], refused: respond([["P1-R1-1", "accepted"], ["", "accepted"]]), repaired: respond([["P1-R1-1", "accepted"]]) },
];

for (const c of RESPONSE_CASES) {
  test(`a response with ${c.name} gets one repair turn in its session, kept on disk before it, and the loop goes on`, async () => {
    const failure = roundFailure(c.issues, c.refused);
    let atRepair: { cc: unknown; kept: unknown } | null = null;
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [
        { output: noQuestions, plan: "v1" },
        { output: c.refused, plan: "v2" },
        { output: c.repaired, plan: "v2", onCall: () => (atRepair = { cc: json(probe.dir, "planning-1/cc-1.json"), kept: json(probe.dir, "invalid-replies/claude-1.json") }) },
      ],
      reviews: [{ issues: [...c.issues] }, { issues: [] }, { issues: [] }],
      execs: [finished],
    });
    assert.equal(await runTask(layer), 1);
    const repairPrompt = roundRepairPrompt(failure, c.issues.map((i) => i.id));
    assert.equal(probe.planner.prompts[2], repairPrompt);
    assert.equal(sessionOf(probe.planner, repairPrompt), sessionOf(probe.planner, probe.planner.prompts[1]));
    assert.ok(atRepair !== null);
    const seen = atRepair as { cc: PlannerResponse; kept: PlannerResponse };
    assert.deepEqual(seen.cc.dispositions, c.refused.dispositions, "cc-1.json held the refused reply before the repair turn");
    assert.deepEqual(seen.kept.dispositions, c.refused.dispositions, "the refused reply was kept in invalid-replies/");
    assert.deepEqual(json(probe.dir, "planning-1/cc-1.json").dispositions, unmarked(c.repaired.dispositions), "cc-1.json holds the accepted reply");
  });

  test(`a second response with ${c.name} halts with RoundInvalid, both replies kept`, async () => {
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [{ output: noQuestions, plan: "v1" }, { output: c.refused, plan: "v2" }, { output: { ...c.refused, reviewer_feedback: "second" }, plan: "v2" }],
      reviews: [{ issues: [...c.issues] }],
    });
    await runFails(layer, "RoundInvalid", /the cycle is invalid/);
    assert.equal(probe.planner.prompts.length, 3);
    assert.equal(json(probe.dir, "planning-1/cc-1.json").reviewer_feedback, "second");
    assert.equal(json(probe.dir, "invalid-replies/claude-1.json").reviewer_feedback, "");
    assert.equal(json(probe.dir, "invalid-replies/claude-2.json").reviewer_feedback, "second");
  });
}

test("a missing disposition is named in the halt after the second failure", async () => {
  const refused = respond([["A", "accepted"]]);
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: refused, plan: "v2" }, { output: refused, plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "RoundInvalid", /Claude Code returned no disposition for: B/);
});

// S8: a generated self-correction id that already exists in the log is repaired with an explicit free id.
test("a colliding generated self-correction id gets one repair turn, and the explicit id is logged beside the unrelated entry", async () => {
  const round1 = respond([["P1-R1-1", "accepted"]], { self_corrections: [{ id: "P1-S2-1", new_action: "plan_error", explanation: "earlier" }] });
  const refused = respond([["P1-R2-1", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }] });
  const repaired = respond([["P1-R2-1", "accepted"]], { self_corrections: [{ id: "P1-S2-2", new_action: "plan_error", explanation: "x" }] });
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: round1, plan: "v2" }, { output: refused, plan: "v3" }, { output: repaired, plan: "v3" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  const before = planLog(probe.dir).filter((e) => e.round === 1);
  const failure = roundFailure([issue("P1-R2-1")], refused, before, 2);
  assert.deepEqual(failure.collidingIds, ["P1-S2-1"]);
  assert.equal(probe.planner.prompts[3], roundRepairPrompt(failure, ["P1-R2-1"]));
  const log = planLog(probe.dir);
  const unrelated = log.filter((e) => e.id === "P1-S2-1");
  assert.deepEqual(unrelated.map((e) => [e.round, e.action, e.rationale, e.superseded]), [[1, "plan_error", "earlier", false]]);
  const added = log.filter((e) => e.id === "P1-S2-2");
  assert.deepEqual(added.map((e) => [e.round, e.action, e.rationale]), [[2, "plan_error", "x"]]);
});

test("a second colliding generated self-correction id halts with RoundInvalid", async () => {
  const round1 = respond([["P1-R1-1", "accepted"]], { self_corrections: [{ id: "P1-S2-1", new_action: "plan_error", explanation: "earlier" }] });
  const refused = respond([["P1-R2-1", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }] });
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: round1, plan: "v2" }, { output: refused, plan: "v3" }, { output: refused, plan: "v3" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R2-1")] }],
  });
  await runFails(layer, "RoundInvalid", /a generated self-correction id already exists in the log: P1-S2-1/);
});

test("a reply that fails its schema is in its round file before its schema repair turn", async () => {
  let atRepair: unknown = null;
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: { dispositions: "none" }, plan: "v2" },
      { output: respond([["A", "accepted"]]), plan: "v2", onCall: () => (atRepair = json(probe.dir, "planning-1/cc-1.json")) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal((atRepair as { dispositions: unknown } | null)?.dispositions, "none");
});

// W1-R1-1: a reply JSON cannot represent is written to its round file as serializeReply's text, as invalid-replies/ keeps
// it, so the raw save never ends the run before the reply's repair turn.
for (const [what, extra] of [["a BigInt", 1n], ["a cycle", (() => { const c: Record<string, unknown> = { name: "x" }; c.self = c; return c; })()]] as const) {
  test(`a refused response containing ${what} is in its round file and invalid-replies/ as serializeReply's text before its repair turn`, async () => {
    const refused = { ...respond([["A", "accepted"]]), extra };
    let atRepair: { cc: string; kept: string } | null = null;
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [
        { output: noQuestions, plan: "v1" },
        { output: refused, plan: "v2" },
        {
          output: respond([["A", "accepted"], ["B", "rejected"]]),
          plan: "v2",
          onCall: () => (atRepair = { cc: fs.readFileSync(path.join(probe.dir, "planning-1/cc-1.json"), "utf8"), kept: fs.readFileSync(path.join(probe.dir, "invalid-replies/claude-1.json"), "utf8") }),
        },
      ],
      reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [] }, { issues: [] }],
      execs: [finished],
    });
    assert.equal(await runTask(layer), 1);
    assert.ok(atRepair !== null, "the repair turn was not reached");
    const seen = atRepair as { cc: string; kept: string };
    const expected = serializeReply({ ...refused, plan: json(probe.dir, "planning-1/cc-1.json").plan });
    assert.equal(seen.cc.trimEnd(), expected, "cc-1.json held serializeReply's text of the refused reply");
    assert.equal(seen.kept.trimEnd(), expected, "invalid-replies/ kept the same text");
    assert.deepEqual(json(probe.dir, "planning-1/cc-1.json").dispositions, unmarked(respond([["A", "accepted"], ["B", "rejected"]]).dispositions));
  });
}

/** Each review defect of RoundInvalid. */
const REVIEW_CASES: readonly Readonly<{ name: string; refused: Review }>[] = [
  { name: "duplicateIssues", refused: { issues: [issue("P1-R1-1", "first"), issue("P1-R1-1", "second")] } },
  { name: "emptyIds", refused: { issues: [issue("P1-R1-1"), issue("")] } },
];

for (const c of REVIEW_CASES) {
  test(`a review with ${c.name} gets one repair turn in its thread, kept on disk before it, and the loop goes on`, async () => {
    const failure = reviewFailure(c.refused);
    let atRepair: { review: unknown; kept: unknown } | null = null;
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }],
      reviews: [
        c.refused,
        { issues: [issue("P1-R1-1")], onCall: () => (atRepair = { review: json(probe.dir, "planning-1/review-1.json"), kept: json(probe.dir, "invalid-replies/codex-1.json") }) },
        { issues: [] },
        { issues: [] },
      ],
      execs: [finished],
    });
    assert.equal(await runTask(layer), 1);
    assert.equal(probe.reviewer.prompts[1], reviewRepairPrompt(failure));
    assert.equal(probe.reviewer.callPhases[1], probe.reviewer.callPhases[0], "the repair turn ran in the review's thread");
    assert.ok(atRepair !== null);
    const seen = atRepair as { review: unknown; kept: unknown };
    assert.deepEqual(seen.review, c.refused, "review-1.json held the refused review before the repair turn");
    assert.deepEqual(seen.kept, c.refused, "the refused review was kept in invalid-replies/");
    assert.deepEqual(json(probe.dir, "planning-1/review-1.json"), { issues: [issue("P1-R1-1")] });
  });

  test(`a second review with ${c.name} halts with RoundInvalid before any response`, async () => {
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [{ output: noQuestions, plan: "v1" }],
      reviews: [c.refused, c.refused],
    });
    await runFails(layer, "RoundInvalid", /the cycle is invalid/);
    assert.equal(probe.planner.prompts.length, 1, "Claude Code was asked to respond to an invalid review");
    assert.equal(probe.reviewer.prompts.length, 2);
  });
}

test("one validation repair turn per call: a reply that fails the questions' rules and then the round's validation halts", async () => {
  const badQuestion = { context: [], history: [], question: [{ text: "Which?", ref: "t9", code: false }], explanations: [], options: [] };
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]], { questions_for_user: [badQuestion] }), plan: "v2" }, { output: respond([]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "RoundInvalid", /Claude Code returned no disposition for: A/);
  assert.equal(probe.planner.prompts.length, 3);
});

test("a corrective reply refused by the corrective validation (CorrectionInvalid) is in its round file before its repair turn, and the repaired reply lets the loop go on", async () => {
  let atRepair: unknown = null;
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]) },
      { output: respond([]) },
      { output: respond([["A", "rejected"]]), onCall: () => (atRepair = json(probe.dir, "planning-1/cc-1-corrective-1.json")) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual((atRepair as PlannerResponse | null)?.dispositions, []);
  assert.deepEqual(json(probe.dir, "planning-1/cc-1-corrective-1.json").dispositions, respond([["A", "rejected"]]).dispositions);
});

// W1-R1-2: the corrective validation lets only the action and the rationale of the accepted dispositions change, comparing
// by position, so [A, B] answered as [A, A] passes it, and the round's validation refuses it (B missing, A duplicated).
test("a corrective reply the corrective validation accepts but the round's validation refuses gets the round's repair turn", async () => {
  const response = respond([["A", "accepted"], ["B", "accepted"]]);
  const refused = respond([["A", "accepted"], ["A", "accepted"]]);
  const repaired = respond([["A", "rejected"], ["B", "rejected"]]);
  assert.ok(Result.isSuccess(correctiveValidation<PlannerResponse>(response, ["A", "B"])(refused)), "the corrective validation accepts the refused reply");
  const failure = roundFailure([issue("A"), issue("B")], refused);
  let atRepair: { cc: unknown; kept: unknown } | null = null;
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: response },
      { output: refused },
      { output: repaired, onCall: () => (atRepair = { cc: json(probe.dir, "planning-1/cc-1-corrective-1.json"), kept: json(probe.dir, "invalid-replies/claude-1.json") }) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[3], roundRepairPrompt(failure, ["A", "B"]));
  assert.ok(atRepair !== null, "the repair turn was not reached");
  const seen = atRepair as { cc: PlannerResponse; kept: PlannerResponse };
  assert.deepEqual(seen.cc.dispositions, refused.dispositions);
  assert.deepEqual(seen.kept.dispositions, refused.dispositions);
  assert.deepEqual(json(probe.dir, "planning-1/cc-1-corrective-1.json").dispositions, repaired.dispositions);
  assert.ok(!/RoundInvalid|CorrectionInvalid|the cycle is invalid/.test(probe.ui.said.join("\n")), "the run did not halt on the corrective reply");
});

test("a work response with a missing disposition gets its read-only repair turn without halting on its own record write", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([]) }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[2], roundRepairPrompt(roundFailure([issue("W1-R1-1")], respond([])), ["W1-R1-1"]));
  assert.deepEqual(probe.planner.capabilities.slice(1), ["readOnly", "readOnly"]);
  assert.ok(exists(probe.dir, "invalid-replies/claude-1.json"));
  assert.deepEqual(json(probe.dir, "work-review-1/cc-1.json").dispositions, unmarked(respond([["W1-R1-1", "rejected"]]).dispositions));
});
