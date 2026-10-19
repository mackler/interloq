// Issue #184 (S1): properties of Interloq's choice of the next agreed question of the first interview
// (src/clarificationState.ts) over lists with chains of skip conditions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { type AgreedAnswer, type PremiseEntry, orderBySkipCondition, skippedQuestions, waitingFor } from "../src/premises.ts";
import { type ClarificationState, INITIAL_CLARIFICATION, nextAgreed, nextQuestion, progressOf, withAnswer, withEnded, withFollowUps, withShown } from "../src/clarificationState.ts";
import { opt } from "./helpers.ts";

const RUNS = { numRuns: 150, seed: 20261019 };
const LABELS = ["a", "b", "c"];

/** A list ordered as questions.json is: each question names an earlier one or none, then ordered by orderBySkipCondition. */
const arbList: fc.Arbitrary<readonly PremiseEntry[]> = fc
  .integer({ min: 1, max: 7 })
  .chain((n) =>
    fc.tuple(
      fc.tuple(...Array.from({ length: n }, (_, i) => fc.option(fc.tuple(fc.integer({ min: 0, max: Math.max(0, i - 1) }), fc.constantFrom(...LABELS)), { nil: null, freq: 2 }))),
      fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }),
    ),
  )
  .map(([parents, order]) => {
    const entries: PremiseEntry[] = parents.map((p, i) => ({ id: `Q${i + 1}`, proposed_answers: LABELS.map((l) => opt(l)), skip_if: p === null || i === 0 ? null : { question: `Q${p[0] + 1}`, answer: p[1] } }));
    const ordered = orderBySkipCondition(order.map((i) => entries[i]));
    return Result.isSuccess(ordered) ? ordered.success : [];
  });

const arbAnswer: fc.Arbitrary<AgreedAnswer> = fc.oneof(fc.constantFrom(...LABELS).map((label): AgreedAnswer => ({ kind: "option", label })), fc.constant<AgreedAnswer>({ kind: "text" }));

/** A state reached by answering, in turn, some of the questions nextAgreed returns. */
const arbRun = arbList.chain((questions) =>
  fc.tuple(fc.constant(questions), fc.array(arbAnswer, { maxLength: 8 }), fc.boolean()).map(([qs, answers, showNext]) => {
    const state = answers.reduce<ClarificationState>((s, a) => {
      const q = nextAgreed(qs, s);
      return q === null ? s : withAnswer(withShown(s, q.id), q.id, a);
    }, INITIAL_CLARIFICATION);
    const next = nextAgreed(qs, state);
    return { questions: qs, state: showNext && next !== null ? withShown(state, next.id) : state };
  }),
);

test("nextAgreed is the first question in list order unanswered, not skipped, not waiting and not shown", () => {
  fc.assert(
    fc.property(arbRun, ({ questions, state }) => {
      const skipped = skippedQuestions(questions, state.answers).map((k) => k.id);
      const expected = questions.find((q) => !state.answers.has(q.id) && !skipped.includes(q.id) && waitingFor(questions, state.answers, q.id) === null && !state.shown.includes(q.id)) ?? null;
      assert.equal(nextAgreed(questions, state), expected);
    }),
    RUNS,
  );
});

test("nextAgreed never returns a question whose premise is unanswered", () => {
  fc.assert(
    fc.property(arbRun, ({ questions, state }) => {
      const q = nextAgreed(questions, state);
      assert.ok(q === null || waitingFor(questions, state.answers, q.id) === null);
    }),
    RUNS,
  );
});

test("answering every question returned visits each question not skipped exactly once", () => {
  fc.assert(
    fc.property(arbList, fc.array(arbAnswer, { minLength: 8, maxLength: 8 }), (questions, answers) => {
      const visit = (s: ClarificationState, i: number, seen: readonly string[]): Readonly<{ s: ClarificationState; seen: readonly string[] }> => {
        const q = nextAgreed(questions, s);
        return q === null ? { s, seen } : visit(withAnswer(withShown(s, q.id), q.id, answers[i % answers.length]), i + 1, [...seen, q.id]);
      };
      const { s, seen } = visit(INITIAL_CLARIFICATION, 0, []);
      const skipped = skippedQuestions(questions, s.answers).map((k) => k.id);
      assert.deepEqual(new Set(seen).size, seen.length);
      assert.deepEqual([...seen].sort(), questions.map((q) => q.id).filter((id) => !skipped.includes(id)).sort());
    }),
    RUNS,
  );
});

test("the count never counts a skipped question and never answers more than its total", () => {
  fc.assert(
    fc.property(arbRun, ({ questions, state }) => {
      const ids = questions.map((q) => q.id);
      const skipped = skippedQuestions(questions, state.answers).map((k) => k.id);
      const count = progressOf(ids, questions, state);
      assert.ok(count.answered <= count.total);
      assert.equal(count.total, ids.filter((id) => !skipped.includes(id)).length);
      assert.equal(count.answered, [...state.answers.keys()].filter((id) => !skipped.includes(id)).length);
    }),
    RUNS,
  );
});

test("after /done no agreed question is offered, and only follow-ups are", () => {
  fc.assert(
    fc.property(arbRun, fc.boolean(), ({ questions, state }, withFollowUp) => {
      const ended = withEnded(state);
      assert.equal(nextAgreed(questions, ended), null);
      const f = { id: "F1", context: [], history: [], text: [], explanations: [], options: [] };
      const s = withFollowUp ? withFollowUps(ended, [f], questions.map((q) => q.id)) : ended;
      assert.equal(nextQuestion(questions, s).kind, withFollowUp ? "followUp" : "none");
    }),
    RUNS,
  );
});
