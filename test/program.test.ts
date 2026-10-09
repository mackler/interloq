import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber, Result } from "effect";
import type { FakeItem } from "./fakeTracker.ts";
import { itemIdOf } from "../src/tracker.ts";
import { refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { exitCodeOf, program, type Wiring } from "../src/program.ts";
import { finished, scriptedTask, scriptedStart, steppingClock, tempRepo, testWiring, type WiringProbe, questionOf, currentOf, questionEntry , TEST_ROOT, scriptedItem, fakeTrackerOf } from "./helpers.ts";
import type { RunRoot } from "../src/artifacts.ts";
import { mainSessionLine, workReviewBeganLine } from "../src/prompts.ts";
import { phaseName } from "../src/uiEvents.ts";

const noQuestions = { questions_for_user: [] };
const runProgram = (probe: WiringProbe, wiring: Wiring): Promise<number> => Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");

/** The run's root, as the program allocated it (issue #120): its records directory relative to plan-review/. */
const rootOf = (probe: WiringProbe): RunRoot => path.relative(path.join(probe.project, "plan-review"), probe.dir).split(path.sep).join("/") as RunRoot;
/** The session line of the run, naming its own usage.jsonl. */
const sessionLine = (probe: WiringProbe, id: string | null): string => mainSessionLine(rootOf(probe), id);
/** The session line of a run halted before its records directory was allocated: no session, whatever the path it names. */
const NO_SESSION = /^Claude Code main session id: none \(/;
/** The lines every ending prints last: the main Claude Code session id and the usage summary. */
const assertTail = (probe: WiringProbe): void => {
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.ok([sessionLine(probe, "test-session"), sessionLine(probe, null)].includes(lines.at(-2) ?? "") || NO_SESSION.test(lines.at(-2) ?? ""), lines.at(-2));
  assert.match(lines.at(-1) ?? "", /^Usage: /);
};

test("a finished run prints the plan path and exits 0", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runProgram(probe, wiring), 0);
  assert.match(said(probe), /Claude Code reports that the task is finished after 1 implementation phase\(s\)\./);
  assert.match(said(probe), new RegExp(`Plan: ${path.join(probe.dir, "plan.md")}\\nConversation record: ${probe.dir}/conversation.md`));
  assert.ok(said(probe).includes(sessionLine(probe, "test-session")));
  assertTail(probe);
});

test("a halt prints HALTED and the reason, the session id and the usage, and exits 1", async () => {
  // Issue #6 (F1): a plan write without the plan, twice, halts after the repair turn.
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions }, { output: noQuestions }] });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: the reply of Claude Code does not match its schema: [^]*\nState is preserved in .*plan-review\/runs\/[^/\s]+\./);
  assertTail(probe);
});

test("the project directory of the start is used, and the config of that project applies", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], config: { maxRounds: 3 } });
  assert.equal(await runProgram(probe, wiring), 0);
  assert.match(said(probe), /Planning phase 1, cycle 1: Codex review \.\.\./);
  // Issue #6: one iteration, so the phases carry no number.
  assert.match(said(probe), /\nPlanning: requesting the initial plan/);
  assert.match(said(probe), /\nImplementation: Claude Code implements the plan/);
  assert.match(said(probe), /\nImplementation ended with status: finished/);
  assert.ok(said(probe).includes(workReviewBeganLine(phaseName({ kind: "work", n: 1 }, 1))));
  assert.match(said(probe), /finished after 1 implementation phase\(s\)\./);
});

test("an invalid config prints HALTED with the file and field and exits 1, before any agent call and without records", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ maxRounds: "5" }));
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: Expected number \(at maxRounds\)/);
  assert.ok(probe.ui.said.flatMap((t) => t.split("\n")).some((l) => NO_SESSION.test(l)));
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialised");
});

// Decision support, plan step 2.1 (D7): the representation's format is read from the program's own directory.
test("an unreadable decision-making format prints HALTED with the file and exits 1, before any agent call and without records", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  const missing = path.join(probe.dir, "no-such-format.md");
  assert.equal(await runProgram(probe, { ...wiring, decisionFormat: missing }), 1);
  assert.match(said(probe), new RegExp(`HALTED: the decision-making format ${missing} could not be read`));
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialized");
});

/** Runs the program in a fiber, waits for the double to be reached, interrupts it, and returns its exit. */
const interruptWhen = async (probe: WiringProbe, wiring: Wiring, reached: Promise<void>): Promise<Exit.Exit<number, never>> => {
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  await Promise.race([reached, sleep(30_000).then(() => assert.fail("the program did not reach the point to interrupt within 30 s"))]);
  await sleep(10);
  await Effect.runPromise(Fiber.interrupt(fiber));
  return Effect.runPromise(Fiber.await(fiber));
};

const assertInterrupted = (probe: WiringProbe, exit: Exit.Exit<number, never>): void => {
  assert.equal(exitCodeOf(exit), 130);
  assert.match(said(probe), /INTERRUPTED by the user\. State is preserved in .*plan-review\/runs\/[^/\s]+\./);
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
  const exit = await interruptWhen(probe, wiring, probe.ui.nextAsk());
  assertInterrupted(probe, exit);
});

test("interrupt while a scripted agent call is pending", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }] });
  const exit = await interruptWhen(probe, wiring, probe.planner.nextHang());
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
  const code = await runProgram(probe, wiring);
  assert.equal(code, 130);
  assert.equal(code, statedCode(prompts.confirmEndText("endRun")), "the confirmation states another exit code");
  assert.ok(probe.ui.asked.includes(prompts.confirmEndText("endRun")));
  assert.match(said(probe), /INTERRUPTED by the user\. State is preserved in .*plan-review\/runs\/[^/\s]+\./);
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
  assert.equal(await runProgram(probe, wiring), 130);
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
  const code = await runProgram(halted.probe, halted.wiring);
  assert.equal(code, 1);
  assert.equal(code, statedCode(prompts.confirmEndText("limitStop")));
  assert.match(said(halted.probe), /HALTED: stopped by the user at the cycle limit/);
  const declined = limited(["0", "n", "0", "y"]);
  assert.equal(await runProgram(declined.probe, declined.wiring), 1);
  assert.equal(declined.probe.ui.asked.filter((a) => a === prompts.confirmEndText("limitStop")).length, 2);
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
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  await Promise.race([waiting, sleep(30_000).then(() => assert.fail("the wait did not begin within 30 s"))]);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assertInterrupted(probe, exit);
  const text = said(probe);
  assert.ok(text.indexOf("INTERRUPTED by the user.") < text.indexOf("Waited for Claude Code's usage limits"), "the summary is not after the interruption");
  assert.match(text, /Waited for Claude Code's usage limits: 1 time, 1:00 in all \(the last interrupted\)\./);
});

// Issue #117: with a session per execution phase the end names the run's main session as the main one, and the usage line
// counts every session.
test("issue #117: a run of two execution phases ends naming its main session as such, and the usage counts three sessions", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1", usage: true }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "B" }, finished],
    execScripts: [{ usage: true }, { usage: true }],
  });
  assert.equal(await runProgram(probe, wiring), 0);
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.equal(lines.at(-2), sessionLine(probe, "test-session"));
  assert.match(sessionLine(probe, "test-session"), /main session/);
  assert.match(lines.at(-1) ?? "", /Claude Code: 3 calls in 3 sessions/);
});

// Issue #120, S5: a run is started from an item; the program reads it from the tracker and its task is the item's. The
// seam: the item id the run is given, the item the fake holds, and the task the planner receives, all from one item.
const developerText = "Make the page two tabs.";
const sectionedItem = (): FakeItem => ({ ...scriptedItem, id: Result.getOrThrow(itemIdOf("120")), title: "Two modes", body: Result.getOrThrow(withRefinement(developerText, Result.getOrThrow(refinementOf("The confirmed requirements.")))), open: true });
const converging = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

for (const mode of ["refinement", "implementation"] as const) {
  test(`the task of a${mode === "implementation" ? "n" : ""} ${mode} run is its item's title and body, read from the tracker, ${mode === "refinement" ? "without" : "with"} the section`, async () => {
    const item = sectionedItem();
    const tracker = fakeTrackerOf([item]);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker });
    await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, mode, item.id), wiring)));
    const held = (await Effect.runPromise(tracker.items)).find((i) => i.id === item.id);
    assert.ok(held !== undefined);
    const body = mode === "refinement" ? Result.getOrThrow(withoutRefinement(held.body)) : held.body;
    assert.ok(probe.planner.prompts[0].includes(`Task: ${held.title}\n\n${body}`), probe.planner.prompts[0].slice(-300));
    assert.equal(probe.planner.prompts[0].includes("The confirmed requirements."), mode === "implementation");
    assert.ok(said(probe).includes(`of item ${item.id}: ${item.title}`));
  });
}

test("an item the tracker does not hold halts the run with 1 before any agent call and without records", async () => {
  const { wiring, probe } = testWiring(tempRepo(), converging);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "implementation", Result.getOrThrow(itemIdOf("999"))), wiring)));
  assert.equal(code, 1);
  assert.match(said(probe), /HALTED: the issue tracker has no item 999/);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.project, "plan-review", "runs")), "a records directory was created");
});

test("a project without a configured tracker halts the run with 1 before any agent call, naming the config files", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker: null });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: no issue tracker is configured: set the key tracker in the shared config\.json of Interloq or in plan-review\/config\.json/);
  assert.deepEqual(probe.planner.prompts, []);
});
