import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRound, correctionCount, correctionsDue, displayEntry } from "../src/issueLog.ts";
import type { IssueId, ValidatedRound } from "../src/round.ts";

// Plan step 2.4 (P1-R1-1 of this run, rounds 1 and 2): a work review leaves for a planning phase when the round has a
// correction due: an accepted or partially accepted disposition, or an effective self-correction accepted or plan_error.
const id = (s: string) => s as IssueId;
const round = (dispositions: [string, ValidatedRound["dispositions"][number]["action"]][], self: [string, "accepted" | "rejected" | "plan_error"][] = []): ValidatedRound => ({
  phase: 1,
  round: 1,
  review: { issues: dispositions.map(([i]) => ({ id: id(i), severity: "major", location: "l", problem: "p", evidence: "e", workEffect: null })) },
  dispositions: dispositions.map(([i, action]) => ({ id: id(i), action, rationale: "r", duplicateOf: null, reverses: null, taskDispute: false, workEffect: null })),
  selfCorrections: self.map(([i, newAction]) => ({ id: id(i), newAction, explanation: "x", generated: false })),
  notes: [],
  reviewerFeedback: "",
  questionsForUser: [],
});

test("correctionsDue: an accepted or partially accepted disposition", () => {
  assert.equal(correctionsDue(round([["A", "accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "partially_accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"], ["B", "no_change_needed"], ["C", "clarification_requested"]])), false);
});

test("correctionsDue: an accepted self-correction of an earlier issue, and a plan_error", () => {
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-1", "accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-9", "plan_error"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-1", "rejected"]])), false);
});

test("correctionsDue: a self-correction superseded by the round's disposition of the same id does not count", () => {
  const overlapping = round([["X", "rejected"]], [["X", "accepted"]]);
  assert.equal(correctionsDue(overlapping), false);
  // In agreement with the log appendRound writes: the disposition's entry is the current one.
  const log = appendRound([], overlapping, null);
  assert.deepEqual(log.filter((e) => e.superseded !== true).map((e) => [e.id, e.action]), [["X", "rejected"]]);
});

// Issue #14 (Q2): the finished loop's line counts the corrections of its cycles, from the response the page receives.
test("correctionCount: accepted and partially accepted dispositions and effective self-corrections outside the review", () => {
  const response = (actions: string[], self: [string, "accepted" | "rejected" | "plan_error"][] = []) => ({
    dispositions: actions.map((action, i) => ({ id: `R${i}`, action: action as "accepted", rationale: "r", duplicate_of: "", reverses: "" })),
    self_corrections: self.map(([i, new_action]) => ({ id: i, new_action, explanation: "x" })),
  });
  const ids = ["R0", "R1", "R2", "R3", "R4"];
  assert.equal(correctionCount([], response([])), 0);
  assert.equal(correctionCount(ids, response(["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"])), 2);
  assert.equal(correctionCount(ids, response([], [["", "plan_error"], ["P1-R1-2", "accepted"]])), 2, "effective self-corrections outside the review count");
  assert.equal(correctionCount(ids, response(["rejected"], [["R0", "accepted"]])), 0, "a self-correction of an issue of the same review is superseded");
  assert.equal(correctionCount(ids, response([], [["P1-R1-2", "rejected"]])), 0, "a rejecting self-correction is not a correction");
});

// Issue #31: the change of the round's response is stamped on every entry the round appends; a user's decision has none.
test("appendRound stamps the round's file change on each entry it appends", () => {
  const change = { changed: true, added: 2, removed: 1 };
  const log = appendRound([], round([["A", "accepted"], ["B", "rejected"]], [["P1-S1-1", "plan_error"]]), change);
  assert.equal(log.length, 3);
  for (const e of log) assert.deepEqual("file_change" in e ? e.file_change : undefined, change);
  const unmeasured = appendRound([], round([["A", "accepted"]]), null);
  assert.equal("file_change" in unmeasured[0]! ? unmeasured[0].file_change : undefined, null);
});

// Q6: the measurement goes to the records and to Codex only; what the user is shown of an entry omits it.
test("displayEntry omits file_change and keeps everything else", () => {
  const [entry] = appendRound([], round([["A", "accepted"]]), { changed: false, added: 0, removed: 0 });
  const shown = displayEntry(entry!);
  assert.equal("file_change" in shown, false);
  const { file_change: _f, ...rest } = entry as typeof entry & { file_change: unknown };
  assert.deepEqual(shown, rest);
});

// Issue #183: a review entry carries both agents' statements of the issue's effect on the work in its round.
test("appendRound writes work_effects where the issue and the disposition both state one, and null otherwise", () => {
  const none = { kind: "none" as const };
  const differs = { kind: "differs" as const, difference: "the README stays unwrapped" as import("../src/schema.ts").EffectText };
  const base = round([["A", "rejected"], ["B", "accepted"], ["C", "rejected"], ["D", "rejected"]]);
  const withEffects: ValidatedRound = {
    ...base,
    review: { issues: base.review.issues.map((i) => ({ ...i, workEffect: i.id === "D" ? null : none })) },
    dispositions: base.dispositions.map((d) => ({ ...d, workEffect: d.id === "A" ? differs : d.id === "C" ? null : d.id === "D" ? none : null })),
  };
  const entries = appendRound([], withEffects, null);
  assert.deepEqual(
    entries.map((e) => [e.id, e.source === "review" ? e.work_effects : "?"]),
    [["A", { reviewer: none, planner: differs }], ["B", null], ["C", null], ["D", null]],
  );
});
