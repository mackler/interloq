import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { pauseProse } from "../src/render.ts";
import { blocksMarkdown } from "../src/pieces.ts";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, subjectOf, type Transition } from "../src/reviewState.ts";
import type { LogEntry } from "../src/schema.ts";
import { issue, respond, questionOf } from "./helpers.ts";
import * as prompts from "../src/prompts.ts";
import { piecesText } from "../src/pieces.ts";

/** What the user reads of a pause the loop asks (S11): its facts as prose. */
const askedProse = (c: ReviewCommand): string => (c.kind === "AskDecision" && c.asks.kind === "pause" ? blocksMarkdown(pauseProse(c.asks.facts)) : "");
/** The record's subject of a decision the loop asks (S7): composed from what it asks by the one function. */
const askedSubject = (c: ReviewCommand, state: ReviewState): string => {
  assert.equal(c.kind, "AskDecision");
  return c.kind === "AskDecision" ? subjectOf(state.setup.heading, c.asks) : "";
};

// Finding 13 (and 14, 15) of docs/functional-design-review.md; decision Q7: the review loop as a pure
// state machine. The scenario tests of test/run.test.ts remain the behavioural specification; these
// examples pin each transition.

const setup: ReviewSetup = { subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, idNumber: 1, proceed: "proceed to execution with the plan as it is", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, onUnchanged: null, disputesSettledBy: "user", maxRounds: 5, maxIdleRounds: 2, countMinor: true };
const start = (config: Partial<{ maxRounds: number; maxIdleRounds: number; countMinor: boolean }> = {}, log: LogEntry[] = []): Transition =>
  advance(initialState(setup, { maxRounds: 5, maxIdleRounds: 2, countMinor: true, ...config }), { kind: "Begin", hash: "h0", text: "", log });
// Notify commands are pinned by their own tests below; the sequences of the other commands ignore them.
const kinds = (t: Transition): string[] => t.commands.filter((c) => c.kind !== "Notify").map((c) => c.kind);
const last = (t: Transition): ReviewCommand => t.commands[t.commands.length - 1];
const says = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Say" ? [c.text] : [])).join("\n");
const halt = (t: Transition): RunError => {
  const c = last(t);
  assert.equal(c.kind, "Halt", `expected Halt, got ${kinds(t).join(",")}`);
  return (c as { error: RunError }).error;
};
/** Applies the events in order, returning the last transition. */
const run = (first: Transition, ...events: ReviewEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const noQuestions = { questions_for_user: [] };
const entry = (id: string, action: string, round = 1): LogEntry =>
  ({ id, phase: 1, round, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action, rationale: "r", duplicate_of: null, reverses: null, superseded: false }) as LogEntry;
const response = (dispositions: [string, "accepted" | "rejected" | "partially_accepted" | "no_change_needed" | "clarification_requested"][], extra = {}): ReviewEvent => ({ kind: "ResponseDecoded", response: respond(dispositions, extra), resultText: "", costUsd: 0.1 });
void noQuestions;

test("Begin: round 1 starts with the Codex review and the initial observation is recorded", () => {
  const t = start();
  assert.match(says(t), /^\nPlanning phase 1, cycle 1: Codex review \.\.\.$/m);
  assert.doesNotMatch(says(t), /limit|round/);
  assert.deepEqual(last(t), { kind: "CallReviewer", round: 1 });
  assert.deepEqual(t.state.observations, [{ round: 0, stage: "start", hash: "h0" }]);
  assert.equal(t.state.round, 1);
});

test("a review with no counted issue converges; with countMinor off, minor issues do not count", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.deepEqual(kinds(t).slice(-3), ["Converse", "Checkpoint", "Finish"]);
  assert.deepEqual(last(t), { kind: "Finish", result: "converged" });
  assert.deepEqual(t.state.counts, [0]);
  const minor = run(start({ countMinor: false }), { kind: "ReviewDecoded", review: { issues: [{ ...issue("A"), severity: "minor" }] } });
  assert.deepEqual(last(minor), { kind: "Finish", result: "converged" });
});

test("a review with duplicate ids halts before anything is counted", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("A")] } });
  assert.equal(halt(t)._tag, "RoundInvalid");
  assert.deepEqual(t.state.counts, []);
});

test("a counted review saves the review, reports the count, and asks about each reraised id before the response", () => {
  const t = run(start({}, [entry("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.ok(kinds(t).includes("SaveReview"));
  assert.match(says(t), /Issues: 2 total, 2 counted/);
  assert.match(askedProse(last(t)), /raised issue A again/);
  assert.deepEqual(last(t), {
    kind: "AskDecision",
    asks: { kind: "pause", facts: { pause: "reraised", id: "A", history: [entry("A", "rejected")], issue: issue("A") } },
    id: "A",
    options: [{ label: prompts.REVIEWER_POSITION, description: "p e" }, { label: prompts.PLANNER_POSITION, description: "r" }],
  });
  assert.equal(askedSubject(last(t), t.state), "issue A, raised again after Claude Code did not accept it in full");
  const kept = advance(t.state, { kind: "DecisionGiven", text: "keep the rejection" });
  assert.equal(kept.commands[0].kind, "RecordDecision");
  assert.deepEqual(last(kept), { kind: "CallPlanner", round: 1 });
  const silent = advance(t.state, { kind: "DecisionGiven", text: "" });
  assert.ok(!kinds(silent).includes("RecordDecision"));
  assert.deepEqual(last(silent), { kind: "CallPlanner", round: 1 });
});

const afterReview = (log: LogEntry[] = [], issues = [issue("A")]): Transition => run(start({}, log), { kind: "ReviewDecoded", review: { issues } });

test("an invalid response halts; a valid one is saved, rendered, and the round goes to the log and the file is observed", () => {
  const invalid = run(afterReview(), response([["A", "accepted"], ["A", "rejected"]]));
  assert.equal(halt(invalid)._tag, "RoundInvalid");
  const valid = run(afterReview(), response([["A", "accepted"]]));
  assert.deepEqual(kinds(valid).filter((k) => k !== "Say"), ["SaveResponse", "SaveRound", "Converse", "Checkpoint", "SaveLog", "Checkpoint", "ObserveFile"]);
  assert.deepEqual(last(valid), { kind: "ObserveFile", stage: "response" });
  assert.equal(valid.state.log.length, 1);
  assert.equal(valid.state.log[0].action, "accepted");
  assert.deepEqual(valid.state.costs, [0.1]);
});

test("reviewer feedback is recorded, and a dropped reference is noted", () => {
  const t = run(afterReview([entry("Z", "rejected")]), response([["A", "rejected"]], { reviewer_feedback: "too strict" }));
  assert.ok(t.commands.some((c) => c.kind === "RecordFeedback" && c.text === "too strict"));
  const withRef = { kind: "ResponseDecoded", response: { ...respond([["A", "rejected"]]), dispositions: [{ ...respond([["A", "rejected"]]).dispositions[0], reverses: "Q" }] }, resultText: "", costUsd: null } as const;
  const noted = run(afterReview(), withRef);
  assert.ok(noted.commands.some((c) => c.kind === "Converse" && /Reference dropped/.test(c.markdown)));
});

// Behavior 7 as amended for issue #30: the condition is a pause, and its Stop halts with AcceptedWithoutChange.
test("accepted without a change of the file is the pause; Stop halts", () => {
  const paused = run(afterReview(), response([["A", "accepted"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.equal(last(paused).kind, "AskUnchanged");
  const t = advance(paused.state, { kind: "UnchangedAnswer", answer: "stop" });
  const error = halt(t);
  assert.equal(error._tag, "AcceptedWithoutChange");
  assert.match(describe(error), /plan\.md is unchanged/);
});

test("the pauses ask in the decided order and a decision leads to ApplyDecisions before the log", () => {
  const log = [entry("C", "accepted"), entry("O", "rejected")];
  const dispositions = respond([["A", "clarification_requested"], ["B", "rejected"], ["N", "rejected"]]).dispositions.map((d) => (d.id === "B" ? { ...d, reverses: "C" } : d.id === "N" ? { ...d, duplicate_of: "O" } : d));
  const resp = { ...respond([]), dispositions, self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "x" }], questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] };
  const t = run(afterReview([...log, entry("A", "clarification_requested")], [issue("A"), issue("B"), issue("N")]), { kind: "ResponseDecoded", response: resp, resultText: "", costUsd: null });
  const subjects: string[] = [];
  let step = t;
  while (last(step).kind === "AskDecision") {
    subjects.push(askedSubject(last(step), step.state));
    step = advance(step.state, { kind: "DecisionGiven", text: subjects.length === 1 ? "answer" : "" });
  }
  assert.deepEqual(subjects.map((s) => s.split(",")[0].split(" against")[0]), ["issue A", "the accepted correction for C", "issue B", "issue N", "question from Claude Code: Which?"]);
  assert.deepEqual(last(step), { kind: "ApplyDecisions" });
  const applied = advance(step.state, { kind: "DecisionsApplied" });
  assert.deepEqual(kinds(applied), ["SaveLog", "Checkpoint", "ObserveFile"]);
  assert.equal(applied.state.log.filter((e) => e.action === "decided_by_user").length, 1);
});

test("an unexplained change asks; no decision leads on, a decision applies and observes again", () => {
  const t = run(afterReview(), response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" });
  assert.match(askedProse(last(t)), /changed in cycle 1 although Claude Code accepted no issue/);
  assert.match(askedSubject(last(t), t.state), /^the unexplained change to plan\.md in Planning phase 1, cycle 1$/);
  assert.equal(last(t).kind, "AskDecision");
  const onward = advance(t.state, { kind: "DecisionGiven", text: "" });
  assert.deepEqual(last(onward), { kind: "CallReviewer", round: 2 });
  assert.deepEqual(onward.state.observations.at(-1), { round: 1, stage: "response", hash: "h1" });
  assert.equal(onward.state.idle, 1);
  const applying = advance(t.state, { kind: "DecisionGiven", text: "fix it" });
  assert.deepEqual(last(applying), { kind: "ApplyDecisions" });
  const observing = advance(applying.state, { kind: "DecisionsApplied" });
  assert.deepEqual(last(observing), { kind: "ObserveFile", stage: "decision" });
  const done = advance(observing.state, { kind: "FileObserved", hash: "h2", text: "" });
  assert.deepEqual(done.state.observations.at(-1), { round: 1, stage: "decision", hash: "h2" });
});

test("identical content names the round after which it was seen, with the decision stage", () => {
  const t = run(afterReview(), response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" }, { kind: "DecisionGiven", text: "" });
  const round2 = run(t, { kind: "ReviewDecoded", review: { issues: [issue("B")] } }, response([["B", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" }, { kind: "DecisionGiven", text: "" });
  assert.match(askedProse(last(round2)), /after cycle 2 is identical to plan\.md after cycle 0 \(cycle 0 is the state at the start\)/);
  assert.equal(last(round2).kind, "AskDecision");
});

test("idle rounds: the prompt after maxIdleRounds, a decision applies and is observed as a decision stage, and the counter resets", () => {
  const t = run(afterReview(), { kind: "ResponseDecoded", response: respond([["A", "rejected"]]), resultText: "", costUsd: null }, { kind: "FileObserved", hash: "h0", text: "" });
  const idle = run(start({ maxIdleRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.match(askedProse(last(idle)), /accepted no issue in the last cycle\.\n\nThe issues of the last cycle that led to no change:\n\n- In cycle 1, Codex raised it: p — Claude Code rejected it: rationale A$/);
  assert.equal(askedSubject(last(idle), idle.state), "the issues of the last 1 cycles that produced no amendment");
  assert.equal(last(idle).kind, "AskDecision");
  const applied = run(idle, { kind: "DecisionGiven", text: "apply" }, { kind: "DecisionsApplied" });
  assert.deepEqual(last(applied), { kind: "ObserveFile", stage: "decision" });
  const next = advance(applied.state, { kind: "FileObserved", hash: "h5", text: "" });
  assert.deepEqual(next.state.observations.at(-1), { round: 1, stage: "decision", hash: "h5" });
  assert.equal(next.state.idle, 0);
  assert.deepEqual(last(next), { kind: "CallReviewer", round: 2 });
  assert.equal(t.state.idle, 1);
});

test("the round limit: proceed, stop, or more rounds", () => {
  const atLimit = run(start({ maxRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.deepEqual(last(atLimit), { kind: "AskLimit", limit: 1 });
  assert.match(says(atLimit), /per cycle of Planning phase 1:\n  cycle 1: counted issues = 1, total_cost_usd = 0.1/);
  const proceed = advance(atLimit.state, { kind: "LimitAnswer", answer: "p" });
  assert.deepEqual(last(proceed), { kind: "Finish", result: "proceed" });
  assert.ok(proceed.commands.some((c) => c.kind === "Converse" && /without convergence after round 1/.test(c.markdown)));
  assert.equal(halt(advance(atLimit.state, { kind: "LimitAnswer", answer: "0" }))._tag, "RoundLimitStop");
  const more = advance(atLimit.state, { kind: "LimitAnswer", answer: "3" });
  assert.equal(more.state.limit, 4);
  assert.deepEqual(last(more), { kind: "CallReviewer", round: 2 });
});

test("amend runs between the pauses and the log when the subject has one", () => {
  const withAmend = advance(initialState({ ...setup, hasAmend: true }, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log: [] });
  const t = run(withAmend, { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]));
  assert.deepEqual(last(t), { kind: "Amend", round: 1 });
  const amended = advance(t.state, { kind: "Amended" });
  assert.deepEqual(kinds(amended), ["SaveLog", "Checkpoint", "ObserveFile"]);
});

test("every batch has at most one event-producing command, and it is the last", () => {
  const producing = new Set(["AskLimit", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
  const check = (t: Transition): void => {
    const positions = t.commands.flatMap((c, i) => (producing.has(c.kind) ? [i] : []));
    assert.ok(positions.length <= 1 && (positions.length === 0 || positions[0] === t.commands.length - 1), kinds(t).join(","));
  };
  let t = start({ maxIdleRounds: 1 });
  check(t);
  for (const e of [{ kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" }, { kind: "DecisionGiven", text: "" }, { kind: "DecisionGiven", text: "" }] as ReviewEvent[]) {
    t = advance(t.state, e);
    check(t);
  }
  const state: ReviewState = t.state;
  assert.equal(state.round, 2);
});

// Q5: the round record is written from the validated values: no_response with the review, validated with the response.
test("the round record is saved as no_response after the review and as validated after the response", () => {
  const rounds = (t: Transition) => t.commands.flatMap((c) => (c.kind === "SaveRound" ? [c.record] : []));
  const afterReviewT = afterReview();
  const [noResponse] = rounds(afterReviewT);
  assert.equal(noResponse?.kind, "no_response");
  assert.deepEqual([noResponse?.subject, noResponse?.phase, noResponse?.round, noResponse?.reconstructed], ["planning-1", 1, 1, false]);
  const converged = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.equal(rounds(converged)[0]?.kind, "no_response");
  const [validated] = rounds(run(afterReviewT, response([["A", "accepted"]])));
  assert.equal(validated?.kind, "validated");
  if (validated?.kind !== "validated") return;
  assert.deepEqual(validated.response.dispositions.map((d) => [d.id, d.action]), [["A", "accepted"]]);
  assert.deepEqual(validated.review.issues.map((i) => i.id), ["A"]);
  assert.equal(validated.reconstructed, false);
});

// Q6: a checkpoint follows the records of each transition, after the last record of the batch.
test("a checkpoint follows the records of each transition: reviewed, responded, logged, decided", () => {
  const points = (t: Transition) => t.commands.flatMap((c) => (c.kind === "Checkpoint" ? [c.point] : []));
  const reviewed = afterReview();
  assert.deepEqual(points(reviewed), [{ subject: "planning-1", phase: 1, round: 1, stage: "reviewed" }]);
  assert.ok(kinds(reviewed).indexOf("Checkpoint") > kinds(reviewed).indexOf("SaveRound"));
  const converged = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.deepEqual(kinds(converged).filter((k) => k !== "Say"), ["SaveReview", "SaveRound", "Converse", "Checkpoint", "Finish"]);
  const responded = run(reviewed, response([["A", "accepted"]]));
  assert.deepEqual(kinds(responded).filter((k) => k !== "Say"), ["SaveResponse", "SaveRound", "Converse", "Checkpoint", "SaveLog", "Checkpoint", "ObserveFile"]);
  assert.deepEqual(points(responded).map((p) => p.stage), ["responded", "logged"]);
  const asked = afterReview([entry("A", "rejected")]);
  const decided = advance(asked.state, { kind: "DecisionGiven", text: "keep it" });
  assert.deepEqual(kinds(decided).slice(0, 2), ["RecordDecision", "Checkpoint"]);
  assert.deepEqual(points(decided), [{ subject: "planning-1", phase: 1, round: 1, stage: "decided" }]);
});

// Plan step 1.4 (decision Q5): the loop reports its progress to the Ui through Notify commands.
const notified = (t: Transition): string[] => t.commands.flatMap((c) => (c.kind === "Notify" ? [c.event._tag] : []));
const indexOf = (t: Transition, pred: (c: ReviewCommand) => boolean): number => t.commands.findIndex(pred);

test("Notify: a round begins with RoundBegan before its Say", () => {
  const t = start();
  const at = indexOf(t, (c) => c.kind === "Notify" && c.event._tag === "RoundBegan");
  assert.ok(at >= 0, "no Notify command in the transition");
  assert.deepEqual((t.commands[at] as Extract<ReviewCommand, { kind: "Notify" }>).event, { _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 });
  assert.ok(at < indexOf(t, (c) => c.kind === "Say"));
});

test("Notify: a review is reported after its round record, and convergence finishes the loop", () => {
  const counted = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } });
  const at = indexOf(counted, (c) => c.kind === "Notify" && c.event._tag === "ReviewReceived");
  assert.ok(at > indexOf(counted, (c) => c.kind === "SaveRound"), "no Notify command in the transition after SaveRound");
  assert.equal((counted.commands[at] as Extract<ReviewCommand, { kind: "Notify" }>).event._tag === "ReviewReceived" && (counted.commands[at] as { event: { counted: number } }).event.counted, 1);
  const converged = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.deepEqual(notified(converged), ["ReviewReceived", "LoopFinished"]);
  assert.ok(indexOf(converged, (c) => c.kind === "Notify" && c.event._tag === "LoopFinished") < indexOf(converged, (c) => c.kind === "Finish"));
});

test("Notify: a response is reported after its round record", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]));
  const at = indexOf(t, (c) => c.kind === "Notify" && c.event._tag === "ResponseReceived");
  assert.ok(at > indexOf(t, (c) => c.kind === "SaveRound"), "no Notify command in the transition after SaveRound");
});

test("Notify: proceeding at the round limit finishes the loop with proceed", () => {
  const atLimit = run(start({ maxRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  const proceed = advance(atLimit.state, { kind: "LimitAnswer", answer: "p" });
  assert.deepEqual(
    proceed.commands.filter((c) => c.kind === "Notify").map((c) => (c as { event: unknown }).event),
    [{ _tag: "LoopFinished", subject: { plan: 1 }, result: "proceed" }],
  );
});

// Plan step 2.4: the policies of a work review (Q13, Q14, G-R1-1; P1-R1-1 of the earlier run, P1-R1-1 of this one).
const workSetup: ReviewSetup = { ...setup, subject: { work: 1 }, heading: "Work review 1", fileLabel: "changes.diff", dirName: "work-review-1", proceed: null, leaveOnAcceptance: true, leaveOnDecision: true };
const workStart = (config: Partial<{ maxRounds: number; maxIdleRounds: number }> = {}, log: LogEntry[] = []): Transition =>
  advance(initialState(workSetup, { maxRounds: 5, maxIdleRounds: 2, countMinor: true, ...config }), { kind: "Begin", hash: "h0", text: "", log });
const allKinds = (t: Transition): string[] => t.commands.map((c) => (c.kind === "Notify" ? `Notify:${c.event._tag}` : c.kind === "Checkpoint" ? `Checkpoint:${c.point.stage}` : c.kind));
const savedLog = (t: Transition): readonly LogEntry[] => {
  const saves = t.commands.filter((c) => c.kind === "SaveLog");
  assert.equal(saves.length, 1, `expected one SaveLog, got ${allKinds(t).join(",")}`);
  return (saves[0] as { log: readonly LogEntry[] }).log;
};
const revised = (t: Transition): void => {
  assert.deepEqual(allKinds(t).slice(-2), ["Notify:LoopFinished", "Finish"]);
  assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
};

test("work review: without a proceed choice, p at the round limit is a stop", () => {
  const atLimit = run(workStart({ maxRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.deepEqual(last(atLimit), { kind: "AskLimit", limit: 1 });
  assert.equal(halt(advance(atLimit.state, { kind: "LimitAnswer", answer: "p" }))._tag, "RoundLimitStop");
});

test("work review: an accepted issue ends the loop with revise after the log and the logged checkpoint, without an observation", () => {
  const t = run(workStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]));
  assert.deepEqual(allKinds(t).slice(-4), ["SaveLog", "Checkpoint:logged", "Notify:LoopFinished", "Finish"]);
  assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
  assert.ok(!kinds(t).includes("ObserveFile"));
});

test("work review: an effective accepted self-correction ends the loop with revise; the plan subject continues", () => {
  const self = { self_corrections: [{ id: "W1-R0-1", new_action: "accepted" as const, explanation: "earlier issue is valid" }] };
  const work = run(workStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]], self));
  assert.deepEqual(last(work), { kind: "Finish", result: "revise" });
  const plan = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]], self));
  assert.equal(last(plan).kind, "ObserveFile");
});

test("work review exit (i): a decision at a pause after the response logs the round once with the decision, then checkpoint logged", () => {
  const log = [entry("A", "clarification_requested")];
  const asked = run(workStart({}, log), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "clarification_requested"]]));
  assert.equal(last(asked).kind, "AskDecision");
  const t = advance(asked.state, { kind: "DecisionGiven", text: "act on it" });
  assert.deepEqual(allKinds(t), ["RecordDecision", "Checkpoint:decided", "SaveLog", "Checkpoint:logged", "Notify:LoopFinished", "Finish"]);
  revised(t);
  const saved = savedLog(t);
  // The earlier entry, the round's one entry, and the decision: the round is appended once.
  assert.equal(saved.length, log.length + 2, "the round's entry is not in the log exactly once");
  assert.equal(saved.at(-1)?.action, "decided_by_user");
});

test("work review exit (ii): a decision at the idle, unexplained-change or identical-content pause appends nothing and ends after checkpoint decided", () => {
  const idleAsk = run(workStart({ maxIdleRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  const unexplainedAsk = run(workStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" });
  const identicalAsk = run(
    workStart({ maxIdleRounds: 5 }),
    { kind: "ReviewDecoded", review: { issues: [issue("A")] } },
    response([["A", "rejected"]]),
    { kind: "FileObserved", hash: "h1", text: "" },
    { kind: "DecisionGiven", text: "" },
    { kind: "ReviewDecoded", review: { issues: [issue("B")] } },
    response([["B", "rejected"]]),
    { kind: "FileObserved", hash: "h0", text: "" },
    { kind: "DecisionGiven", text: "" },
  );
  for (const [asked, step] of [[idleAsk, "askingIdle"], [unexplainedAsk, "askingUnexplained"], [identicalAsk, "askingIdentical"]] as const) {
    assert.equal(asked.state.step.name, step);
    const t = advance(asked.state, { kind: "DecisionGiven", text: "act on it" });
    assert.deepEqual(allKinds(t), ["RecordDecision", "Checkpoint:decided", "Notify:LoopFinished", "Finish"], step);
    revised(t);
    assert.deepEqual(t.state.log, asked.state.log, `${step}: the log changed`);
  }
});

test("work review exit (iii): a decision on a reraised issue appends only the decision and writes a second decided checkpoint", () => {
  const log = [entry("A", "rejected")];
  const asked = run(workStart({}, log), { kind: "ReviewDecoded", review: { issues: [issue("A")] } });
  assert.equal(asked.state.step.name, "askingReraised");
  const t = advance(asked.state, { kind: "DecisionGiven", text: "act on it" });
  assert.deepEqual(allKinds(t), ["RecordDecision", "Checkpoint:decided", "SaveLog", "Checkpoint:decided", "Notify:LoopFinished", "Finish"]);
  revised(t);
  const saved = savedLog(t);
  assert.equal(saved.length, log.length + 1);
  assert.deepEqual([saved.at(-1)?.id, saved.at(-1)?.action], ["A", "decided_by_user"]);
});

test("work review: an empty answer continues the loop as for the plan", () => {
  const idleAsk = run(workStart({ maxIdleRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.deepEqual(last(advance(idleAsk.state, { kind: "DecisionGiven", text: "" })), { kind: "CallReviewer", round: 2 });
});

// Decision support, plan step 1.3 (P1-R1-1): decision 2 inside phase 1 generates D2-… ids, and its log entries carry phase 1.
test("a decision subject generates ids with its decision number and records the enclosing phase in its log", () => {
  const decision: ReviewSetup = { ...setup, subject: { decision: 2 }, heading: "Decision 2", fileLabel: "analysis.json", dirName: "decision-2", phase: 1, idNumber: 2 };
  const first = advance(initialState(decision, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log: [] });
  const t = run(first, { kind: "ReviewDecoded", review: { issues: [issue("D2-R1-1")] } }, { kind: "ResponseDecoded", response: respond([["D2-R1-1", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }] }), resultText: "", costUsd: null });
  const saved = t.commands.find((c) => c.kind === "SaveLog");
  assert.ok(saved !== undefined && saved.kind === "SaveLog");
  assert.deepEqual(saved.log.map((e) => [e.id, e.phase]), [["D2-R1-1", 1], ["D2-S1-1", 1]]);
  // The plan subject is unchanged: its id number is its phase.
  const plan = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, { kind: "ResponseDecoded", response: respond([["A", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }] }), resultText: "", costUsd: null });
  const planLog = plan.commands.find((c) => c.kind === "SaveLog");
  assert.ok(planLog !== undefined && planLog.kind === "SaveLog");
  assert.deepEqual(planLog.log.map((e) => e.id), ["A", "P1-S1-1"]);
});

// Decision support, plan step 3.5 (decision Q1): the disputed pauses offer the reviewer's and the planner's positions,
// a question of Claude Code offers its own options, and the other pauses offer none.
const optionsOf = (t: Transition) => {
  const c = last(t);
  assert.equal(c.kind, "AskDecision");
  return (c as { options: readonly { label: string; description: string }[] }).options;
};
test("each disputed pause offers the two positions; a question offers its options; the other pauses none", () => {
  const log = [entry("C", "accepted"), entry("O", "rejected"), entry("A", "clarification_requested")];
  const issues = [{ ...issue("A"), problem: "A is unclear", evidence: "see s" }, { ...issue("B"), problem: "undo C" }, { ...issue("N"), problem: "O again" }];
  const dispositions = [
    { id: "A", action: "clarification_requested" as const, rationale: "what do you mean by A?", duplicate_of: "", reverses: "" },
    { id: "B", action: "rejected" as const, rationale: "C must stay", duplicate_of: "", reverses: "C" },
    { id: "N", action: "rejected" as const, rationale: "as before", duplicate_of: "O", reverses: "" },
  ];
  const question = questionOf({ context: "c", question: "Which?", terms: [], options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }] });
  const resp = { ...respond([]), dispositions, self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "C was wrong" }], questions_for_user: [question] };
  let step = run(afterReview(log.map((e) => (e.id === "O" ? { ...e, rationale: "O is fine" } : e.id === "C" ? { ...e, problem: "C was missing" } : e)), issues), { kind: "ResponseDecoded", response: resp, resultText: "", costUsd: null });
  const seen: (readonly { label: string; description: string }[])[] = [];
  while (last(step).kind === "AskDecision") {
    seen.push(optionsOf(step));
    step = advance(step.state, { kind: "DecisionGiven", text: "" });
  }
  const positions = (reviewer: string, planner: string) => [{ label: prompts.REVIEWER_POSITION, description: reviewer }, { label: prompts.PLANNER_POSITION, description: planner }];
  assert.deepEqual(seen, [
    positions("A is unclear see s", "what do you mean by A?"),
    positions("C was missing", "C was wrong"),
    positions("undo C e", "C must stay"),
    positions("O again e", "O is fine"),
    question.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) })),
  ]);
  // The unexplained change, identical content and the idle pause.
  const unexplained = run(afterReview(), response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" });
  assert.deepEqual(optionsOf(unexplained), []);
  const idle = run(start({ maxIdleRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0", text: "" });
  assert.deepEqual(optionsOf(idle), []);
});

// Issue #31 (plan step S6): a measured subject observes the reviewed file before it logs the round; the log's
// file_change and the guard's hash comparison both derive from that one observation.
const measured: ReviewSetup = { ...setup, onUnchanged: "corrective" };
const measuredStart = (text: string): Transition =>
  advance(initialState(measured, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text, log: [] });
const loggedBy = (t: Transition): readonly LogEntry[] => {
  const save = t.commands.find((c) => c.kind === "SaveLog");
  assert.ok(save !== undefined, `no SaveLog in ${kinds(t).join(",")}`);
  return (save as { log: readonly LogEntry[] }).log;
};
const changeOf = (e: LogEntry | undefined): unknown => (e !== undefined && "file_change" in e ? e.file_change : undefined);

test("a measured subject observes the file before it logs, and the log's file_change agrees with the guard's comparison", () => {
  const responded = run(measuredStart("a\n"), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]));
  assert.deepEqual(last(responded), { kind: "ObserveFile", stage: "response" });
  assert.equal(kinds(responded).includes("SaveLog"), false, "the round was logged before its observation");
  const cases: [string, string, string][] = [
    ["h1", "a\nb\n", "changed"],
    ["h0", "a\n", "unchanged"],
  ];
  for (const [hash, text, what] of cases) {
    const t = advance(responded.state, { kind: "FileObserved", hash, text });
    const e = loggedBy(t)[0];
    assert.equal((changeOf(e) as { changed: boolean }).changed, hash !== "h0", what);
  }
  const changed = loggedBy(advance(responded.state, { kind: "FileObserved", hash: "h1", text: "a\nb\n" }));
  assert.deepEqual(changeOf(changed[0]), { changed: true, added: 1, removed: 0 });
});

test("a file that returns to an earlier content is measured as changed, and the identical-content pause follows", () => {
  const round1 = run(measuredStart("a\n"), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), { kind: "FileObserved", hash: "h1", text: "b\n" });
  const round2 = run(round1, { kind: "ReviewDecoded", review: { issues: [issue("B")] } }, response([["B", "accepted"]]), { kind: "FileObserved", hash: "h0", text: "a\n" });
  const e = loggedBy(round2).find((x) => x.id === "B");
  assert.deepEqual(changeOf(e), { changed: true, added: 1, removed: 1 });
  assert.equal(round2.state.step.name, "askingIdentical");
});

test("an unmeasured subject (the work review) logs file_change null and observes after the log, as before", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]));
  assert.equal(changeOf(loggedBy(t)[0]), null);
  assert.deepEqual(last(t), { kind: "ObserveFile", stage: "response" });
});

// Issue #30 (plan step S11): an accepted issue with the file unchanged gets one corrective turn in the same session;
// the corrective reply is validated and its dispositions re-evaluated against the log as the round began.
const correctiveStart = (log: LogEntry[] = []): Transition =>
  advance(initialState(measured, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "a\n", log });
const corrected = (dispositions: Parameters<typeof respond>[0], extra = {}): ReviewEvent => ({ kind: "CorrectionDecoded", response: respond(dispositions, extra), resultText: "", costUsd: 0.2 });
const unchanged: ReviewEvent = { kind: "FileObserved", hash: "h0", text: "a\n" };
const amended: ReviewEvent = { kind: "FileObserved", hash: "h1", text: "a\nb\n" };

test("(a) an accepted issue with the file unchanged gets a corrective turn; its amendment ends the round as usual", () => {
  const unchangedAfter = run(correctiveStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), unchanged);
  assert.deepEqual(last(unchangedAfter), { kind: "CallCorrective", round: 1, attempt: 1 });
  assert.ok(kinds(unchangedAfter).indexOf("SaveLog") < kinds(unchangedAfter).indexOf("CallCorrective"), "the round was not logged before the corrective turn");
  const reply = advance(unchangedAfter.state, corrected([["A", "accepted"]]));
  assert.ok(kinds(reply).includes("SaveRound") && kinds(reply).includes("Checkpoint"));
  assert.ok(reply.commands.some((c) => c.kind === "Notify" && c.event._tag === "ResponseReceived"));
  assert.deepEqual(last(reply), { kind: "ObserveFile", stage: "response" });
  const next = advance(reply.state, amended);
  assert.deepEqual(changeOf(loggedBy(next).find((e) => e.id === "A")), { changed: true, added: 1, removed: 0 });
  assert.deepEqual(last(next), { kind: "CallReviewer", round: 2 });
});

test("(b) a corrective turn that changes accepted to rejected resolves the condition; the log holds the new disposition", () => {
  const t = run(correctiveStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), unchanged, corrected([["A", "rejected"]]), unchanged);
  const a = loggedBy(t).filter((e) => e.id === "A" && e.superseded !== true);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.action, "rejected");
  assert.equal((changeOf(a[0]) as { changed: boolean }).changed, false);
  assert.equal(loggedBy(t).length, 1, "the first reply's entry was not replaced");
  assert.notEqual(last(t).kind, "Halt");
});

test("(g) a corrective reply that turns an accepted issue into a second clarification request asks that pause once", () => {
  const t0 = run(correctiveStart([entry("A", "clarification_requested")]), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), unchanged);
  assert.deepEqual(last(t0), { kind: "CallCorrective", round: 1, attempt: 1 });
  const t = advance(t0.state, corrected([["A", "clarification_requested"]]));
  const asks = t.commands.filter((c) => c.kind === "AskDecision");
  assert.equal(asks.length, 1);
  assert.match(askedSubject(asks[0], t.state), /issue A, for which one clarification exchange did not produce a disposition/);
});

test("(h) a pause asked for the first reply is not asked again after the corrective turn", () => {
  const history = [entry("C", "rejected")];
  const first = run(correctiveStart(history), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } }, response([["A", "accepted"], ["B", "rejected"]], { dispositions: [{ id: "A", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" }, { id: "B", action: "rejected", rationale: "r", duplicate_of: "C", reverses: "" }] }));
  assert.equal(first.commands.filter((c) => c.kind === "AskDecision").length, 1);
  const unchangedAfter = run(first, { kind: "DecisionGiven", text: "" }, unchanged);
  assert.equal(last(unchangedAfter).kind, "CallCorrective");
  const reply = advance(unchangedAfter.state, { kind: "CorrectionDecoded", response: respond([], { dispositions: [{ id: "A", action: "accepted", rationale: "now done", duplicate_of: "", reverses: "" }, { id: "B", action: "rejected", rationale: "r", duplicate_of: "C", reverses: "" }] }), resultText: "", costUsd: null });
  assert.equal(reply.commands.filter((c) => c.kind === "AskDecision").length, 0);
  assert.deepEqual(last(reply), { kind: "ObserveFile", stage: "response" });
});

test("(j) a self-correction with an empty id kept through the corrective turn keeps its generated id and is logged once", () => {
  const self = { self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "a slip" }] };
  const t = run(correctiveStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]], self), unchanged, corrected([["A", "accepted"]], self), amended);
  assert.notEqual(last(t).kind, "Halt", describe((last(t) as { error?: RunError }).error ?? ({ _tag: "UserStopped", where: "" } as never)));
  assert.deepEqual(loggedBy(t).filter((e) => e.source === "self_correction").map((e) => e.id), ["P1-S1-1"]);
});

// Issue #30 (plan step S12): the condition that persists is a pause, Retry, Proceed or Stop; never a halt by itself.
const stillUnchanged = (): Transition => run(correctiveStart(), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), unchanged, corrected([["A", "accepted"]]), unchanged);

test("(c) a second unchanged file after the corrective turn is the pause", () => {
  const t = stillUnchanged();
  assert.deepEqual(last(t), { kind: "AskUnchanged", accepted: ["A"], retry: "corrective" });
  assert.match(says(t), /plan\.md is unchanged/);
});

test("the pause: Retry takes another corrective turn, Proceed continues with the next cycle, Stop halts", () => {
  const retry = advance(stillUnchanged().state, { kind: "UnchangedAnswer", answer: "retry" });
  assert.deepEqual(last(retry), { kind: "CallCorrective", round: 1, attempt: 2 });
  const proceed = advance(stillUnchanged().state, { kind: "UnchangedAnswer", answer: "proceed" });
  assert.deepEqual(last(proceed), { kind: "CallReviewer", round: 2 });
  assert.ok(proceed.commands.some((c) => c.kind === "Converse" && /proceed with plan\.md unchanged after cycle 1/.test(c.markdown)));
  const stop = advance(stillUnchanged().state, { kind: "UnchangedAnswer", answer: "stop" });
  assert.equal(halt(stop)._tag, "AcceptedWithoutChange");
});

test("the requirements (pause) go straight to the pause, whose Retry is another interview; the work review (null) never gets there", () => {
  const requirements = advance(initialState({ ...measured, onUnchanged: "pause", hasAmend: true }, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "a\n", log: [] });
  const t = run(requirements, { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]), { kind: "Amended" }, unchanged);
  assert.deepEqual(last(t), { kind: "AskUnchanged", accepted: ["A"], retry: "interview" });
  const retry = advance(t.state, { kind: "UnchangedAnswer", answer: "retry" });
  assert.deepEqual(last(retry), { kind: "Amend", round: 1 });
  const again = run(retry, { kind: "Amended" }, amended);
  assert.deepEqual(last(again), { kind: "CallReviewer", round: 2 });
});
