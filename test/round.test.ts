import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import type { RoundInvalid } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import * as log from "../src/issueLog.ts";
import { type IssueId, validateReview, validateRound, type ValidatedReview } from "../src/round.ts";
import type { LogEntry, PlannerResponse, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

// Findings 3, 4 and 7 of docs/functional-design-review.md; decisions Q2 and Q3 of plan-review/requirements.md.

const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result), `expected success, got ${Result.isFailure(result) ? describe(result.failure as RoundInvalid) : "?"}`);
  return result.success;
};
const invalid = <A>(result: Result.Result<A, RoundInvalid>, ...texts: RegExp[]): RoundInvalid => {
  assert.ok(Result.isFailure(result), "expected RoundInvalid, got success");
  for (const text of texts) assert.match(describe(result.failure), text);
  return result.failure;
};
const review = (...issues: Review["issues"]): Review => ({ issues });
/** A version-2 review entry by default; `extra` may change the source (the review-only fields are then ignored by the functions under test). */
const entry = (id: string, action: string, extra: Partial<LogEntry> = {}): LogEntry =>
  ({ id, phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action, rationale: "r", duplicate_of: null, reverses: null, superseded: false, task_dispute: false, ...extra }) as LogEntry;
const validated = (r: Review): ValidatedReview => ok(validateReview(r));

test("validateReview: unique non-empty ids pass; a duplicate or an empty id is RoundInvalid", () => {
  assert.equal(validated(review(issue("A"), issue("B"))).issues.length, 2);
  invalid(validateReview(review(issue("A"), issue("A"))), /more than one issue with the id: A/);
  invalid(validateReview(review(issue(""))), /empty/);
});

test("validateRound: the finding-3 counterexample (A rejected, then A accepted) is RoundInvalid naming A", () => {
  invalid(validateRound(validated(review(issue("A"))), respond([["A", "rejected"], ["A", "accepted"]]), [], 1, 1, "P"), /more than one disposition for: A/);
});

test("validateRound: a missing, an unknown and an empty disposition id are RoundInvalid", () => {
  const r = validated(review(issue("A"), issue("B")));
  invalid(validateRound(r, respond([["A", "accepted"]]), [], 1, 1, "P"), /no disposition for: B/);
  invalid(validateRound(r, respond([["A", "accepted"], ["B", "accepted"], ["C", "rejected"]]), [], 1, 1, "P"), /not in the review: C/);
  invalid(validateRound(r, respond([["A", "accepted"], ["", "accepted"]]), [], 1, 1, "P"), /empty/);
});

test("validateRound: references are normalised (Q3): sentinels become null, unknown and not-accepted references are dropped with a note", () => {
  const r = validated(review(issue("C")));
  const history = [entry("A", "accepted"), entry("B", "rejected")];
  const plain = ok(validateRound(r, respond([["C", "rejected"]]), history, 1, 2, "P"));
  assert.deepEqual(plain.dispositions.map((d) => [d.duplicateOf, d.reverses]), [[null, null]]);
  assert.deepEqual(plain.notes, []);

  const response = respond([["C", "rejected"]]);
  const withRefs: PlannerResponse = { ...response, dispositions: [{ ...response.dispositions[0], duplicate_of: "Z", reverses: "B" }] };
  const round = ok(validateRound(r, withRefs, history, 1, 2, "P"));
  assert.deepEqual(round.dispositions.map((d) => [d.duplicateOf, d.reverses]), [[null, null]]);
  assert.deepEqual(round.notes.map((n) => [n.id, n.field, n.named, n.reason]), [["C", "duplicate_of", "Z", "unknown"], ["C", "reverses", "B", "not_accepted"]]);

  const accepted: PlannerResponse = { ...response, dispositions: [{ ...response.dispositions[0], duplicate_of: "B", reverses: "A" }] };
  const kept = ok(validateRound(r, accepted, history, 1, 2, "P"));
  assert.deepEqual(kept.dispositions.map((d) => [d.duplicateOf, d.reverses]), [["B", "A"]]);
  assert.deepEqual(kept.notes, []);
});

test("validateRound: an empty self-correction id is replaced by a generated id; a generated id that exists in the log is RoundInvalid", () => {
  const r = validated(review(issue("A")));
  const response = respond([["A", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }, { id: "B", new_action: "accepted", explanation: "y" }] });
  const round = ok(validateRound(r, response, [entry("B", "rejected")], 2, 3, "P"));
  assert.deepEqual(round.selfCorrections.map((s) => [s.id, s.generated]), [["P2-S3-1", true], ["B", false]]);
  invalid(validateRound(r, response, [entry("B", "rejected"), entry("P2-S3-1", "plan_error")], 2, 3, "P"), /P2-S3-1/);
});

test("appendRound takes the validated round, leaves its inputs unchanged, and applies the Q2 overlap order", () => {
  const r = validated(review(issue("X")));
  const response = respond([["X", "accepted"]], { self_corrections: [{ id: "X", new_action: "rejected", explanation: "disputed" }, { id: "", new_action: "plan_error", explanation: "other" }] });
  const before: readonly LogEntry[] = Object.freeze([entry("X", "rejected", { round: 1 })]);
  const round = ok(validateRound(r, response, before, 1, 2, "P"));
  const after = log.appendRound(before, round, null);
  assert.deepEqual(before, [entry("X", "rejected", { round: 1 })]);
  const currentX = after.filter((e) => e.id === "X" && e.superseded !== true);
  assert.equal(currentX.length, 1, JSON.stringify(after, null, 1));
  assert.equal(currentX[0].action, "accepted");
  assert.equal(currentX[0].source, "review");
  const selfX = after.find((e) => e.id === "X" && e.source === "self_correction");
  assert.equal(selfX?.superseded, true, "the overlapping self-correction is not superseded by the disposition");
  assert.ok(after.findIndex((e) => e === selfX) < after.findIndex((e) => e === currentX[0]), "the self-correction is not appended before the review entry");
  assert.equal(after.filter((e) => e.id === "P1-S2-2").length, 1);
});

test("the detections use the normalised references", () => {
  const r = validated(review(issue("N")));
  const history = [entry("O", "rejected"), entry("A", "accepted")];
  const response = respond([["N", "rejected"]]);
  const round = ok(validateRound(r, { ...response, dispositions: [{ ...response.dispositions[0], duplicate_of: "O", reverses: "A" }] }, history, 1, 2, "P"));
  assert.deepEqual(log.repeatedUnderNewId(history, round), [["N", "O"]]);
  assert.deepEqual(log.reversals(round), [["N", "A"]]);
  assert.equal(log.acceptedCount(round), 0);
  const id = "N" as IssueId;
  void id;
});

// Plan step 2.5: generated self-correction ids carry the subject's prefix, so they never look like another subject's.
test("validateRound generates self-correction ids with the given prefix", () => {
  const response = respond([["A", "rejected"]], { self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "x" }] });
  for (const prefix of ["P", "W", "Q", "G"]) {
    const round = ok(validateRound(validated(review(issue("A"))), response, [], 2, 3, prefix));
    assert.equal(round.selfCorrections[0].id, `${prefix}2-S3-1`);
  }
});

// Decision support, plan step 1.3 (P1-R1-1): the id number of generated ids is separate from the phase of the entries.
test("validateRound: a generated self-correction id uses the id number, while the round keeps the phase", () => {
  const r = validated(review(issue("A")));
  const response = respond([["A", "accepted"]], { self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }] });
  const round = ok(validateRound(r, response, [], 1, 1, "D", 2));
  assert.deepEqual(round.selfCorrections.map((s) => s.id), ["D2-S1-1"]);
  assert.equal(round.phase, 1);
});

// Issue #156: Claude Code's mark on a disposition, that its disagreement is about what the task requires.

test("validateRound: a marked disposition that is not accepted carries the mark; a mark on accepted is ignored", () => {
  const r = validated(review(issue("A"), issue("B"), issue("C"), issue("D"), issue("E")));
  const round = ok(
    validateRound(
      r,
      respond([
        ["A", "rejected", true],
        ["B", "accepted", true],
        ["C", "partially_accepted", true],
        ["D", "no_change_needed", true],
        ["E", "clarification_requested", true],
      ]),
      [],
      1,
      1,
      "Q",
    ),
  );
  assert.deepEqual(
    round.dispositions.map((d) => [d.id, d.taskDispute]),
    [["A", true], ["B", false], ["C", true], ["D", true], ["E", true]],
  );
});

test("validateRound: an unmarked disposition, and a disposition without the field (the plan's response), carry no mark", () => {
  const r = validated(review(issue("A"), issue("B")));
  const unmarked = ok(validateRound(r, respond([["A", "rejected", false], ["B", "rejected"]]), [], 1, 1, "Q"));
  assert.deepEqual(unmarked.dispositions.map((d) => d.taskDispute), [false, false]);
  const plain: PlannerResponse = { dispositions: [{ id: "A", action: "rejected", rationale: "r", duplicate_of: "", reverses: "" }, { id: "B", action: "rejected", rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
  assert.deepEqual(ok(validateRound(r, plain, [], 1, 1, "P")).dispositions.map((d) => d.taskDispute), [false, false]);
});

test("appendRound writes the round's mark on each review entry", () => {
  const r = validated(review(issue("A"), issue("B")));
  const round = ok(validateRound(r, respond([["A", "rejected", true], ["B", "rejected"]]), [], 1, 1, "Q"));
  const entries = log.appendRound([], round, null);
  assert.deepEqual(entries.map((e) => [e.id, e.source === "review" ? e.task_dispute : null]), [["A", true], ["B", false]]);
});
