import assert from "node:assert/strict";
import { test } from "node:test";
import { countOfKind, describeEvent, foreseenPhases, phaseName, type UiEvent } from "../src/uiEvents.ts";
import { para, plain } from "./helpers.ts";
import * as prompts from "../src/prompts.ts";

const review = { issues: [] };
const response = { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
const outcome = { status: "finished" as const, summary: "done", question: "", remainingWork: "", userInput: null };

// One example of every variant; the `satisfies` makes a missing tag a type error when the union grows.
/** The heading the page shows above the conversation (issue #113), and the same text as a pattern. */
const heading = prompts.clarificationHeading("clarification");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headed = (rest: string) => new RegExp(escapeRegExp(heading) + rest);

const examples: { [K in UiEvent["_tag"]]: [Extract<UiEvent, { _tag: K }>, RegExp] } = {
  PhaseBegan: [{ _tag: "PhaseBegan", phase: { kind: "planning", n: 2 } }, /Planning 2 began/],
  PhaseEnded: [{ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "done" }, /Gather Requirements ended: done/],
  RoundBegan: [{ _tag: "RoundBegan", subject: { plan: 1 }, round: 3, limit: 10 }, /planning-1, cycle 3$/],
  ReviewReceived: [{ _tag: "ReviewReceived", subject: "questions", round: 1, review, counted: 0 }, /review of question-review, round 1: 0 issues, 0 counted/],
  ResponseReceived: [{ _tag: "ResponseReceived", subject: "requirements", round: 2, response, resultText: "" }, /response in requirements-review, round 2/],
  LoopFinished: [{ _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" }, /planning-1 finished: converged/],
  AnalysisProgress: [{ _tag: "AnalysisProgress", decision: 2, question: 7, check: 1 }, /^decision 2, check 1$/],
  PlanWritten: [{ _tag: "PlanWritten", phase: 1, resultText: "" }, /plan written in phase 1$/],
  ExecutionEnded: [{ _tag: "ExecutionEnded", phase: 1, outcome }, /execution 1 ended: finished/],
  AgentCallStarted: [{ _tag: "AgentCallStarted", agent: "codex", purpose: "review" }, /Codex call started: review/],
  ToolUsed: [{ _tag: "ToolUsed", agent: "claude", tool: "Read", target: "src/run.ts" }, /Claude Code used Read src\/run\.ts/],
  AgentCallEnded: [{ _tag: "AgentCallEnded", agent: "claude", ok: false }, /Claude Code call ended: failed/],
  AgentReconnecting: [{ _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: 2, of: 10, delayMs: 1500, detail: "status 503" }, /Claude Code: reconnecting 2 of 10 in 1\.5 s \(status 503\)/],
  TransportRetrying: [{ _tag: "TransportRetrying", agent: "codex", attempt: 2, of: 3, delaySeconds: 10, fault: "stream disconnected", fromMs: 0, untilMs: 10_000 }, /Codex: connection lost, retry 2 of 3 in 10 s \(stream disconnected\)/],
  TransportRecovered: [{ _tag: "TransportRecovered", agent: "claude" }, /Claude Code: connection restored/],
  UsageLimitWaiting: [{ _tag: "UsageLimitWaiting", agent: "claude", limitType: "five_hour", fromMs: 0, untilMs: 9_000_000 }, /^Claude Code: five-hour session limit reached; Interloq waits until 1970-01-01 02:30 UTC, then continues$/],
  UsageLimitLifted: [{ _tag: "UsageLimitLifted", agent: "claude", waitedMs: 9_000_000 }, /^Claude Code: the usage limit has lifted after 2:30:00; continuing$/],
  InterviewTurn: [{ _tag: "InterviewTurn", heading, message: "Hello", summary: null, answered: 1, total: 3 }, headed(" \\(1 of 3 answered\\): Hello")],
  InterviewOpened: [{ _tag: "InterviewOpened", heading, stage: "clarification", total: 3 }, headed(" opened, 3 questions")],
  ClaudeSaid: [{ _tag: "ClaudeSaid", text: "done" }, /Claude Code said: done/],
  QuestionPresented: [
    { _tag: "QuestionPresented", question: { number: 3, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Which?"), options: [{ label: plain("A"), description: [], answer: { token: "1" } }, { label: plain("B"), description: [], answer: { token: "2" } }], details: [], decision: null } },
    /question 3: Which\? \(2 options\)/,
  ],
  DecisionAnalyzed: [{ _tag: "DecisionAnalyzed", decision: 2, question: "Which?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details: [], decision: null }, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } }, /decision 2 analyzed: Which\? \(0 columns\)/],
  AnswerRejected: [{ _tag: "AnswerRejected" }, /answer rejected, asked again/],
  PhasesForeseen: [{ _tag: "PhasesForeseen", phases: [{ kind: "planning", n: 1 }, { kind: "execution", n: 1 }] }, /phases foreseen: Planning 1, Implementation 1/],
  PlanChanged: [{ _tag: "PlanChanged", phase: 2, plan: { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "", status: "done" }, { id: "S2", number: 2, label: "l", text: "", status: "started" }] }] }, step: null }, /plan of phase 2 changed: 1 of 2 steps done/],
};

for (const [tag, [event, expected]] of Object.entries(examples)) {
  test(`describeEvent describes ${tag}`, () => {
    assert.match(describeEvent(event), expected);
  });
}

// Issue #14: the phases are named for what they do; "Question phase" and "Execution" are gone from the labels.
test("phaseName names the phases as the page shows them", () => {
  assert.equal(phaseName({ kind: "questions" }, 1), "Gather Requirements");
  assert.equal(phaseName({ kind: "planning", n: 1 }, 1), "Planning");
  assert.equal(phaseName({ kind: "planning", n: 1 }, 2), "Planning 1");
  assert.equal(phaseName({ kind: "execution", n: 2 }, 2), "Implementation 2");
  assert.equal(phaseName({ kind: "work", n: 3 }, 3), "Code review 3");
  // Issue #6: the count of a kind among the known phases.
  const phases = foreseenPhases(true, 2);
  assert.deepEqual([countOfKind(phases, "questions"), countOfKind(phases, "planning"), countOfKind(phases.slice(0, 4), "work")], [1, 2, 1]);
});

// Issue #6: the run's shape, known from the start, and each further iteration as soon as it is known.
test("foreseenPhases lists Gather Requirements when configured, then Planning, Implementation and Code review per iteration", () => {
  assert.deepEqual(foreseenPhases(true, 1), [{ kind: "questions" }, { kind: "planning", n: 1 }, { kind: "execution", n: 1 }, { kind: "work", n: 1 }]);
  assert.deepEqual(foreseenPhases(false, 2), [1, 2].flatMap((n) => [{ kind: "planning", n }, { kind: "execution", n }, { kind: "work", n }]));
});
