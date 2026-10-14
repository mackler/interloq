import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Result } from "effect";
import { ServerFault } from "../src/errors.ts";
import { Reviewer, Tracker } from "../src/services.ts";
import type { FakeItem } from "./fakeTracker.ts";
import { itemIdOf } from "../src/tracker.ts";
import { refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { exitCodeOf, type FaultSignal, makeFaultSignal, program, type Wiring } from "../src/program.ts";
import { finished, scriptedTask, scriptedStart, steppingClock, tempRepo, testWiring, type WiringProbe, questionOf, currentOf, questionEntry , TEST_ROOT, scriptedItem, fakeTrackerOf } from "./helpers.ts";
import type { RunRoot } from "../src/artifacts.ts";
import { checkCommandInvalidText, serverFaultRecord, serverFaultText, sessionsLine, sessionTooLongText, workReviewBeganLine } from "../src/prompts.ts";
import type { RunMode } from "../src/runMode.ts";
import type { CommandLine } from "../src/schema.ts";
import { phaseName } from "../src/uiEvents.ts";

const noQuestions = { questions_for_user: [] };
const runProgram = (probe: WiringProbe, wiring: Wiring): Promise<number> => Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");

/** The run's root, as the program allocated it (issue #120): its records directory relative to plan-review/. */
const rootOf = (probe: WiringProbe): RunRoot => path.relative(path.join(probe.project, "plan-review"), probe.dir).split(path.sep).join("/") as RunRoot;
/** The session line of the run, naming its own usage.jsonl (issue #122: by the run's mode). */
const sessionLine = (probe: WiringProbe, id: string | null, mode: RunMode = "implementation"): string => sessionsLine(rootOf(probe), mode, id);
/** The session line of a run halted before its records directory was allocated: its words before the path it names. */
const noSession = (line: string): boolean => (["implementation", "refinement"] as const).some((mode) => line.startsWith(sessionsLine("unallocated" as RunRoot, mode, null).split("plan-review/")[0]));
/** The lines every ending prints last: the Claude Code sessions and the usage summary. */
const assertTail = (probe: WiringProbe, mode: RunMode = "implementation"): void => {
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.ok([sessionLine(probe, "test-session", mode), sessionLine(probe, null, mode)].includes(lines.at(-2) ?? "") || noSession(lines.at(-2) ?? ""), lines.at(-2));
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
  assert.ok(probe.ui.said.flatMap((t) => t.split("\n")).some(noSession));
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialised");
});

// Issue #142: an unknown value of terms halts before any agent call and before the records are initialized (behavior 9).
test("a terms value other than checked, unchecked or onRequest halts with 1 before any agent call and without records", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ terms: "sometimes" }));
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: .*\(at terms\)/);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialized");
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
    steps: [{ output: { questions: [questionEntry("Q1", "Which database should the service use?", [["PostgreSQL", "p"], ["SQLite", "s"]], { context: "c" })] } }, { output: turn }],
    reviews: [{ issues: [] }],
    answers: ["/quit", "y"],
    confirmEnds: true,
  });
  // The clarification belongs to a refinement run (issue #120).
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring))), 130);
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

// Issue #122: every phase of an implementation run has a session of its own, so its end names no main session; the
// usage line counts each phase's session. A refinement run keeps one session, which its end names.
test("issue #122: a run of two iterations ends with the implementation's sessions line, and the usage counts each phase's session", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1", usage: true }, { output: noQuestions, plan: "v2", usage: true }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "B" }, finished],
    execScripts: [{ usage: true }, { usage: true }],
  });
  assert.equal(await runProgram(probe, wiring), 0);
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.equal(lines.at(-2), sessionLine(probe, null, "implementation"));
  assert.doesNotMatch(lines.at(-2) ?? "", /main session/);
  assert.match(lines.at(-1) ?? "", /Claude Code: 4 calls in 4 sessions/);
});

test("issue #122: a refinement run ends naming its one session", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker, mode: "refinement" });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring))), 0);
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.equal(lines.at(-2), sessionLine(probe, "test-session", "refinement"));
  assertTail(probe, "refinement");
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
    // A refinement run is the question phase alone (S6): an empty agreed list, which ends it successfully.
    const script = mode === "refinement" ? { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] } : converging;
    const { wiring, probe } = testWiring(tempRepo(), { ...script, tracker });
    assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, mode, item.id), wiring))), 0);
    const held = (await Effect.runPromise(tracker.items)).find((i) => i.id === item.id);
    assert.ok(held !== undefined);
    const body = mode === "refinement" ? Result.getOrThrow(withoutRefinement(held.body)) : held.body;
    assert.ok(probe.planner.prompts[0].includes(`Task: ${held.title}\n\n${body}`), probe.planner.prompts[0].slice(-300));
    assert.equal(probe.planner.prompts[0].includes("The confirmed requirements."), mode === "implementation");
    assert.ok(said(probe).includes(`of item ${item.id}: ${item.title}`));
    // The program ran the mode's run: a refinement run sets its item refined; an implementation run, until S7, nothing.
    assert.equal(held.state === "refined" && (await Effect.runPromise(tracker.items))[0].body !== item.body, mode === "refinement");
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

// Issue #122: a Claude Code request refused because its session is too long halts with 1 and names the cause.
test("a plan write refused because the session is too long halts with 1, naming the session as the cause", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ sessionTooLong: "Prompt is too long" }] });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(`HALTED: ${sessionTooLongText("Prompt is too long")}`), said(probe));
  assert.doesNotMatch(said(probe), /Claude Code planning call failed/);
  assertTail(probe);
});

test("an execution refused because the session is too long halts with 1, with no work review and no question", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execScripts: [{ sessionTooLong: "Prompt is too long" }] });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(`HALTED: ${sessionTooLongText("Prompt is too long")}`), said(probe));
  assert.equal(fs.existsSync(path.join(probe.dir, "work-review-1")), false);
  assert.deepEqual(probe.ui.asked, []);
});

// Issue #158 (the user's decision Q1): an error the server cannot trace to one run halts every run in progress with
// ServerFault, wherever the run is, with its record in conversation.md; the run's code is 1 and nothing says INTERRUPTED.
const faultWhen = async (
  probe: WiringProbe,
  wiring: Wiring,
  reached: Promise<void>,
  start = scriptedStart(probe.project),
  signal: FaultSignal = Effect.runSync(makeFaultSignal),
): Promise<Exit.Exit<number, never>> => {
  const fiber = Effect.runFork(Effect.scoped(program(start, wiring, signal)));
  await Promise.race([reached, sleep(30_000).then(() => assert.fail("the program did not reach the point of the fault within 30 s"))]);
  await sleep(10);
  await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
  const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption("10 seconds")));
  if (Option.isSome(ended)) return ended.value;
  await Effect.runPromise(Fiber.interrupt(fiber));
  return assert.fail("the run did not end within 10 s of the server's fault");
};
const assertServerFault = (probe: WiringProbe, exit: Exit.Exit<number, never>, dir = probe.dir): void => {
  assert.equal(exitCodeOf(exit), 1);
  assert.ok(said(probe).includes(`HALTED: ${serverFaultText("write EPIPE")}`), said(probe));
  assert.ok(!said(probe).includes("INTERRUPTED"));
  const record = fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
  assert.ok(record.endsWith(serverFaultRecord("write EPIPE")), record);
  assert.ok(!record.includes("**Interrupted by the user.**"));
};

test("the server's fault while a run waits at a prompt halts it with 1 and its record", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...withQuestion, answers: [{ wait: true }] });
  const exit = await faultWhen(probe, wiring, probe.ui.nextAsk());
  assertServerFault(probe, exit);
  assertTail(probe);
});

test("the server's fault during a Codex turn halts the run with 1 and its record, the turn ended", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let ended = false;
  const hanging = Layer.succeed(Reviewer, {
    startPhase: Effect.succeed({ review: () => Effect.sync(reach).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => void (ended = true)))) }),
  });
  const exit = await faultWhen(probe, { ...wiring, agents: Layer.merge(wiring.agents, hanging) }, reached);
  assertServerFault(probe, exit);
  assert.ok(ended, "the Codex turn was not ended");
});

test("the server's fault while the run's services are built (a layer that never finishes) halts it with 1 and its record in the directory allocated", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const building = Layer.effectDiscard(Effect.sync(reach).pipe(Effect.andThen(Effect.never)));
  const signal = Effect.runSync(makeFaultSignal);
  const exit = await faultWhen(probe, { ...wiring, agents: Layer.merge(wiring.agents, building) }, reached, scriptedStart(probe.project), signal);
  const runs = path.join(probe.project, "plan-review", "runs");
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  assert.equal(dirs.length, 1, `one records directory expected: ${dirs.join(", ")}`);
  assertServerFault(probe, exit, path.join(runs, dirs[0]));
  assertTail(probe);
  assert.ok(Effect.runSync(Deferred.isDone(signal.recorded)), "the record was not marked written");
});

/**
 * A run whose Codex turn is uninterruptible until `release`, interrupted from outside (W1-S1-1 of issue #158): with the
 * server's fault failed first, or, as Stop task, without it. Returns the run's exit once it ended.
 */
const interruptedFromOutside = async (faulted: boolean) => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const release = Effect.runSync(Deferred.make<void>());
  const holding = Layer.succeed(Reviewer, { startPhase: Effect.succeed({ review: () => Effect.sync(reach).pipe(Effect.andThen(Effect.uninterruptible(Deferred.await(release))), Effect.andThen(Effect.never)) }) });
  const signal = Effect.runSync(makeFaultSignal);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), { ...wiring, agents: Layer.merge(wiring.agents, holding) }, signal)));
  await Promise.race([reached, sleep(30_000).then(() => assert.fail("the Codex turn was not reached within 30 s"))]);
  await sleep(10);
  if (faulted) await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
  await sleep(10);
  Effect.runFork(Fiber.interrupt(fiber));
  await sleep(10);
  await Effect.runPromise(Deferred.succeed(release, undefined));
  const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption("10 seconds")));
  if (Option.isNone(ended)) return assert.fail("the run did not end within 10 s of its interruption");
  return { probe, signal };
};

test("a faulted run interrupted from outside in an uninterruptible turn records and says the server's fault, never INTERRUPTED", async () => {
  const { probe, signal } = await interruptedFromOutside(true);
  assert.ok(said(probe).includes(`HALTED: ${serverFaultText("write EPIPE")}`), said(probe));
  assert.ok(!said(probe).includes("INTERRUPTED"), said(probe));
  const record = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.ok(record.endsWith(serverFaultRecord("write EPIPE")), record);
  assert.ok(!record.includes("**Interrupted by the user.**"), record);
  assert.ok(Effect.runSync(Deferred.isDone(signal.recorded)), "the record was not marked written");
  assertTail(probe);
});

test("a run interrupted from outside without a fault (Stop task) still records and says the user's interruption", async () => {
  const { probe, signal } = await interruptedFromOutside(false);
  assert.ok(said(probe).includes("INTERRUPTED by the user. State is preserved in"), said(probe));
  assert.ok(!said(probe).includes("HALTED"), said(probe));
  const record = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.ok(record.includes("**Interrupted by the user.**"), record);
  assert.ok(!Effect.runSync(Deferred.isDone(signal.recorded)));
});

test("the server's fault before the run's records exist (a tracker read that never returns) halts it with 1 and creates its record", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(tempRepo(), { tracker });
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const stuck: Wiring = { ...wiring, tracker: () => Result.succeed(Layer.succeed(Tracker, { ...tracker.tracker, read: () => Effect.sync(reach).pipe(Effect.andThen(Effect.never)) })) };
  const exit = await faultWhen(probe, stuck, reached);
  const runs = path.join(probe.project, "plan-review", "runs");
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  assert.equal(dirs.length, 1, "no records directory was created");
  assertServerFault(probe, exit, path.join(runs, dirs[0]));
});

// Issue #162: an implementation run decodes checkCommands and suiteCommand and checks the npm scripts they name against
// the project's package.json at its start, before any record or agent call; a refinement run reads neither.
const writeManifest = (project: string, scripts: Record<string, string>): void => fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", scripts }));
const heldState = async (tracker: ReturnType<typeof fakeTrackerOf>): Promise<string | undefined> => (await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)?.state;

test("issue #162: a listed npm command naming a script package.json lacks halts an implementation run with 1 before any agent call", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: { checkCommands: [{ change: "unit", command: "npm run test:missing" }], suiteCommand: "npm test" } });
  writeManifest(probe.project, { test: "node --test" });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(checkCommandInvalidText([{ _tag: "MissingScript", command: "npm run test:missing" as CommandLine, script: "test:missing" }])), said(probe));
  assert.match(said(probe), /HALTED: .*npm run test:missing.*test:missing/su);
  assert.deepEqual(probe.planner.prompts, []);
  assert.equal(await heldState(tracker), scriptedItem.state, "the item was moved");
});

test("issue #162: the same configuration does not refuse a refinement run", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker, mode: "refinement", config: { checkCommands: [{ change: "unit", command: "npm run test:missing" }] } });
  writeManifest(probe.project, { test: "node --test" });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring))), 0);
});

test("issue #162 (P1-R1-2): malformed settings halt an implementation run with ConfigInvalid naming the key and the file, and never a refinement run", async () => {
  const malformed = { suiteCommand: " ", checkCommands: [{ change: "unit", command: "npm test\nnpm run check" }] };
  const refinement = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker: fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]), mode: "refinement", config: malformed });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(refinement.probe.project, "refinement"), refinement.wiring))), 0);
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: malformed });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: .*\(at checkCommands\[0\]\.command\)/u);
  assert.deepEqual(probe.planner.prompts, []);
  assert.equal(await heldState(tracker), scriptedItem.state);
});

test("issue #162: a listed command that is not an npm script is used as written and not checked", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, config: { checkCommands: [{ change: "e2e", command: "npx playwright test e2e/run.spec.ts" }] } });
  assert.equal(await runProgram(probe, wiring), 0);
});

test("issue #162: an npm command in a project with no package.json halts, naming the command", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, config: { suiteCommand: "npm test" } });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(checkCommandInvalidText([{ _tag: "NoManifest", command: "npm test" as CommandLine }])), said(probe));
  assert.deepEqual(probe.planner.prompts, []);
});
