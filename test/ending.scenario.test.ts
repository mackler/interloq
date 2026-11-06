// Issue #44 (S4): the program concludes the run's ending where it knows it, on every path, with the parking and the
// item's return as confirmed; the exit code is derived from it and unchanged (behavior 11).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import { describe as describeError, GitError, ServerFault, TrackerStepFailed, TrackerUnreachable } from "../src/errors.ts";
import { type Conclusion, exitCodeOf, type FaultSignal, makeFaultSignal, program, returnCheckOf, type Wiring } from "../src/program.ts";
import { commentText, runCommentKey } from "../src/itemComments.ts";
import { exitCodeOfEnding } from "../src/ending.ts";
import { haltRecord } from "../src/prompts.ts";
import type { FakeItem } from "./fakeTracker.ts";
import { seededId } from "./fakeTracker.ts";
import { fakeTrackerOf, finished, notRefined, questionOf, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const MISSING = "The requirements do not say how long a note is kept.";
const noQuestions = { questions_for_user: [] };
const quickTracker = { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 };
const unreachable = (status: number | null = null) => new TrackerUnreachable({ tracker: "fake", message: "down", status });
const verdictAtFirstPlan: TestOptions = { steps: [{ output: notRefined(MISSING) }], reviews: [{ issues: [] }] };
const notRefinedExec = { status: "not_refined" as const, summary: "S1 done", question: MISSING, remainingWork: "S2", userInput: null, checks: [], testFirst: [] };
const verdictMidWork: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [notRefinedExec] };
const finishing: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
const haltsAtPlanning: TestOptions = { steps: [{ sessionTooLong: "Prompt is too long" }] };
const itemAsked = (asked: boolean): FakeItem => ({
  ...scriptedItem,
  comments: [{ id: seededId(), body: commentText({ _tag: "RefinementRecord", key: runCommentKey("refinement-run"), date: "2026-10-28", asked }), created: "2026-10-28T00:00:00Z" }],
});

/** Starts the program with a `concluded` Ref and the wiring's observation of each conclusion. */
const started = (probe: WiringProbe, wiring: Wiring, signal?: FaultSignal, mode: "implementation" | "refinement" = "implementation") => {
  const concluded = Effect.runSync(Ref.make(Option.none<Conclusion>()));
  const observed: Conclusion[] = [];
  const observing: Wiring = { ...wiring, observeConclusion: (c) => Effect.sync(() => void observed.push(c)) };
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project, mode), observing, signal, undefined, undefined, concluded)));
  return { concluded, observed, fiber };
};
const ended = async (options: TestOptions, mode: "implementation" | "refinement" = "implementation") => {
  const { wiring, probe } = testWiring(tempRepo(), options);
  const { concluded, observed, fiber } = started(probe, wiring, undefined, mode);
  const code = exitCodeOf(await Effect.runPromise(Fiber.await(fiber)));
  const conclusion = Option.getOrNull(Effect.runSync(Ref.get(concluded)));
  assert.ok(conclusion !== null, "nothing was concluded");
  // (k) the observation receives the value the Ref holds, once.
  assert.deepEqual(observed, [conclusion]);
  assert.equal(code, exitCodeOfEnding(conclusion.ending));
  return { code, conclusion, ending: conclusion.ending, probe };
};

test("(a) a verdict that stands after work was done is a send-back with its parked branch, code 0", async () => {
  const { code, ending } = await ended(verdictMidWork);
  assert.equal(code, 0);
  assert.equal(ending._tag, "SentBack");
  if (ending._tag !== "SentBack") return;
  assert.equal(ending.missing, MISSING);
  assert.equal(ending.park._tag, "Parked");
});

test("(b) a verdict that stands with nothing to park is a send-back that parked nothing", async () => {
  const { code, ending } = await ended(verdictAtFirstPlan);
  assert.equal(code, 0);
  assert.deepEqual(ending, { _tag: "SentBack", missing: MISSING, park: { _tag: "NothingParked" } });
});

test("(c) an abandonment whose parking fails is abandoned with the parking's failure and the label kept implementing, code 2", async () => {
  const question = questionOf({ context: "c", question: "Which retention?", terms: [], options: [] });
  const { code, ending } = await ended({
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: { questions_for_user: [question] }, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execScripts: [{ uncommitted: true }],
    execs: [{ status: "needs_input", summary: "s", question: "q", remainingWork: "r", userInput: null, checks: [], testFirst: [] }],
    store: (s) => ({ ...s, commitLeftovers: () => Effect.fail(new GitError({ args: ["commit"], message: "the commit was refused" })) }),
  });
  assert.equal(code, 2);
  assert.equal(ending._tag, "Abandoned");
  if (ending._tag !== "Abandoned") return;
  assert.equal(ending.park?._tag, "ParkFailed");
  assert.deepEqual(ending.label, { _tag: "KeptImplementing" });
});

test("(d) a run that finished its work and failed its final tracker step is halted with that reason, code 1", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 10; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "implemented"));
  const { code, ending, probe } = await ended({ ...finishing, tracker, config: quickTracker, answers: [{ beside: "s" }] });
  assert.equal(code, 1);
  assert.equal(ending._tag, "Halted");
  if (ending._tag !== "Halted") return;
  assert.match(ending.reason, /implemented/);
  assert.equal(ending.records, probe.dir);
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").endsWith(haltRecord(ending.reason)));
});

test("(e) a completion names the final commands that passed, and none where none is configured", async () => {
  const withSuite = await ended({ ...finishing, config: { suiteCommand: "script/test --all" } });
  assert.deepEqual(withSuite.ending, { _tag: "Completed", work: { _tag: "Implemented", finalCommands: ["script/test --all"] } });
  const without = await ended(finishing);
  assert.deepEqual(without.ending, { _tag: "Completed", work: { _tag: "Implemented", finalCommands: [] } });
});

test("(f) a refinement that wrote its requirements back completed with the item refined", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const { code, ending } = await ended({ steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker, mode: "refinement" }, "refinement");
  assert.equal(code, 0);
  assert.deepEqual(ending, { _tag: "Completed", work: { _tag: "Refined" } });
});

const whenPlanning = (probe: WiringProbe) =>
  new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (probe.planner.prompts.length > 0) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });

test("(g) Stop task with no commit is interrupted with the item returned, code 130", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }] });
  const { concluded, observed, fiber } = started(probe, wiring);
  await whenPlanning(probe);
  await sleep(20);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  const conclusion = Option.getOrNull(Effect.runSync(Ref.get(concluded)));
  assert.deepEqual(conclusion?.ending, { _tag: "Interrupted", park: null, item: { _tag: "Returned" } });
  assert.deepEqual(observed, [conclusion]);
});

test("(h) a return refused with the item read back implementing is not returned, the label it held named", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 4; i++) Effect.runSync(tracker.failNext("setState", unreachable(500), "refined"));
  const { ending } = await ended({ ...haltsAtPlanning, tracker, config: quickTracker });
  assert.equal(ending._tag, "Halted");
  if (ending._tag !== "Halted") return;
  assert.equal(ending.item?._tag, "NotReturned");
  if (ending.item?._tag !== "NotReturned") return;
  assert.deepEqual(ending.item.check, { _tag: "Held", state: "implementing" });
});

test("(h2) a return applied whose answer was lost, with nothing read back, is not returned and unchecked", async () => {
  // The write lands and its answer is lost, so nothing is read back: the item is in fact refined, unconfirmed.
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 2; i++) Effect.runSync(tracker.failAfterNext("setState", unreachable(), "refined"));
  const { ending } = await ended({ ...haltsAtPlanning, tracker, config: quickTracker });
  assert.equal(ending._tag, "Halted");
  if (ending._tag !== "Halted" || ending.item?._tag !== "NotReturned") return assert.fail(JSON.stringify(ending));
  assert.deepEqual(ending.item.check, { _tag: "Unchecked" });
});

test("(h2b) a return applied and answered with a server error, whose read-back fails, is not returned and unchecked, never the label it held before", async () => {
  // The write lands and is answered 500, so the item is read back; the read-back fails, so nothing is confirmed. The read
  // failures are queued only once the halting planning call holds, so the run's own first read of its item takes none.
  const tracker = fakeTrackerOf([scriptedItem]);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ sessionTooLong: "Prompt is too long", gate: () => held }], tracker, config: quickTracker });
  const { concluded, fiber } = started(probe, wiring);
  await whenPlanning(probe);
  for (let i = 0; i < 2; i++) {
    Effect.runSync(tracker.failAfterNext("setState", unreachable(500), "refined"));
    Effect.runSync(tracker.failNext("read", unreachable()));
  }
  const readsBefore = Effect.runSync(tracker.reads).length;
  release();
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 1);
  const ending = Option.getOrNull(Effect.runSync(Ref.get(concluded)))?.ending;
  if (ending?._tag !== "Halted" || ending.item?._tag !== "NotReturned") return assert.fail(JSON.stringify(ending));
  assert.deepEqual(ending.item.check, { _tag: "Unchecked" });
  assert.equal(Effect.runSync(tracker.items).find((i) => i.id === scriptedItem.id)?.state, "refined");
  assert.ok(Effect.runSync(tracker.reads).length >= readsBefore + 2, "the item was not read back after each write");
});

test("(h3) after the server's fault, a return the tracker never answers is not returned and unchecked", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 10; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }], tracker });
  const signal = Effect.runSync(makeFaultSignal);
  const { concluded, fiber } = started(probe, wiring, signal);
  await whenPlanning(probe);
  await sleep(10);
  await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 1);
  const ending = Option.getOrNull(Effect.runSync(Ref.get(concluded)))?.ending;
  if (ending?._tag !== "Halted" || ending.item?._tag !== "NotReturned") return assert.fail(JSON.stringify(ending));
  assert.equal(ending.reason, describeError(new ServerFault({ message: "write EPIPE" })));
  assert.deepEqual(ending.item.check, { _tag: "Unchecked" });
});

test("(i) a guard stop is halted with its parking's note", async () => {
  const { code, ending } = await ended({ ...verdictMidWork, tracker: fakeTrackerOf([itemAsked(false)]) });
  assert.equal(code, 1);
  assert.equal(ending._tag, "Halted");
  if (ending._tag !== "Halted") return;
  assert.equal(ending.park?._tag, "Parked");
  assert.equal(ending.item, null);
});

test("(j) a halt before the records is halted with the directory allocated for it, and no item return", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { ...finishing, tracker: null });
  const { concluded, observed, fiber } = started(probe, wiring);
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 1);
  const ending = Option.getOrNull(Effect.runSync(Ref.get(concluded)))?.ending;
  if (ending?._tag !== "Halted") return assert.fail(JSON.stringify(ending));
  const dirs = fs.readdirSync(path.join(repo, "plan-review", "runs"));
  assert.equal(dirs.length, 1);
  assert.equal(ending.records, path.join(fs.realpathSync(repo), "plan-review", "runs", dirs[0]!));
  assert.equal(ending.park, null);
  assert.equal(ending.item, null);
  assert.equal(observed.length, 1);
});

test("returnCheckOf: what is known of the label after the last write", () => {
  assert.deepEqual(returnCheckOf(null), { _tag: "Unchecked" });
  assert.deepEqual(returnCheckOf({ kind: "unchecked" }), { _tag: "Unchecked" });
  assert.deepEqual(returnCheckOf({ kind: "held", held: { kind: "state", state: "implementing" } }), { _tag: "Held", state: "implementing" });
  assert.deepEqual(returnCheckOf({ kind: "held", held: { kind: "noSection" } }), { _tag: "Unchecked" });
  void TrackerStepFailed;
});
