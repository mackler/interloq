import assert from "node:assert/strict";
import { planRepairPrompt, withOffer } from "../src/prompts.ts";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { run } from "../src/run.ts";
import { countOfKind, foreseenPhases, type Phase, phaseName, type UiEvent } from "../src/uiEvents.ts";
import { finished, issue, respond, runFails, runTask, scriptedRecordedPlan, scriptedTask, tempRepo, testLayer, presentedQuestions, presentedSubjects } from "./helpers.ts";
import { blocksMarkdown, piecesText } from "../src/pieces.ts";

const noQuestions = { questions_for_user: [] };

test("one accepted issue, then convergence, then finished", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, []);
  const log = await probe.loadLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "accepted");
  // Issue #31: the plan's change during the response (v1 to v2 in plan.json) is on the entry.
  const change = "file_change" in log[0] ? log[0].file_change : undefined;
  assert.equal(change?.changed, true);
  assert.ok(change !== null && change !== undefined && change.added >= 1 && change.removed >= 1, JSON.stringify(change));
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.match(conversation, /\[P1-R1-1\]\*\* accepted/);
  assert.match(conversation, /The review of plan.json has converged/);
});

test("a rejected issue raised again produces one prompt", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep the rejection"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      { output: respond([["B", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 1);
  assert.match(presentedSubjects(probe.ui)[0], /issue B, raised again/);
  const entries = (await probe.loadLog()).filter((e) => e.id === "B");
  assert.deepEqual(entries.map((e) => e.superseded === true), [true, true, false]);
  // Finding 15: the decision on the reraised issue is one typed decision, so it is in the issue log too.
  assert.equal(entries.at(-1)?.action, "decided_by_user");
  assert.equal(entries.at(-1)?.rationale, "keep the rejection");
});

// Issue #31, Q6: the measurement is in the issue log and the reviewer's prompt, never in what the user is shown.
test("a pause shows the log entries without file_change, while issue-log.json keeps it", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep the rejection"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      { output: respond([["B", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  // S11: the pause shows the point's history as prose; the measurement is not in it.
  const details = presentedQuestions(probe.ui).map((q) => blocksMarkdown(q.details)).join("\n");
  assert.match(details, /Claude Code rejected it: rationale B/, "the pause showed no log entry");
  assert.equal([...probe.ui.said, details].some((line) => line.includes(S.FILE_CHANGE_FIELD) || /lines? added/.test(line)), false, "the user was shown file_change");
  assert.ok((await probe.loadLog()).some((e) => S.FILE_CHANGE_FIELD in e), "issue-log.json lacks file_change");
});

test("a stop with a question starts a second planning phase with a new Codex thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    // Plan review 1, work review 1, plan review 2, work review 2.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "step 1", question: "A or B?", remainingWork: "steps 2-3", userInput: "B" }, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.reviewer.phases, 4);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-2", "cc-0.json")));
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /stop in execution phase 1 \(needs_input\): A or B\?\nDecision: B/);
  assert.deepEqual(probe.ui.asked, []);
});

// Issue #117: each execution phase runs in a Claude Code session of its own, which carries nothing of the planning's
// session or of an earlier execution's, and its prompt names the task as the run passes it.
test("issue #117: two execution phases run in two sessions of their own, each with only its own prompt", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "step 1", question: "A or B?", remainingWork: "steps 2-3", userInput: "B" }, finished],
  });
  assert.equal(await runTask(layer, scriptedTask), 2);
  const [first, second] = probe.planner.execSessions;
  assert.equal(probe.planner.execSessions.length, 2);
  assert.notEqual(first, second);
  assert.ok(first !== "test-session" && second !== "test-session", probe.planner.execSessions.join(", "));
  const expected = prompts.executePrompt(scriptedTask, false);
  assert.deepEqual(probe.planner.execPrompts, [expected, expected]);
  assert.ok(expected.includes(scriptedTask));
  assert.deepEqual(probe.planner.history.get(second), [expected], "the second execution's session holds only its own prompt");
  assert.ok(!(probe.planner.history.get("test-session") ?? []).includes(expected), "no execution prompt reached the run's main session");
});

test("a stop without a question asks the user for input", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["retry with smaller steps"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "aborted", summary: "", question: "no status", remainingWork: "", userInput: null }, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.ui.asked.length, 1);
});

test("a planning call that changes the project halts the run", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1", touchProject: true }] });
  await runFails(layer, "ProjectChanged", /changed during a planning-phase call/, /a\.txt/);
});

test("a change to an ignored path does not halt the run", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1", touchProject: true }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    config: { ignorePaths: ["a.txt"] },
  });
  assert.equal(await runTask(layer), 1);
});

// Behavior 7 as amended (issue #30): a corrective turn, then the pause; Stop halts, and the log holds the round.
test("an accepted issue without a plan change: a corrective turn, then the pause, whose Stop halts the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["s"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]) }, { output: respond([["A", "accepted"]]) }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "AcceptedWithoutChange", /plan\.json is unchanged/);
  assert.equal(probe.ui.asked.length, 1);
  assert.equal(probe.ui.asked[0], prompts.withOffer(prompts.unchangedPrompt));
  assert.deepEqual((await probe.loadLog()).map((e) => [e.id, e.action]), [["A", "accepted"]]);
});

test("the pause's Retry takes another corrective turn, which applies the amendment", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["r"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]) }, { output: respond([["A", "accepted"]]) }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "cc-1-corrective-2.json")));
  assert.match(fs.readFileSync(path.join(probe.dir, "plan.md"), "utf8"), /v2/);
});

test("the pause's Proceed continues with the next cycle, and the log shows the file unchanged", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]) }, { output: respond([["A", "accepted"]]) }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  const [entry] = await probe.loadLog();
  assert.equal(entry !== undefined && "file_change" in entry ? entry.file_change?.changed : undefined, false);
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*User decision:\*\* proceed with plan\.json unchanged after cycle 1/);
});

test("Help me decide at the pause runs a decision and asks again", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "p"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["A", "accepted"]]) },
      { output: { decision: "d", columns: [["Retry"], ["Proceed"], ["Stop the run"]].map(([option]) => ({ kind: "argued", option, advantages: [], disadvantages: [] })), recommendation: { option: "", reason: "" } } },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.ui.asked.length, 2);
  assert.ok(probe.ui.notified.some((e) => e._tag === "DecisionAnalyzed"));
});

test("the round limit offers to proceed to implementation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(await runTask(layer), 1);
  // Decision support (decision Q6): the limit is a choice between options, so it carries the offer.
  assert.equal(probe.ui.asked[0], withOffer(prompts.limitPrompt));
  // S5: the question says how many cycles were completed, and the proceed option says what proceeding does.
  const limit = probe.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []))[0];
  assert.equal(piecesText(limit.question), prompts.limitQuestion("Planning phase 1", 1));
  assert.match(piecesText(limit.options[0].description), /proceeds to implementation with the plan as it is/i);
});

test("a reversal and a disputed self-correction each produce a prompt and a decided_by_user entry", async () => {
  const reversal = {
    ...respond([["C", "rejected"]]),
    dispositions: [{ id: "C", action: "rejected" as const, rationale: "rationale C", duplicate_of: "", reverses: "A" }],
    self_corrections: [{ id: "A", new_action: "rejected" as const, explanation: "A breaks the migration" }, { id: "", new_action: "plan_error" as const, explanation: "wrong module" }],
  };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep A", "keep A again"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: reversal, plan: "v3" },
      { output: noQuestions, plan: "v4" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("C")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 2);
  const log = await probe.loadLog();
  assert.ok(log.some((e) => e.id === "P1-S2-2" && e.action === "plan_error"));
  assert.equal(log.filter((e) => e.action === "decided_by_user").length, 2);
  assert.equal(log.filter((e) => e.id === "A" && e.superseded !== true).length, 1);
});

test("a second run archives the files of the first", async () => {
  const repo = tempRepo();
  const mk = () => testLayer(repo, { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  await runTask(mk().layer, "first");
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), "{}");
  execFileSync("git", ["-C", repo, "checkout", "-q", "a.txt"]);
  const second = mk();
  await runTask(second.layer, "second");
  const names = fs.readdirSync(second.probe.dir);
  assert.equal(names.filter((n) => n.startsWith("archive-")).length, 1);
  assert.ok(names.includes("config.json"));
  assert.match(fs.readFileSync(path.join(second.probe.dir, "conversation.md"), "utf8"), /Task: second/);
});

test("0 at the round limit stops with RoundLimitStop", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["0"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(layer, "RoundLimitStop", /stopped by the user at the cycle limit of Planning phase 1/);
});

test("q at the round limit stops with UserStopped", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["q"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(layer, "UserStopped", /stopped by the user/);
});

test("q at a decision prompt stops with UserStopped", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["q"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }],
  });
  await runFails(layer, "UserStopped", /stopped by the user/);
});

test("a missing disposition stops with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "RoundInvalid", /Claude Code returned no disposition for: B/);
});

// Issue #6 (F1): a plan write without a plan is a schema mismatch, with its repair turn, not a missing file.
test("a plan write without a plan gets the schema repair turn, and a second one stops the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions }, { output: noQuestions }] });
  await runFails(layer, "AgentReplyInvalid", /plan/);
  assert.equal(probe.planner.prompts.length, 2);
});

test("Codex changing the reviewed file stops with ReviewedFileChanged", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [issue("A")], plan: "changed by the reviewer" }],
  });
  await runFails(layer, "ReviewedFileChanged", /plan\.json changed during a Codex review/);
});

// Finding 14 of docs/functional-design-review.md: after an idle-round decision appended a second hash for one
// round, the position in the history was printed as a round number.
test("the identical-content message names the round after which the content was seen, also after an idle decision", async () => {
  const reject = (id: string, plan?: string) => ({ output: respond([[id, "rejected"]]), ...(plan === undefined ? {} : { plan }) });
  const { layer, probe } = testLayer(tempRepo(), {
    // round 1: unexplained change (no decision), idle prompt (a decision that applies changes -> v3)
    // rounds 2 and 3: unexplained change and idle prompt, no decisions; round 4: the plan is v4 again
    answers: ["", "apply the missing step", "", "", "", "", "", "", ""],
    steps: [
      { output: noQuestions, plan: "v1" },
      reject("A", "v2"),
      { output: noQuestions, plan: "v3" }, // applies the decision of round 1
      reject("B", "v4"),
      reject("C", "v5"),
      reject("D", "v4"),
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [issue("D")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 1, maxRounds: 6 },
  });
  assert.equal(await runTask(layer), 1);
  const identical = presentedQuestions(probe.ui).map((q) => blocksMarkdown(q.details)).filter((line) => /is identical to plan\.json after/.test(line));
  assert.equal(identical.length, 1, presentedSubjects(probe.ui).join("\n"));
  assert.match(identical[0], /identical to plan\.json after cycle 2\b/);
});

// Finding 3 of docs/functional-design-review.md: duplicate or extra dispositions and duplicate review ids passed
// the presence check, so counts and the recorded actions could disagree. Decision Q3: a structural halt.
test("two dispositions for one issue halt the run with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "rejected"], ["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
});

test("a disposition for an id that is not in the review halts the run with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"], ["B", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "RoundInvalid", /\bB\b/);
});

test("a review with two issues of the same id halts the run with RoundInvalid before any response", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [issue("A", "first"), issue("A", "second")] }],
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
  assert.equal(probe.planner.prompts.length, 1, "Claude Code was asked to respond to an invalid review");
});

test("a review with two minor issues of the same id halts instead of converging when minor issues do not count", async () => {
  const minor = (id: string) => ({ ...issue(id), severity: "minor" as const });
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [minor("A"), minor("A")] }, { issues: [] }],
    execs: [finished],
    config: { countMinor: false },
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
});

test("a missing disposition still halts, now as RoundInvalid, naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "RoundInvalid", /returned no disposition for: B/);
});

// Finding 5 of docs/functional-design-review.md: the extra-rounds answer accepted integers beyond safe range.
test("at the round limit, an integer beyond the safe range is an invalid answer and stops; a small one adds rounds", async () => {
  const huge = testLayer(tempRepo(), {
    answers: ["99999999999999999999"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(huge.layer, "RoundLimitStop", /cycle limit/);

  const three = testLayer(tempRepo(), {
    answers: ["3"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(await runTask(three.layer), 1);
  assert.ok(three.probe.ui.said.some((line) => /^\nPlanning phase 1, cycle 2: Codex review \.\.\.$/.test(line)), three.probe.ui.said.join("\n"));
});

// Finding 16 / decision Q6: checkpoint.json names the last committed transition (no resume).
test("the checkpoint names the last committed transition: the execution phase after a run, round 1 logged after a halt in round 2", async () => {
  const point = (dir: string) => {
    const { version, subject, phase, round, stage, time } = JSON.parse(fs.readFileSync(path.join(dir, "checkpoint.json"), "utf8"));
    assert.equal(version, 2);
    assert.equal(typeof time, "string");
    return { subject, phase, round, stage };
  };
  const finishedRun = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(finishedRun.layer);
  // The last committed transition of a finished run is the converged round of its last work review.
  assert.deepEqual(point(finishedRun.probe.dir), { subject: "work-review-1", phase: 1, round: 1, stage: "reviewed" });

  const halted = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B"), issue("B")] }],
  });
  await runFails(halted.layer, "RoundInvalid", /B/);
  assert.deepEqual(point(halted.probe.dir), { subject: "planning-1", phase: 1, round: 1, stage: "logged" });
});

// The Codex model is the configured one; the SDK does not report which model answered.
test("the run announces the Codex model it was configured with, or the login's default", async () => {
  const configured = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    config: { codexModel: "gpt-test" },
  });
  await runTask(configured.layer);
  assert.ok(configured.probe.ui.said.includes("Codex model: gpt-test"), configured.probe.ui.said.slice(0, 3).join(" | "));
  const byDefault = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  await runTask(byDefault.layer);
  assert.ok(byDefault.probe.ui.said.includes("Codex model: the default of the Codex login"));
});

// Plan step 1.5 (decision Q5): the run reports its phases, plan writes and execution outcomes to the Ui.
test("the run notifies the phases, the plan write and the execution outcome in order", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1", resultText: "plan written" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const phaseLevel = new Set(["PhaseBegan", "PhaseEnded", "PlanWritten", "ExecutionEnded", "LoopFinished"]);
  assert.deepEqual(
    probe.ui.notified.filter((e) => phaseLevel.has(e._tag)),
    [
      { _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } },
      { _tag: "PlanWritten", phase: 1, resultText: "plan written" },
      { _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" },
      { _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } },
      { _tag: "ExecutionEnded", phase: 1, outcome: finished },
      { _tag: "PhaseEnded", phase: { kind: "execution", n: 1 }, result: "finished" },
      { _tag: "PhaseBegan", phase: { kind: "work", n: 1 } },
      { _tag: "LoopFinished", subject: { work: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "work", n: 1 }, result: "converged" },
    ],
  );
});

// Issue #6 (F1, F2, G-R1-1, Q3): the plan is the reply; the program writes plan.json and plan.md, notifies the plan,
// and a plan that breaks the id rule gets one validation repair turn.
test("a plan write saves plan.json and plan.md and notifies the plan for its phase; a response replaces both", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "first text" }, { output: respond([["A", "accepted"]]), plan: "second text" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  const recorded = JSON.parse(fs.readFileSync(path.join(probe.dir, "plan.json"), "utf8"));
  assert.deepEqual(recorded, { version: 2, plan: scriptedRecordedPlan("second text") });
  assert.match(fs.readFileSync(path.join(probe.dir, "plan.md"), "utf8"), /second text/);
  const changed = probe.ui.notified.filter((e) => e._tag === "PlanChanged");
  assert.deepEqual(changed.map((e) => (e._tag === "PlanChanged" ? [e.phase, e.plan.stages[0].steps[0].text] : null)), [[1, "first text"], [1, "second text"]]);
  // Issue #53: a plan written by the program names no report of a step.
  assert.ok(changed.every((e) => e._tag === "PlanChanged" && e.step === null));
  // The planner's schema carries the plan (F1).
  assert.ok(probe.planner.schemas.slice(0, 2).every((s) => s === S.PlanWrite || s === S.PlanResponse));
});

test("a plan that breaks the id rule gets one validation repair turn, and a second failure stops the run", async () => {
  const twice = { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "a", text: "a" }, { id: "S1", number: 2, label: "b", text: "b" }] }] };
  const repaired = testLayer(tempRepo(), {
    steps: [{ output: { ...noQuestions, plan: twice } }, { output: noQuestions, plan: "fixed" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(repaired.layer), 1);
  assert.equal(repaired.probe.planner.prompts[1], planRepairPrompt({ duplicateIds: ["S1"], emptyIds: 0, removedDone: [], changedDone: [] }));
  const { layer } = testLayer(tempRepo(), { steps: [{ output: { ...noQuestions, plan: twice } }, { output: { ...noQuestions, plan: twice } }] });
  await runFails(layer, "PlanInvalid", /S1/);
});

test("Codex changing plan.json during its turn stops with ReviewedFileChanged naming plan.json", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], plan: "changed by Codex" }] });
  await runFails(layer, "ReviewedFileChanged", /plan\.json changed during a Codex review/);
});

// Issue #6 (Q2, Q5, G-R1-2): the steps reported during execution, and a started step that the call leaves unfinished.
const planStatuses = (dir: string): Record<string, string> => {
  const file = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  return Object.fromEntries(file.plan.stages.flatMap((s: { steps: { id: string; status: string }[] }) => s.steps.map((st) => [st.id, st.status])));
};
const stopped = { status: "needs_input" as const, summary: "s", question: "A or B?", remainingWork: "w", userInput: "B" };

test("a step started in a stopped execution is unfinished before the work review, remains for the next execution, and a report there belongs to phase 2", async () => {
  const seen: Record<string, string>[] = [];
  let dir = "";
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    // Plan review 1, work review 1 (sees S1 unfinished), plan review 2, work review 2.
    reviews: [{ issues: [] }, { issues: [], onCall: () => seen.push(planStatuses(dir)) }, { issues: [] }, { issues: [] }],
    execs: [stopped, finished],
    execScripts: [{ reports: [["S1", "started"]] }, { onCall: () => seen.push(planStatuses(dir)), reports: [["S1", "started"], ["S1", "done"]] }],
  });
  dir = probe.dir;
  assert.equal(await runTask(layer), 2);
  assert.deepEqual(seen, [{ S1: "unfinished" }, { S1: "unfinished" }]);
  assert.deepEqual(planStatuses(probe.dir), { S1: "done" });
  const changed = probe.ui.notified.flatMap((e) => (e._tag === "PlanChanged" ? [`${e.phase}:${e.plan.stages[0].steps[0].status}`] : []));
  assert.deepEqual(changed, ["1:pending", "1:started", "1:unfinished", "2:unfinished", "2:started", "2:done"]);
});

test("a report naming no step of the plan is answered with an error, changes nothing and the run goes on", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    execScripts: [{ reports: [["S7", "done"], ["S1", "done"]] }],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.planner.stepReplies.map((r) => r.isError), [true, false]);
  assert.deepEqual(planStatuses(probe.dir), { S1: "done" });
});

test("an edit of plan.json and plan.md after the last report does not survive the end of execution", async () => {
  let dir = "";
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    execScripts: [
      {
        reports: [["S1", "done"]],
        after: () => {
          fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ version: 2, plan: scriptedRecordedPlan("edited", "pending") }));
          fs.writeFileSync(path.join(dir, "plan.md"), "edited");
        },
      },
    ],
  });
  dir = probe.dir;
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")).plan, scriptedRecordedPlan("v1", "done"));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "plan.md"), "utf8"), /edited/);
});

test("an interrupted execution leaves its started step unfinished", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execScripts: [{ reports: [["S1", "started"]], hang: true }],
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  for (let i = 0; i < 200 && planStatusesOrNull(probe.dir)?.S1 !== "started"; i++) await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.deepEqual(planStatuses(probe.dir), { S1: "unfinished" });
});
const planStatusesOrNull = (dir: string): Record<string, string> | null => (fs.existsSync(path.join(dir, "plan.json")) ? planStatuses(dir) : null);

// Issue #6 ("the whole run from the start"): the phases known of the run, notified before they begin.
const foreseen = (notified: readonly UiEvent[]): string[] =>
  notified.flatMap((e) => (e._tag === "PhasesForeseen" ? [`foreseen ${e.phases.map((p) => (p.kind === "questions" ? "Q" : `${p.kind[0]}${p.n}`)).join(",")}`] : e._tag === "PhaseBegan" ? [`began ${e.phase.kind === "questions" ? "Q" : `${e.phase.kind[0]}${e.phase.n}`}`] : []));
const everyBeganForeseen = (notified: readonly UiEvent[]): void => {
  const known = new Set<string>();
  for (const e of notified) {
    if (e._tag === "PhasesForeseen") for (const p of e.phases) known.add(JSON.stringify(p));
    if (e._tag === "PhaseBegan") assert.ok(known.has(JSON.stringify(e.phase)), `${JSON.stringify(e.phase)} began unforeseen`);
  }
};

test("a converging run foresees its one iteration at the start, and every foreseen phase begins", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  await runTask(layer);
  assert.deepEqual(foreseen(probe.ui.notified), ["foreseen p1,e1,w1", "began p1", "began e1", "began w1"]);
  everyBeganForeseen(probe.ui.notified);
});

test("a stopped execution foresees the second iteration at once; a work review that revises foresees it after the review", async () => {
  const stop = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stopped, finished],
  });
  await runTask(stop.layer);
  assert.deepEqual(foreseen(stop.probe.ui.notified), ["foreseen p1,e1,w1", "began p1", "began e1", "foreseen p1,e1,w1,p2,e2,w2", "began w1", "began p2", "began e2", "began w2"]);
  everyBeganForeseen(stop.probe.ui.notified);
  const revise = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["W1-R1-1", "accepted"]]) }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  await runTask(revise.layer);
  assert.deepEqual(foreseen(revise.probe.ui.notified), ["foreseen p1,e1,w1", "began p1", "began e1", "began w1", "foreseen p1,e1,w1,p2,e2,w2", "began p2", "began e2", "began w2"]);
});

test("with the question phase configured, Gather Requirements is foreseen first", async () => {
  // The run ends at its first planning call, which is not scripted; what was notified before is what counts.
  const { layer, probe } = testLayer(tempRepo(), { config: { questionPhase: true } });
  await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
  assert.equal(foreseen(probe.ui.notified)[0], "foreseen Q,p1,e1,w1");
});

test("the phase lines carry numbers only once a second iteration is foreseen", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stopped, finished],
  });
  await runTask(layer);
  const lines = probe.ui.said.filter((l) => /^\n?(Planning|Implementation|Code review)( \d)?:/.test(l)).map((l) => l.trim().replace(/:.*/, ""));
  assert.deepEqual(lines, ["Planning", "Implementation", "Code review 1", "Planning 2", "Implementation 2", "Code review 2"]);
});

// Issue #60: the seam of the phase lines. Each line's label is phaseName's, with the count of the phases known
// when it is printed: one iteration for the first Planning and Implementation, two from the first Code review on, since
// the stop has made the second iteration known. A line that writes a phase's name by hand fails whatever the name is.
test("the seam of the phase names: the phase lines open with phaseName's names", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stopped, finished],
  });
  await runTask(layer);
  const known: readonly (readonly [Phase, number])[] = [[{ kind: "planning", n: 1 }, 1], [{ kind: "execution", n: 1 }, 1], [{ kind: "work", n: 1 }, 2], [{ kind: "planning", n: 2 }, 2], [{ kind: "execution", n: 2 }, 2], [{ kind: "work", n: 2 }, 2]];
  const expected = known.map(([phase, iterations]) => phaseName(phase, countOfKind(foreseenPhases("implementation", iterations), phase.kind)));
  const candidates = [1, 2].flatMap((iterations) => foreseenPhases("implementation", 2).map((phase) => phaseName(phase, countOfKind(foreseenPhases("implementation", iterations), phase.kind))));
  const opened = probe.ui.said.map((l) => l.trim()).flatMap((l) => candidates.filter((name) => l.startsWith(`${name}:`)).sort((a, b) => b.length - a.length).slice(0, 1));
  assert.deepEqual(opened, expected);
});

// Issue #26 (S20): an execution call whose retries are exhausted and stopped halts the run with AgentUnreachable; the end
// handling of behavior 4 runs once, so a started step is unfinished in plan.json.
test("an execution that ends in AgentUnreachable halts the run, and a started step is unfinished", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execScripts: [{ reports: [["S1", "started"]], unreachable: true }],
  });
  await runFails(layer, "AgentUnreachable", /Claude Code could not be reached after 4 attempts: read ECONNRESET\. The records are preserved\./);
  const plan = JSON.parse(fs.readFileSync(path.join(probe.dir, "plan.json"), "utf8")).plan;
  assert.equal(plan.stages[0].steps[0].status, "unfinished");
});

// S52 (W5-R1-1): at an execution stop without a question, Claude Code's description is in the details, not the question.
test("a stop without a question presents Claude Code's description in the details", async () => {
  const description = `The migration failed: ${"m".repeat(2500)}`;
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["retry with smaller steps"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "aborted", summary: "", question: description, remainingWork: "", userInput: null }, finished],
  });
  assert.equal(await runTask(layer), 2);
  const [q] = presentedQuestions(probe.ui).filter((p) => p.origin.kind === "execStop");
  assert.equal(piecesText(q.question), prompts.execStopQuestion());
  assert.deepEqual(q.details, prompts.execStopDetails(description));
});

// Issue #112: the exception is narrow. On the plan, an issue raised again after a partial acceptance is still put to
// the user, as behavior 7 has it.
test("issue #112: on the plan, an issue raised again after a partial acceptance is still put to the user", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep it"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "partially_accepted"]]), plan: "v2" },
      { output: respond([["A", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 1);
  assert.match(presentedSubjects(probe.ui)[0], /issue A, raised again/);
  assert.doesNotMatch(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), new RegExp(prompts.WORDING_DISPUTE_HEADING));
});
