// Issue #38: the positions, resolutions and investigations of src/resolution.ts, by example.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { changesAuthority, investigatedIds, positionOf, previousRound, resolutionOf, resolutionOutcomes, standingDisputes } from "../src/resolution.ts";
import type * as S from "../src/schema.ts";
import { reviewEntry, selfEntry } from "./resolutionFixtures.ts";

type LogEntry = S.LogEntry;
const id = (s: string) => s as S.IssueId;
const text = (s: string) => s as S.PositionText;
const resolution = (t: string, changes: string[] = []): S.Resolution => ({ text: text(t), changes: changes.map(text) });

const userEntry = (i: string): LogEntry => ({ id: id(i), phase: 1, round: 2, source: "user", problem: "p", action: "decided_by_user", rationale: "d", superseded: false });
const inv = (pause: S.InvestigatedPause, other: string | null = null): S.Investigation => ({ pause, other: other === null ? null : id(other) });

test("positionOf keeps a concern and a remedy that are not blank, and refuses a blank one", () => {
  assert.deepEqual(positionOf({ concern: "safety", remedy: "a guard" }), Result.succeed({ concern: "safety", remedy: "a guard" }));
  assert.deepEqual(positionOf({ concern: " ", remedy: "a guard" }), Result.fail("blank"));
  assert.deepEqual(positionOf({ concern: "safety", remedy: "" }), Result.fail("blank"));
});

test("resolutionOf: null stays null, a blank text or change is refused", () => {
  assert.deepEqual(resolutionOf(null), Result.succeed(null));
  assert.deepEqual(resolutionOf({ text: "both", changes: ["behavior 7"] }), Result.succeed(resolution("both", ["behavior 7"])));
  assert.deepEqual(resolutionOf({ text: "\n", changes: [] }), Result.fail("blank"));
  assert.deepEqual(resolutionOf({ text: "both", changes: ["", "x"] }), Result.fail("blank"));
});

test("changesAuthority is true exactly where the resolution names a change", () => {
  assert.equal(changesAuthority(resolution("both")), false);
  assert.equal(changesAuthority(resolution("both", ["requirement 2"])), true);
});

test("previousRound is the latest round before the given one, the previous phase's last for a later phase's first", () => {
  const log = [reviewEntry("A", "accepted", { phase: 1, round: 1 }), reviewEntry("B", "rejected", { phase: 1, round: 3 }), reviewEntry("C", "rejected", { phase: 2, round: 1 })];
  assert.deepEqual(previousRound(log, 1, 4), { phase: 1, round: 3 });
  assert.deepEqual(previousRound(log, 2, 1), { phase: 1, round: 3 });
  assert.deepEqual(previousRound(log, 2, 2), { phase: 2, round: 1 });
  assert.equal(previousRound(log, 1, 1), null);
});

test("resolutionOutcomes: an agreed resolution, one put to the developer, one raised again and one superseded", () => {
  const log = [
    reviewEntry("A", "partially_accepted", { round: 2, resolution: resolution("meets both") }),
    reviewEntry("B", "rejected", { round: 2, resolution: resolution("would change", ["requirement 1"]) }),
    reviewEntry("C", "partially_accepted", { round: 2, resolution: resolution("raised") }),
    reviewEntry("D", "partially_accepted", { round: 2, resolution: resolution("old"), superseded: true }),
    reviewEntry("E", "partially_accepted", { round: 1, resolution: resolution("earlier round") }),
    selfEntry("S", "accepted", { round: 2, resolution: resolution("self agreed") }),
    selfEntry("T", "correction_disputed", { round: 2, resolution: resolution("self authority", ["a decision"]) }),
  ];
  const out = resolutionOutcomes(log, ["C"], 1, 3);
  assert.deepEqual(out.agreed.map((a) => [a.id, a.resolution.text]), [["A", "meets both"], ["S", "self agreed"]]);
  assert.deepEqual(out.authority.map((e) => e.id), ["B"]);
});

test("resolutionOutcomes reads the previous work review's last round for a later work review's first", () => {
  const log = [reviewEntry("W1-R2-1", "partially_accepted", { phase: 1, round: 2, resolution: resolution("carried out") })];
  assert.deepEqual(resolutionOutcomes(log, [], 2, 1).agreed.map((a) => a.id), ["W1-R2-1"]);
});

test("investigatedIds holds exactly the ids with a non-empty record", () => {
  const log = [reviewEntry("A", "rejected", { investigations: [inv("reraised")] }), reviewEntry("B", "rejected"), selfEntry("S", "correction_disputed", { investigations: [inv("disputedSelfCorrection")] })];
  assert.deepEqual([...investigatedIds(log)].sort(), ["A", "S"]);
});

test("standingDisputes: each kind stands under its own condition and stops when it fails", () => {
  const kinds = (log: readonly LogEntry[]) => standingDisputes(log).map((d) => [d.id, d.investigation.pause]);
  assert.deepEqual(kinds([reviewEntry("A", "rejected", { investigations: [inv("reraised")] })]), [["A", "reraised"]]);
  assert.deepEqual(kinds([reviewEntry("A", "accepted", { investigations: [inv("reraised")] })]), []);
  // A disputed self-correction later turned accepted.
  assert.deepEqual(kinds([selfEntry("S", "correction_disputed", { investigations: [inv("disputedSelfCorrection")] })]), [["S", "disputedSelfCorrection"]]);
  assert.deepEqual(kinds([selfEntry("S", "accepted", { investigations: [inv("disputedSelfCorrection")] })]), []);
  // An accepted reversal that still names reverses stands; one whose reverses is now null does not.
  assert.deepEqual(kinds([reviewEntry("B", "accepted", { reverses: id("A"), investigations: [inv("reversal", "A")] })]), [["B", "reversal"]]);
  assert.deepEqual(kinds([reviewEntry("B", "rejected", { investigations: [inv("reversal", "A")] })]), []);
  // A repetition whose new disposition is accepted stands while its earlier id is not accepted in full.
  const repeat = reviewEntry("B", "accepted", { duplicate_of: id("A"), investigations: [inv("repeatedUnderNewId", "A")] });
  assert.deepEqual(kinds([reviewEntry("A", "rejected"), repeat]), [["B", "repeatedUnderNewId"]]);
  assert.deepEqual(kinds([reviewEntry("A", "accepted"), repeat]), []);
  // A clarification answered.
  assert.deepEqual(kinds([reviewEntry("A", "clarification_requested", { investigations: [inv("secondClarification")] })]), [["A", "secondClarification"]]);
  assert.deepEqual(kinds([reviewEntry("A", "accepted", { investigations: [inv("secondClarification")] })]), []);
  // A user decision superseding the entry.
  assert.deepEqual(kinds([reviewEntry("A", "rejected", { superseded: true, investigations: [inv("reraised")] }), userEntry("A")]), []);
  // An entry with two records yields both while each stands.
  const two = reviewEntry("B", "rejected", { duplicate_of: id("A"), reverses: id("C"), investigations: [inv("repeatedUnderNewId", "A"), inv("reversal", "C")] });
  assert.deepEqual(kinds([reviewEntry("A", "rejected"), two]), [["B", "repeatedUnderNewId"], ["B", "reversal"]]);
  assert.deepEqual(kinds([reviewEntry("A", "accepted"), two]), [["B", "reversal"]]);
});
