import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program, type Wiring } from "../src/program.ts";
import { finished, steppingClock, tempRepo, testWiring, type WiringProbe, questionOf, currentOf, questionEntry } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const runProgram = (args: readonly string[], wiring: Wiring): Promise<number> => Effect.runPromise(Effect.scoped(program(args, wiring)));
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");

/** The lines every ending prints last: the Claude Code session id and the usage summary. */
const assertTail = (probe: WiringProbe): void => {
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.match(lines.at(-2) ?? "", /^Claude Code session id: /);
  assert.match(lines.at(-1) ?? "", /^Usage: /);
};

test("a finished run prints the plan path and exits 0", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runProgram(["task"], wiring), 0);
  assert.match(said(probe), /Claude Code reports that the task is finished after 1 implementation phase\(s\)\./);
  assert.match(said(probe), new RegExp(`Plan: ${path.join(probe.dir, "plan.md")}\\nConversation record: ${probe.dir}/conversation.md`));
  assert.match(said(probe), /Claude Code session id: test-session/);
  assertTail(probe);
});

test("a halt prints HALTED and the reason, the session id and the usage, and exits 1", async () => {
  // Issue #6 (F1): a plan write without the plan, twice, halts after the repair turn.
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions }, { output: noQuestions }] });
  assert.equal(await runProgram(["task"], wiring), 1);
  assert.match(said(probe), /HALTED: the reply of Claude Code does not match its schema: [^]*\nState is preserved in .*plan-review\./);
  assertTail(probe);
});

test("the project directory argument is used, and the config of that project applies", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], config: { maxRounds: 3 } });
  assert.equal(await runProgram(["task", repo], { ...wiring, cwd: "/nonexistent" }), 0);
  assert.match(said(probe), /Planning phase 1, cycle 1: Codex review \.\.\./);
  // Issue #6: one iteration, so the phases carry no number.
  assert.match(said(probe), /\nPlanning: requesting the initial plan/);
  assert.match(said(probe), /\nImplementation: Claude Code implements the plan/);
  assert.match(said(probe), /\nImplementation ended with status: finished/);
  assert.match(said(probe), /\nWork review: Codex reviews the changes/);
  assert.match(said(probe), /finished after 1 implementation phase\(s\)\./);
});

test("a missing task prints the usage and exits 2", async () => {
  const { wiring, probe } = testWiring(tempRepo());
  assert.equal(await runProgram([], wiring), 2);
  assert.match(probe.usageLines[0] ?? "", /^usage: node main\.ts "task description" \[project directory\]$/);
  assert.deepEqual(probe.ui.said, []);
});

test("an invalid config prints HALTED with the file and field and exits 1, before any agent call and without records", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ maxRounds: "5" }));
  assert.equal(await runProgram(["task"], wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: Expected number \(at maxRounds\)/);
  assert.match(said(probe), /Claude Code session id: none/);
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialised");
});

// Decision support, plan step 2.1 (D7): the representation's format is read from the program's own directory.
test("an unreadable decision-making format prints HALTED with the file and exits 1, before any agent call and without records", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  const missing = path.join(probe.dir, "no-such-format.md");
  assert.equal(await runProgram(["task"], { ...wiring, decisionFormat: missing }), 1);
  assert.match(said(probe), new RegExp(`HALTED: the decision-making format ${missing} could not be read`));
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialized");
});

/** Runs the program in a fiber, waits for the double to be reached, interrupts it, and returns its exit. */
const interruptWhen = async (wiring: Wiring, reached: Promise<void>): Promise<Exit.Exit<number, never>> => {
  const fiber = Effect.runFork(Effect.scoped(program(["task"], wiring)));
  await Promise.race([reached, sleep(30_000).then(() => assert.fail("the program did not reach the point to interrupt within 30 s"))]);
  await sleep(10);
  await Effect.runPromise(Fiber.interrupt(fiber));
  return Effect.runPromise(Fiber.await(fiber));
};

const assertInterrupted = (probe: WiringProbe, exit: Exit.Exit<number, never>): void => {
  assert.equal(exitCodeOf(exit), 130);
  assert.match(said(probe), /INTERRUPTED by the user\. State is preserved in .*plan-review\./);
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*\n$/);
  assertTail(probe);
};

test("interrupt while the UI waits for input", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    answers: [{ wait: true }],
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execs: [{ status: "aborted", summary: "", question: "no status", remainingWork: "", userInput: null }],
  });
  const exit = await interruptWhen(wiring, probe.ui.nextAsk());
  assertInterrupted(probe, exit);
});

test("interrupt while a scripted agent call is pending", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }] });
  const exit = await interruptWhen(wiring, probe.planner.nextHang());
  assertInterrupted(probe, exit);
  assert.equal(probe.planner.hangSignals[0].aborted, true, "the pending call was not aborted");
});

test("exitCodeOf: the program's own code, 130 for an interruption, 1 for a defect", () => {
  assert.equal(exitCodeOf(Exit.succeed(0)), 0);
  assert.equal(exitCodeOf(Exit.succeed(2)), 2);
  assert.equal(exitCodeOf(Exit.interrupt(1)), 130);
  assert.equal(exitCodeOf(Exit.die(new Error("x"))), 1);
});

// S24 (issue #25; the user's decision at the stop of execution phase 1): End the run is an interruption with exit code
// 130, like Stop task and Ctrl+C; Stop at the cycle limit stays a halt with exit code 1. Each confirmation says so.
const withQuestion = { steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }], reviews: [{ issues: [] }] };
const statedCode = (text: string): number => Number(/exit code (\d+)/.exec(text)?.[1]);

test("q at a question, confirmed, ends the run as an interruption with exit code 130", async () => {
  const prompts = await import("../src/prompts.ts");
  const { wiring, probe } = testWiring(tempRepo(), { ...withQuestion, answers: ["q", "y"], confirmEnds: true });
  const code = await runProgram(["task"], wiring);
  assert.equal(code, 130);
  assert.equal(code, statedCode(prompts.confirmEndPrompt("endRun")), "the confirmation states another exit code");
  assert.ok(probe.ui.asked.includes(prompts.confirmEndPrompt("endRun")));
  assert.match(said(probe), /INTERRUPTED by the user\. State is preserved in .*plan-review\./);
  assert.doesNotMatch(said(probe), /HALTED/);
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*\n$/);
  assertTail(probe);
});

test("/quit in the clarification, confirmed, ends the run with exit code 130", async () => {
  const turn = { message_to_user: "Tell me more.", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: [], answered_ids: [], complete: false, summary: "" };
  const { wiring, probe } = testWiring(tempRepo(), {
    config: { questionPhase: true },
    steps: [{ output: { questions: [questionEntry("Q1", "Which database should the service use?", [["PostgreSQL", "p"], ["SQLite", "s"]], { context: "c" })] } }, { output: turn }],
    reviews: [{ issues: [] }],
    answers: ["/quit", "y"],
    confirmEnds: true,
  });
  assert.equal(await runProgram(["task"], wiring), 130);
  assert.match(said(probe), /INTERRUPTED by the user/);
});

test("Stop at the cycle limit, confirmed, stays a halt with exit code 1; declined, it returns to the limit", async () => {
  const prompts = await import("../src/prompts.ts");
  const limited = (answers: string[]) =>
    testWiring(tempRepo(), {
      steps: [{ output: noQuestions, plan: "v1" }, { output: { dispositions: [{ id: "P1-R1-1", action: "rejected", rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] } }],
      reviews: [{ issues: [{ id: "P1-R1-1", severity: "major", location: "l", problem: "p", evidence: "e" }] }],
      config: { maxRounds: 1 },
      answers,
      confirmEnds: true,
    });
  const halted = limited(["", "y"]);
  const code = await runProgram(["task"], halted.wiring);
  assert.equal(code, 1);
  assert.equal(code, statedCode(prompts.confirmEndPrompt("limitStop")));
  assert.match(said(halted.probe), /HALTED: stopped by the user at the cycle limit/);
  const declined = limited(["0", "n", "0", "y"]);
  assert.equal(await runProgram(["task"], declined.wiring), 1);
  assert.equal(declined.probe.ui.asked.filter((a) => a === prompts.confirmEndPrompt("limitStop")).length, 2);
});

// Issue #68 (P1-R1-1): an interrupted wait for a usage limit is recorded as actually spent before the summary is printed.
test("interrupt one minute into a weekly usage-limit wait: the summary printed reports one minute waited, not a week", async () => {
  const START = Date.UTC(2026, 8, 30, 5, 32);
  const WEEK = 7 * 24 * 3_600_000;
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ limit: { resetsAtMs: START + WEEK, limitType: "seven_day" } }] });
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((r) => (reached = r));
  let time = START;
  const clock: Clock.Clock = {
    ...steppingClock(START).clock,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeMillisUnsafe: () => time,
    sleep: () => Effect.suspend(() => ((time += 60_000), reached(), Effect.never)),
  };
  const fiber = Effect.runFork(Effect.scoped(program(["task"], wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  await Promise.race([waiting, sleep(30_000).then(() => assert.fail("the wait did not begin within 30 s"))]);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assertInterrupted(probe, exit);
  const text = said(probe);
  assert.ok(text.indexOf("INTERRUPTED by the user.") < text.indexOf("Waited for Claude Code's usage limits"), "the summary is not after the interruption");
  assert.match(text, /Waited for Claude Code's usage limits: 1 time, 1:00 in all \(the last interrupted\)\./);
});
