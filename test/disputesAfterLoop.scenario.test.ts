// Issue #243 (requirements Q1): a disagreement put to the developer beside the run outlives its review loop. Answered for
// Codex's position after the loop ended, it is recorded and applied at the next point the run can still change the work;
// the run never finishes with one unapplied; unanswered at the run's end, it is withdrawn and recorded as settled.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { finished, issue, questionEntry, runRefinement, summaryReply, type PlanningStep, type ReviewStep, type ScriptedAnswer, type TestOptions, respond, runTask, scriptedItem, scriptedStart, tempRepo, testLayer, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** A plan review whose issue B is rejected twice, so its second cycle opens a dispute; the third cycle raises nothing. */
const disputedPlan = (answers: readonly ScriptedAnswer[], extraSteps: readonly PlanningStep[] = [], extraReviews: readonly ReviewStep[] = []): TestOptions => ({
  answers,
  steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["B", "rejected"]]) }, { output: respond([["B", "rejected"]]) }, ...extraSteps],
  reviews: [{ issues: [issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }, ...extraReviews],
  config: { maxIdleRounds: 9 },
});

test("a plan-review dispute answered for Codex's position during the execution is recorded and revises the plan before the run finishes", async () => {
  const during = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    ...disputedPlan([{ beside: "1", when: () => during.promise }], [{ output: noQuestions, plan: "v2" }], [{ issues: [] }, { issues: [] }]),
    execs: [finished, finished],
    execScripts: [{ onCall: () => during.resolve() }],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(read(probe.dir, "user-decisions.md"), /issue B, raised again/);
  assert.ok(read(probe.dir, "conversation.md").includes(prompts.disputesRevisionLine("Code review 1")));
});

test("answered for Claude Code's position during the execution, it is recorded and the run finishes unchanged", async () => {
  const during = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    ...disputedPlan([{ beside: "2", when: () => during.promise }]),
    execs: [finished],
    execScripts: [{ onCall: () => during.resolve() }],
  });
  assert.equal(await runTask(layer), 1);
  assert.match(read(probe.dir, "user-decisions.md"), /issue B, raised again/);
});

test("a work-review dispute answered for Codex's position while its loop leaves for a revision is recorded once, at the next planning phase", async () => {
  const last = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "1", when: () => last.promise }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["W1-R1-1", "rejected"]]) },
      { output: respond([["W1-R1-1", "rejected"], ["W1-R2-1", "accepted"]]) },
      { output: noQuestions, plan: "v2" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1"), issue("W1-R2-1")], onCall: () => last.resolve() }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  const decisions = read(probe.dir, "user-decisions.md");
  assert.equal(decisions.match(/issue W1-R1-1, raised again/g)?.length, 1, decisions);
});

test("a dispute unanswered at the run's end is withdrawn and recorded as settled without the developer; the item is implemented after", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...disputedPlan([]), execs: [finished] });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.match(read(probe.dir, "conversation.md"), /was not answered before the run ended; it is settled without you/);
  const item = (await Effect.runPromise(probe.tracker!.items)).find((i) => i.id === scriptedItem.id);
  assert.equal(item?.state, "implemented");
});

// ---- the refinement run (S12): answers applied to requirements.md before the write-back ----

const q1 = questionEntry("Q1", "question Q1?", [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const marked = { ...respond([["Q-R1-1", "rejected", true]]), questions: [q1] };
/** A question review whose marked rejection of Q-R1-1, raised again, opens a dispute; the interview's closing call gives `onClosing`. */
const refinement = (answers: readonly ScriptedAnswer[], onClosing: () => void, extraSteps: readonly PlanningStep[] = [], extraReviews: readonly ReviewStep[] = []): TestOptions => ({
  answers: [...answers, "A"],
  steps: [{ output: { questions: [q1] } }, { output: marked }, { output: marked }, ...extraSteps],
  closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done."), onCall: onClosing }],
  reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [issue("Q-R1-1")] }, { issues: [] }, { issues: [] }, ...extraReviews],
  config: { maxIdleRounds: 9 },
  mode: "refinement",
});
const sectionOf = async (tracker: NonNullable<ReturnType<typeof testLayer>["probe"]["tracker"]>) => (await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)!;

test("a marked question-list dispute answered for Codex's position during the interview is applied to requirements.md and reviewed before the write-back", async () => {
  const closing = signal();
  const { layer, probe } = testLayer(tempRepo(), refinement([{ beside: "1", when: () => closing.promise }], () => closing.resolve(), [{ output: { requirements: "# Requirements\n\nQ1: A\n\nAmended by the answer." } }], [{ issues: [] }]));
  await runRefinement(layer, "task", "onRequest");
  assert.match(read(probe.dir, "requirements.md"), /Amended by the answer\./);
  const item = await sectionOf(probe.tracker);
  assert.equal(item.state, "refined");
  assert.match(item.body, /Amended by the answer\./);
});

test("a marked question-list dispute left unanswered is withdrawn and recorded, and the item is still refined", async () => {
  const { layer, probe } = testLayer(tempRepo(), refinement([], () => {}));
  await runRefinement(layer, "task", "onRequest");
  assert.match(read(probe.dir, "conversation.md"), /it is settled without you/);
  assert.equal((await sectionOf(probe.tracker)).state, "refined");
});
