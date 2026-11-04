// Issue #243 (requirements Q1): a disagreement put to the developer beside the run outlives its review loop. Answered for
// Codex's position after the loop ended, it is recorded and applied at the next point the run can still change the work;
// the run never finishes with one unapplied; unanswered at the run's end, it is withdrawn and recorded as settled.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import type { RunEvent } from "../src/protocol.ts";
import { makeWebUi } from "../src/webUi.ts";
import * as prompts from "../src/prompts.ts";
import { finished, issue, questionEntry, runRefinement, summaryReply, type PlanningStep, type ReviewStep, type ScriptedAnswer, type TestOptions, respond, runTask, scriptedItem, scriptedStart, tempRepo, testLayer, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const until = async (condition: () => Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
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

test("W2-R2-3: answered for Codex's position after the plan review ended and before execution, it is applied and reviewed in the same phase first", async () => {
  const converged = signal();
  let records: string | null = null;
  let before: string[] | null = null;
  const reviewFile = (n: number) => path.join(records!, "planning-1", `review-${n}.json`);
  const seen: { review4: boolean; applied: boolean }[] = [];
  const { wiring, probe } = testWiring(tempRepo(), {
    ...disputedPlan([{ beside: "1", when: () => converged.promise }], [{ output: noQuestions, plan: "v2" }], [{ issues: [] }]),
    execs: [finished],
    execScripts: [
      {
        onCall: () =>
          void seen.push({
            review4: fs.existsSync(reviewFile(4)),
            applied: probe.planner.prompts.some((p) => p.includes("user-decisions.md has new entries") && p.includes("plan.json")),
          }),
      },
    ],
    store: (store) => ({
      ...store,
      converse: (markdown) =>
        before === null && markdown.includes("The review of plan.json has converged")
          ? Effect.sync(() => {
              records = store.dir;
              before = [1, 2, 3].map((n) => fs.readFileSync(reviewFile(n), "utf8"));
              converged.resolve();
            }).pipe(Effect.andThen(store.converse(markdown)))
          : store.converse(markdown),
    }),
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.match(read(records!, "user-decisions.md"), /issue B, raised again/);
  assert.deepEqual(seen, [{ review4: true, applied: true }], "the application and the review of round 4 came before the execution");
  assert.deepEqual([1, 2, 3].map((n) => fs.readFileSync(reviewFile(n), "utf8")), before, "the earlier rounds' files are unchanged");
});

test("W8-R1-1: an answer for Codex's position accepted while an earlier answer is being recorded is applied and reviewed before the execution", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const beside = () => events.flatMap((e) => (e._tag === "Asked" && e.beside !== null ? [e.prompt] : []));
  const converged = signal();
  const aAnswered = signal();
  const recording = signal();
  const release = signal();
  let records: string | null = null;
  let before: string[] | null = null;
  let held = false;
  const reviewFile = (n: number) => path.join(records!, "planning-1", `review-${n}.json`);
  const seen: { decided: boolean; applied: boolean; review5: boolean }[] = [];
  const { wiring, probe } = testWiring(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["B", "rejected"]]) },
      { output: respond([["B", "rejected"], ["A", "rejected"]]) },
      { output: respond([["A", "rejected"]]) },
      { output: noQuestions, plan: "v2" },
    ],
    // B is raised again in cycle 2 and A in cycle 3, so B's dispute is opened first and A's frame stands over it.
    reviews: [{ issues: [issue("B")] }, { issues: [issue("B"), issue("A")] }, { issues: [issue("A")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    config: { maxIdleRounds: 9 },
    execs: [finished],
    execScripts: [
      {
        onCall: () =>
          void seen.push({
            decided: fs.existsSync(path.join(records!, "user-decisions.md")) && /issue B, raised again/.test(read(records!, "user-decisions.md")),
            applied: probe.planner.prompts.some((p) => p.includes("user-decisions.md has new entries") && p.includes("plan.json")),
            review5: fs.existsSync(reviewFile(5)),
          }),
      },
    ],
    store: (store) => ({
      ...store,
      converse: (markdown) =>
        before === null && markdown.includes("The review of plan.json has converged")
          ? Effect.sync(() => {
              records = store.dir;
              before = [1, 2, 3, 4].map((n) => fs.readFileSync(reviewFile(n), "utf8"));
              converged.resolve();
            }).pipe(Effect.andThen(Effect.promise(() => aAnswered.promise)), Effect.andThen(store.converse(markdown)))
          : store.converse(markdown),
      appendDecision: (decision) =>
        !held && before !== null
          ? Effect.sync(() => {
              held = true;
              recording.resolve();
            }).pipe(Effect.andThen(Effect.promise(() => release.promise)), Effect.andThen(store.appendDecision(decision)))
          : store.appendDecision(decision),
    }),
  });
  const done = Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  await converged.promise;
  const [b, a] = beside();
  assert.equal((await Effect.runPromise(ui.pending))?.prompt, a, "A's frame stands over B's");
  assert.equal(await Effect.runPromise(ui.answer(a, "2")), "taken");
  aAnswered.resolve();
  await recording.promise;
  await until(async () => (await Effect.runPromise(ui.pending))?.prompt === b);
  assert.equal(await Effect.runPromise(ui.answer(b, "1")), "taken");
  release.resolve();
  const outcome = done.then((code) => code, (e: unknown) => e);
  await until(async () => seen.length > 0);
  assert.deepEqual(seen[0], { decided: true, applied: true, review5: true }, "B's answer was recorded, applied and reviewed before the execution");
  assert.equal(await outcome, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual([1, 2, 3, 4].map((n) => fs.readFileSync(reviewFile(n), "utf8")), before, "the earlier rounds' files are unchanged");
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
