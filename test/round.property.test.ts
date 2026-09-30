import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import * as log from "../src/issueLog.ts";
import { type IssueId, validateReview, validateRound } from "../src/round.ts";
import type { Action, LogEntry, PlannerResponse, Review } from "../src/schema.ts";
import { questionOf } from "./helpers.ts";

// Properties of round validation, the log transitions, detection and counting: rows 1 and 2 of the table in
// recommendation E of docs/functional-design-review.md. Valid rounds are generated directly; invalid boundary
// data is generated separately. numRuns ≤ 200, a fixed seed, and fast-check shrinks a failure to a small case.

const RUNS = { numRuns: 200, seed: 20260925 };
// fc.record builds null-prototype objects by default; the program's values are plain objects.
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const ACTIONS: readonly Action[] = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"];
const NEW_ACTIONS = ["accepted", "rejected", "plan_error"] as const;

const arbId = fc.stringMatching(/^[A-Z][A-Z0-9-]{0,7}$/);
const arbIssue = (id: string) => record({ id: fc.constant(id), severity: fc.constantFrom("blocking", "major", "minor"), location: fc.string(), problem: fc.string(), evidence: fc.string() });
const arbReview: fc.Arbitrary<Review> = fc.uniqueArray(arbId, { minLength: 0, maxLength: 5 }).chain((ids) => fc.tuple(...ids.map(arbIssue)).map((issues) => ({ issues })));
const arbEntry = (id: string): fc.Arbitrary<LogEntry> =>
  fc.oneof(
    record({ id: fc.constant(id as IssueId), phase: fc.constant(0), round: fc.constant(0), source: fc.constant("review" as const), severity: fc.constantFrom("blocking", "major", "minor"), location: fc.string(), problem: fc.string(), evidence: fc.string(), action: fc.constantFrom(...ACTIONS), rationale: fc.string(), duplicate_of: fc.constant(null), reverses: fc.constant(null), superseded: fc.constant(false), file_change: fc.constant(null) }),
    record({ id: fc.constant(id as IssueId), phase: fc.constant(0), round: fc.constant(0), source: fc.constant("user" as const), problem: fc.string(), action: fc.constant("decided_by_user" as const), rationale: fc.string(), superseded: fc.constant(false) }),
  );
const arbLog: fc.Arbitrary<LogEntry[]> = fc.uniqueArray(arbId, { maxLength: 4 }).chain((ids) => fc.tuple(...ids.map(arbEntry)));
/** A complete, valid response to a review: one disposition per issue, references from the log or unknown. */
const arbResponse = (review: Review, history: LogEntry[]): fc.Arbitrary<PlannerResponse> => {
  const known = history.map((e) => e.id);
  const ref = fc.oneof({ weight: 3, arbitrary: fc.constant("") }, { weight: 2, arbitrary: known.length > 0 ? fc.constantFrom(...known) : fc.constant("") }, { weight: 1, arbitrary: arbId });
  return record({
    dispositions: fc.tuple(...review.issues.map((i) => record({ id: fc.constant(i.id), action: fc.constantFrom(...ACTIONS), rationale: fc.string(), duplicate_of: ref, reverses: ref }))),
    self_corrections: fc.array(record({ id: fc.oneof(fc.constant(""), arbId), new_action: fc.constantFrom(...NEW_ACTIONS), explanation: fc.string() }), { maxLength: 2 }),
    reviewer_feedback: fc.string(),
    questions_for_user: fc.array(fc.record({ context: fc.string(), question: fc.string(), options: fc.array(fc.record({ label: fc.string(), description: fc.string() }), { maxLength: 2 }) }).map((w) => questionOf(w)), { maxLength: 2 }),
  });
};
const arbRound = fc.tuple(arbReview, arbLog).chain(([review, history]) => arbResponse(review, history).map((response) => ({ review, history, response })));
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") for (const v of Object.values(value as object)) deepFreeze(v);
  return Object.freeze(value);
};
const validate = ({ review, history, response }: { review: Review; history: LogEntry[]; response: PlannerResponse }) => {
  const validated = validateReview(review);
  assert.ok(Result.isSuccess(validated), "a generated review with unique ids was rejected");
  return validateRound(validated.success, response, history, 1, 1, "P");
};

test("property: a generated valid round validates, its inputs are unchanged, and every review issue gets exactly one current entry", () => {
  fc.assert(
    fc.property(arbRound, (round) => {
      const frozen = deepFreeze(structuredClone(round));
      const result = validate(frozen);
      assert.ok(Result.isSuccess(result), "valid round rejected");
      assert.deepEqual(frozen, round);
      const after = log.appendRound(frozen.history, result.success, null);
      for (const issue of frozen.review.issues) assert.equal(after.filter((e) => e.id === issue.id && e.superseded !== true).length, 1, `issue ${issue.id}`);
      assert.equal(after.length, frozen.history.length + frozen.review.issues.length + frozen.response.self_corrections.length);
    }),
    RUNS,
  );
});

test("property: a duplicate, an extra or a missing disposition, or an empty required id, fails validation; the sentinels succeed", () => {
  fc.assert(
    fc.property(arbRound.filter((r) => r.review.issues.length > 0), fc.nat(), (round, pick) => {
      const ds = round.response.dispositions;
      const i = pick % ds.length;
      const duplicated = { ...round, response: { ...round.response, dispositions: [...ds, ds[i]] } };
      const missing = { ...round, response: { ...round.response, dispositions: ds.filter((_, k) => k !== i) } };
      const extra = { ...round, response: { ...round.response, dispositions: [...ds, { ...ds[i], id: "ZZ-EXTRA" }] } };
      const emptyDisposition = { ...round, response: { ...round.response, dispositions: ds.map((d, k) => (k === i ? { ...d, id: "" } : d)) } };
      for (const bad of [duplicated, missing, extra, emptyDisposition]) assert.ok(Result.isFailure(validate(bad)), "an invalid round validated");
      const emptyIssue: Review = { issues: round.review.issues.map((x, k) => (k === i ? { ...x, id: "" } : x)) };
      assert.ok(Result.isFailure(validateReview(emptyIssue)), "an empty issue id validated");
      // The wire sentinels: "" in duplicate_of / reverses is "no reference", "" as a self-correction id is "new".
      const sentinels = { ...round, response: { ...round.response, dispositions: ds.map((d) => ({ ...d, duplicate_of: "", reverses: "" })), self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "e" }] } };
      const result = validate(sentinels);
      assert.ok(Result.isSuccess(result), "the sentinels were rejected");
      assert.ok(result.success.dispositions.every((d) => d.duplicateOf === null && d.reverses === null));
      assert.deepEqual(result.success.notes, []);
      assert.equal(result.success.selfCorrections[0].generated, true);
    }),
    RUNS,
  );
});

test("property: a user decision supersedes earlier entries of its id, and the one-current-entry invariant holds after any sequence of valid rounds and decisions", () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(arbRound, fc.option(fc.tuple(arbId, fc.string()), { nil: null })), { maxLength: 4 }), (steps) => {
      let history: readonly LogEntry[] = [];
      let phase = 1;
      for (const [round, decision] of steps) {
        const validated = validateReview(round.review);
        if (!Result.isSuccess(validated)) return;
        const result = validateRound(validated.success, round.response, history, phase, 1, "P");
        if (!Result.isSuccess(result)) return; // a generated id may collide with the growing history; that is a valid RoundInvalid
        history = log.appendRound(history, result.success, null);
        if (decision !== null) history = log.appendUserDecision(history, decision[0] as IssueId, decision[1], phase, 1);
        phase++;
      }
      const currentIds = history.filter((e) => e.superseded !== true).map((e) => e.id);
      assert.equal(new Set(currentIds).size, currentIds.length, `more than one current entry: ${currentIds.join(",")}`);
      for (const [, decision] of steps) {
        if (decision === null) continue;
        const entries = history.filter((e) => e.id === decision[0]);
        const last = entries.at(-1);
        assert.ok(last !== undefined && entries.slice(0, -1).every((e) => e.superseded === true));
      }
    }),
    RUNS,
  );
});

test("property: detection and counting laws", () => {
  fc.assert(
    fc.property(arbRound, fc.boolean(), (round, countMinor) => {
      const validated = validateReview(round.review);
      assert.ok(Result.isSuccess(validated));
      const result = validate(round);
      assert.ok(Result.isSuccess(result));
      const current = round.history.filter((e) => e.superseded !== true);
      const notAccepted = new Set<string>(current.filter((e) => ["rejected", "partially_accepted", "no_change_needed"].includes(e.action)).map((e) => e.id));
      assert.deepEqual(log.reraisedIds(round.history, round.review), round.review.issues.map((i) => i.id).filter((id) => notAccepted.has(id)));
      const asked = new Set<string>(round.history.filter((e) => e.action === "clarification_requested").map((e) => e.id));
      for (const id of log.secondClarifications(round.history, result.success)) assert.ok(asked.has(id));
      const all = log.countedIssues(round.review, true);
      assert.equal(all, round.review.issues.length);
      assert.ok(log.countedIssues(round.review, false) <= all);
      void countMinor;
    }),
    RUNS,
  );
});

test("property: a bijective renaming of ids commutes with the detections", () => {
  fc.assert(
    fc.property(arbRound, (round) => {
      const rename = (id: string): string => (id === "" ? "" : `R_${id}`);
      const renamedReview: Review = { issues: round.review.issues.map((i) => ({ ...i, id: rename(i.id) })) };
      const renamedHistory: LogEntry[] = round.history.map((e) => ({ ...e, id: rename(e.id) as IssueId }));
      const renamedResponse: PlannerResponse = {
        ...round.response,
        dispositions: round.response.dispositions.map((d) => ({ ...d, id: rename(d.id), duplicate_of: rename(d.duplicate_of), reverses: rename(d.reverses) })),
        self_corrections: round.response.self_corrections.map((s) => ({ ...s, id: rename(s.id) })),
      };
      const a = validate(round);
      const b = validate({ review: renamedReview, history: renamedHistory, response: renamedResponse });
      assert.ok(Result.isSuccess(a) && Result.isSuccess(b));
      assert.deepEqual(log.reraisedIds(renamedHistory, renamedReview), log.reraisedIds(round.history, round.review).map((id) => rename(id)));
      assert.deepEqual(log.repeatedUnderNewId(renamedHistory, b.success), log.repeatedUnderNewId(round.history, a.success).map(([x, y]) => [rename(x), rename(y)]));
      assert.deepEqual(log.reversals(b.success), log.reversals(a.success).map(([x, y]) => [rename(x), rename(y)]));
      assert.deepEqual(log.secondClarifications(renamedHistory, b.success), log.secondClarifications(round.history, a.success).map((id) => rename(id)));
      assert.equal(log.acceptedCount(b.success), log.acceptedCount(a.success));
    }),
    RUNS,
  );
});
