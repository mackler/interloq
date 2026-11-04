// Issue #243 (Q1): the run's registry of disputes put to the developer. A dispute's question outlives its review loop:
// answered during the loop it is read at the loop's boundary and acknowledged; answered after, taken at the next point
// the run can still change the work; unanswered at the run's end, withdrawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import * as R from "../src/openDisputes.ts";
import { keepsPlannerPosition, type BesideKey } from "../src/reviewState.ts";
import * as prompts from "../src/prompts.ts";

const options = [
  { label: prompts.REVIEWER_POSITION, description: "do the change" },
  { label: prompts.PLANNER_POSITION, description: "keep it" },
];
const dispute = (n: number, owner: R.DisputeOwner = { _tag: "Run" }): R.OpenDispute => ({
  key: `d/1/R1/k${n}` as BesideKey,
  heading: "Planning phase 1",
  subject: { plan: 1 },
  phase: 1,
  round: 1,
  id: null,
  recordSubject: "s",
  reviewer: "do the change",
  planner: "keep it",
  options,
  owner,
});
const keyOf = (n: number) => `d/1/R1/k${n}` as BesideKey;
const TEXTS = [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION, "something else"];

type Op =
  | Readonly<{ op: "answer"; n: number; text: string }>
  | Readonly<{ op: "peek"; ns: readonly number[] }>
  | Readonly<{ op: "acknowledge"; ns: readonly number[] }>
  | Readonly<{ op: "loopEnded"; ns: readonly number[] }>
  | Readonly<{ op: "take" }>
  | Readonly<{ op: "withdrawOwned"; decision: number | null }>
  | Readonly<{ op: "withdrawAll" }>;
const n = fc.integer({ min: 0, max: 4 });
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("answer" as const), n, text: fc.constantFrom(...TEXTS) }),
  fc.record({ op: fc.constant("peek" as const), ns: fc.array(n) }),
  fc.record({ op: fc.constant("acknowledge" as const), ns: fc.array(n) }),
  fc.record({ op: fc.constant("loopEnded" as const), ns: fc.array(n) }),
  fc.constant({ op: "take" as const }),
  fc.record({ op: fc.constant("withdrawOwned" as const), decision: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }) }),
);
const ownerOf = (i: number): R.DisputeOwner => (i % 3 === 2 ? { _tag: "Decision", decision: (i % 2) + 1 } : { _tag: "Run" });

test("property: every key opened leaves the registry exactly once; peek changes nothing; take returns only Run-owned answers out of their loop; an answer before a withdrawal is in it", () => {
  fc.assert(
    fc.property(fc.array(arbOp, { maxLength: 30 }), (ops) => {
      let reg: R.Registry = R.EMPTY_REGISTRY;
      for (let i = 0; i < 5; i++) [, reg] = R.opened(reg, dispute(i, ownerOf(i)));
      const left = new Map<string, number>();
      const answeredText = new Map<string, string>();
      const count = (k: string) => left.set(k, (left.get(k) ?? 0) + 1);
      const gone = new Set<string>();
      for (const o of [...ops, { op: "withdrawAll" } as const]) {
        switch (o.op) {
          case "answer": {
            const [r, next] = R.answered(reg, keyOf(o.n), o.text);
            assert.equal(r, gone.has(keyOf(o.n)) ? "tooLate" : "kept");
            if (r === "kept") answeredText.set(keyOf(o.n), o.text);
            reg = next;
            break;
          }
          case "peek": {
            const [seen, next] = R.peeked(reg, o.ns.map(keyOf));
            assert.deepEqual(next, reg);
            for (const a of seen) assert.equal(a.text, answeredText.get(a.dispute.key));
            break;
          }
          case "acknowledge": {
            const before = reg;
            [, reg] = R.acknowledged(reg, o.ns.map(keyOf));
            for (const e of before) if (!reg.includes(e)) (count(e.dispute.key), gone.add(e.dispute.key));
            break;
          }
          case "loopEnded":
            [, reg] = R.loopEnded(reg, o.ns.map(keyOf));
            break;
          case "take": {
            const inLoop = new Set(reg.filter((e) => e.inLoop).map((e) => e.dispute.key));
            const [taken, next] = R.takenAfterLoop(reg);
            for (const a of taken) {
              assert.equal(a.dispute.owner._tag, "Run");
              assert.ok(!inLoop.has(a.dispute.key));
              assert.equal(a.applies, !keepsPlannerPosition(a.dispute.options, a.text));
              count(a.dispute.key);
              gone.add(a.dispute.key);
            }
            reg = next;
            break;
          }
          case "withdrawOwned":
          case "withdrawAll": {
            const owner: R.DisputeOwner | null = o.op === "withdrawAll" ? null : o.decision === null ? { _tag: "Run" } : { _tag: "Decision", decision: o.decision };
            const [w, next] = owner === null ? R.withdrawnAll(reg) : R.withdrawnOwned(reg, owner);
            for (const d of w.withdrawn) (assert.ok(!answeredText.has(d.key), "an answered dispute withdrawn as unanswered"), count(d.key), gone.add(d.key));
            for (const a of w.answered) (assert.equal(a.text, answeredText.get(a.dispute.key)), count(a.dispute.key), gone.add(a.dispute.key));
            reg = next;
            break;
          }
        }
      }
      assert.deepEqual(reg, []);
      for (let i = 0; i < 5; i++) assert.equal(left.get(keyOf(i)), 1, `key ${i} left ${left.get(keyOf(i)) ?? 0} times`);
    }),
    { numRuns: 300, seed: 243 },
  );
});

test("an answered Run-owned dispute peeked and not acknowledged before its loop ended is taken after it; a decision's is not", () => {
  let reg: R.Registry = R.EMPTY_REGISTRY;
  [, reg] = R.opened(reg, dispute(0));
  [, reg] = R.opened(reg, dispute(1, { _tag: "Decision", decision: 1 }));
  [, reg] = R.answered(reg, keyOf(0), prompts.REVIEWER_POSITION);
  [, reg] = R.answered(reg, keyOf(1), prompts.REVIEWER_POSITION);
  const [inLoop] = R.takenAfterLoop(reg);
  assert.deepEqual(inLoop, [], "nothing is taken while in its loop");
  const [seen] = R.peeked(reg, [keyOf(0)]);
  assert.equal(seen.length, 1);
  [, reg] = R.loopEnded(reg, [keyOf(0), keyOf(1)]);
  const [taken, after] = R.takenAfterLoop(reg);
  assert.deepEqual(taken.map((a) => [a.dispute.key, a.applies]), [[keyOf(0), true]]);
  assert.equal(after.length, 1);
  const [w] = R.withdrawnOwned(after, { _tag: "Decision", decision: 1 });
  assert.deepEqual(w.answered.map((a) => a.dispute.key), [keyOf(1)]);
  assert.equal(R.answered(R.EMPTY_REGISTRY, keyOf(3), "x")[0], "tooLate");
});

test("W7-R1-1: isRegistered holds exactly for a key opened and not withdrawn", () => {
  fc.assert(
    fc.property(fc.uniqueArray(n, { maxLength: 5 }), fc.subarray([0, 1, 2, 3, 4]), n, (opened, withdrawn, probe) => {
      const r0 = opened.reduce((r, i) => R.opened(r, dispute(i, { _tag: "Decision", decision: i }))[1], R.EMPTY_REGISTRY);
      const r1 = withdrawn.reduce((r, i) => R.withdrawnOwned(r, { _tag: "Decision", decision: i })[1], r0);
      assert.equal(R.isRegistered(r1, keyOf(probe)), opened.includes(probe) && !withdrawn.includes(probe));
    }),
  );
});
