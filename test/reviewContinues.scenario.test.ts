// Issue #243: a review's round limit, its idle limit, an accepted point that left the file unchanged and a disputed
// pause no longer stop the review: each question is opened beside it, the review goes on, and an answer applies at the
// next round's boundary. Scenarios over testLayer and testWiring, with no chain and no foreground answer scripted.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import type { RunEvent } from "../src/protocol.ts";
import { run } from "../src/run.ts";
import { makeWebUi } from "../src/webUi.ts";
import { finished, issue, questionEntry, respond, runRefinement, runTask, scriptedStart, summaryReply, tempRepo, testLayer, testWiring } from "./helpers.ts";

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

test("(7) an accepted point that leaves the plan unchanged after its corrective turn goes on; Retry answered then issues another corrective turn", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "retry" }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["A", "accepted"]]) },
      { output: respond([["A", "accepted"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "cc-1-corrective-2.json")), "the Retry took a second corrective turn");
  assert.ok(conversation(probe.dir).includes(prompts.unchangedContinuesLine("plan.json", 1, "review")));
});

test("(8) a disputed point goes on with Claude Code's position; Codex's position answered during the loop is recorded and applied at the next boundary", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [{ beside: "1" }],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      { output: respond([["B", "rejected"]]) },
      { output: noQuestions, plan: "v3" },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(conversation(probe.dir).includes(prompts.DISPUTE_PUT_TO_YOU_HEADING));
  const decisions = fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8");
  assert.match(decisions, /issue B, raised again/);
  const log = await probe.loadLog();
  assert.equal(log.filter((e) => e.id === "B" && e.action === "decided_by_user").length, 1);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-1", "review-3.json")), "the review went on after applying the answer");
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
      { output: respond([["B", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }, { issues: [] }],
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
