import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { appendRound } from "../src/issueLog.ts";
import { keptBaselineOf } from "../src/keptCorrections.ts";
import type { IssueId, ValidatedRound } from "../src/round.ts";
import type { LogEntry } from "../src/schema.ts";

// Issue #232: over any sequence of rounds, the passages the log keeps follow one rule: this round's entry of an id wins;
// otherwise the earlier passages stand; a validated reversal clears them.
const IDS = ["A", "B", "C", "D"] as const;
const id = fc.constantFrom(...IDS);
const passages = fc.array(fc.constantFrom("p", "q", "r"), { maxLength: 2 });
const roundSpec = fc.record({
  issues: fc.uniqueArray(fc.record({ id, accepted: fc.boolean() }), { selector: (i) => i.id, maxLength: 3 }),
  self: fc.uniqueArray(fc.record({ id, action: fc.constantFrom("accepted" as const, "rejected" as const, "plan_error" as const) }), { selector: (s) => s.id, maxLength: 2 }),
  entries: fc.uniqueArray(fc.record({ id, passages }), { selector: (e) => e.id, maxLength: 3 }),
  reverse: fc.option(id, { nil: null }),
});
type Spec = typeof roundSpec extends fc.Arbitrary<infer T> ? T : never;

const roundOf = (spec: Spec, n: number, log: readonly LogEntry[]): ValidatedRound => {
  const current = new Set(log.filter((e) => !e.superseded).map((e) => e.id as string));
  const rejected = spec.issues.find((i) => !i.accepted);
  // validateRound keeps a reverses only where it names another current entry; the property builds only such a reference.
  const reverses = rejected !== undefined && spec.reverse !== null && spec.reverse !== rejected.id && current.has(spec.reverse) ? spec.reverse : null;
  return {
    phase: 1,
    round: n,
    review: { issues: spec.issues.map((i) => ({ id: i.id as IssueId, severity: "major", location: "l", problem: "p", evidence: "e", workEffect: null, position: null })) },
    dispositions: spec.issues.map((i) => ({ id: i.id as IssueId, action: i.accepted ? "accepted" : "rejected", rationale: "r", duplicateOf: null, reverses: i === rejected ? (reverses as IssueId | null) : null, taskDispute: false, workEffect: null, position: null, resolution: null })),
    selfCorrections: spec.self.map((s) => ({ id: s.id as IssueId, newAction: s.action, explanation: "x", generated: false, position: null, resolution: null })),
    notes: [],
    reviewerFeedback: "",
    questionsForUser: [],
    correctionPassages: spec.entries,
  };
};

const model = (state: ReadonlyMap<string, readonly string[]>, r: ValidatedRound): ReadonlyMap<string, readonly string[]> => {
  const entry = (i: string) => r.correctionPassages.find((e) => e.id === i)?.passages;
  const next = new Map(state);
  for (const [i, ps] of state) if (entry(i) !== undefined) next.set(i, entry(i)!);
  for (const s of r.selfCorrections) next.set(s.id, entry(s.id) ?? state.get(s.id) ?? []);
  for (const d of r.dispositions) next.set(d.id, entry(d.id) ?? (d.action === "accepted" ? [] : (state.get(d.id) ?? [])));
  for (const d of r.dispositions) if (d.reverses !== null) next.set(d.reverses, []);
  return next;
};

test("keptBaselineOf after any sequence of rounds equals the reference model", () => {
  fc.assert(
    fc.property(fc.array(roundSpec, { maxLength: 6 }), (specs) => {
      let log: readonly LogEntry[] = [];
      let state: ReadonlyMap<string, readonly string[]> = new Map();
      specs.forEach((spec, k) => {
        const r = roundOf(spec, k + 1, log);
        log = appendRound(log, r, null);
        state = model(state, r);
      });
      const expected = [...state].filter(([, ps]) => ps.length > 0).sort(([a], [b]) => a.localeCompare(b));
      const actual = keptBaselineOf(log, 1).map((c) => [c.id, c.passages] as const).sort(([a], [b]) => a.localeCompare(b));
      assert.deepEqual(actual, expected);
    }),
    { numRuns: 300 },
  );
});
