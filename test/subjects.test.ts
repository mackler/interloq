import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import type { Subject } from "../src/review.ts";
import * as S from "../src/schema.ts";
import { Store, Ui } from "../src/services.ts";
import { planSubject, questionSubject, requirementsSubject, workSubject } from "../src/subjects.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { ScriptedUi, tempRepo, entryOf, workExecution , TEST_ROOT } from "./helpers.ts";

// Finding 12 of docs/functional-design-review.md: a subject's decoded output and its handler share one type.

test("the type of a subject's handler follows the type of its schema (compile-time)", () => {
  const wrong: Subject<S.PlannerResponse, S.QuestionList> = {
    id: "questions",
    phase: 0,
    heading: "h",
    fileLabel: "f",
    respond: { prompt: () => "p", schema: S.PlannerResponse, after: null, capability: "records", validate: null },
    // @ts-expect-error the handler must take the decoded type of the operation's schema
    applyDecisions: { prompt: "p", schema: S.QuestionList, after: (output: S.ExecOutcome) => Effect.sync(() => void output), validate: null },
    amend: null,
    proceed: "go",
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    prepare: null,
  };
  void wrong;
});

test("the question subject's handlers receive the decoded list and write questions.json", async () => {
  const store = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const subject = questionSubject("task");
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store | Ui>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Ui, new ScriptedUi([]))))));
  const list = { questions: [entryOf({ id: "Q1", context: "c", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "A" })] };
  assert.ok(subject.applyDecisions.after !== null && subject.respond.after !== null);
  await withStore(subject.applyDecisions.after(list));
  assert.deepEqual(JSON.parse(fs.readFileSync(store.questions, "utf8")).questions.map((q: { id: string }) => q.id), ["Q1"]);
  await withStore(subject.respond.after({ dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], questions: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(store.questions, "utf8")).questions, []);
});

// Plan step 2.7: the work subject carries the work review's policies; the other subjects keep today's behaviour.
test("the work subject: its id, file, prompts and policies", () => {
  const work = workSubject(2, true, workExecution);
  assert.deepEqual(work.id, { work: 2 });
  assert.equal(work.heading, "Work review 2");
  assert.equal(work.fileLabel, "changes.diff");
  assert.match(work.reviewPrompt(1), /work-review-2\/changes\.diff/);
  assert.match(work.respond.prompt(1, { review: { issues: [] }, log: [], changes: "" }), /work-review-2\/review-1\.json/);
  assert.deepEqual([work.proceed, work.leaveOnAcceptance, work.leaveOnDecision, work.amend], [null, true, true, null]);
  assert.notEqual(work.prepare, null);
  assert.equal(work.respond.capability, "readOnly", "a work response is read-only (finding 1 of docs/gui-review.md)");
  for (const other of [planSubject(1, true, null), questionSubject("t"), requirementsSubject()]) {
    assert.equal(other.respond.capability, "records");
    assert.equal(typeof other.proceed, "string");
    assert.deepEqual([other.leaveOnAcceptance, other.leaveOnDecision, other.prepare], [false, false, null]);
  }
});

// Issue #14 and the clarification's name (Q5): the proceed choice at the cycle limit is shown to the user.
test("the proceed choices name the clarification and implementation", () => {
  assert.equal(questionSubject("t").proceed, "proceed to the clarification with the question list as it is");
  assert.equal(requirementsSubject().proceed, "proceed to planning with the requirements as they are");
  assert.equal(planSubject(1, false, null).proceed, "proceed to implementation with the plan as it is");
});

// Decision support, plan step 1.3: a subject carries the phase its loop records (a decision's is where it took place).
test("every subject carries its phase", () => {
  assert.deepEqual([questionSubject("t").phase, requirementsSubject().phase, planSubject(3, false, null).phase, workSubject(2, false, workExecution).phase], [0, 0, 3, 2]);
});
