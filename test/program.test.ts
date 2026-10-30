import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, test } from "node:test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Result } from "effect";
import { ServerFault, TrackerAuthRefused, TrackerUnreachable } from "../src/errors.ts";
import { Planner, Reviewer, Tracker } from "../src/services.ts";
import type { FakeItem } from "./fakeTracker.ts";
import { itemIdOf } from "../src/tracker.ts";
import { refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { commentText, runCommentKey } from "../src/itemComments.ts";
import { type Conclusion, defectMessage, exitCodeOf, type FaultSignal, makeFaultSignal, program, type Wiring } from "../src/program.ts";
import { askedInPlanReview, tempDir, finished, scriptedTask, scriptedStart, steppingClock, tempRepo, testWiring, type WiringProbe, questionOf, questionEntry , TEST_ROOT, scriptedItem, fakeTrackerOf, haltConversationOf, haltReasonOf, withoutReturnLine } from "./helpers.ts";
import type { RunRoot } from "../src/artifacts.ts";
import { checkCommandInvalidText, defectRecord, sendBackIncompleteText, sentBackLine, haltRecord, itemStartedLine, trackerDecisionLine, trackerExhaustedQuestion, trackerRetryLine, transportPrompt, serverFaultRecord, serverFaultText, sessionsLine, sessionTooLongText, workReviewBeganLine } from "../src/prompts.ts";
import type { RunMode } from "../src/runMode.ts";
import type { CommandLine } from "../src/schema.ts";
import { phaseName } from "../src/uiEvents.ts";
import { seededId } from "./fakeTracker.ts";

const noQuestions = { questions_for_user: [] };
const runProgram = (probe: WiringProbe, wiring: Wiring): Promise<number> => Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");

/**
 * Issue #193: the run's conversation.md, in the directory the page named, ends with the halt's record, whose text is the
 * one the page said after HALTED: (the seam: both from the one describe, neither compared with a literal of its own).
 */
const assertHaltRecorded = (probe: WiringProbe): void => {
  const reason = haltReasonOf(said(probe));
  assert.ok(reason !== null, `no halt said: ${said(probe)}`);
  const record = haltConversationOf(said(probe));
  assert.ok(record.endsWith(haltRecord(reason)), record.slice(-600));
};

/**
 * Issue #193: a halt before the run's records existed allocated exactly one directory under plan-review/runs/, the one
 * the page named, and recorded the halt there; returns that directory's conversation.md.
 */
const assertHaltedBeforeRecords = (probe: WiringProbe): string => {
  const runs = path.join(probe.project, "plan-review", "runs");
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  assert.equal(dirs.length, 1, `one records directory expected: ${dirs.join(", ")}`);
  assert.ok(said(probe).includes(`State is preserved in ${path.join(runs, dirs[0])}.`), said(probe));
  assertHaltRecorded(probe);
  return fs.readFileSync(path.join(runs, dirs[0], "conversation.md"), "utf8");
};

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
  assertHaltRecorded(probe);
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

test("an invalid config prints HALTED with the file and field and exits 1, before any agent call, its halt recorded in a directory of its own", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ maxRounds: "5" }));
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: Expected number \(at maxRounds\)/);
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
});

// Issue #142: an unknown value of terms halts before any agent call and before the records are initialized (behavior 9).
test("a terms value other than checked, unchecked or onRequest halts with 1 before any agent call, its halt recorded", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ terms: "sometimes" }));
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: .*\(at terms\)/);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
});

// Decision support, plan step 2.1 (D7): the representation's format is read from the program's own directory.
test("an unreadable decision-making format prints HALTED with the file and exits 1, before any agent call, its halt recorded", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }] });
  const missing = path.join(probe.dir, "no-such-format.md");
  assert.equal(await runProgram(probe, { ...wiring, decisionFormat: missing }), 1);
  assert.match(said(probe), new RegExp(`HALTED: the decision-making format ${missing} could not be read`));
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
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
  const { wiring, probe } = testWiring(tempRepo(), askedInPlanReview({
    answers: [{ wait: true }],
    // A plan writer's question, which still reaches the user (issue #181 removed the question at an execution stop).
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }],
  }));
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
const withQuestion = askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }], reviews: [{ issues: [] }] });
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
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: { questions: [questionEntry("Q1", "Which database should the service use?", [["PostgreSQL", "p"], ["SQLite", "s"]], { context: "c" })] } }],
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
  assertHaltRecorded(halted.probe);
  const declined = limited(["0", "n", "0", "y"]);
  assert.equal(await runProgram(declined.probe, declined.wiring), 1);
  assert.equal(declined.probe.ui.asked.filter((a) => a === prompts.confirmEndText("limitStop")).length, 2);
});

// Issue #68 (P1-R1-1): an interrupted wait for a usage limit is recorded as actually spent before the summary is printed.
test("interrupt one minute into a weekly usage-limit wait: the summary printed reports one minute waited, not a week", async () => {
  const START = Date.UTC(2026, 8, 30, 5, 32);
  const WEEK = 7 * 24 * 3_600_000;
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ limit: { reset: { kind: "instant", atMs: START + WEEK }, limitType: "seven_day" } }] });
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
    execs: [{ status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "B", checks: [] }, finished],
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

// Issue #186 (requirements Q3): a refinement run's task carries the item's comments, a send-back's and the developer's,
// without the markers; an implementation run's carries none.
const sentBackItem = (): FakeItem => ({
  ...sectionedItem(),
  comments: [
    { id: seededId(), body: commentText({ _tag: "SentBack", key: runCommentKey("earlier-run", "verdict-1"), date: "2026-10-28", missing: "The retention period of a note." }), created: "2026-10-28T10:00:00Z" },
    { id: seededId(), body: "Keep them 30 days.", created: "2026-10-28T11:00:00Z" },
  ],
});
for (const mode of ["refinement", "implementation"] as const) {
  test(`issue #186: a${mode === "implementation" ? "n" : ""} ${mode} run's task ${mode === "refinement" ? "carries" : "does not carry"} the item's comments`, async () => {
    const item = sentBackItem();
    const script = mode === "refinement" ? { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] } : converging;
    const { wiring, probe } = testWiring(tempRepo(), { ...script, tracker: fakeTrackerOf([item]) });
    assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, mode, item.id), wiring))), 0);
    const first = probe.planner.prompts[0];
    for (const text of ["The retention period of a note.", "Keep them 30 days."]) assert.equal(first.includes(text), mode === "refinement", text);
    assert.ok(!first.includes("interloq:"), "a marker reached the task");
  });
}

test("issue #186: a refinement whose comments cannot be read halts with 1 before any agent call, its halt recorded", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  await Effect.runPromise(tracker.failNext("comments", new TrackerAuthRefused({ tracker: "GitHub", status: 401 })));
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker, mode: "refinement" });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring))), 1);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
});

test("an item the tracker does not hold halts the run with 1 before any agent call, its halt recorded", async () => {
  const { wiring, probe } = testWiring(tempRepo(), converging);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "implementation", Result.getOrThrow(itemIdOf("999"))), wiring)));
  assert.equal(code, 1);
  assert.match(said(probe), /HALTED: the issue tracker has no item 999/);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
});

test("a project without a configured tracker halts the run with 1 before any agent call, naming the config files", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker: null });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: no issue tracker is configured: set the key tracker in the shared config\.json of Interloq or in plan-review\/config\.json/);
  assert.deepEqual(probe.planner.prompts, []);
  assertHaltedBeforeRecords(probe);
});

// Issue #122: a Claude Code request refused because its session is too long halts with 1 and names the cause.
test("a plan write refused because the session is too long halts with 1, naming the session as the cause", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ sessionTooLong: "Prompt is too long" }] });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(`HALTED: ${sessionTooLongText("Prompt is too long")}`), said(probe));
  assert.doesNotMatch(said(probe), /Claude Code planning call failed/);
  assertTail(probe);
  assertHaltRecorded(probe);
});

test("an execution refused because the session is too long halts with 1, with no work review and no question", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execScripts: [{ sessionTooLong: "Prompt is too long" }] });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(`HALTED: ${sessionTooLongText("Prompt is too long")}`), said(probe));
  assert.equal(fs.existsSync(path.join(probe.dir, "work-review-1")), false);
  assert.deepEqual(probe.ui.asked, []);
  assertHaltRecorded(probe);
});

// Issue #193 and issue #147: a halt before the records directory is recorded in one, which the run manager is not given,
// so the chain treats the run as one that halted before its setup.
test("issue #193: a halt before the records leaves the run manager's allocated directory unset", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ maxRounds: "5" }));
  const allocated = Effect.runSync(Ref.make<Option.Option<RunRoot>>(Option.none()));
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring, undefined, allocated))), 1);
  assert.ok(Option.isNone(Effect.runSync(Ref.get(allocated))));
  assertHaltedBeforeRecords(probe);
});

// Issue #193: every halt writes its reason to conversation.md, as the run ends, with the code and its word.
test("issue #193: a tracker step refused at the start (TrackerStepFailed) halts with 1 and its record in conversation.md", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  await Effect.runPromise(tracker.failNext("setState", new TrackerAuthRefused({ tracker: "GitHub", status: 401 })));
  const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker });
  assert.equal(await runProgram(probe, wiring), 1);
  assert.match(said(probe), /HALTED: [^]*refused the credential/);
  assertHaltRecorded(probe);
});

test("issue #193: a halt whose record cannot be written still ends with 1 and says HALTED", async () => {
  let records = (): string => assert.fail("the records directory is not known");
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [
      {
        sessionTooLong: "Prompt is too long",
        onCall: () => {
          const file = path.join(records(), "conversation.md");
          fs.rmSync(file, { force: true });
          fs.mkdirSync(file);
        },
      },
    ],
  });
  records = () => probe.dir;
  assert.equal(await runProgram(probe, wiring), 1);
  assert.ok(said(probe).includes(`HALTED: ${sessionTooLongText("Prompt is too long")}`), said(probe));
  assertTail(probe);
});

test("issue #193 (Q2): a defect in the run records an internal error in conversation.md, and the run ends with 1", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ defect: "boom" }] });
  const exit = await Effect.runPromiseExit(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  assert.equal(exitCodeOf(exit), 1);
  const record = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.ok(record.endsWith(defectRecord("boom")), record.slice(-400));
});

test("issue #193 (Q2): a defect while the run's services are built records it in the directory allocated", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [] });
  const agents = Layer.merge(Layer.effect(Planner, Effect.die(new Error("layer"))), Layer.succeed(Reviewer, probe.reviewer));
  const exit = await Effect.runPromiseExit(Effect.scoped(program(scriptedStart(probe.project), { ...wiring, agents })));
  assert.equal(exitCodeOf(exit), 1);
  const runs = path.join(probe.project, "plan-review", "runs");
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  assert.equal(dirs.length, 1, `one records directory expected: ${dirs.join(", ")}`);
  const record = fs.readFileSync(path.join(runs, dirs[0], "conversation.md"), "utf8");
  assert.ok(record.endsWith(defectRecord("layer")), record);
});

test("issue #193: a defect's message is an Error's message, any other value's String", () => {
  assert.equal(defectMessage(new Error("boom")), "boom");
  assert.equal(defectMessage("plain"), "plain");
  assert.equal(defectMessage(42), "42");
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
  assert.ok(withoutReturnLine(record).endsWith(serverFaultRecord("write EPIPE")), record);
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
  assert.ok(withoutReturnLine(record).endsWith(serverFaultRecord("write EPIPE")), record);
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
  assertHaltedBeforeRecords(probe);
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
  assertHaltedBeforeRecords(probe);
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
  assertHaltedBeforeRecords(probe);
});

// Issue #171 (S11, requirements Q3, the developer's decision of 15 Oct 2026): the run's first read of its item is
// repeated like every tracker request; its waits, its question and the answer are held until the run creates
// conversation.md, and its question carries no Help me decide, since the records directory is created only after the
// item has been read.
describe("the first read of the item, repeated", () => {
  const FAST = { maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.01 };
  const unreached = () => new TrackerUnreachable({ tracker: "GitHub", message: "reached no answer from GitHub", status: null });
  const failReads = (tracker: ReturnType<typeof fakeTrackerOf>, times: number, error: TrackerUnreachable | TrackerAuthRefused = unreached()) =>
    Effect.runPromise(Effect.forEach(Array.from({ length: times }), () => tracker.failNext("read", error), { discard: true }));
  const conversationOf = (probe: WiringProbe): string => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const readLine = (attempt: number, delay: number) => trackerRetryLine("GitHub", "reading item 1", attempt, 2, delay, unreached().message);

  test("a first read that reached no answer twice runs on, and conversation.md holds both waits before the item's line", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 2);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: FAST });
    assert.equal(await runProgram(probe, wiring), 0);
    const conversation = conversationOf(probe);
    const first = conversation.indexOf(readLine(1, 0.01));
    const second = conversation.indexOf(readLine(2, 0.02));
    const started = conversation.indexOf(itemStartedLine("implementation", scriptedItem.id, scriptedItem.title));
    assert.ok(first >= 0 && second > first && started > second, conversation);
  });

  test("a first read whose repeats run out asks without Help me decide, and Stop halts with 1, the failure named, its repeats and halt recorded", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 3);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: FAST, answers: ["s"] });
    assert.equal(await runProgram(probe, wiring), 1);
    assert.deepEqual(probe.ui.asked, [transportPrompt]);
    assert.match(said(probe), /HALTED: the GitHub issue tracker could not be reached: reached no answer from GitHub/);
    assert.deepEqual(probe.planner.prompts, []);
    // Issue #193: the held records of the first read come before the halt's record.
    const conversation = assertHaltedBeforeRecords(probe);
    const retry = conversation.indexOf(readLine(1, 0.01));
    const question = conversation.indexOf(trackerExhaustedQuestion("GitHub", "reading item 1"));
    const decision = conversation.indexOf(trackerDecisionLine("stop", "GitHub", "reading item 1"));
    const record = conversation.indexOf(haltRecord(haltReasonOf(said(probe)) ?? ""));
    assert.ok(retry >= 0 && question > retry && decision > question && record > decision, conversation);
  });

  test("W1-R1-1: a first read that succeeds after a repeat, then a listed command naming a missing script: the retry line comes before the halt's record", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 1);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: { ...FAST, checkCommands: [{ change: "unit", command: "npm run test:missing" }] } });
    writeManifest(probe.project, { test: "node --test" });
    assert.equal(await runProgram(probe, wiring), 1);
    const conversation = assertHaltedBeforeRecords(probe);
    const retry = conversation.indexOf(readLine(1, 0.01));
    const record = conversation.indexOf(haltRecord(haltReasonOf(said(probe)) ?? ""));
    assert.ok(retry >= 0 && record > retry, conversation);
  });

  test("Retry again, then a read that succeeds: the run goes on, the question and the decision in conversation.md", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 3);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: FAST, answers: ["r"] });
    assert.equal(await runProgram(probe, wiring), 0);
    const conversation = conversationOf(probe);
    assert.ok(conversation.includes(trackerExhaustedQuestion("GitHub", "reading item 1")), conversation);
    assert.ok(conversation.includes(trackerDecisionLine("retry", "GitHub", "reading item 1")));
  });

  test("a refused credential at the first read halts at once, with no question", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 1, new TrackerAuthRefused({ tracker: "GitHub", status: 401 }));
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: FAST });
    assert.equal(await runProgram(probe, wiring), 1);
    assert.deepEqual(probe.ui.asked, []);
    assert.match(said(probe), /HALTED: the GitHub issue tracker refused the credential \(HTTP status 401\)/);
    assertHaltedBeforeRecords(probe);
  });

  test("End the run at the first read's question ends the run with 130", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 3);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: FAST, answers: ["q"] });
    assert.equal(await runProgram(probe, wiring), 130);
    assert.match(said(probe), /INTERRUPTED by the user\./);
  });

  test("Stop task during a first-read wait ends the run with 130", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    await failReads(tracker, 1);
    const { wiring, probe } = testWiring(tempRepo(), { ...converging, tracker, config: { maxTrackerRetries: 2, trackerRetryDelaySeconds: 60 } });
    const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
    for (let waited = 0; !probe.ui.notified.some((e) => e._tag === "TrackerRetrying") && waited < 10_000; waited += 10) await sleep(10);
    assert.ok(probe.ui.notified.some((e) => e._tag === "TrackerRetrying"), "the wait never began");
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  });
});

// Issue #186: a send-back ends with 0 and concludes the run's own parking; a guard stop, a parking that failed and a
// send-back left incomplete end with 1 and keep the item implementing; an interruption after the run's own parking
// concludes it from parked.json and never returns the item to refined (reviews P1-R1-2, P1-R1-3).
describe("issue #186: how a send-back ends", () => {
  const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const MISSING = "The requirements do not say how long a note is kept.";
  const noQuestions = { questions_for_user: [] };
  const verdictAtFirstPlan = { steps: [{ output: { reply: { kind: "notRefined", missing: MISSING } } }], reviews: [{ issues: [] }] };
  const notRefinedExec = { status: "not_refined" as const, summary: "S1 done", question: MISSING, remainingWork: "S2", userInput: null, checks: [] };
  const verdictMidWork = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [notRefinedExec] };
  /** The item, whose last refinement asked the developer nothing where `asked` is false: the guard of requirements Q5. */
  const itemAsked = (asked: boolean): FakeItem => ({ ...scriptedItem, comments: [{ id: seededId(), body: commentText({ _tag: "RefinementRecord", key: runCommentKey("refinement-run"), date: "2026-10-28", asked }), created: "2026-10-28T00:00:00Z" }] });
  const started = (probe: WiringProbe, wiring: Wiring, signal?: FaultSignal) => {
    const concluded = Effect.runSync(Ref.make(Option.none<Conclusion>()));
    const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring, signal, undefined, undefined, concluded)));
    return { concluded, fiber };
  };
  const ended = async (probe: WiringProbe, wiring: Wiring) => {
    const { concluded, fiber } = started(probe, wiring);
    const code = exitCodeOf(await Effect.runPromise(Fiber.await(fiber)));
    return { code, conclusion: Option.getOrNull(Effect.runSync(Ref.get(concluded))) };
  };
  const stateOf = async (probe: WiringProbe) => (await Effect.runPromise(probe.tracker!.items)).find((i) => i.id === scriptedItem.id)?.state;
  const waitFor = async (probe: WiringProbe, tag: string) => {
    for (let waited = 0; !probe.ui.notified.some((e) => e._tag === tag) && waited < 20_000; waited += 10) await sleep(10);
    assert.ok(probe.ui.notified.some((e) => e._tag === tag), `${tag} never came`);
  };

  test("a send-back concludes 0 with its parking and says the send-back line", async () => {
    const { wiring, probe } = testWiring(tempRepo(), verdictMidWork);
    const { code, conclusion } = await ended(probe, wiring);
    assert.equal(code, 0);
    assert.equal(conclusion?.code, 0);
    assert.equal(conclusion?.parked?._tag, "Parked");
    assert.ok(probe.ui.said.includes(sentBackLine(scriptedItem.id, 1)), said(probe));
    assert.equal(await stateOf(probe), "unrefined");
  });

  test("a guard stop concludes 1 with its note, records its halt and keeps the item implementing with no commit made", async () => {
    const tracker = fakeTrackerOf([itemAsked(false)]);
    const { wiring, probe } = testWiring(tempRepo(), { ...verdictAtFirstPlan, tracker });
    const { code, conclusion } = await ended(probe, wiring);
    assert.equal(code, 1);
    assert.deepEqual(conclusion, { code: 1, parked: { _tag: "NothingParked" }, abandoned: null });
    assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes("**Halted (exit code 1):**"));
    assert.equal(await stateOf(probe), "implementing");
  });

  test("a parking that failed concludes 1 with ParkFailed and keeps the item implementing", async () => {
    // A repository on an unborn branch: the baseline has no start commit, so the parking cannot return the working
    // branch to it (PARK_NO_START_COMMIT).
    const unborn = tempDir("interloq-unborn-");
    execFileSync("git", ["-C", unborn, "init", "-q"]);
    const { wiring, probe } = testWiring(unborn, verdictAtFirstPlan);
    const { code, conclusion } = await ended(probe, wiring);
    assert.equal(code, 1);
    assert.equal(conclusion?.parked?._tag, "ParkFailed");
    assert.equal(await stateOf(probe), "implementing");
  });

  test("a guard stop and a send-back, each stopped by Stop task during the comment write with nothing to park, conclude 130 with NothingParked", async () => {
    for (const asked of [false, true]) {
      const tracker = fakeTrackerOf([itemAsked(asked)]);
      Effect.runSync(tracker.failNext("comment", new TrackerUnreachable({ tracker: "fake", message: "down", status: null })));
      const { wiring, probe } = testWiring(tempRepo(), { ...verdictAtFirstPlan, tracker, config: { maxTrackerRetries: 2, trackerRetryDelaySeconds: 60 } });
      const { concluded, fiber } = started(probe, wiring);
      await waitFor(probe, "TrackerRetrying");
      await Effect.runPromise(Fiber.interrupt(fiber));
      assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
      assert.deepEqual(Option.getOrNull(Effect.runSync(Ref.get(concluded))), { code: 130, parked: { _tag: "NothingParked" }, abandoned: null }, `asked: ${asked}`);
      assert.equal(await stateOf(probe), "implementing", `asked: ${asked}`);
    }
  });

  // Work review 1 (W1-R1-3): a guard stop whose parking kept the run's commit, and whose comment then fails for good.
  test("a guard stop whose comment fails for good after a parking that kept work concludes 1 with Parked, its halt SendBackIncomplete", async () => {
    const tracker = fakeTrackerOf([itemAsked(false)]);
    Effect.runSync(tracker.failNext("comment", new TrackerAuthRefused({ tracker: "fake", status: 403 })));
    const repo = tempRepo();
    const start = git(repo, "rev-parse", "HEAD");
    const { wiring, probe } = testWiring(repo, { ...verdictMidWork, tracker });
    const { code, conclusion } = await ended(probe, wiring);
    assert.equal(code, 1);
    assert.equal(conclusion?.code, 1);
    const parked = conclusion?.parked;
    assert.ok(parked?._tag === "Parked", JSON.stringify(parked));
    assert.notEqual(git(repo, "rev-parse", parked.branch), start, "the run's commit is on the item's branch");
    assert.equal(git(repo, "rev-parse", "HEAD"), start, "the working branch is back at the start commit");
    assert.equal(await stateOf(probe), "implementing");
    const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
    const incomplete = sendBackIncompleteText(scriptedItem.id, "stoppedUnrefined", parked, "<cause>").split("<cause>")[0]!;
    assert.ok(conversation.includes(incomplete), conversation.slice(-1500));
    assert.ok(conversation.trimEnd().split("\n").at(-1)!.startsWith("**Halted (exit code 1):**"), conversation.slice(-500));
  });

  // Work review 1 (W1-R1-3): the send-back's parking runs uninterruptibly, so Stop task during it takes effect after it.
  test("Stop task during a send-back's parking lets the parking complete, concludes 130 with Parked and keeps the item implementing", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const repo = tempRepo();
    const start = git(repo, "rev-parse", "HEAD");
    const { wiring, probe } = testWiring(repo, {
      ...verdictMidWork,
      tracker: fakeTrackerOf([itemAsked(true)]),
      store: (s) => ({ ...s, commitLeftovers: (m) => Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), s.commitLeftovers(m))) }),
    });
    const { concluded, fiber } = started(probe, wiring);
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("20 seconds")));
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await interrupted;
    assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
    const conclusion = Option.getOrNull(Effect.runSync(Ref.get(concluded)));
    assert.equal(conclusion?.code, 130);
    const parked = conclusion?.parked;
    assert.ok(parked?._tag === "Parked", JSON.stringify(parked));
    assert.equal(JSON.parse(fs.readFileSync(path.join(probe.dir, "parked.json"), "utf8"))._tag, "Parked");
    assert.notEqual(git(repo, "rev-parse", parked.branch), start);
    assert.equal(git(repo, "rev-parse", "HEAD"), start);
    assert.equal(await stateOf(probe), "implementing");
  });

  test("a guard stop interrupted by the server's fault during its comment write concludes 1 and keeps the item implementing", async () => {
    const tracker = fakeTrackerOf([itemAsked(false)]);
    Effect.runSync(tracker.failNext("comment", new TrackerUnreachable({ tracker: "fake", message: "down", status: null })));
    const { wiring, probe } = testWiring(tempRepo(), { ...verdictAtFirstPlan, tracker, config: { maxTrackerRetries: 2, trackerRetryDelaySeconds: 60 } });
    const signal = Effect.runSync(makeFaultSignal);
    const { concluded, fiber } = started(probe, wiring, signal);
    await waitFor(probe, "TrackerRetrying");
    await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
    assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 1);
    assert.equal(Option.getOrNull(Effect.runSync(Ref.get(concluded)))?.code, 1);
    assert.equal(await stateOf(probe), "implementing");
  });
});
