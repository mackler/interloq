import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { advance as advanceState, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, roundCheckOf, type Transition } from "../src/reviewState.ts";
import { validateReview } from "../src/round.ts";
import type { Action, LogEntry, PlannerResponse, Review } from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { issue, respond } from "./helpers.ts";

// Issue #252, S3 (requirements Q1): a collecting review does not leave at the first cycle with a correction due; it runs
// cycles until one raises no counted issue and then leaves with every accepted finding, or converges where none was
// accepted, the round limit bounding it.

const setup: ReviewSetup = { subject: { work: 1 }, heading: "Work review 1", fileLabel: "changes.diff", dirName: "work-review-1", phase: 1, idNumber: 1, proceed: null, hasAmend: false, onAcceptance: "collect", leaveOnDecision: true, onUnchanged: null, disputesSettledBy: "noWorkEffect", maxRounds: 5, maxIdleRounds: 9, countMinor: true };
type TestEvent = Exclude<ReviewEvent, Readonly<{ kind: "ReviewDecoded" | "ResponseDecoded" | "CorrectionDecoded" }>> | Readonly<{ kind: "ReviewDecoded"; review: Review }> | Readonly<{ kind: "ResponseDecoded"; response: PlannerResponse }>;
const complete = (s: ReviewState, e: TestEvent): ReviewEvent =>
  e.kind === "ReviewDecoded"
    ? { ...e, validated: Result.getOrThrow(validateReview(e.review)) }
    : e.kind === "ResponseDecoded"
      ? { ...e, costUsd: 0.1, round: Result.getOrThrow(roundCheckOf(s)(e.response)) }
      : e;
const advance = (s: ReviewState, e: TestEvent): Transition => advanceState(s, complete(s, e));
const run = (first: Transition, ...events: TestEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const begin = (extra: Partial<ReviewSetup> = {}, maxRounds = 5, log: LogEntry[] = []): Transition =>
  advance(initialState({ ...setup, ...extra }, { maxRounds, maxIdleRounds: 9, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log });
const last = (t: Transition): ReviewCommand => t.commands[t.commands.length - 1]!;
const reviewOf = (...ids: string[]): TestEvent => ({ kind: "ReviewDecoded", review: { issues: ids.map((id) => issue(id)) } });
const answer = (pairs: [string, Action][]): TestEvent => ({ kind: "ResponseDecoded", response: respond(pairs as [string, "accepted"][]) });
const observed: TestEvent = { kind: "FileObserved", hash: "h0", text: "" };
const said = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Say" ? [c.text] : c.kind === "Converse" ? [c.markdown] : [])).join("\n");
const opensLimit = (t: Transition): boolean => t.commands.some((c) => c.kind === "OpenBeside" && c.beside.question.kind === "limit");

test("S3 (1): a round with an accepted issue is followed by the next round's review, not by the end", () => {
  const t = run(begin(), reviewOf("A"), answer([["A", "accepted"]]), observed);
  assert.equal(last(t).kind, "CallReviewer");
  assert.equal(t.state.collected, true);
});

test("S3 (2): a later review with no counted issue leaves with revise and the collected line, and no agreement block", () => {
  const t = run(begin(), reviewOf("A"), answer([["A", "accepted"]]), observed, reviewOf());
  assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
  const text = said(t);
  assert.ok(text.includes(prompts.collectedLeaveLine("Work review 1", 2)));
  assert.ok(!text.includes(prompts.reviewConvergedMarkdown("Work review 1", 2, "changes.diff", prompts.passNoun({ work: 1 }))));
});

test("S3 (3): a collecting loop with nothing accepted converges at a review with no counted issue", () => {
  const t = run(begin(), reviewOf("A"), answer([["A", "rejected"]]), observed, reviewOf());
  assert.deepEqual(last(t), { kind: "Finish", result: "converged" });
});

test("S3 (4): at the limit with a finding collected, the review leaves with revise and opens no limit question", () => {
  const t = run(begin({}, 2), reviewOf("A"), answer([["A", "accepted"]]), observed, reviewOf("B"), answer([["B", "rejected"]]), observed);
  assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
  assert.ok(!opensLimit(t));
  assert.ok(said(t).includes(prompts.collectedLimitLine("Work review 1", 2)));
});

test("S3 (5): a cycle whose only counted issue is a clarification raised again under its id does not end the loop", () => {
  const t = run(begin(), reviewOf("A"), answer([["A", "clarification_requested"]]), observed, reviewOf("A"));
  assert.notEqual(last(t).kind, "Finish");
});

test("S3 (6): leave behaves as before: one round with an acceptance ends with revise", () => {
  const t = run(begin({ onAcceptance: "leave" }), reviewOf("A"), answer([["A", "accepted"]]));
  assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
});

test("S3 (7): a collecting loop at its limit with nothing accepted leaves with revise; a continuing one is extended", () => {
  const collect = run(begin({}, 1), reviewOf("A"), answer([["A", "rejected"]]), observed);
  assert.deepEqual(last(collect), { kind: "Finish", result: "revise" });
  assert.ok(!opensLimit(collect));
  assert.equal(collect.state.limit, 1);
  const cont = run(begin({ onAcceptance: "continue", subject: { plan: 1 }, dirName: "planning-1", proceed: "proceed" }, 1), reviewOf("A"), answer([["A", "rejected"]]), observed);
  assert.equal(last(cont).kind, "CallReviewer");
  assert.ok(opensLimit(cont));
  assert.equal(cont.state.limit, 2);
});

test("S3 (property): a collecting loop ends only at a review with no counted issue or at the limit, revise exactly where a correction was due or the limit was reached", () => {
  const cycle = fc.record({ issues: fc.integer({ min: 0, max: 2 }), accept: fc.boolean() });
  fc.assert(
    fc.property(fc.array(cycle, { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 4 }), (cycles, maxRounds) => {
      let t = begin({}, maxRounds);
      let due = false;
      for (const [k, c] of cycles.entries()) {
        const round = k + 1;
        const ids = Array.from({ length: c.issues }, (_, i) => `W1-R${round}-${i + 1}`);
        t = advance(t.state, reviewOf(...ids));
        if (c.issues === 0) {
          assert.deepEqual(last(t), { kind: "Finish", result: due ? "revise" : "converged" });
          return;
        }
        assert.notEqual(last(t).kind, "Finish");
        t = run(t, answer(ids.map((id) => [id, c.accept ? "accepted" : "rejected"])), observed);
        due = due || c.accept;
        if (round >= maxRounds) {
          assert.deepEqual(last(t), { kind: "Finish", result: "revise" });
          return;
        }
        assert.equal(last(t).kind, "CallReviewer");
      }
    }),
    { numRuns: 300 },
  );
});
