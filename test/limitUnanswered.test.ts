// Issue #185 (requirements Q3's exception, G-R1-3): a review's round limit or idle limit whose question goes unanswered
// extends the review instead of ending the run, and every later limit of that loop is extended without a question.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { advance as advanceState, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, roundCheckOf, type Transition } from "../src/reviewState.ts";
import { validateReview } from "../src/round.ts";
import type { PlannerResponse, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";
import { limitExtendedLine } from "../src/prompts.ts";

const setup: ReviewSetup = { subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, idNumber: 1, proceed: "proceed to execution with the plan as it is", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, onUnchanged: null, disputesSettledBy: "user", maxRounds: 5, maxIdleRounds: 2, countMinor: true };
type TestEvent =
  | Exclude<ReviewEvent, Readonly<{ kind: "ReviewDecoded" | "ResponseDecoded" | "CorrectionDecoded" }>>
  | Readonly<{ kind: "ReviewDecoded"; review: Review }>
  | Readonly<{ kind: "ResponseDecoded"; response: PlannerResponse }>;
const advance = (s: ReviewState, e: TestEvent): Transition =>
  advanceState(
    s,
    e.kind === "ReviewDecoded"
      ? { ...e, validated: Result.getOrThrow(validateReview(e.review)) }
      : e.kind === "ResponseDecoded"
        ? { ...e, round: Result.getOrThrow(roundCheckOf(s)(e.response)), resultText: "", costUsd: 0.1 }
        : e,
  );
const run = (first: Transition, ...events: TestEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const start = (maxRounds: number, maxIdleRounds: number): Transition =>
  advance(initialState(setup, { maxRounds, maxIdleRounds, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log: [] });
const last = (t: Transition): ReviewCommand => t.commands[t.commands.length - 1];
const converses = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Converse" ? [c.markdown] : [])).join("");
const says = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Say" ? [c.text] : [])).join("\n");
/** One round whose issue is rejected, so it counts toward the idle limit; the file unchanged. */
const rejectedRound = (n: number): TestEvent[] => [
  { kind: "ReviewDecoded", review: { issues: [issue(`A${n}`)] } },
  { kind: "ResponseDecoded", response: respond([[`A${n}`, "rejected"]]) },
  { kind: "FileObserved", hash: "h0", text: "" },
];
const roundOf = (t: Transition, n: number) => run(t, ...rejectedRound(n));

test("an unanswered round limit extends the review by maxRounds and writes the line; a later limit extends without a question", () => {
  const atLimit = roundOf(start(1, 99), 1);
  assert.deepEqual(last(atLimit), { kind: "AskLimit", limit: 1 });
  const extended = advance(atLimit.state, { kind: "LimitUnanswered" });
  assert.equal(extended.state.limit, 2);
  assert.equal(extended.state.unanswered, true);
  const first = limitExtendedLine("Planning phase 1", "rounds", 1, true);
  assert.ok(converses(extended).includes(first) && says(extended).includes(first));
  assert.deepEqual(last(extended), { kind: "CallReviewer", round: 2 });
  const again = roundOf(extended, 2);
  assert.ok(!again.commands.some((c) => c.kind === "AskLimit"));
  assert.equal(again.state.limit, 3);
  assert.ok(converses(again).includes(limitExtendedLine("Planning phase 1", "rounds", 1, false)));
  assert.deepEqual(last(again), { kind: "CallReviewer", round: 3 });
});

test("an unanswered idle limit resets the idle count without recording a decision; a later idle limit asks nothing", () => {
  const atIdle = roundOf(start(99, 1), 1);
  assert.equal(last(atIdle).kind, "AskDecision");
  const extended = advance(atIdle.state, { kind: "IdleUnanswered" });
  assert.equal(extended.state.idle, 0);
  assert.equal(extended.state.unanswered, true);
  assert.ok(!extended.commands.some((c) => c.kind === "RecordDecision"));
  assert.ok(converses(extended).includes(limitExtendedLine("Planning phase 1", "idle", 1, true)));
  assert.deepEqual(last(extended), { kind: "CallReviewer", round: 2 });
  const again = roundOf(extended, 2);
  assert.ok(!again.commands.some((c) => c.kind === "AskDecision" || c.kind === "RecordDecision"));
  assert.ok(converses(again).includes(limitExtendedLine("Planning phase 1", "idle", 1, false)));
  assert.deepEqual(last(again), { kind: "CallReviewer", round: 3 });
});

test("an answered limit leaves the loop asking at the next limit", () => {
  const atLimit = roundOf(start(1, 99), 1);
  const more = advance(atLimit.state, { kind: "LimitAnswer", answer: "1" });
  assert.equal(more.state.unanswered, false);
  assert.deepEqual(last(roundOf(more, 2)), { kind: "AskLimit", limit: 2 });
});

test("the events are ignored at any other step", () => {
  const begun = start(5, 2);
  assert.deepEqual(advance(begun.state, { kind: "LimitUnanswered" }).commands, []);
  assert.deepEqual(advance(begun.state, { kind: "IdleUnanswered" }).commands, []);
});

test("no extension line says give up", () => {
  for (const kind of ["rounds", "idle"] as const) for (const first of [true, false]) assert.doesNotMatch(limitExtendedLine("H", kind, 3, first), /give up/i);
});
