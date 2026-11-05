// Issue #38: the investigation before a disagreement is put to the developer, over the test layers: the order of events
// at a re-raise, a resolution agreed with no question, one only the developer may authorize offered as a third choice and
// never applied, an investigation ending without agreement, the third choice chosen, carried out and reviewed, and a
// disposition-based pause's investigation turn.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { blocksText, piecesText } from "../src/pieces.ts";
import type * as S from "../src/schema.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { finished, issue, presentedQuestions, questionEntry, respond, runRefinement, runTask, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const ID = "P1-R1-1";
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const disputes = (ui: Parameters<typeof presentedQuestions>[0]) => presentedQuestions(ui).filter((q) => q.origin.kind === "pause");
const resolved = (action: S.Action, text: string, changes: string[] = []) => ({
  ...respond([[ID, action]]),
  dispositions: respond([[ID, action]]).dispositions.map((d) => ({ ...d, concern: "the plan must stay short", remedy: "keep the step", resolution: { text, changes } })),
});
const tagsOf = (events: readonly UiEvent[]): string[] => events.flatMap((e) => (e._tag === "ReviewReceived" || e._tag === "ResponseReceived" || e._tag === "QuestionPresented" ? [e._tag] : []));
const planLog = (dir: string): S.LogEntry[] => JSON.parse(read(dir, "issue-log.json")).entries;

test("(1) a point raised again gets an investigation before the developer is asked, and is asked when Codex raises it again", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([[ID, "rejected"]]), plan: "v2" }, { output: respond([[ID, "rejected"]]), plan: "v3" }, { output: respond([[ID, "rejected"]]), plan: "v4" }],
    reviews: [{ issues: [issue(ID)] }, { issues: [issue(ID)] }, { issues: [issue(ID)] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts[2]?.includes(prompts.investigationNote([ID])), "the response to the first re-raise asks for a resolution");
  assert.ok(!(probe.planner.prompts[1] ?? "").includes(prompts.investigationNote([ID])));
  assert.equal(disputes(probe.ui).length, 1);
  // The order: the first re-raise is answered by Claude Code, Codex reviews again, and only then is the developer asked.
  assert.deepEqual(tagsOf(probe.ui.notified).slice(0, 6), ["ReviewReceived", "ResponseReceived", "ReviewReceived", "ResponseReceived", "ReviewReceived", "QuestionPresented"]);
  const said = probe.ui.said.join("\n");
  assert.ok(said.indexOf(prompts.INVESTIGATION_HEADING) >= 0);
  assert.match(read(probe.dir, "conversation.md"), new RegExp(prompts.INVESTIGATION_HEADING));
});

test("(2) a resolution proposed in Claude Code's first response, raised by Codex and revised, then agreed: no question", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: resolved("partially_accepted", "keep the step and add a check"), plan: "v2" }, { output: resolved("partially_accepted", "keep the step, add a check and name it"), plan: "v3" }],
    reviews: [{ issues: [issue(ID)] }, { issues: [issue(ID)] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.deepEqual(disputes(probe.ui), []);
  const text = read(probe.dir, "conversation.md");
  assert.ok(text.includes(prompts.RESOLUTION_AGREED_HEADING), text.slice(-1500));
  assert.ok(text.includes("keep the step, add a check and name it"));
  const entry = planLog(probe.dir).filter((e) => e.id === ID && !e.superseded).at(-1)!;
  assert.ok(entry.source === "review");
  assert.deepEqual(entry.planner_position, { concern: "the plan must stay short", remedy: "keep the step" });
});

test("(3) a resolution only the developer may authorize is a third choice naming the change, never applied before his answer", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: resolved("rejected", "drop the step and its test", ["requirement 2: the step is required"]) }, { output: respond([[ID, "rejected"]]) }],
    reviews: [{ issues: [issue(ID)] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  const [question] = disputes(probe.ui);
  assert.ok(question !== undefined, "the developer is asked");
  assert.equal(question.origin.kind === "pause" ? question.origin.pause : "", "authorityResolution");
  assert.equal(question.options.length, 3);
  const third = piecesText(question.options[2].description);
  assert.ok(third.includes("requirement 2: the step is required"), third);
  // The planner's position and the reviewer's carry each one's concern and remedy (the trade-off).
  assert.match(read(probe.dir, "plan.md"), /v1/);
});

test("(5) the developer chooses the third choice: it is recorded, Claude Code carries it out, and Codex reviews it", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["3"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: resolved("rejected", "drop the step and its test", ["requirement 2"]) }, { output: respond([]), plan: "v2 resolved" }],
    reviews: [{ issues: [issue(ID)] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.ok(read(probe.dir, "user-decisions.md").includes(prompts.RESOLUTION_POSITION));
  const decided = planLog(probe.dir).filter((e) => e.source === "user");
  assert.ok(decided.some((e) => e.rationale.includes(prompts.RESOLUTION_POSITION)), JSON.stringify(decided));
  assert.match(read(probe.dir, "plan.md"), /v2 resolved/);
  // Codex reviewed the plan after the resolution was carried out: the review after the answer exists.
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "review-3.json")));
});

test("(7) a reversal gets the investigation turn first, and is asked only when Codex raises its id again", async () => {
  const reversal = (action: S.Action) => ({ ...respond([["P1-R2-1", action]]), dispositions: respond([["P1-R2-1", action]]).dispositions.map((d) => ({ ...d, reverses: ID })) });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([[ID, "accepted"]]), plan: "v2" }, { output: reversal("rejected") }, { output: reversal("rejected") }, { output: reversal("rejected") }, { output: reversal("rejected") }, { output: reversal("rejected") }],
    reviews: [{ issues: [issue(ID)] }, { issues: [issue("P1-R2-1")] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "cc-2-investigation-1.json")));
  const [question] = disputes(probe.ui);
  assert.ok(question !== undefined);
  assert.equal(question.origin.kind === "pause" ? question.origin.pause : "", "reversal");
  // Asked after the third review, not after the second round's response.
  const tags = tagsOf(probe.ui.notified);
  const thirdReview = tags.map((t, i) => (t === "ReviewReceived" ? i : -1)).filter((i) => i >= 0)[2];
  assert.ok(tags.indexOf("QuestionPresented") > thirdReview, tags.join(","));
  assert.equal(disputes(probe.ui).length, 1, "asked once in its round");
});

test("(11) a disputed self-correction kept with a resolution naming a change is asked at the next review with three options", async () => {
  const disputing = { ...respond([["P1-R2-1", "accepted"]]), self_corrections: [{ id: ID, new_action: "rejected" as const, explanation: "the correction was wrong", concern: "the step must stay", remedy: "restore it", resolution: { text: "restore it behind a flag", changes: ["decision 3"] } }] };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["3"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([[ID, "accepted"]]), plan: "v2" }, { output: disputing, plan: "v3" }, { output: disputing, plan: "v3" }, { output: respond([]), plan: "v4" }, { output: respond([]) }],
    reviews: [{ issues: [issue(ID)] }, { issues: [issue("P1-R2-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  const [question] = disputes(probe.ui);
  assert.ok(question !== undefined, "the disputed self-correction reaches the developer");
  assert.equal(question.origin.kind === "pause" ? question.origin.pause : "", "disputedSelfCorrection");
  assert.equal(question.options.length, 3);
  assert.ok(read(probe.dir, "user-decisions.md").includes(prompts.RESOLUTION_POSITION));
  assert.match(read(probe.dir, "plan.md"), /v4/);
});

test("(W1-R1-1) in the question list a marked dispute whose review entry an earlier self-correction superseded is investigated and then asked", async () => {
  const q1 = questionEntry("Q1", "question Q1?", [["A", "a"], ["B", "b"]], { context: "c", reason: "the codebase does not determine it", default_answer: "A" });
  const qv = (n: string) => questionEntry("Q1", `question Q1, ${n}?`, [["A", "a"], ["B", "b"]], { context: "c", reason: "r", default_answer: "A" });
  const marked = { ...respond([["Q-R1-1", "partially_accepted", true]]), questions: [qv("first")] };
  const corrected = { ...respond([["Q-R2-1", "accepted"]]), self_corrections: [{ id: "Q-R1-1", new_action: "accepted" as const, explanation: "the point holds after all", concern: "", remedy: "", resolution: null }], questions: [questionEntry("Q1", "question Q1, revised?", [["A", "a"], ["B", "b"]], { context: "c", reason: "r", default_answer: "A" })] };
  const disputing = { ...respond([["Q-R3-1", "accepted"]]), self_corrections: [{ id: "Q-R1-1", new_action: "rejected" as const, explanation: "the correction misread the task", concern: "the task allows two readings", remedy: "keep Q1 as asked", resolution: null }], questions: [questionEntry("Q1", "question Q1, again?", [["A", "a"], ["B", "b"]], { context: "c", reason: "r", default_answer: "A" })] };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2", "A"],
    steps: [{ output: { questions: [q1] } }, { output: marked }, { output: corrected }, { output: disputing }, { output: disputing }, { output: { ...respond([]), questions: [q1] } }],
    closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Complete.") }],
    reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [issue("Q-R2-1")] }, { issues: [issue("Q-R3-1")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 9 },
  });
  await runRefinement(layer);
  assert.ok(fs.readdirSync(probe.dir, { recursive: true }).some((f) => /cc-\d+-investigation-\d+\.json$/.test(String(f))), "the investigation turn ran");
  const [question] = disputes(probe.ui);
  assert.ok(question !== undefined, "the marked dispute reaches the developer");
  assert.equal(question.origin.kind === "pause" ? question.origin.pause : "", "disputedSelfCorrection");
  const conversation = read(probe.dir, "conversation.md");
  assert.ok(!new RegExp(`\\*\\*${prompts.WORDING_DISPUTE_HEADING}\\*\\*[^\\n]*Q-R1-1`).test(conversation), conversation.slice(-2000));
});

test("(W1-R1-2) an authority resolution answered with Claude Code's position on a review with no counted issue is logged as the developer's decision", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: resolved("rejected", "drop the step and its test", ["requirement 2: the step is required"]) }, { output: respond([[ID, "rejected"]]) }],
    reviews: [{ issues: [issue(ID)] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.equal(disputes(probe.ui).length, 1);
  const current = planLog(probe.dir).filter((e) => e.id === ID && !e.superseded).at(-1);
  assert.equal(current?.source, "user", JSON.stringify(planLog(probe.dir)));
});

const CODEX_SIDE = { concern: "codex concern X", remedy: "codex remedy X" };
const CLAUDE_SIDE = { concern: "claude concern Y", remedy: "claude remedy Y" };
const codexRaises = () => ({ ...issue(ID), ...CODEX_SIDE });
const claudeRejects = (resolution: { text: string; changes: string[] } | null = null) => ({
  ...respond([[ID, "rejected"]]),
  dispositions: respond([[ID, "rejected"]]).dispositions.map((d) => ({ ...d, ...CLAUDE_SIDE, resolution })),
});
const fourTexts = [CODEX_SIDE.concern, CODEX_SIDE.remedy, CLAUDE_SIDE.concern, CLAUDE_SIDE.remedy];

test("(4, W1-R1-3) the question after an investigation that ends without agreement shows both agents' concerns and remedies, in its options and its details", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: claudeRejects(), plan: "v2" }, { output: claudeRejects({ text: "keep the step behind a check", changes: [] }), plan: "v3" }, { output: claudeRejects(), plan: "v4" }],
    reviews: [{ issues: [codexRaises()] }, { issues: [codexRaises()] }, { issues: [{ ...codexRaises(), evidence: "the check does not meet the concern" }] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 5 },
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts[2]?.includes(prompts.investigationNote([ID])), "the response to the first re-raise carries the investigation note");
  const [question] = disputes(probe.ui);
  assert.ok(question !== undefined, "asked after the investigation");
  assert.deepEqual(tagsOf(probe.ui.notified).slice(0, 6), ["ReviewReceived", "ResponseReceived", "ReviewReceived", "ResponseReceived", "ReviewReceived", "QuestionPresented"]);
  assert.equal(question.options.length, 3, "the resolution is the third choice");
  const descriptions = question.options.map((o) => piecesText(o.description)).join("\n");
  const details = blocksText(question.attached?.blocks ?? []).join("\n");
  for (const want of fourTexts) {
    assert.ok(descriptions.includes(want), `${want} in the options:\n${descriptions}`);
    assert.ok(details.includes(want), `${want} in the details:\n${details}`);
  }
});
