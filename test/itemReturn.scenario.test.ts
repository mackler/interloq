// Issue #192 (decision Q5): an implementation run that halts (1) or is stopped (130) having made no commit labels its
// item refined again, through the tracker retry, saying and writing the outcome; the exit code never changes.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Deferred, Effect, Fiber, Option, Ref } from "effect";
import { ServerFault, trackerFailureText, TrackerUnreachable } from "../src/errors.ts";
import { exitCodeOf, type FaultSignal, makeFaultSignal, program, type Wiring } from "../src/program.ts";
import { haltRecord, itemReturnedLine, serverFaultRecord, sessionTooLongText } from "../src/prompts.ts";
import type { ItemState } from "../src/tracker.ts";
import { fakeTrackerOf, heldClock, questionOf, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const item = scriptedItem.id;
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");
const conversation = (probe: WiringProbe): string => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
const stateOf = async (probe: WiringProbe): Promise<ItemState> => {
  const items = await Effect.runPromise(probe.tracker?.items ?? Effect.succeed([]));
  const found = items.find((i) => i.id === item);
  assert.ok(found !== undefined);
  return found.state;
};
const unreachable = (status: number | null = null) => new TrackerUnreachable({ tracker: "fake", message: "down", status });
const quickTracker = { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 };

const runWith = (wiring: Wiring, probe: WiringProbe, claim?: Effect.Effect<boolean>, signal?: FaultSignal): Promise<number> =>
  Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring, signal, undefined, claim)));
/** A halt in the first planning call: the session is too long, after the item was labeled and the baseline written. */
const haltsAtPlanning: TestOptions = { steps: [{ sessionTooLong: "Prompt is too long" }] };

test("(a) a halt with no commit labels the item refined, says the line and writes it before the halt's record", async () => {
  const { wiring, probe } = testWiring(tempRepo(), haltsAtPlanning);
  assert.equal(await runWith(wiring, probe), 1);
  assert.equal(await stateOf(probe), "refined");
  assert.ok(said(probe).includes(itemReturnedLine(item)), said(probe));
  const record = conversation(probe);
  const line = record.indexOf(itemReturnedLine(item));
  assert.ok(line >= 0, record);
  assert.ok(record.endsWith(haltRecord(sessionTooLongText("Prompt is too long"))), record.slice(-400));
  assert.ok(line < record.lastIndexOf("**Halted"), record.slice(-600));
});

test("(b) Stop task during the first planning call: 130, the item refined, the line before the interruption's record", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }] });
  const reached = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (probe.planner.prompts.length > 0) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  await reached;
  await sleep(20);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130);
  assert.equal(await stateOf(probe), "refined");
  const record = conversation(probe);
  assert.ok(record.indexOf(itemReturnedLine(item)) >= 0, record);
  assert.ok(record.indexOf(itemReturnedLine(item)) < record.lastIndexOf("**Interrupted by the user.**"), record);
});

test("(c) End the run, confirmed, at a question: 130 and the item refined", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }],
    reviews: [{ issues: [] }],
    answers: ["q", "y"],
    confirmEnds: true,
  });
  assert.equal(await runWith(wiring, probe), 130);
  assert.equal(await stateOf(probe), "refined");
});

test("(d) a halt after an execution that committed keeps the item implementing and says nothing of a relabeling", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { sessionTooLong: "Prompt is too long" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "s", question: "q", remainingWork: "r", userInput: null, checks: [] }],
  });
  assert.equal(await runWith(wiring, probe), 1);
  assert.equal(await stateOf(probe), "implementing");
  assert.ok(!said(probe).includes(itemReturnedLine(item)));
  assert.ok(!said(probe).includes("could not label item"));
});

test("(e) a halt before the baseline relabels nothing", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 10; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "implementing"));
  const { wiring, probe } = testWiring(tempRepo(), { ...haltsAtPlanning, tracker, config: quickTracker, answers: ["s"] });
  assert.equal(await runWith(wiring, probe), 1);
  assert.equal(await stateOf(probe), "refined");
  assert.ok(!said(probe).includes(itemReturnedLine(item)));
  assert.ok(!said(probe).includes("could not label item"));
});

test("(f) a relabeling that fails for good says and writes itemNotReturnedLine, asks nothing, and the code stays 1", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 4; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const { wiring, probe } = testWiring(tempRepo(), { ...haltsAtPlanning, tracker, config: quickTracker });
  assert.equal(await runWith(wiring, probe), 1);
  assert.equal(await stateOf(probe), "implementing");
  assert.ok(said(probe).includes("could not label item"), said(probe));
  assert.ok(conversation(probe).includes("could not label item"));
  assert.deepEqual(probe.ui.asked, []);
});

test("(f2) a conversation.md that cannot be written cuts no retry short: the retry succeeds, or fails and is said", async () => {
  for (const failures of [1, 4]) {
    const tracker = fakeTrackerOf([scriptedItem]);
    for (let i = 0; i < failures; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
    // The planning call makes conversation.md read-only, so every later write to it fails, the retry's lines included.
    let probeOf: WiringProbe | null = null;
    const { wiring, probe } = testWiring(tempRepo(), {
      steps: [{ sessionTooLong: "Prompt is too long", onCall: () => probeOf !== null && fs.chmodSync(path.join(probeOf.dir, "conversation.md"), 0o444) }],
      tracker,
      config: quickTracker,
    });
    probeOf = probe;
    assert.equal(await runWith(wiring, probe), 1);
    assert.ok(!conversation(probe).includes(itemReturnedLine(item)), "conversation.md was written after it was made read-only");
    if (failures === 1) {
      assert.ok(said(probe).includes(itemReturnedLine(item)), said(probe));
      assert.equal(await stateOf(probe), "refined");
    } else assert.ok(said(probe).includes("could not label item"), said(probe));
  }
});

test("(g) a finished run still ends implemented and writes no relabeling line", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [{ status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks: [] }] });
  assert.equal(await runWith(wiring, probe), 0);
  assert.equal(await stateOf(probe), "implemented");
  assert.ok(!said(probe).includes(itemReturnedLine(item)));
});

/** A halt in the work review after an execution that left its change uncommitted (and made no commit). */
const leavesUncommitted: TestOptions = {
  steps: [{ output: noQuestions, plan: "v1" }, { sessionTooLong: "Prompt is too long" }],
  reviews: [{ issues: [] }, { issues: [{ id: "W1-R1-1", severity: "major", location: "l", problem: "p", evidence: "e" }] }],
  execScripts: [{ uncommitted: true }],
  execs: [{ status: "finished", summary: "s", question: "", remainingWork: "", userInput: null, checks: [] }],
};
const counting = (answer: boolean) => {
  let asked = 0;
  return { claim: Effect.sync(() => (asked++, answer)), asked: () => asked };
};
const dirty = (probe: WiringProbe): string => execFileSync("git", ["status", "--porcelain", "--", "a.txt"], { cwd: probe.project, encoding: "utf8" });

test("(h) a halt with leftovers asks for the parking claim once: granted keeps implementing, refused returns with the file left", async () => {
  for (const granted of [true, false]) {
    const { wiring, probe } = testWiring(tempRepo(), leavesUncommitted);
    const c = counting(granted);
    assert.equal(await runWith(wiring, probe, c.claim), 1);
    assert.equal(c.asked(), 1);
    assert.equal(await stateOf(probe), granted ? "implementing" : "refined");
    if (!granted) assert.notEqual(dirty(probe), "");
  }
});

test("(h) a halt with nothing uncommitted, and a Stop task with leftovers, return the item without asking for the claim", async () => {
  const halt = testWiring(tempRepo(), haltsAtPlanning);
  const c = counting(true);
  assert.equal(await runWith(halt.wiring, halt.probe, c.claim), 1);
  assert.equal(c.asked(), 0);
  assert.equal(await stateOf(halt.probe), "refined");

  const stop = testWiring(tempRepo(), { ...leavesUncommitted, steps: [{ output: noQuestions, plan: "v1" }, { hang: true }] });
  const s = counting(true);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(stop.probe.project), stop.wiring, undefined, undefined, s.claim)));
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (stop.probe.planner.prompts.length > 1 && stop.probe.planner.execPrompts.length > 0) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  await sleep(20);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  assert.equal(s.asked(), 0);
  assert.equal(await stateOf(stop.probe), "refined");
});

/** The server's fault during the first planning call, which hangs. */
const faultedAtPlanning = async (options: TestOptions = {}) => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }], ...options });
  const signal = Effect.runSync(makeFaultSignal);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring, signal)));
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (probe.planner.prompts.length > 0) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  await sleep(10);
  await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
  const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption("20 seconds")));
  if (Option.isNone(ended)) return assert.fail("the run did not end within 20 s of the fault");
  return { probe, exit: ended.value };
};

test("(i) the server fault halts with 1, writes its record, then labels the item refined and says the line", async () => {
  const { probe, exit } = await faultedAtPlanning();
  assert.equal(exitCodeOf(exit), 1);
  assert.equal(await stateOf(probe), "refined");
  assert.ok(said(probe).includes(itemReturnedLine(item)), said(probe));
  const record = conversation(probe);
  assert.ok(record.indexOf(serverFaultRecord("write EPIPE")) < record.indexOf(itemReturnedLine(item)), record);
});

test("(i) after the fault, a write applied and answered with a server error is read back as done", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  Effect.runSync(tracker.failAfterNext("setState", unreachable(500), "refined"));
  const { probe, exit } = await faultedAtPlanning({ tracker });
  assert.equal(exitCodeOf(exit), 1);
  assert.ok(said(probe).includes(itemReturnedLine(item)), said(probe));
  assert.ok(!said(probe).includes("could not label item"), said(probe));
});

test("(i) after the fault, a tracker unreachable on every attempt is said within the bound and the code stays 1", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 10; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const started = Date.now();
  const { probe, exit } = await faultedAtPlanning({ tracker });
  assert.equal(exitCodeOf(exit), 1);
  assert.ok(said(probe).includes("could not label item"), said(probe));
  assert.ok(Date.now() - started < 15_000, "the relabeling after the fault was not bounded");
});

test("(j) a refinement run's halt leaves its item unrefined", async () => {
  const unrefined = { ...scriptedItem, state: "unrefined" as const };
  const tracker = fakeTrackerOf([unrefined]);
  const { wiring, probe } = testWiring(tempRepo(), { ...haltsAtPlanning, tracker, mode: "refinement" });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring))), 1);
  assert.equal(await stateOf(probe), "unrefined");
  assert.ok(!said(probe).includes(itemReturnedLine(item)));
});

// Work review 2 (W2-R1-1): once the body has ended, the run's ending runs uninterruptibly, and the code it computes
// reaches the caller through `concluded`, although the fiber ends interrupted. Work review 3 (W3-R2-1): the relabel's
// waits are held on `heldClock`, so the interruption is requested while the run is known to be inside its wait.
const interruptedDuringRelabel = (probe: WiringProbe, wiring: Wiring, clock: Clock.Clock, signal?: FaultSignal) => {
  const concluded = Effect.runSync(Ref.make(Option.none<number>()));
  const fiber = Effect.runFork(
    Effect.scoped(program(scriptedStart(probe.project), wiring, signal, undefined, undefined, concluded)).pipe(Effect.provideService(Clock.Clock, clock)),
  );
  return { concluded, fiber };
};
/** Requests the interruption synchronously, after checking that the fiber has not ended, so it lands inside the wait. */
const interruptWhileWaiting = (fiber: Fiber.Fiber<number, unknown>): void => {
  assert.equal(fiber.pollUnsafe(), undefined, "the run ended before the interruption was requested");
  fiber.interruptUnsafe();
};
const heldTimeout = { timeout: 30_000 };

test("W2-R1-1 (k) Stop task during the relabel's wait: the item is returned, the halt's record is written, the code stays 1", heldTimeout, async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const { wiring, probe } = testWiring(tempRepo(), { ...haltsAtPlanning, tracker, config: { maxTrackerRetries: 2, trackerRetryDelaySeconds: 3 } });
  const held = heldClock(Date.now());
  const { concluded, fiber } = interruptedDuringRelabel(probe, wiring, held.clock);
  await held.sleepRegistered(3000);
  interruptWhileWaiting(fiber);
  held.advance(3000);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130, "the interruption did not land inside the run's ending");
  assert.deepEqual(Effect.runSync(Ref.get(concluded)), Option.some(1));
  assert.equal(await stateOf(probe), "refined");
  const record = conversation(probe);
  assert.ok(record.includes(itemReturnedLine(item)), record);
  assert.ok(record.endsWith(haltRecord(sessionTooLongText("Prompt is too long"))), record.slice(-400));
  assert.ok(!record.includes("**Interrupted by the user.**"), record);
});

test("W2-R1-1 (k2) Stop task during the relabel's wait, the tracker unreachable throughout: itemNotReturnedLine, then the halt's record, code 1", heldTimeout, async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 4; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const { wiring, probe } = testWiring(tempRepo(), { ...haltsAtPlanning, tracker, config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 3 } });
  const held = heldClock(Date.now());
  const { concluded, fiber } = interruptedDuringRelabel(probe, wiring, held.clock);
  await held.sleepRegistered(3000);
  interruptWhileWaiting(fiber);
  held.advance(3000);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130, "the interruption did not land inside the run's ending");
  assert.deepEqual(Effect.runSync(Ref.get(concluded)), Option.some(1));
  // The relabel ran to its last attempt: the line names the tracker's failure, not an interruption of the write.
  const exhausted = `could not label item ${item} refined again: ${trackerFailureText(unreachable())}.`;
  assert.ok(said(probe).includes(exhausted), said(probe));
  const record = conversation(probe);
  assert.ok(record.includes(exhausted), record);
  assert.ok(record.endsWith(haltRecord(sessionTooLongText("Prompt is too long"))), record.slice(-400));
});

test("W2-R1-1 (k3) after the server's fault, an interruption during the relabel leaves its 5 s bound: no answer within 5 s, code 1", heldTimeout, async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 10; i++) Effect.runSync(tracker.failNext("setState", unreachable(), "refined"));
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }], tracker, config: { maxTrackerRetries: 5, trackerRetryDelaySeconds: 10 } });
  const signal = Effect.runSync(makeFaultSignal);
  const held = heldClock(Date.now());
  const { concluded, fiber } = interruptedDuringRelabel(probe, wiring, held.clock, signal);
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (probe.planner.prompts.length > 0) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  await sleep(10);
  await Effect.runPromise(Deferred.fail(signal.fault, new ServerFault({ message: "write EPIPE" })));
  await held.sleepRegistered(5000);
  await held.sleepRegistered(10_000);
  interruptWhileWaiting(fiber);
  held.advance(5000);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 130, "the interruption did not land inside the run's ending");
  assert.deepEqual(Effect.runSync(Ref.get(concluded)), Option.some(1));
  assert.ok(said(probe).includes("no answer within 5 s"), said(probe));
  assert.deepEqual(
    [held.sleeps().filter((ms) => ms === 5000).length, held.sleeps().filter((ms) => ms === 10_000).length],
    [1, 1],
    `the bound did not end the relabel during its first retry wait: ${JSON.stringify(held.sleeps())}`,
  );
});
