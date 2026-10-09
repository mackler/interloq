import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Result, Scope } from "effect";
import { claudePlannerLayer } from "../src/claude.ts";
import { codexReviewerLayer } from "../src/codex.ts";
import { identify, type MountTable } from "../src/hostDir.ts";
import { platformLayer } from "../src/platform.ts";
import { NoTracker, TrackerUnreachable } from "../src/errors.ts";
import { program } from "../src/program.ts";
import { listedState, type RunMode } from "../src/runMode.ts";
import { runInProgressText } from "../src/prompts.ts";
import { Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import type { RunEvent } from "../src/protocol.ts";
import { type Broadcast, type EventBroadcast, type Listener, type UiBroadcast, makePublisher, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
import { subscribeBounded } from "../src/webServer.ts";
import { FakeSdk, init, messages, success, turn } from "./fakeSdk.ts";
import { finished, scriptedPlan, scriptedTask, scriptedStart, type TestOptions, tempDir, tempRepo, testWiring, questionOf, currentOf, plain, questionEntry, runDirOf, runDirsOf, fakeTrackerOf, MANAGER_ITEMS, trackerAccessOf } from "./helpers.ts";

// Plan step 3.3: the run manager with scripted clients over the scripted wiring (and once over the real adapters).
const run = Effect.runPromise;
const noQuestions = { questions_for_user: [] };
type Harness = { manager: RunManager; received: EventBroadcast[]; uiReceived: UiBroadcast[]; scope: Scope.Closeable; repo: string; scripts: TestOptions[]; tracker: FakeTracker; used: Set<string> };

/**
 * The project's tracker of a harness (issue #120): refined items for the implementation runs and unrefined ones for the
 * refinement runs, each with the scripted item's title and empty body, so that its task is the scripted task.
 */
const ITEMS = MANAGER_ITEMS;
/** The next item of the mode that no run of the harness has started from. */
const nextItem = (h: Harness, mode: RunMode): string => {
  const item = ITEMS.find((i) => i.state === listedState(mode) && !h.used.has(i.id)) ?? assert.fail(`no ${mode} item left`);
  h.used.add(item.id);
  return item.id;
};

/** A manager over `cwd` whose runs use, in turn, the scripted wiring of each options object; a listener collects the broadcast. */
const harness = async (repo: string, scripts: TestOptions[], wiringOf = (options: TestOptions) => testWiring(repo, options).wiring, mounts: MountTable = [], tracker: FakeTracker = fakeTrackerOf(ITEMS)): Promise<Harness> => {
  const queue = [...scripts];
  const access = trackerAccessOf(tracker);
  const manager = await run(makeRunManager((ui) => ({ ...wiringOf({ tracker, ...(queue.shift() ?? {}) }), ui: Effect.succeed(ui) }), repo, mounts, "test", access).pipe(Effect.provide(platformLayer)));
  const received: EventBroadcast[] = [];
  const uiReceived: UiBroadcast[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b: Broadcast) => Effect.sync(() => void (b._tag === "event" ? received.push(b) : uiReceived.push(b)))).pipe(Scope.provide(scope)));
  return { manager, received, uiReceived, scope, repo, scripts, tracker, used: new Set() };
};
const until = async (what: string, condition: () => boolean, ms = 30_000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 5) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const eventsOf = (h: Harness, id: number): RunEvent[] => h.received.filter((b) => b.run === id).map((b) => b.event);
const ended = (h: Harness, id: number) => until(`the end of run ${id}`, () => eventsOf(h, id).some((e) => e._tag === "Ended"));
const endCode = (h: Harness, id: number): number | undefined => eventsOf(h, id).flatMap((e) => (e._tag === "Ended" ? [e.code] : []))[0];
const started = async (h: Harness, mode: RunMode = "implementation"): Promise<number> => {
  const id = await run(h.manager.start(mode, nextItem(h, mode)));
  assert.equal(typeof id, "number", `refused: ${(id as Refusal).refused}`);
  return id as number;
};
const pendingAsk = async (h: Harness, id: number) => {
  let asked: Extract<RunEvent, { _tag: "Asked" }> | undefined;
  await until("a prompt", () => {
    const events = eventsOf(h, id);
    const last = [...events].reverse().find((e) => e._tag === "Asked" || e._tag === "Answered");
    asked = last?._tag === "Asked" ? last : undefined;
    return asked !== undefined;
  });
  return asked!;
};
const NONE = { refinement: null, implementation: null };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

test("a run: Started, the Ui's events, Ended 0; conversation.md is byte-identical to a direct run of the program over the same script", async () => {
  const direct = tempRepo();
  const { wiring } = testWiring(direct, { ...converging, tracker: fakeTrackerOf(ITEMS) });
  assert.equal(await run(Effect.scoped(program(scriptedStart(direct, "implementation", ITEMS[0].id), wiring))), 0);

  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const id = await started(h);
  await ended(h, id);
  const events = eventsOf(h, id);
  assert.equal(events[0]._tag, "Started");
  assert.deepEqual(h.received.filter((b) => b.run === id).map((b) => b.seq), events.map((_, i) => i), "seq counts from 0 without a gap");
  assert.equal(endCode(h, id), 0);
  assert.ok(events.some((e) => e._tag === "Said" && /finished after 1 implementation phase/.test(e.text)));
  assert.ok(events.some((e) => e._tag === "Notified" && e.event._tag === "PhaseBegan"));
  const read = (r: string) => fs.readFileSync(path.join(runDirOf(r), "conversation.md"), "utf8");
  assert.equal(read(repo), read(direct));
  assert.deepEqual(await run(h.manager.current), NONE);
});

test("a question is answered through the manager, with the same text the scripted Ui would send", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] }]);
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  assert.equal(asked.kind, "decision");
  assert.equal(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "PostgreSQL")), null);
  await ended(h, id);
  assert.match(fs.readFileSync(path.join(runDirOf(repo), "user-decisions.md"), "utf8"), /Which database\?\nDecision: PostgreSQL/);
});

// Issue #120: one run per mode. A second start in the same mode is refused with that mode; the other mode accepts one.
test("a second start in a mode is refused with that mode while the other mode accepts a run; a project that is no worktree is refused", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }, { steps: [{ hang: true }] }]);
  const id = await started(h, "implementation");
  await until("the hanging call", () => eventsOf(h, id).some((e) => e._tag === "Said" && /^Planning: requesting the initial plan/.test(e.text)));
  const refusedStart = (await run(h.manager.start("implementation", nextItem(h, "implementation")))) as Refusal;
  assert.deepEqual(refusedStart, { refused: runInProgressText("implementation"), mode: "implementation" });
  const other = await started(h, "refinement");
  assert.deepEqual(await run(h.manager.current), { refinement: other, implementation: id });
  for (const r of [id, other]) {
    await run(h.manager.stop(h.manager.incarnation, r));
    await ended(h, r);
  }
  for (const [cwd, reason] of [[path.join(repo, "nope"), /does not exist/], [path.join(repo, "a.txt"), /not a directory/], [tempDir("pr-plain-"), /not a git repository/]] as const) {
    const bad = await harness(cwd as string, []);
    const refused = (await run(bad.manager.start("implementation", "1"))) as Refusal;
    assert.match(refused.refused, reason);
    assert.equal(refused.mode, "implementation");
  }
});

test("a start for an item whose state changed since the list was shown is refused, and nothing starts", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const item = nextItem(h, "implementation");
  await run(h.tracker.tracker.setState(Result.getOrThrow(itemIdOf(item)), "implemented"));
  const refused = (await run(h.manager.start("implementation", item))) as Refusal;
  assert.deepEqual(refused, { refused: `item ${item} is no longer refined: it is implemented; refresh the list`, mode: "implementation" });
  assert.deepEqual(h.received, []);
});

test("answering and stopping one run leaves the run of the other mode running, each with its own records directory", async () => {
  const repo = tempRepo();
  const question = (q: string): TestOptions => ({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: q, terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: [], answered_ids: [], complete, summary });
  const refining: TestOptions = { steps: [{ output: { questions: [questionEntry("Q1", "Which cache?", [["Redis", "r"], ["None", "n"]], { context: "c" })] } }, { output: turn("Which cache?", false, "") }, { output: turn("Done.", true, "# Requirements\n\nRedis.") }], reviews: [{ issues: [] }, { issues: [] }], answers: [] };
  const h = await harness(repo, [question("Which database?"), refining]);
  const implementation = await started(h, "implementation");
  const asked = await pendingAsk(h, implementation);
  const refinement = await started(h, "refinement");
  const you = await pendingAsk(h, refinement);
  const before = runDirsOf(repo);
  assert.equal(before.length, 2, "each run has its own records directory");
  const files = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
  const refinementFiles = files(before.find((d) => d.endsWith(`refinement-${eventsOf(h, refinement).flatMap((e) => (e._tag === "Started" ? [e.item.id] : []))[0]}`)) ?? assert.fail("no refinement directory"));
  // The implementation run is answered and ends; the refinement run still waits on its prompt, its records untouched.
  assert.equal(await run(h.manager.answer(h.manager.incarnation, implementation, asked.prompt, "PostgreSQL")), null);
  await ended(h, implementation);
  assert.equal(endCode(h, implementation), 0);
  assert.equal(eventsOf(h, refinement).some((e) => e._tag === "Ended"), false);
  assert.deepEqual(files(runDirsOf(repo).find((d) => d.includes("-refinement-"))!), refinementFiles);
  assert.equal(await run(h.manager.stop(h.manager.incarnation, refinement)), null);
  await ended(h, refinement);
  assert.equal(endCode(h, refinement), 130);
  void you;
});

// Issue #120: a run is started from an item. A start frame with a blank item id, which the page's buttons do not send but
// another client could, is refused before the project is examined; no run is reserved and nothing is published.
test("a blank item id is refused, before the project check; no run starts and nothing is published", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const bad = await harness(path.join(repo, "nope"), []);
  for (const item of ["", "   ", "\n\t "]) {
    const refused = (await run(h.manager.start("refinement", item))) as Refusal;
    assert.deepEqual(refused, { refused: "no item was chosen", mode: "refinement" }, JSON.stringify(item));
    assert.equal(((await run(bad.manager.start("implementation", item))) as Refusal).refused, "no item was chosen");
  }
  assert.deepEqual(await run(h.manager.current), NONE);
  assert.deepEqual(h.received, []);
  await run(Scope.close(h.scope, Exit.void));
});

test("stop interrupts the run like Ctrl+C; answers and stops naming an ended run are refused; a new run gets a new id", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }] }, converging]);
  const first = await started(h);
  const asked = await pendingAsk(h, first);
  assert.equal(await run(h.manager.stop(h.manager.incarnation, first)), null);
  await ended(h, first);
  assert.equal(endCode(h, first), 130);
  assert.ok(eventsOf(h, first).some((e) => e._tag === "Said" && /INTERRUPTED by the user\. State is preserved in/.test(e.text)));
  assert.match(fs.readFileSync(path.join(runDirOf(repo), "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*/);
  assert.match(((await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
  assert.match(((await run(h.manager.stop(h.manager.incarnation, first))) as Refusal).refused, /that run has ended/);

  const second = await started(h);
  assert.equal(second, first + 1);
  const { time, ...firstOfSecond } = h.received.find((b) => b.run === second)!;
  assert.deepEqual(firstOfSecond, { _tag: "event", run: second, seq: 0, event: eventsOf(h, second)[0] });
  assert.ok(!Number.isNaN(Date.parse(time)), "the broadcast carries its time");
  assert.match(((await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
  await ended(h, second);
  assert.equal(endCode(h, second), 0);
  // After the end, the replay holds the last run only.
  assert.deepEqual((await run(h.manager.replay)).runs.map((r) => r.id), [second]);
});

test("the replay during a run holds the last run and the current one", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging, { steps: [{ hang: true }] }]);
  const first = await started(h);
  await ended(h, first);
  const second = await started(h);
  const { runs: replay } = await run(h.manager.replay);
  assert.deepEqual(replay.map((r) => r.id), [first, second]);
  assert.deepEqual(replay[0].events, h.received.filter((b) => b.run === first).map((b) => ({ time: b.time, event: b.event })));
  await run(h.manager.stop(h.manager.incarnation, second));
  await ended(h, second);
});

// Issue #120: the interview belongs to a refinement run, started from an unrefined item.
test("an interview's numbered answer sent through the manager reaches Claude Code as the scripted Ui's text", async () => {
  const repo = tempRepo();
  const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: [], answered_ids: [], complete, summary });
  const database = currentOf({ id: "F1", context: "The service keeps its data in a database, which Interloq, the orchestrator, starts with the service.", text: "Which database should the service use?", terms: [], options: [{ label: "PostgreSQL", description: "already in the container" }, { label: "SQLite", description: "no server needed" }] });
  const h = await harness(repo, [
    {
      steps: [{ output: { questions: [questionEntry("Q1", "Which cache should the service use?", [["Redis", "r"], ["None", "n"]], { context: "c" })] } }, { output: { ...turn("One question.", false, ""), current_question: database, asked_ids: ["F1"] } }, { output: turn("Done.", true, "# Requirements\n\nPostgreSQL.") }],
      reviews: [{ issues: [] }, { issues: [] }],
    },
  ]);
  const id = await started(h, "refinement");
  const you = await pendingAsk(h, id);
  assert.equal(you.kind, "interviewMessage");
  // S5: the turn's question is presented before the prompt, its options with the answers that choose them.
  const presented = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "QuestionPresented" ? [e.event.question] : [])).at(-1);
  const choice = presented?.options[1];
  assert.deepEqual(choice, { label: plain("SQLite"), description: plain("no server needed"), answer: { token: "2" } });
  await run(h.manager.answer(h.manager.incarnation, id, you.prompt, "token" in choice.answer ? choice.answer.token : ""));
  const confirm = await pendingAsk(h, id);
  assert.equal(confirm.kind, "confirmSummary");
  await run(h.manager.answer(h.manager.incarnation, id, confirm.prompt, ""));
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
  assert.match(fs.readFileSync(path.join(runDirOf(repo), "conversation.md"), "utf8"), /\*\*User:\*\* 2\n/);
  assert.ok(eventsOf(h, id).some((e) => e._tag === "Answered" && e.text === "2"));
});

test("over the real adapters and the fake SDK, the run reports both agents' activity", async () => {
  const repo = tempRepo();
  // Issue #6 (F1): the plan is the reply.
  const writePlan = () => (async function* () {
    yield init("s-1");
    yield success({ ...noQuestions, plan: scriptedPlan("step") });
  })();
  const report = { status: "finished", summary: "done", question: "", remaining_work: "" };
  const sdk = new FakeSdk([writePlan, messages(init("s-1"), success(report))], [turn(JSON.stringify({ issues: [] })), turn(JSON.stringify({ issues: [] }))]);
  const h = await harness(repo, [{}], (options) => ({ ...testWiring(repo, options).wiring, sdk, agents: Layer.mergeAll(claudePlannerLayer, codexReviewerLayer) }));
  const id = await started(h);
  await ended(h, id);
  assert.equal(endCode(h, id), 0, JSON.stringify(eventsOf(h, id).filter((e) => e._tag === "Said").map((e) => (e as { text: string }).text)));
  const activity = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "AgentCallStarted" ? [`${e.event.agent}:${e.event.purpose}`] : []));
  assert.deepEqual(activity, ["claude:planning", "codex:review", "claude:execution", "codex:review"]);
});

// Finding 4 of docs/gui-review.md: the project is the worktree root; a subdirectory or a bare repository is refused
// before anything is archived or initialised.
test("a subdirectory of a repository and a bare repository are refused; the root and a link to it are accepted", async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, "sub"));
  const sub = (await run((await harness(path.join(repo, "sub"), [])).manager.start("implementation", "1"))) as Refusal;
  assert.equal(typeof sub, "object", "the subdirectory was started");
  assert.match(sub.refused, /is inside the git repository/);
  assert.ok(sub.refused.includes(fs.realpathSync(repo)), "the refusal names the repository root");
  assert.match(sub.refused, /choose its top-level directory/);
  assert.ok(!fs.existsSync(path.join(repo, "plan-review")) && !fs.existsSync(path.join(repo, "sub", "plan-review")), "records were initialised");

  const bare = tempDir("pr-bare-");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const refusedBare = (await run((await harness(bare, [])).manager.start("implementation", "1"))) as Refusal;
  assert.equal(typeof refusedBare, "object", "the bare repository was started");
  assert.match(refusedBare.refused, /is a bare repository/);

  const link = path.join(tempDir("pr-link-"), "project");
  fs.symlinkSync(repo, link);
  const h = await harness(link, [converging]);
  const id = await started(h);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 11 of docs/gui-review.md: every ownership transfer is cancellation-safe.
test("publication: two concurrent publishers deliver every event to every listener in the order of its seq", async () => {
  const state = await run(Ref.make(0));
  const seen: number[][] = [[], []];
  const listeners = await run(Ref.make<ReadonlySet<Listener<number>>>(new Set(seen.map((into) => (n: number) => Effect.forEach(Array.from({ length: n % 2 === 0 ? 3 : 0 }), () => Effect.yieldNow).pipe(Effect.andThen(Effect.sync(() => void into.push(n))))))));
  // An even event is slower to deliver, so an unserialized publisher lets the next odd one overtake it.
  const publish = await run(makePublisher(state, listeners));
  const next = (s: number): readonly [number, number] => [s, s + 1];
  await run(Effect.all([Effect.forEach(Array.from({ length: 50 }), () => publish(next)), Effect.forEach(Array.from({ length: 50 }), () => publish(next))], { concurrency: 2 }));
  for (const into of seen) assert.deepEqual(into, Array.from({ length: 100 }, (_, i) => i), "an event offered out of seq order");
});

test("publication: a publisher interrupted while a listener is delivering still offers the recorded event to every listener", async () => {
  const state = await run(Ref.make(0));
  const entered = await run(Deferred.make<void>());
  const release = await run(Deferred.make<void>());
  const second: number[] = [];
  const blocking: Listener<number> = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  const listeners = await run(Ref.make<ReadonlySet<Listener<number>>>(new Set([blocking, (n: number) => Effect.sync(() => void second.push(n))])));
  const publish = await run(makePublisher(state, listeners));
  const publisher = Effect.runFork(publish((s) => [s, s + 1]));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(publisher));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  assert.equal(await run(Ref.get(state)), 1);
  assert.deepEqual(second, [0], "the event was recorded but not offered");
});

test("start interrupted while Started is being delivered leaves a run that can be stopped, and a new start is accepted after it", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }, converging]);
  const entered = await run(Deferred.make<void>());
  const release = await run(Deferred.make<void>());
  await run(
    h.manager
      .subscribe((b) => (b._tag === "event" && b.event._tag === "Started" && b.run === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void))
      .pipe(Scope.provide(h.scope)),
  );
  const starting = Effect.runFork(h.manager.start("implementation", nextItem(h, "implementation")));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(starting));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  assert.deepEqual(await run(h.manager.current), { refinement: null, implementation: 1 }, "the run was not reserved");
  assert.equal(await run(h.manager.stop(h.manager.incarnation, 1)), null, "the run cannot be stopped");
  await ended(h, 1);
  const id = await started(h);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 12 of docs/gui-review.md: an action of another incarnation is refused even when its numbers match.
test("a stop and an answer with the current run's numbers but another incarnation are refused, and the run continues", async () => {
  const repo = tempRepo();
  const withQuestion: TestOptions = { steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
  const h = await harness(repo, [withQuestion]);
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  const stale = (await run(h.manager.stop("an earlier start", id))) as Refusal;
  assert.match(stale.refused, /earlier start of the server/);
  const staleAnswer = (await run(h.manager.answer("an earlier start", id, asked.prompt, "x"))) as Refusal;
  assert.match(staleAnswer.refused, /earlier start of the server/);
  assert.equal(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "")), null);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 13 of docs/gui-review.md: a tab that falls behind is marked overflowed at the bound; the run never waits for it.
test("a subscriber that never reads overflows at its bound, and the run and the other subscribers do not wait for it", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const scope = await run(Scope.make());
  const slow = await run(subscribeBounded(h.manager, 3).pipe(Scope.provide(scope)));
  const id = await started(h);
  await ended(h, id);
  assert.equal(endCode(h, id), 0, "the run did not end");
  assert.ok(await run(Deferred.isDone(slow.overflowed)), "the slow subscriber was not marked overflowed");
  assert.equal(await run(Queue.size(slow.queue)), 3, "the queue grew beyond its bound");
  assert.ok(eventsOf(h, id).length > 3, "the other subscriber missed events");
  await run(Scope.close(scope, Exit.void));
});

// Issue #1: every event is stamped where it gets its seq, from the Clock service, on both publication paths.
test("append and end stamp every event with the Clock's time; the replay holds the same times; end still makes the run the last one", async () => {
  const reads: number[] = [];
  const next = (): number => {
    const ms = Date.UTC(2026, 8, 27, 14, 0, 0) + 1_000 * reads.length;
    reads.push(ms);
    return ms;
  };
  const stepping: Clock.Clock = {
    currentTimeMillisUnsafe: next,
    currentTimeMillis: Effect.sync(next),
    currentTimeNanosUnsafe: () => BigInt(next()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(next()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const id = await run(h.manager.start("implementation", nextItem(h, "implementation")).pipe(Effect.provideService(Clock.Clock, stepping)));
  assert.equal(typeof id, "number");
  await ended(h, id as number);
  const mine = h.received.filter((b) => b.run === id);
  const issued = new Set(reads.map((ms) => new Date(ms).toISOString()));
  for (const b of mine) assert.ok(issued.has(b.time), `seq ${b.seq} (${b.event._tag}) has the time ${String(b.time)}, not one the clock gave`);
  assert.equal(mine[0].event._tag, "Started");
  assert.equal(mine.at(-1)?.event._tag, "Ended");
  const times = mine.map((b) => Date.parse(b.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "one run publishes in order, so its times do not decrease along seq");
  assert.deepEqual(await run(h.manager.current), NONE);
  const { runs: replay } = await run(h.manager.replay);
  assert.deepEqual(replay.map((r) => r.id), [id]);
  assert.deepEqual(replay[0].events, mine.map((b) => ({ time: b.time, event: b.event })));
  await run(Scope.close(h.scope, Exit.void));
});

// S24: End the run in the page (the answer q, which the page confirms itself, S25) ends the run with code 130.
test("End the run in the page ends the run with code 130 as an interruption, and the server keeps running", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }] }, converging]);
  const first = await started(h);
  const asked = await pendingAsk(h, first);
  await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "q"));
  await ended(h, first);
  assert.equal(endCode(h, first), 130);
  assert.ok(eventsOf(h, first).some((e) => e._tag === "Said" && /INTERRUPTED by the user/.test(e.text)));
  assert.equal(await started(h), first + 1);
});

// Issue #87 (decision G-R1-1): the shared state of a run's page, held beside the run's events and never in them.
const entryScope = (decision: number, entry: string) => ({ _tag: "DecisionEntry" as const, decision, entry });
test("setUi broadcasts the run's whole state with a rising version; the replay holds it; the run's events are unchanged", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }]);
  const id = await started(h);
  await until("the hanging call", () => eventsOf(h, id).some((e) => e._tag === "Said" && /^Planning: requesting the initial plan/.test(e.text)));
  const before = (await run(h.manager.replay)).runs.find((r) => r.id === id)!.events;
  assert.equal(await run(h.manager.setUi(h.manager.incarnation, id, { scope: entryScope(1, "e1"), open: true })), null);
  assert.equal(await run(h.manager.setUi(h.manager.incarnation, id, { scope: entryScope(2, "e1"), open: true })), null);
  assert.deepEqual(h.uiReceived.map((b) => [b.run, b.state.version]), [[id, 1], [id, 2]]);
  const replay = await run(h.manager.replay);
  assert.deepEqual(replay.ui, [{ run: id, state: h.uiReceived[1].state }]);
  assert.deepEqual(replay.runs.find((r) => r.id === id)!.events, before, "the shared state adds nothing to the run's record");
  await run(h.manager.stop(h.manager.incarnation, id));
  await ended(h, id);
});

test("setUi of another incarnation or of an unknown run is refused; the last run's state can still change", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const id = await started(h);
  await ended(h, id);
  const flag = { scope: entryScope(1, "e1"), open: true };
  assert.match(((await run(h.manager.setUi("another", id, flag))) as Refusal).refused, /earlier start of the server/);
  assert.match(((await run(h.manager.setUi(h.manager.incarnation, id + 5, flag))) as Refusal).refused, /that run has ended/);
  assert.equal(await run(h.manager.setUi(h.manager.incarnation, id, flag)), null, "the last run, still shown in the page");
  assert.deepEqual((await run(h.manager.replay)).ui.map((u) => [u.run, u.state.version]), [[id, 1]]);
});

test("a run's shared state leaves with the run when it is no longer the last one", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging, converging, converging]);
  const first = await started(h);
  await ended(h, first);
  await run(h.manager.setUi(h.manager.incarnation, first, { scope: entryScope(1, "e1"), open: true }));
  const second = await started(h);
  await ended(h, second);
  const third = await started(h);
  await ended(h, third);
  const replay = await run(h.manager.replay);
  assert.deepEqual(replay.runs.map((r) => r.id), [third]);
  assert.deepEqual(replay.ui.map((u) => u.run), [third]);
  assert.match(((await run(h.manager.setUi(h.manager.incarnation, first, { scope: entryScope(1, "e1"), open: false }))) as Refusal).refused, /that run has ended/);
});

// Issue #29: the manager identifies its working directory and every run's project by the mount table it was given.
test("a manager with a table that identifies its project reports the host directory, in its location and on Started; with an empty table, the path", async () => {
  const repo = tempRepo();
  const mounts: MountTable = [{ root: "/host/proj", point: path.dirname(repo) }];
  const expected = identify(mounts, repo);
  assert.equal(expected, `/host/proj/${path.basename(repo)}`);
  const h = await harness(repo, [converging], undefined, mounts);
  assert.equal(h.manager.location, expected);
  const id = await started(h);
  await ended(h, id);
  const start = eventsOf(h, id).find((e) => e._tag === "Started");
  assert.deepEqual(start, { _tag: "Started", project: repo, location: expected, task: "task", mode: "implementation", item: { id: "1", title: "task" } });
  await run(Scope.close(h.scope, Exit.void));

  const plainRepo = tempRepo();
  const p = await harness(plainRepo, [converging]);
  assert.equal(p.manager.location, plainRepo);
  const pid = await started(p);
  await ended(p, pid);
  assert.deepEqual(eventsOf(p, pid).find((e) => e._tag === "Started"), { _tag: "Started", project: plainRepo, location: plainRepo, task: "task", mode: "implementation", item: { id: "1", title: "task" } });
  await run(Scope.close(p.scope, Exit.void));
});

// Issue #120: a tab's items come from the tracker through the server; a tracker that cannot be reached is a notice in the
// tab, not a failure of the page.
test("listItems lists a mode's items with their excerpts, and a tracker that fails or is not configured gives a notice", async () => {
  const repo = tempRepo();
  const h = await harness(repo, []);
  for (const mode of ["refinement", "implementation"] as const) {
    const listed = await run(h.manager.listItems(mode));
    assert.deepEqual(listed, { _tag: "Listed", items: ITEMS.filter((i) => i.state === listedState(mode)).map((i) => ({ id: i.id, title: i.title, excerpt: "" })) });
  }
  await run(h.tracker.failNext("list", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset" })));
  assert.deepEqual(await run(h.manager.listItems("refinement")), { _tag: "Unavailable", notice: "the GitHub issue tracker could not be reached: connection reset" });

  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  const none = await run(makeRunManager(() => testWiring(repo).wiring, repo, [], "test", { sharedConfig: shared, tracker: () => Result.fail(new NoTracker()) }).pipe(Effect.provide(platformLayer)));
  const notice = await run(none.listItems("implementation"));
  assert.equal(notice._tag, "Unavailable");
  assert.match(notice._tag === "Unavailable" ? notice.notice : "", /no issue tracker is configured/);
  const refused = (await run(none.start("implementation", "1"))) as Refusal;
  assert.deepEqual([refused.mode, /no issue tracker is configured/.test(refused.refused)], ["implementation", true]);
});
