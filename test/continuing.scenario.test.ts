// Issue #154 (decisions Q2 and Q3 of its requirements): an execution call that reports work left and nothing for the user
// to decide (status continuing) is continued in the phase's own session without a question, without a decision, and
// without a plan revision or review; the work review runs when the continued Implementation ends. Without limit.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import { continuingLine, executionContinuingPrompt, execStopQuestion } from "../src/prompts.ts";
import type { ExecCallOutcome } from "../src/schema.ts";
import { finished, runTask, scriptedStart, tempRepo, testLayer, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const continuing = (remainingWork: string): ExecCallOutcome => ({ status: "continuing", summary: "part done", remainingWork });
const blocked: ExecCallOutcome = { status: "blocked", summary: "s", question: "the database is down", remainingWork: "S1", userInput: null };
const decisionsOf = (dir: string): string => {
  const file = path.join(dir, "user-decisions.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const planStatuses = (dir: string): Record<string, string> => {
  const file = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  return Object.fromEntries(file.plan.stages.flatMap((s: { steps: { id: string; status: string }[] }) => s.steps.map((st) => [st.id, st.status])));
};
const began = (notified: readonly { _tag: string }[], kind: string): number => notified.filter((e) => e._tag === "PhaseBegan" && (e as unknown as { phase: { kind: string } }).phase.kind === kind).length;

test("a continuing execution is continued in its own session without a question, a decision or a plan review, and the work review follows the continuation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    // Plan review 1, then work review 1, which must see the second call's end.
    reviews: [{ issues: [] }, { issues: [], onCall: () => assert.equal(probe.planner.execPrompts.length, 2, "the work review ran before the continuation") }],
    execs: [continuing("S2 and S3"), finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, []);
  assert.equal(decisionsOf(probe.dir), "");
  assert.equal(probe.planner.execSessions.length, 2);
  assert.equal(probe.planner.execSessions[0], probe.planner.execSessions[1], "the continuation ran in another session");
  assert.equal(probe.planner.execPrompts[1], executionContinuingPrompt("S2 and S3"));
  assert.equal(began(probe.ui.notified, "planning"), 1);
  assert.equal(began(probe.ui.notified, "execution"), 1);
  assert.equal(began(probe.ui.notified, "work"), 1);
  assert.equal(probe.reviewer.prompts.length, 2, "one plan review and one work review");
  const line = continuingLine("Implementation", "S2 and S3");
  assert.ok(probe.ui.said.includes(line), probe.ui.said.join("\n"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(line));
});

test("continuing is continued without limit: three in a row ask nothing", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [continuing("a"), continuing("b"), continuing("c"), finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, []);
  assert.equal(decisionsOf(probe.dir), "");
  assert.deepEqual(probe.planner.execPrompts.slice(1), ["a", "b", "c"].map(executionContinuingPrompt));
  assert.equal(new Set(probe.planner.execSessions).size, 1);
  assert.equal(began(probe.ui.notified, "planning"), 1);
});

test("a blocked report after a continuation takes the stop's path: the question, the decision, the revision and its review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["go on"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [continuing("S1"), blocked, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.ui.asked.length, 1);
  assert.ok(probe.ui.asked[0].includes(execStopQuestion()) || probe.ui.notified.some((e) => e._tag === "QuestionPresented"), "the stop's question was not asked");
  assert.match(decisionsOf(probe.dir), /stop in execution phase 1 \(blocked\): the database is down/);
  assert.equal(began(probe.ui.notified, "planning"), 2);
  assert.equal(probe.reviewer.prompts.length, 4);
});

test("Stop task during a continuation ends the run with 130", async () => {
  let reached: () => void = () => {};
  const continued = new Promise<void>((resolve) => (reached = resolve));
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execs: [continuing("S1")],
    execScripts: [{}, { onCall: () => reached(), hang: true }],
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  await Promise.race([continued, sleep(30_000).then(() => assert.fail("the continuation did not begin within 30 s"))]);
  await sleep(10);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130);
  assert.ok(Exit.isSuccess(exit) || Exit.isFailure(exit));
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*\n$/);
  assert.deepEqual(probe.ui.asked, []);
});

test("a step left started by a continuing call is still started when the continuation begins, and its end runs once", async () => {
  const seen: Record<string, string>[] = [];
  let dir = "";
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [continuing("S1"), finished],
    execScripts: [{ reports: [["S1", "started"]] }, { onCall: () => seen.push(planStatuses(dir)), reports: [["S1", "done"]] }],
  });
  dir = probe.dir;
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(seen, [{ S1: "started" }]);
  assert.deepEqual(planStatuses(probe.dir), { S1: "done" });
  const changed = probe.ui.notified.flatMap((e) => (e._tag === "PlanChanged" ? [`${e.phase}:${e.plan.stages[0].steps[0].status}`] : []));
  // No unfinished between the calls: the steps' end did not run until the last call ended.
  assert.deepEqual(changed, ["1:pending", "1:started", "1:done"]);
});
