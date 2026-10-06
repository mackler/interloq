// Issue #99 (S2): properties of the skip conditions of a question list (src/premises.ts): the order is a stable
// topological one, a cycle is rejected, and the user's answers skip exactly the questions that depend on them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { type AgreedAnswer, type PremiseEntry, orderBySkipCondition, skipConditionProblems, skippedQuestions } from "../src/premises.ts";
import { opt } from "./helpers.ts";

const RUNS = { numRuns: 200, seed: 20261006 };
const LABELS = ["a", "b", "c"];

/**
 * A list whose conditions form a forest: the questions Q1…Qn are created in an order in which each names an earlier one
 * or none, then the list is shuffled.
 */
const arbForest: fc.Arbitrary<readonly PremiseEntry[]> = fc
  .integer({ min: 1, max: 7 })
  .chain((n) =>
    fc.tuple(
      fc.tuple(...Array.from({ length: n }, (_, i) => fc.option(fc.tuple(fc.integer({ min: 0, max: Math.max(0, i - 1) }), fc.constantFrom(...LABELS)), { nil: null, freq: 2 }))),
      fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }),
    ),
  )
  .map(([parents, order]) => {
    const entries: PremiseEntry[] = parents.map((p, i) => ({
      id: `Q${i + 1}`,
      proposed_answers: LABELS.map((l) => opt(l)),
      skip_if: p === null || i === 0 ? null : { question: `Q${p[0] + 1}`, answer: p[1] },
    }));
    return order.map((i) => entries[i]);
  });

const parentOf = (questions: readonly PremiseEntry[], id: string): string | null => questions.find((q) => q.id === id)?.skip_if?.question ?? null;
/** The ancestors of a question in a forest, nearest first. */
const ancestors = (questions: readonly PremiseEntry[], id: string): readonly string[] => {
  const p = parentOf(questions, id);
  return p === null ? [] : [p, ...ancestors(questions, p)];
};

test("property: the order of a forest is a permutation in which every question follows its premise, and is unchanged where nothing forces a change", () => {
  fc.assert(
    fc.property(arbForest, (questions) => {
      const ordered = orderBySkipCondition(questions);
      assert.ok(Result.isSuccess(ordered));
      const ids = ordered.success.map((q) => q.id);
      assert.deepEqual([...ids].sort(), questions.map((q) => q.id).sort());
      for (const q of ordered.success) if (q.skip_if !== null) assert.ok(ids.indexOf(q.skip_if.question) < ids.indexOf(q.id), `${q.id} before ${q.skip_if.question}`);
      const roots = (list: readonly PremiseEntry[]) => list.filter((q) => q.skip_if === null).map((q) => q.id);
      assert.deepEqual(roots(ordered.success), roots(questions));
      const alreadyOrdered = questions.every((q, i) => q.skip_if === null || questions.findIndex((p) => p.id === q.skip_if?.question) < i);
      if (alreadyOrdered) assert.deepEqual(ids, questions.map((q) => q.id));
      assert.deepEqual(skipConditionProblems(questions), []);
    }),
    RUNS,
  );
});

test("property: a condition that closes a loop is a cycle, which the order rejects and the checks report", () => {
  fc.assert(
    fc.property(
      arbForest.filter((qs) => qs.some((q) => q.skip_if !== null)),
      fc.nat(),
      (questions, pick) => {
        const dependents = questions.filter((q) => q.skip_if !== null);
        const node = dependents[pick % dependents.length];
        const chain = ancestors(questions, node.id);
        const root = chain[chain.length - 1];
        const looped = questions.map((q) => (q.id === root ? { ...q, skip_if: { question: node.id, answer: "a" } } : q));
        const ordered = orderBySkipCondition(looped);
        assert.ok(Result.isFailure(ordered));
        assert.equal(ordered.failure.kind, "cycle");
        const cycle = [node.id, ...chain];
        const reported = skipConditionProblems(looped).filter((p) => p.kind === "cycle");
        assert.equal(reported.length, 1);
        assert.deepEqual([...(reported[0] as { ids: readonly string[] }).ids].sort(), [...cycle].sort());
      },
    ),
    RUNS,
  );
});

test("property: the answers skip exactly the questions whose premise answer was chosen, and those below them; a text reply skips nothing", () => {
  const arbAnswer: fc.Arbitrary<AgreedAnswer> = fc.oneof(fc.constantFrom(...LABELS).map((label) => ({ kind: "option" as const, label })), fc.constant({ kind: "text" as const }));
  fc.assert(
    fc.property(
      arbForest.chain((questions) => fc.tuple(fc.constant(questions), fc.array(fc.tuple(fc.constantFrom(...questions.map((q) => q.id)), arbAnswer)))),
      ([questions, pairs]) => {
        const answers = new Map(pairs);
        const isSkipped = (id: string): boolean => {
          const condition = questions.find((q) => q.id === id)?.skip_if ?? null;
          if (condition === null) return false;
          const answer = answers.get(condition.question);
          return (answer?.kind === "option" && answer.label === condition.answer) || isSkipped(condition.question);
        };
        const expected = questions.filter((q) => isSkipped(q.id)).map((q) => q.id).sort();
        const skipped = skippedQuestions(questions, answers);
        assert.deepEqual(skipped.map((s) => s.id).sort(), expected);
        for (const s of skipped) assert.equal(s.question, parentOf(questions, s.id));
      },
    ),
    RUNS,
  );
});
