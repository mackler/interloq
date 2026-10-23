import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { pauseProse } from "../src/render.ts";
import { blocksMarkdown } from "../src/pieces.ts";
import { Result } from "effect";
import fc from "fast-check";
import { advance as advanceState, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, roundCheckOf, settles, subjectOf, type Transition } from "../src/reviewState.ts";
import { validateReview, type ValidatedRound } from "../src/round.ts";
import type { LogEntry, PlannerResponse, Review } from "../src/schema.ts";
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
/**
 * An event as these tests write it: a decoded review or response without its validated value, which the interpreter
 * computes before the state machine sees the reply (issue #151) and `advance` below computes the same way.
 */
type TestEvent =
  | Exclude<ReviewEvent, Readonly<{ kind: "ReviewDecoded" | "ResponseDecoded" | "CorrectionDecoded" }>>
  | Readonly<{ kind: "ReviewDecoded"; review: Review }>
  | Readonly<{ kind: "ResponseDecoded" | "CorrectionDecoded"; response: PlannerResponse; resultText: string; costUsd: number | null }>;
const complete = (s: ReviewState, e: TestEvent): ReviewEvent => {
  switch (e.kind) {
    case "ReviewDecoded":
      return { ...e, validated: Result.getOrThrow(validateReview(e.review)) };
    case "ResponseDecoded":
    case "CorrectionDecoded":
      // A response the state machine ignores (sent at another step) has no review to be validated against.
      return { ...e, round: s.current.validatedReview === null ? (null as unknown as ValidatedRound) : Result.getOrThrow(roundCheckOf(s)(e.response)) };
    default:
      return e;
  }
};
const advance = (s: ReviewState, e: TestEvent): Transition => advanceState(s, complete(s, e));
/** Applies the events in order, returning the last transition. */
const run = (first: Transition, ...events: TestEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const noQuestions = { questions_for_user: [] };
const entry = (id: string, action: string, round = 1): LogEntry =>
  ({ id, phase: 1, round, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action, rationale: "r", duplicate_of: null, reverses: null, superseded: false, task_dispute: false, work_effects: null }) as LogEntry;
const response = (dispositions: [string, "accepted" | "rejected" | "partially_accepted" | "no_change_needed" | "clarification_requested"][], extra = {}): TestEvent => ({ kind: "ResponseDecoded", response: respond(dispositions, extra), resultText: "", costUsd: 0.1 });
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

// Issue #151: a review with duplicate ids never reaches the state machine; the interpreter's validation refuses it.
test("a review with duplicate ids is refused by the review's validation before the state machine sees it", () => {
  const refused = validateReview({ issues: [issue("A"), issue("A")] });
  assert.ok(Result.isFailure(refused));
  assert.deepEqual(refused.failure.duplicateIssues, ["A"]);
});

test("a counted review saves the review, reports the count, and asks about each reraised id before the response", () => {
  const t = run(start({}, [entry("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.ok(kinds(t).includes("SaveReview"));
  assert.match(says(t), /Issues: 2 total, 2 counted/);
  assert.match(askedProse(last(t)), /raised issue A again/);
  assert.deepEqual(last(t), {
    kind: "AskDecision",
    asks: { kind: "pause", facts: { pause: "reraised", id: "A", history: [entry("A", "rejected")], issue: issue("A"), taskDispute: false, effects: null } },
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

test("roundCheckOf refuses an invalid response; a valid one is saved, rendered, and the round goes to the log and the file is observed", () => {
  const invalid = roundCheckOf(afterReview().state)(respond([["A", "accepted"], ["A", "rejected"]]));
  assert.ok(Result.isFailure(invalid));
  assert.deepEqual(invalid.failure.duplicateDispositions, ["A"]);
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
  for (const e of [{ kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1", text: "" }, { kind: "DecisionGiven", text: "" }, { kind: "DecisionGiven", text: "" }] as TestEvent[]) {
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
const corrected = (dispositions: Parameters<typeof respond>[0], extra = {}): TestEvent => ({ kind: "CorrectionDecoded", response: respond(dispositions, extra), resultText: "", costUsd: 0.2 });
const unchanged: TestEvent = { kind: "FileObserved", hash: "h0", text: "a\n" };
const amended: TestEvent = { kind: "FileObserved", hash: "h1", text: "a\nb\n" };

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

// Issue #112: a subject whose disputes are settled by the agents asks none of the five disputed pauses of behavior 7;
// each is recorded in conversation.md and said, and Claude Code's disposition stands.
const agents: ReviewSetup = { ...setup, subject: "questions", heading: "Question review", fileLabel: "questions.json", dirName: "question-review", disputesSettledBy: "agents" };
const startAgents = (log: LogEntry[] = []): Transition => advance(initialState(agents, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log });
const settled = (t: Transition): string[] => t.commands.flatMap((c) => (c.kind === "Converse" && c.markdown.startsWith(`**${prompts.WORDING_DISPUTE_HEADING}**`) ? [c.markdown] : []));

test("issue #112: an issue raised again is not asked when the agents settle disputes; it goes to Claude Code's response", () => {
  const t = run(startAgents([entry("A", "partially_accepted")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.ok(!kinds(t).includes("AskDecision"));
  assert.deepEqual(last(t), { kind: "CallPlanner", round: 1 });
  assert.equal(settled(t).length, 1);
  assert.match(settled(t)[0], /issue A, raised again/);
  assert.match(says(t), /issue A, raised again/);
});

test("issue #112: the four disputed pauses after a response are not asked when the agents settle disputes; the planner's question still is", () => {
  const log = [entry("C", "accepted"), entry("O", "rejected"), entry("A", "clarification_requested")];
  const dispositions = respond([["A", "clarification_requested"], ["B", "rejected"], ["N", "rejected"]]).dispositions.map((d) => (d.id === "B" ? { ...d, reverses: "C" } : d.id === "N" ? { ...d, duplicate_of: "O" } : d));
  const resp = { ...respond([]), dispositions, self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "x" }] };
  const reviewed = run(startAgents(log), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B"), issue("N")] } });
  const t = advance(reviewed.state, { kind: "ResponseDecoded", response: resp, resultText: "", costUsd: null });
  assert.ok(!kinds(t).includes("AskDecision"), kinds(t).join(","));
  assert.equal(settled(t).length, 4);
  assert.deepEqual(last(t), { kind: "ObserveFile", stage: "response" });
  assert.deepEqual(t.state.log.slice(log.length).filter((e) => e.source === "review").map((e) => [e.id, e.action]), [["A", "clarification_requested"], ["B", "rejected"], ["N", "rejected"]]);
  const withQuestion = { ...resp, questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] };
  const asked = advance(reviewed.state, { kind: "ResponseDecoded", response: withQuestion, resultText: "", costUsd: null });
  assert.equal(askedSubject(last(asked), asked.state), "question from Claude Code: Which?");
});

// Issue #156 (decisions Q1, Q2): in the subjects whose disputes the agents settle, a disputed pause whose latest answer
// from Claude Code carries its mark, that the disagreement is about what the task requires, is put to the user.
const marked = (id: string, action: string): LogEntry => ({ ...entry(id, action), task_dispute: true }) as LogEntry;
type AskCommand = Extract<ReviewCommand, { kind: "AskDecision" }>;
/** The pauses a transition asks: the one it asks now and the ones queued behind it. */
const askedPauses = (t: Transition): readonly AskCommand[] => {
  const now = t.commands.filter((c): c is AskCommand => c.kind === "AskDecision");
  const step = t.state.step;
  const queued = "queue" in step ? step.queue.map((a) => ({ kind: "AskDecision", asks: a.asks, options: a.options }) as unknown as AskCommand) : [];
  return [...now, ...queued];
};
const pauseOf = (c: AskCommand) => (c.asks.kind === "pause" ? c.asks.facts : null);
const disputedResponse = (marks: Readonly<{ a: boolean; b: boolean; n: boolean }>): PlannerResponse => ({
  ...respond([]),
  dispositions: respond([["A", "clarification_requested", marks.a], ["B", "rejected", marks.b], ["N", "rejected", marks.n]]).dispositions.map((d) =>
    d.id === "B" ? { ...d, reverses: "C" } : d.id === "N" ? { ...d, duplicate_of: "O" } : d,
  ),
});
const disputedLog = [entry("C", "accepted"), entry("O", "rejected"), entry("A", "clarification_requested")];
const afterDisputed = (begin: (log: LogEntry[]) => Transition, marks: Readonly<{ a: boolean; b: boolean; n: boolean }>): Transition =>
  run(begin(disputedLog), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B"), issue("N")] } }, { kind: "ResponseDecoded", response: disputedResponse(marks), resultText: "", costUsd: null });

test("issue #156: an issue raised again whose latest answer is marked is asked, with both positions and no settled line", () => {
  const t = run(startAgents([marked("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.deepEqual(settled(t), []);
  const c = last(t) as AskCommand;
  assert.equal(c.kind, "AskDecision");
  assert.deepEqual(c.options, [
    { label: prompts.REVIEWER_POSITION, description: "p e" },
    { label: prompts.PLANNER_POSITION, description: "r" },
  ]);
  assert.equal(pauseOf(c)?.pause, "reraised");
  assert.equal(pauseOf(c) !== null && "taskDispute" in pauseOf(c)! ? (pauseOf(c) as { taskDispute: boolean }).taskDispute : null, true);
  const unmarked = run(startAgents([entry("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.equal(settled(unmarked).length, 1);
  assert.ok(!kinds(unmarked).includes("AskDecision"));
});

test("issue #156: after a response, a second clarification, a reversal and a repetition are asked when this response's disposition is marked", () => {
  const all = afterDisputed(startAgents, { a: true, b: true, n: true });
  assert.deepEqual(settled(all), []);
  assert.deepEqual(askedPauses(all).map((c) => [pauseOf(c)?.pause, (pauseOf(c) as { taskDispute?: boolean } | null)?.taskDispute]), [
    ["secondClarification", true],
    ["reversal", true],
    ["repeatedUnderNewId", true],
  ]);
  const none = afterDisputed(startAgents, { a: false, b: false, n: false });
  assert.equal(settled(none).length, 3);
  assert.deepEqual(askedPauses(none), []);
});

test("issue #156: a mixed batch asks the marked pauses and settles the others in one transition", () => {
  const t = afterDisputed(startAgents, { a: true, b: false, n: false });
  assert.deepEqual(askedPauses(t).map((c) => pauseOf(c)?.pause), ["secondClarification"]);
  assert.equal(settled(t).length, 2);
  assert.match(settled(t).join(""), /issue B/);
  assert.match(settled(t).join(""), /issue N/);
});

test("issue #156: a disputed self-correction is asked when the issue's entry as the round began is marked", () => {
  const resp = (selfId: string) => ({ ...respond([["X", "rejected"]]), self_corrections: [{ id: selfId, new_action: "rejected" as const, explanation: "x" }] });
  const begin = (log: LogEntry[]) => run(startAgents(log), { kind: "ReviewDecoded", review: { issues: [issue("X")] } });
  const asked = advance(begin([marked("C", "rejected")]).state, { kind: "ResponseDecoded", response: resp("C"), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(asked).map((c) => [pauseOf(c)?.pause, (pauseOf(c) as { taskDispute?: boolean }).taskDispute]), [["disputedSelfCorrection", true]]);
  const settledOne = advance(begin([entry("C", "rejected")]).state, { kind: "ResponseDecoded", response: resp("C"), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(settledOne), []);
  assert.equal(settled(settledOne).length, 1);
});

test("issue #156: a marked repetition under a new id offers the new id's rationale as Claude Code's position, and its facts carry that disposition", () => {
  const t = afterDisputed(startAgents, { a: false, b: false, n: true });
  const [c] = askedPauses(t);
  const facts = pauseOf(c!) as { pause: string; disposition: { id: string; rationale: string } | null };
  assert.equal(facts.pause, "repeatedUnderNewId");
  assert.equal(facts.disposition?.id, "N");
  assert.deepEqual(c!.options?.[1], { label: prompts.PLANNER_POSITION, description: "rationale N" });
  const user = afterDisputed((log) => start({}, log), { a: false, b: false, n: false });
  const repeat = askedPauses(user).find((x) => pauseOf(x)?.pause === "repeatedUnderNewId");
  assert.deepEqual(repeat?.options?.[1], { label: prompts.PLANNER_POSITION, description: "r" });
});

test("property: with disputesSettledBy user every disputed pause is asked, whatever the marks (issue #156)", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (a, b, n) => {
      const t = afterDisputed((log) => start({}, log), { a, b, n });
      return askedPauses(t).length === 3 && settled(t).length === 0;
    }),
    { numRuns: 8, seed: 156 },
  );
});

// P1-R1-3: a corrective reply that marks a settled answer puts its pause to the user; one that leaves it unmarked
// records no second line.
test("issue #156: a corrective reply that marks a settled reversal asks it; one that leaves it unmarked settles it once", () => {
  const agentsMeasured: ReviewSetup = { ...agents, onUnchanged: "corrective" };
  const begin = advance(initialState(agentsMeasured, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", text: "a\n", log: [entry("C", "accepted")] });
  const reversal = (action: "partially_accepted" | "rejected", mark: boolean): PlannerResponse => ({
    ...respond([]),
    dispositions: respond([["B", action, mark]]).dispositions.map((d) => ({ ...d, reverses: "C" })),
  });
  const first = run(begin, { kind: "ReviewDecoded", review: { issues: [issue("B")] } }, { kind: "ResponseDecoded", response: reversal("partially_accepted", false), resultText: "", costUsd: null });
  assert.equal(settled(first).length, 1);
  const correcting = advance(first.state, { kind: "FileObserved", hash: "h0", text: "a\n" });
  assert.deepEqual(last(correcting), { kind: "CallCorrective", round: 1, attempt: 1 });
  const markedReply = advance(correcting.state, { kind: "CorrectionDecoded", response: reversal("rejected", true), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(markedReply).map((c) => pauseOf(c)?.pause), ["reversal"]);
  assert.deepEqual(settled(markedReply), []);
  const unmarkedReply = advance(correcting.state, { kind: "CorrectionDecoded", response: reversal("partially_accepted", false), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(unmarkedReply), []);
  assert.deepEqual(settled(unmarkedReply), []);
});

// ---- issue #183: each agent's statement of a disputed point's effect on the work ------------------------------------

const workEffects: ReviewSetup = { ...setup, subject: { work: 1 }, heading: "Work review 1", fileLabel: "changes.diff", dirName: "work-review-1", leaveOnAcceptance: true, leaveOnDecision: true, disputesSettledBy: "noWorkEffect" };
const planEffects: ReviewSetup = { ...setup, disputesSettledBy: "noWorkEffect" };
const startWith = (s: ReviewSetup, log: LogEntry[] = []): Transition => advance(initialState(s, { maxRounds: 5, maxIdleRounds: 5, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log });
const NONE = { kind: "none" } as const;
const differsBy = (difference: string) => ({ kind: "differs", difference }) as unknown as import("../src/schema.ts").WorkEffect;
const effectIssue = (id: string, effect: unknown) => ({ ...issue(id), work_effect: effect }) as Review["issues"][number];
const withEffects = (e: LogEntry, effects: unknown): LogEntry => ({ ...e, work_effects: effects }) as LogEntry;
const effectsOf = (c: ReviewCommand | undefined) => (c !== undefined && c.kind === "AskDecision" && c.asks.kind === "pause" ? c.asks.facts : null) as { pause: string; effects: unknown } | null;
const SCRIPTED = differsBy("scripted");

test("issue #183: an issue raised again carries Codex's statement now and Claude Code's latest in the log", () => {
  const log = [withEffects(entry("A", "rejected"), { reviewer: NONE, planner: differsBy("the README stays wrapped") })];
  const t = run(startWith(planEffects, log), { kind: "ReviewDecoded", review: { issues: [effectIssue("A", differsBy("the README is committed unwrapped"))] } });
  assert.deepEqual(effectsOf(last(t))?.effects, { reviewer: differsBy("the README is committed unwrapped"), planner: differsBy("the README stays wrapped") });
  const missing = run(startWith(planEffects, [entry("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [effectIssue("A", differsBy("x"))] } });
  assert.equal(effectsOf(last(missing))?.effects, null, "Claude Code's latest answer stated nothing");
});

test("issue #183: a second clarification, a reversal and a repetition carry this round's issue and this response's disposition; a disputed self-correction none", () => {
  const t = afterDisputed((log) => startWith(planEffects, log), { a: false, b: false, n: false });
  assert.deepEqual(askedPauses(t).map((c) => [pauseOf(c)?.pause, effectsOf(c)?.effects]), [
    ["secondClarification", { reviewer: SCRIPTED, planner: SCRIPTED }],
    ["reversal", { reviewer: SCRIPTED, planner: SCRIPTED }],
    ["repeatedUnderNewId", { reviewer: SCRIPTED, planner: SCRIPTED }],
  ]);
  const resp = { ...respond([["X", "rejected"]]), self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "x" }] };
  const reviewed = run(startWith(planEffects, [entry("C", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("X")] } });
  const self = advance(reviewed.state, { kind: "ResponseDecoded", response: resp, resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(self).map((c) => [pauseOf(c)?.pause, effectsOf(c)?.effects]), [["disputedSelfCorrection", null]]);
});

const noEffectLines = (t: Transition): string[] => t.commands.flatMap((c) => (c.kind === "Converse" && c.markdown.startsWith(`**${prompts.NO_WORK_EFFECT_HEADING}**`) ? [c.markdown] : []));
const noEffectSays = (t: Transition): string[] => t.commands.flatMap((c) => (c.kind === "Say" && c.text.startsWith(prompts.NO_WORK_EFFECT_HEADING) ? [c.text] : []));
/** The disputed round of afterDisputed with every issue and disposition stating `effect`, under the given setup. */
const disputedWith = (s: ReviewSetup, issueEffect: unknown, dispositionEffect: unknown): Transition => {
  const resp = disputedResponse({ a: false, b: false, n: false });
  const response = { ...resp, dispositions: resp.dispositions.map((d) => ({ ...d, work_effect: dispositionEffect })) } as PlannerResponse;
  return run(startWith(s, disputedLog), { kind: "ReviewDecoded", review: { issues: ["A", "B", "N"].map((id) => effectIssue(id, issueEffect)) } }, { kind: "ResponseDecoded", response, resultText: "", costUsd: null });
};

test("issue #183: an issue raised again on which both agents state no effect is settled, with both positions, and goes to the response", () => {
  const log = [withEffects({ ...entry("A", "rejected"), rationale: "It took 0 s and changed nothing." } as LogEntry, { reviewer: NONE, planner: NONE })];
  const t = run(startWith(workEffects, log), { kind: "ReviewDecoded", review: { issues: [{ ...effectIssue("A", NONE), problem: "S22 ran an unnamed command." }] } });
  assert.ok(!kinds(t).includes("AskDecision"), kinds(t).join(","));
  assert.deepEqual(last(t), { kind: "CallPlanner", round: 1 });
  assert.equal(noEffectLines(t).length, 1);
  assert.equal(noEffectSays(t).length, 1);
  for (const text of [noEffectLines(t)[0], noEffectSays(t)[0]]) {
    assert.ok(text.includes("S22 ran an unnamed command."), text);
    assert.ok(text.includes("It took 0 s and changed nothing."), text);
    assert.doesNotMatch(text, /word/i);
  }
  assert.deepEqual(settled(t), [], "no wording line");
});

test("issue #183: a second clarification, a reversal and a repetition are settled where both state no effect, and asked where either names one", () => {
  const none = disputedWith(workEffects, NONE, NONE);
  assert.deepEqual(askedPauses(none), []);
  assert.equal(noEffectLines(none).length, 3);
  const codexNames = disputedWith(workEffects, { kind: "differs", difference: "a file changes" }, NONE);
  assert.deepEqual(askedPauses(codexNames).map((c) => pauseOf(c)?.pause), ["secondClarification", "reversal", "repeatedUnderNewId"]);
  assert.deepEqual(noEffectLines(codexNames), []);
  const plannerNames = disputedWith(workEffects, NONE, { kind: "differs", difference: "a file changes" });
  assert.equal(askedPauses(plannerNames).length, 3);
});

test("issue #183: a disputed self-correction is asked under noWorkEffect", () => {
  const resp = { ...respond([["X", "rejected"]]), self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "x" }] };
  const reviewed = run(startWith(workEffects, [withEffects(entry("C", "rejected"), { reviewer: NONE, planner: NONE })]), { kind: "ReviewDecoded", review: { issues: [effectIssue("X", NONE)] } });
  const t = advance(reviewed.state, { kind: "ResponseDecoded", response: { ...resp, dispositions: resp.dispositions.map((d) => ({ ...d, work_effect: NONE })) } as PlannerResponse, resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(t).map((c) => pauseOf(c)?.pause), ["disputedSelfCorrection"]);
});

test("property: with disputesSettledBy user every disputed pause is asked, whatever the effects (issue #183)", () => {
  const effect = fc.constantFrom<unknown>(NONE, { kind: "differs", difference: "d" });
  fc.assert(
    fc.property(effect, effect, (i, d) => {
      const t = disputedWith({ ...workEffects, disputesSettledBy: "user" }, i, d);
      return askedPauses(t).length === 3 && noEffectLines(t).length === 0;
    }),
    { numRuns: 8, seed: 183 },
  );
});

test("property: under noWorkEffect a disputed pause is settled exactly when both effects are none; a pause that is no disagreement never is", () => {
  const arbEffect = fc.constantFrom<import("../src/schema.ts").WorkEffect>(NONE, differsBy("d"));
  const disputed = fc.constantFrom("reraised", "secondClarification", "reversal", "repeatedUnderNewId");
  fc.assert(
    fc.property(disputed, fc.option(fc.record({ reviewer: arbEffect, planner: arbEffect }), { nil: null }), (pause, effects) => {
      const facts = { pause, id: "A", reverses: "B", repeats: "B", history: [], issue: null, disposition: null, taskDispute: false, effects } as unknown as import("../src/question.ts").PauseFacts;
      const ask = { asks: { kind: "pause" as const, facts }, id: null };
      const both = effects !== null && effects.reviewer.kind === "none" && effects.planner.kind === "none";
      assert.equal(settles("noWorkEffect", ask), both);
    }),
    { numRuns: 100, seed: 183 },
  );
  for (const facts of [{ pause: "unexplained", fileLabel: "f", heading: "h", round: 1, resultText: "" }, { pause: "identical", fileLabel: "f", round: 1, seen: "1" }, { pause: "idle", idle: 2, round: 2, issues: [] }] as const) {
    assert.equal(settles("noWorkEffect", { asks: { kind: "pause", facts }, id: null }), false, facts.pause);
  }
});

test("issue #183: a corrective reply that states a difference on a settled reversal asks it; one that keeps none records no second line", () => {
  const measured: ReviewSetup = { ...planEffects, onUnchanged: "corrective" };
  const begin = advance(initialState(measured, { maxRounds: 5, maxIdleRounds: 5, countMinor: true }), { kind: "Begin", hash: "h0", text: "a\n", log: [entry("C", "accepted")] });
  const reversal = (action: "partially_accepted" | "rejected", effect: unknown): PlannerResponse =>
    ({ ...respond([]), dispositions: respond([["B", action]]).dispositions.map((d) => ({ ...d, reverses: "C", work_effect: effect })) }) as PlannerResponse;
  const first = run(begin, { kind: "ReviewDecoded", review: { issues: [effectIssue("B", NONE)] } }, { kind: "ResponseDecoded", response: reversal("partially_accepted", NONE), resultText: "", costUsd: null });
  assert.equal(noEffectLines(first).length, 1);
  const correcting = advance(first.state, { kind: "FileObserved", hash: "h0", text: "a\n" });
  assert.deepEqual(last(correcting), { kind: "CallCorrective", round: 1, attempt: 1 });
  const named = advance(correcting.state, { kind: "CorrectionDecoded", response: reversal("rejected", { kind: "differs", difference: "the plan keeps step S3" }), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(named).map((c) => pauseOf(c)?.pause), ["reversal"]);
  const kept = advance(correcting.state, { kind: "CorrectionDecoded", response: reversal("rejected", NONE), resultText: "", costUsd: null });
  assert.deepEqual(askedPauses(kept), []);
  assert.deepEqual(noEffectLines(kept), []);
});

// ---- issue #183: the options of an asked dispute, and an answer that keeps Claude Code's position -------------------

const DIFF = differsBy("website/README.md is committed unwrapped");
/** A work review whose round 1 logged A rejected with no effect, and whose round 2 raises A again with a difference. */
const reraisedWithDifference = (s: ReviewSetup = workEffects): Transition =>
  run(startWith(s, [withEffects(entry("A", "rejected"), { reviewer: NONE, planner: NONE })]), { kind: "ReviewDecoded", review: { issues: [effectIssue("A", DIFF)] } });
const plannerOption = (c: ReviewCommand) => (c.kind === "AskDecision" ? c.options!.find((o) => o.label === prompts.PLANNER_POSITION)! : assert.fail("not asked"));
const reviewerOption = (c: ReviewCommand) => (c.kind === "AskDecision" ? c.options!.find((o) => o.label === prompts.REVIEWER_POSITION)! : assert.fail("not asked"));

test("issue #183: an asked dispute's options name each stated difference and what each answer costs", () => {
  const asked = last(reraisedWithDifference());
  const effects = { reviewer: DIFF, planner: NONE };
  assert.ok(reviewerOption(asked).description.includes(prompts.followCodexChanges(effects)), reviewerOption(asked).description);
  assert.ok(reviewerOption(asked).description.includes(prompts.followCodexCost(true)));
  assert.ok(plannerOption(asked).description.includes(prompts.followClaudeCodeKeeps(effects)));
  assert.ok(plannerOption(asked).description.includes(prompts.FOLLOW_CLAUDE_CODE_COST));
  assert.ok(prompts.followCodexChanges(effects).includes("website/README.md is committed unwrapped"));
  const plan = last(reraisedWithDifference(planEffects));
  assert.ok(reviewerOption(plan).description.includes(prompts.followCodexCost(false)));
  const user = last(reraisedWithDifference({ ...workEffects, disputesSettledBy: "user" }));
  assert.ok(!reviewerOption(user).description.includes(prompts.followCodexCost(true)), "only noWorkEffect subjects name the cost");
});

test("issue #183: in the work review, Claude Code's position keeps the loop in the review; Codex's position and free text leave", async () => {
  const { optionText } = await import("../src/input.ts");
  const asked = reraisedWithDifference();
  for (const text of [optionText(plannerOption(last(asked))), plannerOption(last(asked)).label]) {
    const t = advance(asked.state, { kind: "DecisionGiven", text });
    assert.ok(!t.commands.some((c) => c.kind === "Finish"), `${text}: ${kinds(t).join(",")}`);
    assert.ok(!kinds(t).includes("ApplyDecisions"));
    assert.ok(kinds(t).includes("RecordDecision"));
    assert.deepEqual(last(t), { kind: "CallPlanner", round: 1 });
  }
  for (const text of [optionText(reviewerOption(last(asked))), "do something else"]) {
    const t = advance(asked.state, { kind: "DecisionGiven", text });
    assert.deepEqual(last(t), { kind: "Finish", result: "revise" }, text);
  }
});

test("issue #183: after a response, Claude Code's position at a disputed pause keeps the work review going without applying decisions", async () => {
  const { optionText } = await import("../src/input.ts");
  const t = disputedWith(workEffects, DIFF, NONE);
  const [first] = askedPauses(t);
  assert.equal(pauseOf(first!)?.pause, "secondClarification");
  const answered = advance(t.state, { kind: "DecisionGiven", text: optionText(plannerOption(first!)) });
  assert.ok(!answered.commands.some((c) => c.kind === "Finish" || c.kind === "ApplyDecisions"), kinds(answered).join(","));
  assert.ok(kinds(answered).includes("RecordDecision"));
  assert.equal(last(answered).kind, "AskDecision", "the next pause in the queue is asked");
});
