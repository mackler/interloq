// Issue #243: a review's round limit, its idle limit, an accepted point that left the file unchanged and a disputed
// pause no longer stop the review: each question is opened beside it, the review goes on, and an answer applies at the
// next round's boundary. Scenarios over testLayer and testWiring, with no chain and no foreground answer scripted.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Fiber, Layer } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import type { RunEvent } from "../src/protocol.ts";
import { run } from "../src/run.ts";
import { makeWebUi } from "../src/webUi.ts";
import { emptyRun, foldEvent, shownAnalysis } from "../web/src/state.ts";
import { reviewLoop } from "../src/review.ts";
import { type Services, Store, type StoreShape } from "../src/services.ts";
import { planSubject } from "../src/subjects.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { finished, issue, questionEntry, scriptedRecordedPlan, TEST_ROOT, respond, runRefinement, runTask, scriptedStart, summaryReply, tempRepo, testLayer, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
/** A promise and the function that resolves it. */
const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Four plan rounds, each accepting its one issue, then a review with no counted issue. */
const fourRounds = {
  steps: [
    { output: noQuestions, plan: "v1" },
    { output: respond([["A", "accepted"]]), plan: "v2" },
    { output: respond([["B", "accepted"]]), plan: "v3" },
    { output: respond([["C", "accepted"]]), plan: "v4" },
  ],
  reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [] }, { issues: [] }],
  execs: [finished],
  config: { maxRounds: 2 },
};

test("(1) a plan review reaching its round limit goes on with the line said and written, and ends when Codex raises nothing", async () => {
  const { layer, probe } = testLayer(tempRepo(), fourRounds);
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, [], "nothing was answered or waited for");
  const line = prompts.limitExtendedLine("Planning phase 1", "rounds", 2, "asked", "review");
  assert.ok(conversation(probe.dir).includes(line));
  assert.ok(probe.ui.said.includes(line));
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "review-4.json")), "the review went on to cycle 4");
  assert.ok(probe.ui.notified.some((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "limit"));
});

test("(2) the idle limit goes on, the idle count restarting, and ends on a review with no counted issue", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "rejected"]]) }, { output: respond([["B", "rejected"]]) }, { output: respond([["C", "rejected"]]) }],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 2 },
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, []);
  assert.ok(conversation(probe.dir).includes(prompts.limitExtendedLine("Planning phase 1", "idle", 2, "asked", "review")));
});

test("(3) Proceed answered at the limit ends the review at the next boundary, the cycle in progress completing first", async () => {
  const { layer, probe } = testLayer(tempRepo(), { ...fourRounds, answers: [{ beside: "p" }] });
  assert.equal(await runTask(layer), 1);
  assert.match(conversation(probe.dir), /without convergence after round 3 of Planning phase 1/);
  assert.ok(!fs.existsSync(path.join(probe.dir, "planning-1", "review-4.json")), "no cycle after the boundary");
});

test("(4) Stop answered at the limit halts the run with RoundLimitStop", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...fourRounds, answers: [{ beside: "0" }] });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 1);
  assert.match(probe.ui.said.join("\n"), /stopped by the user at the cycle limit of Planning phase 1/);
});

test("(4q) q answered at the limit ends the run with 130 while the review runs", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...fourRounds, answers: [{ beside: "q" }] });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 130);
  assert.match(conversation(probe.dir), /Interrupted by the user/);
});

test("(5) Stop task during the extension ends the run with 130", async () => {
  const reached = signal();
  const { wiring, probe } = testWiring(tempRepo(), {
    ...fourRounds,
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")], gate: () => (reached.resolve(), new Promise(() => {})) }],
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  await reached.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130);
  assert.match(conversation(probe.dir), /\*\*Interrupted by the user\.\*\*\n$/);
  assert.ok(conversation(probe.dir).includes(prompts.limitExtendedLine("Planning phase 1", "rounds", 2, "asked", "review")));
});

test("(6) a refinement run's question-list review reaching its limit goes on the same way", async () => {
  const q = questionEntry("Q1", "question Q1?", [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A"],
    steps: [{ output: { questions: [q] } }, { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [q] } }],
    closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }],
    reviews: [{ issues: [{ id: "Q-R1-1", severity: "major", location: "Q1", problem: "p", evidence: "e", concern: "c", remedy: "r" }] }, { issues: [] }, { issues: [] }],
    config: { maxRounds: 1 },
    mode: "refinement",
  });
  await runRefinement(layer);
  assert.ok(conversation(probe.dir).includes(prompts.limitExtendedLine("Question review", "rounds", 1, "asked", "review")), conversation(probe.dir));
  assert.ok(fs.existsSync(probe.requirements));
});

test("(7) an accepted point that leaves the plan unchanged after its corrective turn goes on; Retry answered during the next cycle is recorded and applied", async () => {
  const next = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "retry", when: () => next.promise }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["A", "accepted"]]) },
      { output: noQuestions, plan: "v2" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [], onCall: () => next.resolve() }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(conversation(probe.dir).includes(prompts.unchangedContinuesLine("plan.json", 1, "review")));
  assert.ok(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8").includes(prompts.unchangedRetryDecision("plan.json", 1, ["A"])));
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "review-3.json")), "another cycle reviewed the applied Retry");
});

test("(8) a disputed point goes on with Claude Code's position; Codex's position answered during the loop is recorded and applied at the next boundary", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "1" }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      // Issue #38: the response that investigates B raised again, before B is put to the developer.
      { output: respond([["B", "rejected"]]) },
      { output: respond([["B", "rejected"]]) },
      { output: noQuestions, plan: "v3" },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    config: { maxIdleRounds: 9 },
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(conversation(probe.dir).includes(prompts.DISPUTE_PUT_TO_YOU_HEADING));
  const decisions = fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8");
  assert.match(decisions, /issue B, raised again/);
  const log = await probe.loadLog();
  assert.equal(log.filter((e) => e.id === "B" && e.action === "decided_by_user").length, 1);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "review-4.json")), "the review went on after applying the answer");
});

test("(11) with the web Ui, a plan-review dispute's prompt is still pending after its loop returned, and an answer to it is taken then", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const seen: string[] = [];
  const { layer } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      // Issue #38: the response that investigates B raised again, before B is put to the developer.
      { output: respond([["B", "rejected"]]) },
      { output: respond([["B", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    config: { maxIdleRounds: 9 },
    execs: [finished],
    execScripts: [
      {
        onCall: () => {
          const pending = Effect.runSync(ui.pending);
          seen.push(pending?.beside === null || pending === null ? "none" : "beside");
          if (pending !== null) seen.push(String(Effect.runSync(ui.answer(pending.prompt, "2"))));
        },
      },
    ],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(seen, ["beside", "taken"]);
});

test("(13) a Stop to the first of two unchanged questions, given during the second round, halts at the second boundary", async () => {
  const second = signal();
  const { layer } = testLayer(tempRepo(), {
    answers: [{ beside: "stop", when: () => second.promise }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["B", "accepted"]]) },
      { output: respond([["B", "accepted"]]) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")], onCall: () => second.resolve() }, { issues: [] }],
    execs: [finished],
  });
  const exit = await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
  assert.ok(exit._tag === "Failure" && String(exit.cause).includes("AcceptedWithoutChange"), String(exit));
});

test("(9) a dispute in the work review answered for Codex's position during the loop leaves for a revision", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "1" }],
    steps: [
      { output: noQuestions, plan: "v1" },
      // Issue #38: the response that investigates the point raised again.
      { output: respond([["W1-R1-1", "rejected"]]) },
      { output: respond([["W1-R1-1", "rejected"]]) },
      { output: respond([["W1-R1-1", "rejected"]]) },
      { output: noQuestions, plan: "v2" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    config: { maxIdleRounds: 9 },
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /W1-R1-1/);
});

test("(10) Stop at the limit answered during the final review, which raises nothing, halts with RoundLimitStop", async () => {
  const last = signal();
  const { layer } = testLayer(tempRepo(), {
    ...fourRounds,
    answers: [{ beside: "0", when: () => last.promise }],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [], onCall: () => last.resolve() }],
  });
  const exit = await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
  assert.ok(exit._tag === "Failure" && String(exit.cause).includes("RoundLimitStop"), String(exit));
});

/** The run's Asked events with the given field set. */
const askedWith = (events: readonly RunEvent[], field: "beside" | "deciding") => events.flatMap((e) => (e._tag === "Asked" && e[field] !== null ? [e] : []));
/** Polls until the condition holds, giving up only after a deadline generous enough for the whole suite's load. */
const UNTIL_DEADLINE_MS = 120_000;
const until = async (condition: () => boolean, what = "the condition"): Promise<void> => {
  const deadline = Date.now() + UNTIL_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} never held within ${UNTIL_DEADLINE_MS} ms`);
    await sleep(5);
  }
};
/** A plan review at its limit after cycle 1, its cycle 2 held, the limit answered Help me decide and its analysis held. */
const decidingAtLimit = async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const review2 = signal();
  const analysisCalled = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: { decision: "d", columns: [], recommendation: { option: "", reason: "" } }, gate: () => new Promise(() => {}), onCall: () => analysisCalled.resolve() },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [], gate: () => review2.promise }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(ui.answer(limit.prompt, "/decide")), "taken");
  await analysisCalled.promise;
  await until(() => askedWith(events, "deciding").length > 0, "the analysis's deciding prompt");
  return { events, ui, review2, fiber, probe, analysisPrompt: askedWith(events, "deciding")[0]!.prompt };
};

test("(15) with the web Ui: 0 answered while the limit's analysis is prepared, the final review released: the run halts and the decision's abandoned records are written", async () => {
  const d = await decidingAtLimit();
  assert.equal(await Effect.runPromise(d.ui.answer(d.analysisPrompt, "0")), "taken");
  d.review2.resolve();
  const exit = await Effect.runPromise(Fiber.await(d.fiber));
  assert.ok(exit._tag === "Failure" && String(exit.cause).includes("RoundLimitStop"), String(exit));
  await until(() => fs.existsSync(path.join(d.probe.dir, "decision-1", "chosen.json")), "decision 1's chosen.json");
  assert.ok(conversation(d.probe.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("(16) review P1-R6-1: the plan review ending while the limit's analysis is prepared cancels the analysis's prompt; the page then has no pending prompt and no deciding entry", async () => {
  const d = await decidingAtLimit();
  d.review2.resolve();
  await until(() => d.events.some((e) => e._tag === "Notified" && e.event._tag === "PhaseBegan" && e.event.phase.kind === "execution"), "execution phase 1's start");
  assert.ok(d.events.some((e) => e._tag === "PromptCancelled" && e.prompt === d.analysisPrompt));
  const view = d.events.reduce((r, event) => foldEvent(r, { time: "2026-11-04T00:00:00.000Z", event }), emptyRun(1));
  assert.equal(view.pending, null);
  assert.deepEqual(view.deciding, []);
  await Effect.runPromise(Fiber.await(d.fiber));
});

// W2-R2-2, raised again in work review 3: the limit's analysis finishes (its deciding prompt withdrawn) and the plan
// review ends before the question is asked again beside the run; the plan's cycle-2 review is held until then and the Ui's notify of DecisionAnalyzed is held so the
// loop's scope closes first. The beside prompt is cancelled and the page keeps nothing of the question.
test("(16a) W2-R2-2: the plan review ending after the limit's analysis finished, before it is asked again, cancels the beside prompt; the page keeps no analysis", async () => {
  const events: RunEvent[] = [];
  const webUi = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const ui = { ...webUi, notify: (e: Parameters<typeof webUi.notify>[0]) => (e._tag === "DecisionAnalyzed" ? webUi.notify(e).pipe(Effect.andThen(Effect.never)) : webUi.notify(e)) };
  const review2 = signal();
  const { layer } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: { decision: "d", columns: [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE].map((option) => ({ kind: "unclear", option, unclear: "u" })), recommendation: { option: "", reason: "" } } },
    ],
    // The plan's cycle-2 review is held when it is saved, not at the reviewer, whose gate would hold the analysis's review too.
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    store: (s) => ({ ...s, saveReview: (subject, round, review) => (round === 2 && !(typeof subject === "object" && "decision" in subject) ? Effect.promise(() => review2.promise).pipe(Effect.andThen(s.saveReview(subject, round, review))) : s.saveReview(subject, round, review)) }),
    execs: [finished],
    config: { maxRounds: 1 },
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(webUi.answer(limit.prompt, "/decide")), "taken");
  await until(() => events.some((e) => e._tag === "Notified" && e.event._tag === "DecisionAnalyzed"), "the decision's analysis");
  assert.ok(events.some((e) => e._tag === "PromptWithdrawn"), "the deciding prompt was withdrawn");
  review2.resolve();
  await until(() => events.some((e) => e._tag === "Notified" && e.event._tag === "PhaseBegan" && e.event.phase.kind === "execution"), "execution phase 1's start");
  assert.ok(events.some((e) => e._tag === "PromptCancelled" && e.prompt === limit.prompt), "the beside prompt is cancelled");
  const view = events.reduce((r, event) => foldEvent(r, { time: "2026-11-04T00:00:00.000Z", event }), emptyRun(1));
  assert.equal(view.analysis, null);
  assert.equal(view.pending, null);
  assert.deepEqual(view.deciding, []);
  await Effect.runPromise(Fiber.await(fiber));
});

test("(17) W2-R2-1: an answer to the limit's question after the final boundary read is refused, never silently taken", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const held = signal();
  const reached = signal();
  let holding = true;
  const { layer } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: respond([["B", "accepted"]]), plan: "v3" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 2 },
    store: (store) => ({
      ...store,
      converse: (markdown) =>
        holding && markdown.includes("has converged")
          ? Effect.sync(() => {
              holding = false;
              reached.resolve();
            }).pipe(Effect.andThen(Effect.promise(() => held.promise)), Effect.andThen(store.converse(markdown)))
          : store.converse(markdown),
    }),
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await reached.promise;
  const limit = askedWith(events, "beside")[0]!;
  const result = await Effect.runPromise(ui.answer(limit.prompt, "0"));
  held.resolve();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(result, "notWaiting");
  assert.ok(!events.some((e) => e._tag === "Answered" && e.prompt === limit.prompt), "no Answered was published");
  assert.ok(events.some((e) => e._tag === "PromptCancelled" && e.prompt === limit.prompt));
  assert.equal(exit._tag, "Success", String(exit));
});

test("(18) W2-R2-1, P3-R1-1: a final boundary whose Retry resumes the loop reopens acceptance, so a Stop to the limit is still taken", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const review2 = signal();
  const review3 = signal();
  const reached2 = signal();
  const reached3 = signal();
  const { layer } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: respond([["B", "accepted"]]) },
      { output: respond([["B", "accepted"]]) },
      { output: noQuestions, plan: "v3" },
    ],
    reviews: [
      { issues: [issue("A")] },
      { issues: [issue("B")] },
      { issues: [], gate: () => (reached2.resolve(), review2.promise) },
      { issues: [], gate: () => (reached3.resolve(), review3.promise) },
      { issues: [] },
    ],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  /** The prompt of the beside question of the given origin. */
  const besidePrompt = (kind: string): number => {
    const numbers = events.flatMap((e) => (e._tag === "Notified" && e.event._tag === "QuestionPresented" && e.event.question.origin.kind === kind ? [e.event.question.number] : []));
    return askedWith(events, "beside").find((a) => numbers.includes(a.beside!))!.prompt;
  };
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await reached2.promise;
  await until(() => askedWith(events, "beside").length >= 2, "a second question beside the run");
  assert.equal(await Effect.runPromise(ui.answer(besidePrompt("unchanged"), "retry")), "taken");
  review2.resolve();
  await reached3.promise;
  const limit = besidePrompt("limit");
  assert.equal(await Effect.runPromise(ui.answer(limit, "0")), "taken");
  assert.ok(events.some((e) => e._tag === "Answered" && e.prompt === limit));
  review3.resolve();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.ok(exit._tag === "Failure" && String(exit.cause).includes("RoundLimitStop"), String(exit));
});

test("(12) a review of the same subject continued in one phase continues its round numbers and leaves the earlier rounds' files alone", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: respond([["A", "accepted"]]), plan: "v2" }, { output: respond([["B", "accepted"]]), plan: "v3" }],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
  });
  const files = (n: number) => [`review-${n}.json`, `round-${n}.json`].map((f) => path.join(probe.dir, "planning-1", f));
  const bytes = () => [1, 2, 3].flatMap(files).map((f) => fs.readFileSync(f, "utf8"));
  const subject = planSubject(TEST_ROOT, 1, false, null, NO_STEP_CHECKS);
  const first = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.init("task");
      yield* store.savePlan(scriptedRecordedPlan("v1"));
      return yield* reviewLoop(subject);
    }).pipe(Effect.provide(layer as Layer.Layer<Services>)),
  );
  assert.deepEqual(first, { result: "converged", round: 3 });
  const before = bytes();
  const second = await Effect.runPromise(reviewLoop(subject, { result: "converged", round: 3 }).pipe(Effect.provide(layer as Layer.Layer<Services>)));
  assert.deepEqual(second, { result: "converged", round: 4 });
  for (const f of files(4)) assert.ok(fs.existsSync(f), f);
  assert.deepEqual(bytes(), before);
});

test("(19) W4-R2-1: with the web Ui, /terms at the limit's question is rejected and asked again; p then ends the review at the next boundary", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const review3 = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    ...fourRounds,
    ui,
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")], gate: () => review3.promise }, { issues: [] }, { issues: [] }],
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(ui.answer(limit.prompt, "/terms")), "taken");
  await until(() => askedWith(events, "beside").length > 1, "a second question beside the run");
  const again = askedWith(events, "beside")[1]!;
  assert.equal(again.beside, limit.beside);
  assert.equal(await Effect.runPromise(ui.answer(again.prompt, "p")), "taken");
  review3.resolve();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exit._tag, "Success", String(exit));
  assert.match(conversation(probe.dir), /without convergence after round 3 of Planning phase 1/);
  assert.ok(!fs.existsSync(path.join(probe.dir, "planning-1", "review-4.json")), "no cycle after the boundary");
});

/** A valid analysis of the plan review's limit question: one column per option, recommending Proceed. */
const limitAnalysis = {
  decision: "How to continue?",
  columns: [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE].map((option) => ({ kind: "argued" as const, option, advantages: [], disadvantages: [] })),
  recommendation: { option: prompts.LIMIT_PROCEED, reason: "r" },
};

test("(14) W4-R2-4: Help me decide at the limit; the analysis finishes while the review goes on; p then ends it with proceed and the choice recorded", async () => {
  let answersTaken = (): number => 0;
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: respond([["B", "accepted"]]), plan: "v3" },
      { output: limitAnalysis },
      // Cycle 3's response waits until both answers are taken: the decision's review then ran beside the plan review.
      { output: respond([["C", "accepted"]]), plan: "v4", gate: () => until(() => answersTaken() >= 2, "both answers taken") },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 2 },
    answers: [{ beside: "/decide" }, { beside: "p" }],
  });
  answersTaken = () => probe.ui.asked.length;
  await runTask(layer);
  const text = conversation(probe.dir);
  assert.match(text, /without convergence after round 3 of Planning phase 1/);
  assert.ok(!fs.existsSync(path.join(probe.dir, "planning-1", "review-4.json")), "no cycle after the boundary");
  const chosen = JSON.parse(fs.readFileSync(path.join(probe.dir, "decision-1", "chosen.json"), "utf8"));
  assert.equal(chosen.answer, "p");
  assert.equal(chosen.option, prompts.LIMIT_PROCEED);
  assert.ok(text.includes(`**User choice** after decision 1: p (${prompts.LIMIT_PROCEED})`), text.slice(-2000));
  assert.equal(probe.ui.notified.filter((e) => e._tag === "DecisionAnalyzed").length, 1);
  assert.ok(prompts.offersOf(probe.ui.asked[0]!).decide, "first asked with the offer");
  assert.ok(!prompts.offersOf(probe.ui.asked[1]!).decide, "asked again beside the review without the offer");
});

// W5-R1-1: the server rejects "/terms" at a beside question (S32) and asks it again; the page's reducer, folding the same
// events, keeps the decision's analysis beside the question asked again rather than setting it aside for terms.
test("(21) W5-R1-1: with the web Ui, /terms at the limit's question after its analysis is rejected; the page keeps the analysis beside the question asked again", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const done = signal();
  const { layer } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: respond([["B", "accepted"]]), plan: "v3" },
      { output: limitAnalysis },
      { output: respond([["C", "accepted"]]), plan: "v4", gate: () => done.promise },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 2 },
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(ui.answer(limit.prompt, "/decide")), "taken");
  await until(() => events.some((e) => e._tag === "Notified" && e.event._tag === "DecisionAnalyzed") && askedWith(events, "beside").length > 1, "the decision's analysis and a second question beside the run");
  const again = askedWith(events, "beside")[1]!;
  assert.equal(again.beside, limit.beside);
  assert.equal(await Effect.runPromise(ui.answer(again.prompt, "/terms")), "taken");
  await until(() => askedWith(events, "beside").length > 2, "a third question beside the run");
  assert.ok(events.some((e) => e._tag === "Notified" && e.event._tag === "AnswerRejected"), "the server rejected /terms");
  const third = askedWith(events, "beside")[2]!;
  assert.equal(third.beside, limit.beside);
  const view = events.reduce((r, event) => foldEvent(r, { time: "2026-11-04T00:00:00.000Z", event }), emptyRun(1));
  assert.equal(view.pending?.asked.prompt, third.prompt);
  assert.equal(view.explaining, null);
  assert.equal(shownAnalysis(view)?.event.presented.number, limit.beside);
  assert.equal(await Effect.runPromise(ui.answer(third.prompt, "p")), "taken");
  done.resolve();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exit._tag, "Success", String(exit));
});

test("(20) W4-R2-4: a dispute opened inside the limit's decision is withdrawn and cancelled on the page when the plan review ends while the analysis runs", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const disputeOpen = () => askedWith(events, "beside").some((e) => e.beside !== askedWith(events, "beside")[0]!.beside);
  const decisionResponse = (a: typeof limitAnalysis) => ({ ...respond([["D1-R1-1", "rejected"]]), analysis: a });
  const response2 = signal();
  const { layer, probe } = testLayer(tempRepo(), {
    ui,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      // Cycle 2's response waits until the decision's dispute is open beside the run.
      { output: respond([["B", "accepted"]]), plan: "v3", gate: () => (response2.resolve(), until(() => disputeOpen() && conversation(probe.dir).includes(prompts.DISPUTE_PUT_TO_YOU_HEADING), "the decision's dispute open and recorded")) },
      { output: limitAnalysis },
      { output: decisionResponse(limitAnalysis) },
      // Issue #38: the response that investigates D1-R1-1 raised again, before it is opened beside the run.
      { output: decisionResponse(limitAnalysis) },
      // The decision's next response is held: its analysis is still running when the plan review ends.
      { output: decisionResponse(limitAnalysis), gate: () => new Promise(() => {}) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1, maxIdleRounds: 5 },
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  // Help me decide only once cycle 2's response holds its step, so the decision's calls take the steps after it.
  await response2.promise;
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(ui.answer(limit.prompt, "/decide")), "taken");
  await until(disputeOpen, "the decision's dispute open");
  const dispute = askedWith(events, "beside").find((e) => e.beside !== limit.beside)!;
  const analysisPrompt = askedWith(events, "deciding")[0]!.prompt;
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exit._tag, "Success", String(exit));
  const text = conversation(probe.dir);
  assert.ok(text.includes(prompts.disputeWithdrawnByDecisionLine(1, "Decision 1")), text.slice(-2000));
  const cancelled = events.flatMap((e) => (e._tag === "PromptCancelled" ? [e.prompt] : []));
  assert.ok(cancelled.includes(dispute.prompt), "the dispute's prompt is cancelled");
  assert.ok(cancelled.includes(analysisPrompt) || cancelled.includes(limit.prompt), "the limit question's prompt is cancelled");
  assert.equal(await Effect.runPromise(ui.pending), null);
  assert.ok(!fs.existsSync(path.join(probe.dir, "planning-2")), "no revision for the withdrawn dispute");
});

test("(22) W7-R1-1: the limit's decision cancelled while its dispute's question record is being written: the dispute's question never appears and its producer ends", async () => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const decisionResponse = (a: typeof limitAnalysis) => ({ ...respond([["D1-R1-1", "rejected"]]), analysis: a });
  const response2 = signal();
  const release = signal();
  let headingSeen = false;
  let held = false;
  const store = (s: StoreShape): StoreShape => ({
    ...s,
    converse: (markdown) =>
      Effect.suspend(() => {
        if (markdown.includes(prompts.DISPUTE_PUT_TO_YOU_HEADING)) {
          headingSeen = true;
          return s.converse(markdown);
        }
        if (headingSeen && !held) {
          held = true;
          return Effect.promise(() => release.promise).pipe(Effect.andThen(s.converse(markdown)));
        }
        return s.converse(markdown);
      }),
  });
  const { layer, probe } = testLayer(tempRepo(), {
    ui,
    store,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      // Cycle 2's response waits until the dispute's question record write is held.
      { output: respond([["B", "accepted"]]), plan: "v3", gate: () => (response2.resolve(), until(() => held, "the held question record write")) },
      { output: limitAnalysis },
      { output: decisionResponse(limitAnalysis) },
      // Issue #38: the response that investigates D1-R1-1 raised again, before it is opened beside the run.
      { output: decisionResponse(limitAnalysis) },
      { output: decisionResponse(limitAnalysis), gate: () => new Promise(() => {}) },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1, maxIdleRounds: 5 },
  });
  const fiber = Effect.runFork(run("task").pipe(Effect.provide(layer)));
  await response2.promise;
  await until(() => askedWith(events, "beside").length > 0, "the limit's question beside the review");
  const limit = askedWith(events, "beside")[0]!;
  assert.equal(await Effect.runPromise(ui.answer(limit.prompt, "/decide")), "taken");
  // The plan review ends while the dispute's record write is held; the decision's disputes are withdrawn.
  await until(() => conversation(probe.dir).includes(prompts.disputeWithdrawnByDecisionLine(1, "Decision 1")), "the dispute's withdrawal line");
  const before = events.length;
  release.resolve();
  await sleep(200);
  const disputeAsked = askedWith(events.slice(before), "beside").filter((e) => e.beside !== limit.beside);
  assert.deepEqual(disputeAsked.map((e) => e.prompt), [], "no dispute question appears after its decision ended");
  const pendingNow = await Effect.runPromise(ui.pending);
  assert.ok(pendingNow === null || pendingNow.beside === limit.beside || pendingNow.beside === null, `pending: ${JSON.stringify(pendingNow)}`);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exit._tag, "Success", String(exit));
  assert.equal(await Effect.runPromise(ui.pending), null);
});
