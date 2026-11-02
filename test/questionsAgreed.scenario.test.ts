// Issue #205: the page learns that the agreed question list is known, and how many questions it holds, from one event,
// QuestionsAgreed, notified once per question phase: after the question review and before any terms or question in a
// refinement run, and before the first question of a prepared item (issue #131), with the count 0 where the list is
// empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { runCommentKey } from "../src/itemComments.ts";
import { digestOf, preparedComments, type PreparedQuestion } from "../src/preparedComments.ts";
import { program } from "../src/program.ts";
import type * as S from "../src/schema.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { type FakeItem, seededId } from "./fakeTracker.ts";
import { entryOf, fakeTrackerOf, questionEntry, runRefinement, scriptedItem, scriptedStart, summaryReply, type TestOptions, tempRepo, testLayer, testWiring } from "./helpers.ts";

const entry: S.QuestionEntry = entryOf({
  id: "Q1",
  context: "A context.",
  question: "Which one?",
  reason: "it is open",
  proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
  default_answer: "A",
});
const termsEntry: S.TermsEntry = { id: entry.id, explanations: [], context: entry.context, history: entry.history, question: entry.question, reason: entry.reason, proposed_answers: entry.proposed_answers };
const closings = [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }];

const tags = (events: readonly UiEvent[]): string[] => events.map((e) => e._tag);
const agreedCounts = (events: readonly UiEvent[]): number[] => events.flatMap((e) => (e._tag === "QuestionsAgreed" ? [e.count] : []));
const questionsBegan = (events: readonly UiEvent[]): number => events.findIndex((e) => e._tag === "PhaseBegan" && e.phase.kind === "questions");
const before = (events: readonly UiEvent[], first: string, then: string) => {
  const a = tags(events).indexOf(first);
  const b = tags(events).indexOf(then);
  assert.ok(a >= 0 && b >= 0 && a < b, `${first} is not before ${then}: ${tags(events).join(", ")}`);
};
const afterQuestionsBegan = (events: readonly UiEvent[]) => {
  const began = questionsBegan(events);
  assert.ok(began >= 0 && began < tags(events).indexOf("QuestionsAgreed"), tags(events).join(", "));
};

test("(a) one agreed question with checked terms: QuestionsAgreed 1 after the phase begins and before the terms and the interview", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions: [entry] } }],
    closings,
    terms: [{ output: { entries: [termsEntry] } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  });
  await runRefinement(layer, "task", "checked");
  const events = probe.ui.notified;
  assert.deepEqual(agreedCounts(events), [1]);
  afterQuestionsBegan(events);
  before(events, "QuestionsAgreed", "TermsBegan");
  before(events, "QuestionsAgreed", "InterviewOpened");
});

test("(b) one agreed question with terms on request: QuestionsAgreed 1 before the interview", async () => {
  const { layer, probe } = testLayer(tempRepo(), { answers: ["1"], steps: [{ output: { questions: [entry] } }], closings, reviews: [{ issues: [] }, { issues: [] }] });
  await runRefinement(layer, "task", "onRequest");
  const events = probe.ui.notified;
  assert.deepEqual(agreedCounts(events), [1]);
  afterQuestionsBegan(events);
  before(events, "QuestionsAgreed", "InterviewOpened");
});

test("(c) an empty agreed list: QuestionsAgreed 0, then the phase ends with no conversation, and no terms or interview", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] });
  await runRefinement(layer, "task", "checked");
  const events = probe.ui.notified;
  assert.deepEqual(agreedCounts(events), [0]);
  afterQuestionsBegan(events);
  const agreed = tags(events).indexOf("QuestionsAgreed");
  const ended = events.findIndex((e) => e._tag === "PhaseEnded" && e.phase.kind === "questions" && e.result === "no conversation");
  assert.ok(ended > agreed, tags(events).join(", "));
  assert.ok(!tags(events).includes("TermsBegan") && !tags(events).includes("InterviewOpened"), tags(events).join(", "));
});

// A prepared item (issue #131), built as test/preparedRefinement.scenario.test.ts builds it.
const BASE: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("131")), title: "Prepare questions", body: "The developer's text.", state: "unrefined" };
const KEY = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131");
const stored = (id: string): S.StoredQuestion => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const prepared = (questions: readonly S.StoredQuestion[]): FakeItem => {
  const pqs: PreparedQuestion[] = questions.map((q) => ({ entry: q, terms: { id: q.id, explanations: [], context: q.context, history: q.history, question: q.question, reason: q.reason, proposed_answers: q.proposed_answers } }));
  const texts = Result.getOrThrow(preparedComments(KEY, pqs, { _tag: "Prepared", key: KEY, digest: digestOf(BASE), count: pqs.length, generation: 1, date: "2026-10-30" }));
  return { ...BASE, comments: texts.map((c, i) => ({ id: seededId(`p-${i + 1}`), body: c.text, created: "2026-10-30T00:00:00Z" })) };
};
const refine = async (item: FakeItem, options: TestOptions): Promise<readonly UiEvent[]> => {
  const tracker = fakeTrackerOf([item]);
  const { wiring, probe } = testWiring(tempRepo(), { ...options, tracker });
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement", item.id, "checked"), wiring)));
  assert.equal(code, 0);
  return probe.ui.notified;
};

test("(d) a current preparation of two questions: QuestionsAgreed 2 after the phase begins and before the interview", async () => {
  const events = await refine(prepared([stored("Q1"), stored("Q2")]), {
    answers: ["A", "A"],
    closings: [{ output: summaryReply("# Requirements\n\nQ1: A, Q2: A", "Done.") }],
    reviews: [{ issues: [] }],
  });
  assert.deepEqual(agreedCounts(events), [2]);
  afterQuestionsBegan(events);
  before(events, "QuestionsAgreed", "InterviewOpened");
});

test("(e) a preparation with no question: QuestionsAgreed 0", async () => {
  const events = await refine(prepared([]), {});
  assert.deepEqual(agreedCounts(events), [0]);
  afterQuestionsBegan(events);
});
