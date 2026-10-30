import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Scope } from "effect";
import { claudePlannerLayer } from "../src/claude.ts";
import { codexReviewerLayer } from "../src/codex.ts";
import { identify, type MountTable } from "../src/hostDir.ts";
import { platformLayer } from "../src/platform.ts";
import { NoTracker, TrackerUnreachable } from "../src/errors.ts";
import { program } from "../src/program.ts";
import { listedState, type RunMode } from "../src/runMode.ts";
import { answerExpiredText, limitAnswerExpiredText, refinementInProgressText, runInProgressText, serverEndingText, serverFaultRecord } from "../src/prompts.ts";
import { Reviewer, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import type { RunEvent } from "../src/protocol.ts";
import { type Broadcast, type EventBroadcast, type HaltBounds, type Listener, type UiBroadcast, makePublisher, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
import { subscribeBounded } from "../src/webServer.ts";
import { FakeSdk, init, messages, success, turn } from "./fakeSdk.ts";
import { commentText, runCommentKey } from "../src/itemComments.ts";
import { askedInPlanReview, issue, respond, startOf, withoutReturnLine } from "./helpers.ts";
import { finished, scriptedPlan, scriptedTask, scriptedStart, type TestOptions, tempDir, tempRepo, testWiring, questionOf, currentOf, plain, ack, summaryReply, questionEntry, runDirOf, runDirsOf, fakeTrackerOf, MANAGER_ITEMS, trackerAccessOf } from "./helpers.ts";
import { DEFAULT_SETTINGS, OFF_SETTINGS } from "../src/chain.ts";
import { seededId } from "./fakeTracker.ts";

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
const harness = async (
  repo: string,
  scripts: TestOptions[],
  wiringOf = (options: TestOptions) => testWiring(repo, options).wiring,
  mounts: MountTable = [],
  tracker: FakeTracker = fakeTrackerOf(ITEMS),
  bounds?: HaltBounds,
): Promise<Harness> => {
  const queue = [...scripts];
  const access = trackerAccessOf(tracker);
  const manager = await run(makeRunManager((ui) => ({ ...wiringOf({ tracker, ...(queue.shift() ?? {}) }), ui: Effect.succeed(ui) }), repo, mounts, "test", access, OFF_SETTINGS, bounds).pipe(Effect.provide(platformLayer)));
  const received: EventBroadcast[] = [];
  const uiReceived: UiBroadcast[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b: Broadcast) => Effect.sync(() => void (b._tag === "event" ? received.push(b) : b._tag === "ui" ? uiReceived.push(b) : undefined))).pipe(Scope.provide(scope)));
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
  const id = await run(h.manager.start(startOf(mode, nextItem(h, mode))));
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
const NONE = { refinement: [], implementation: null };
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
  const h = await harness(repo, [askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] })]);
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
  const refusedStart = (await run(h.manager.start(startOf("implementation", nextItem(h, "implementation"))))) as Refusal;
  assert.deepEqual(refusedStart, { refused: runInProgressText("implementation"), mode: "implementation" });
  const other = await started(h, "refinement");
  assert.deepEqual(await run(h.manager.current), { refinement: [other], implementation: id });
  for (const r of [id, other]) {
    await run(h.manager.stop(h.manager.incarnation, r));
    await ended(h, r);
  }
  for (const [cwd, reason] of [[path.join(repo, "nope"), /does not exist/], [path.join(repo, "a.txt"), /not a directory/], [tempDir("pr-plain-"), /not a git repository/]] as const) {
    const bad = await harness(cwd as string, []);
    const refused = (await run(bad.manager.start(startOf("implementation", "1")))) as Refusal;
    assert.match(refused.refused, reason);
    assert.equal(refused.mode, "implementation");
  }
});

test("a start for an item whose state changed since the list was shown is refused, and nothing starts", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const item = nextItem(h, "implementation");
  await run(h.tracker.tracker.setState(Result.getOrThrow(itemIdOf(item)), "implemented"));
  const refused = (await run(h.manager.start(startOf("implementation", item)))) as Refusal;
  assert.deepEqual(refused, { refused: `item ${item} is no longer refined: it is implemented; refresh the list`, mode: "implementation" });
  assert.deepEqual(h.received, []);
});

test("answering and stopping one run leaves the run of the other mode running, each with its own records directory", async () => {
  const repo = tempRepo();
  const question = (q: string): TestOptions => (askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: q, terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] }));
  const refining: TestOptions = { steps: [{ output: { questions: [questionEntry("Q1", "Which cache?", [["Redis", "r"], ["None", "n"]], { context: "c" })] } }], reviews: [{ issues: [] }, { issues: [] }], answers: [] };
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

// Issue #191: any number of refinement runs, each of a different item; a refinement of an item already being refined is refused.
const itemOfRun = (h: Harness, id: number): string => eventsOf(h, id).flatMap((e) => (e._tag === "Started" ? [e.item.id] : []))[0] ?? assert.fail(`run ${id} has not started`);
const stopped = async (h: Harness, ...ids: number[]) => {
  for (const id of ids) {
    await run(h.manager.stop(h.manager.incarnation, id));
    await ended(h, id);
  }
};

test("a second refinement of a different item starts while the first waits; a refinement of the same item is refused", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [refiningAsk, refiningAsk, refiningAsk]);
  const first = await started(h, "refinement");
  await pendingAsk(h, first);
  const second = await started(h, "refinement");
  await pendingAsk(h, second);
  assert.deepEqual(await run(h.manager.current), { refinement: [first, second], implementation: null });
  const published = h.received.length;
  const again = await run(h.manager.start(startOf("refinement", itemOfRun(h, first))));
  assert.deepEqual(again, { refused: refinementInProgressText(itemOfRun(h, first)), mode: "refinement" });
  assert.equal(h.received.length, published, "a refused start publishes nothing");
  await stopped(h, first, second);
});

test("two refinements' events and answers are kept apart by run id", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [refiningAsk, refiningAsk]);
  const first = await started(h, "refinement");
  const asked = await pendingAsk(h, first);
  const second = await started(h, "refinement");
  await pendingAsk(h, second);
  assert.equal(runDirsOf(repo).length, 2, "each run has its own records directory");
  const secondBefore = eventsOf(h, second).length;
  assert.equal(await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "1")), null);
  await until("the first run's answer", () => eventsOf(h, first).some((e) => e._tag === "Answered"));
  assert.equal(eventsOf(h, second).some((e) => e._tag === "Answered"), false, "the other run's prompt is still pending");
  assert.equal(eventsOf(h, second).length, secondBefore);
  assert.equal(await run(h.manager.setUi(h.manager.incarnation, second, { scope: { _tag: "DashboardAnswers" }, open: true })), null);
  assert.deepEqual(h.uiReceived.map((b) => b.run), [second]);
  const replay = await run(h.manager.replay);
  assert.equal(replay.ui.find((u) => u.run === first)!.state.version, 0);
  await stopped(h, first, second);
  assert.equal(endCode(h, first), 130);
  assert.equal(endCode(h, second), 130);
});

test("two starts of the same item at once: exactly one succeeds", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [refiningAsk, refiningAsk]);
  const item = nextItem(h, "refinement");
  const both = await run(Effect.all([h.manager.start(startOf("refinement", item)), h.manager.start(startOf("refinement", item))], { concurrency: "unbounded" }));
  const ids = both.filter((r): r is number => typeof r === "number");
  assert.equal(ids.length, 1, JSON.stringify(both));
  assert.deepEqual(both.find((r) => typeof r !== "number"), { refused: refinementInProgressText(item), mode: "refinement" });
  assert.deepEqual(await run(h.manager.current), { refinement: ids, implementation: null });
  await stopped(h, ids[0]!);
});

test("a second implementation start is refused before the tracker is read", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }]);
  const id = await started(h, "implementation");
  await until("the hanging call", () => eventsOf(h, id).some((e) => e._tag === "Said" && /^Planning: requesting the initial plan/.test(e.text)));
  const reads = (await run(h.tracker.reads)).length;
  await run(h.tracker.failNext("read", new TrackerUnreachable({ tracker: "fake", message: "down", status: null })));
  const refused = await run(h.manager.start(startOf("implementation", nextItem(h, "implementation"))));
  assert.deepEqual(refused, { refused: runInProgressText("implementation"), mode: "implementation" });
  assert.equal((await run(h.tracker.reads)).length, reads, "no read was made");
  await stopped(h, id);
});

test("an ended refinement stays in the replay until a newer refinement of the same item starts", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [refiningAsk, refiningAsk, refiningAsk]);
  const a = await started(h, "refinement");
  await pendingAsk(h, a);
  await stopped(h, a);
  const b = await started(h, "refinement");
  assert.deepEqual((await run(h.manager.replay)).runs.map((r) => r.id), [a, b]);
  const again = await run(h.manager.start(startOf("refinement", itemOfRun(h, a))));
  assert.equal(typeof again, "number", JSON.stringify(again));
  assert.deepEqual((await run(h.manager.replay)).runs.map((r) => r.id), [b, again as number]);
  await stopped(h, b, again as number);
});

// Issue #120: a run is started from an item. A start frame with a blank item id, which the page's buttons do not send but
// another client could, is refused before the project is examined; no run is reserved and nothing is published.
test("a blank item id is refused, before the project check; no run starts and nothing is published", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const bad = await harness(path.join(repo, "nope"), []);
  for (const item of ["", "   ", "\n\t "]) {
    const refused = (await run(h.manager.start(startOf("refinement", item)))) as Refusal;
    assert.deepEqual(refused, { refused: "no item was chosen", mode: "refinement" }, JSON.stringify(item));
    assert.equal(((await run(bad.manager.start(startOf("implementation", item)))) as Refusal).refused, "no item was chosen");
  }
  assert.deepEqual(await run(h.manager.current), NONE);
  assert.deepEqual(h.received, []);
  await run(Scope.close(h.scope, Exit.void));
});

test("stop interrupts the run like Ctrl+C; answers and stops naming an ended run are refused; a new run gets a new id", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }] }), converging]);
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
  const database = currentOf({ id: "F1", context: "The service keeps its data in a database, which Interloq, the orchestrator, starts with the service.", text: "Which database should the service use?", terms: [], options: [{ label: "PostgreSQL", description: "already in the container" }, { label: "SQLite", description: "no server needed" }] });
  const h = await harness(repo, [
    {
      steps: [{ output: { questions: [questionEntry("Q1", "Which cache should the service use?", [["Redis", "r"], ["None", "n"]], { context: "c" })] } }],
      // Issue #184: the follow-up comes in the closing reply after the agreed question, and the next closing proposes the summary.
      closings: [{ output: ack("One question.", { follow_ups: [database] }) }, { output: summaryReply("# Requirements\n\nPostgreSQL.", "Done.") }],
      reviews: [{ issues: [] }, { issues: [] }],
    },
  ]);
  const id = await started(h, "refinement");
  const agreed = await pendingAsk(h, id);
  assert.equal(agreed.kind, "interviewMessage");
  await run(h.manager.answer(h.manager.incarnation, id, agreed.prompt, "1"));
  const you = await pendingAsk(h, id);
  assert.equal(you.kind, "interviewMessage");
  // S5: the follow-up is presented before the prompt, its options with the answers that choose them.
  const presented = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "QuestionPresented" ? [e.event.question] : [])).at(-1);
  assert.deepEqual(presented?.origin, { kind: "followUp", id: "F1" });
  const choice = presented?.options[1];
  assert.deepEqual(choice, { label: plain("SQLite"), description: plain("no server needed"), answer: { token: "2" } });
  await run(h.manager.answer(h.manager.incarnation, id, you.prompt, "token" in choice.answer ? choice.answer.token : ""));
  // Issue #138: the summary is written with no prompt, and the run ends.
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
  assert.match(fs.readFileSync(path.join(runDirOf(repo), "conversation.md"), "utf8"), /\*\*User:\*\* 2\n/);
  assert.ok(eventsOf(h, id).some((e) => e._tag === "Answered" && e.text === "2"));
});

test("over the real adapters and the fake SDK, the run reports both agents' activity", async () => {
  const repo = tempRepo();
  // Issue #6 (F1): the plan is the reply; issue #186: under the first plan reply's reply.
  const writePlan = () => (async function* () {
    yield init("s-1");
    yield success({ reply: { kind: "plan", plan: scriptedPlan("step") } });
  })();
  const report = { status: "finished", summary: "done", question: "", remaining_work: "", missing: "", checks: [] };
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
  const sub = (await run((await harness(path.join(repo, "sub"), [])).manager.start(startOf("implementation", "1")))) as Refusal;
  assert.equal(typeof sub, "object", "the subdirectory was started");
  assert.match(sub.refused, /is inside the git repository/);
  assert.ok(sub.refused.includes(fs.realpathSync(repo)), "the refusal names the repository root");
  assert.match(sub.refused, /choose its top-level directory/);
  assert.ok(!fs.existsSync(path.join(repo, "plan-review")) && !fs.existsSync(path.join(repo, "sub", "plan-review")), "records were initialised");

  const bare = tempDir("pr-bare-");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const refusedBare = (await run((await harness(bare, [])).manager.start(startOf("implementation", "1")))) as Refusal;
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
  const starting = Effect.runFork(h.manager.start(startOf("implementation", nextItem(h, "implementation"))));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(starting));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  assert.deepEqual(await run(h.manager.current), { refinement: [], implementation: 1 }, "the run was not reserved");
  assert.equal(await run(h.manager.stop(h.manager.incarnation, 1)), null, "the run cannot be stopped");
  await ended(h, 1);
  const id = await started(h);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 12 of docs/gui-review.md: an action of another incarnation is refused even when its numbers match.
test("a stop and an answer with the current run's numbers but another incarnation are refused, and the run continues", async () => {
  const repo = tempRepo();
  const withQuestion: TestOptions = askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
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
  const id = await run(h.manager.start(startOf("implementation", nextItem(h, "implementation"))).pipe(Effect.provideService(Clock.Clock, stepping)));
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
  const h = await harness(repo, [askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }] }), converging]);
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
    const items = ITEMS.filter((i) => i.state === listedState(mode)).map((i) => ({ id: i.id, title: i.title, excerpt: "", url: Option.getOrNull(i.url), sentBack: 0 }));
    // Issue #125: the listing carries each item's address, null where the tracker gave none, and both occur.
    assert.deepEqual(new Set(items.map((i) => i.url === null)), new Set([true, false]));
    // Issue #142: the Refinement tab's listing carries the configured choice of terms, which its control starts at.
    assert.deepEqual(listed, mode === "refinement" ? { mode, result: { _tag: "Listed", items, terms: "unchecked" } } : { mode, result: { _tag: "Listed", items } });
  }
  await run(h.tracker.failNext("list", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset", status: null })));
  assert.deepEqual(await run(h.manager.listItems("refinement")), { mode: "refinement", result: { _tag: "Unavailable", notice: "the GitHub issue tracker could not be reached: connection reset" } });

  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  const none = await run(makeRunManager(() => testWiring(repo).wiring, repo, [], "test", { sharedConfig: shared, tracker: () => Result.fail(new NoTracker()) }, OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
  const notice = (await run(none.listItems("implementation"))).result;
  assert.equal(notice._tag, "Unavailable");
  assert.match(notice._tag === "Unavailable" ? notice.notice : "", /no issue tracker is configured/);
  const refused = (await run(none.start({ mode: "implementation", item: "1" }))) as Refusal;
  assert.deepEqual([refused.mode, /no issue tracker is configured/.test(refused.refused)], ["implementation", true]);
});

// Issue #186 (F1): each listed item carries how many times Interloq sent it back, counted from its comments by their
// markers (one per send-back's key); a comment listing that fails is the listing's notice, as a failed listing is.
test("listItems counts each item's send-backs from its comments; a failed comment listing is a notice", async () => {
  const repo = tempRepo();
  const sentBack = (key: string) => ({ id: seededId(), body: commentText({ _tag: "SentBack", key: runCommentKey(key, "verdict-1"), date: "2026-10-28", missing: "m" }), created: "2026-10-28T00:00:00Z" });
  const twice = ITEMS.map((i) => (i.state === "unrefined" && i.id === ITEMS.find((x) => x.state === "unrefined")!.id ? { ...i, comments: [sentBack("run-a"), { id: seededId(), body: "a developer's note", created: "t" }, sentBack("run-b"), sentBack("run-b")] } : i));
  const tracker = fakeTrackerOf(twice);
  const h = await harness(repo, [], undefined, [], tracker);
  const listed = await run(h.manager.listItems("refinement"));
  assert.ok(listed.result._tag === "Listed");
  const counts = listed.result._tag === "Listed" ? listed.result.items.map((i) => i.sentBack) : [];
  assert.deepEqual(counts, twice.filter((i) => i.state === "unrefined").map((i) => (i.comments === undefined ? 0 : 2)));
  await run(tracker.failNext("comments", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset", status: null })));
  assert.deepEqual(await run(h.manager.listItems("refinement")), { mode: "refinement", result: { _tag: "Unavailable", notice: "the GitHub issue tracker could not be reached: connection reset" } });
});

// Issue #142 (requirements Q3): the listing reads the configuration each time, so an edited file shows on the next Refresh.
test("the Refinement listing carries the configured choice of terms; an unknown value is a notice", async () => {
  const repo = tempRepo();
  const h = await harness(repo, []);
  const terms = async () => {
    const listed = await run(h.manager.listItems("refinement"));
    return listed.mode === "refinement" && listed.result._tag === "Listed" ? listed.result.terms : listed.result;
  };
  assert.equal(await terms(), "unchecked");
  fs.mkdirSync(path.join(repo, "plan-review"), { recursive: true });
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), JSON.stringify({ terms: "checked" }));
  assert.equal(await terms(), "checked");
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), JSON.stringify({ terms: "sometimes" }));
  const invalid = await terms();
  assert.ok(typeof invalid !== "string" && invalid._tag === "Unavailable" && /not a valid configuration.*\(at terms\)/.test(invalid.notice), JSON.stringify(invalid));
});

// Issue #158 (the user's decision Q1): after an error the server cannot trace to one run, the manager refuses every new
// start, halts every run in progress with its record, and returns within its bounds even when a run does not end.
const SHORT: HaltBounds = { graceMs: 400, interruptMs: 1_000 };
const asking = (q: string): TestOptions => (askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: q, terms: [], options: [] })] }, plan: "v1" }], reviews: [{ issues: [] }] }));
const refiningAsk: TestOptions = {
  steps: [{ output: { questions: [questionEntry("Q1", "Which cache?", [["Redis", "r"], ["None", "n"]], { context: "c" })] } }],
  reviews: [{ issues: [] }],
};

test("haltAll halts the run of each mode with code 1 and its record, and returns once both ended", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [asking("Which database?"), refiningAsk, refiningAsk], undefined, [], undefined, SHORT);
  const implementation = await started(h, "implementation");
  await pendingAsk(h, implementation);
  const refinement = await started(h, "refinement");
  await pendingAsk(h, refinement);
  // Issue #191: a second refinement in progress is halted too.
  const another = await started(h, "refinement");
  await pendingAsk(h, another);
  const report = await run(h.manager.haltAll("write EPIPE"));
  assert.deepEqual([...report.halted].sort(), [implementation, refinement, another].sort());
  assert.deepEqual(report.unconfirmed, []);
  for (const id of [implementation, refinement, another]) assert.equal(endCode(h, id), 1);
  for (const dir of runDirsOf(repo)) assert.ok(withoutReturnLine(fs.readFileSync(path.join(dir, "conversation.md"), "utf8")).endsWith(serverFaultRecord("write EPIPE")), dir);
  assert.deepEqual(await run(h.manager.current), NONE);
  assert.deepEqual((await run(h.manager.replay)).runs.map((r) => r.id).sort(), [implementation, refinement, another].sort());
});

test("haltAll with no run in progress returns at once with empty lists, and every later start is refused", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging], undefined, [], undefined, SHORT);
  assert.deepEqual(await run(h.manager.haltAll("write EPIPE")), { halted: [], unconfirmed: [] });
  for (const mode of ["implementation", "refinement"] as const) {
    assert.deepEqual(await run(h.manager.start(startOf(mode, nextItem(h, mode)))), { refused: serverEndingText, mode });
  }
  assert.deepEqual(h.received, []);
});

test("a start whose tracker read is pending when haltAll is called is refused at its reservation", async () => {
  const repo = tempRepo();
  const fake = fakeTrackerOf(ITEMS);
  const gate = await run(Deferred.make<void>());
  let reach = (): void => undefined;
  const reading = new Promise<void>((resolve) => (reach = resolve));
  const slow: FakeTracker = { ...fake, tracker: { ...fake.tracker, read: (id) => Effect.sync(reach).pipe(Effect.andThen(Deferred.await(gate)), Effect.andThen(fake.tracker.read(id))) } };
  const h = await harness(repo, [converging], undefined, [], slow, SHORT);
  const pending = Effect.runPromise(h.manager.start(startOf("implementation", nextItem(h, "implementation"))));
  await reading;
  assert.deepEqual(await run(h.manager.haltAll("write EPIPE")), { halted: [], unconfirmed: [] });
  await run(Deferred.succeed(gate, undefined));
  assert.deepEqual(await pending, { refused: serverEndingText, mode: "implementation" });
  assert.deepEqual(await run(h.manager.current), NONE);
  assert.deepEqual(h.received, []);
});

/** A wiring whose Codex turn signals `reached` and then runs `turn`. */
const reviewing = (repo: string, reach: () => void, turn: Effect.Effect<string>) => (options: TestOptions) => {
  const wiring = testWiring(repo, options).wiring;
  const reviewer = Layer.succeed(Reviewer, { startPhase: Effect.succeed({ review: () => Effect.sync(reach).pipe(Effect.andThen(turn), Effect.map((text) => ({ text, inputTokens: null }))) }) });
  return { ...wiring, agents: Layer.merge(wiring.agents, reviewer) };
};

test("a run that never ends does not hold haltAll: past its bounds the manager publishes its end with 1 and names it", async () => {
  const repo = tempRepo();
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const h = await harness(repo, [{ steps: [{ output: noQuestions, plan: "v1" }] }], reviewing(repo, () => reach(), Effect.uninterruptible(Effect.never)), [], undefined, SHORT);
  const id = await started(h);
  await reached;
  const began = Date.now();
  const report = await run(h.manager.haltAll("write EPIPE"));
  assert.ok(Date.now() - began < SHORT.graceMs + SHORT.interruptMs + 2_000, `haltAll took ${Date.now() - began} ms`);
  assert.deepEqual(report, { halted: [], unconfirmed: [id] });
  assert.equal(endCode(h, id), 1);
  assert.deepEqual(await run(h.manager.current), NONE);
});

test("a faulted run that ends by interruption is recorded with code 1, not 130", async () => {
  const repo = tempRepo();
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  // The turn cannot be interrupted for longer than the grace, so haltAll interrupts the run from outside.
  const turn = Effect.uninterruptible(Effect.sleep(`${SHORT.graceMs + 200} millis`)).pipe(Effect.andThen(Effect.never));
  const h = await harness(repo, [{ steps: [{ output: noQuestions, plan: "v1" }] }], reviewing(repo, () => reach(), turn), [], undefined, SHORT);
  const id = await started(h);
  await reached;
  const report = await run(h.manager.haltAll("write EPIPE"));
  assert.deepEqual(report, { halted: [id], unconfirmed: [] });
  assert.equal(endCode(h, id), 1);
  // W1-S1-1: the outside interruption of a faulted run records and says the fault, not the user's interruption.
  const record = fs.readFileSync(path.join(runDirOf(repo), "conversation.md"), "utf8");
  assert.ok(withoutReturnLine(record).endsWith(serverFaultRecord("write EPIPE")), record);
  assert.ok(!record.includes("**Interrupted by the user.**"), record);
  const texts = eventsOf(h, id).flatMap((e) => (e._tag === "Said" ? [e.text] : []));
  assert.ok(texts.some((t) => t.includes("HALTED: ")), texts.join("\n"));
  assert.ok(!texts.some((t) => t.includes("INTERRUPTED")), texts.join("\n"));
});

// P2-R1-1: a run whose halt record cannot be written is never reported halted. Root ignores file modes.
const asRoot = process.getuid?.() === 0;
/** Makes the run's conversation.md read-only for the test's body, its mode restored after it. */
const readOnlyRecord = async <A>(repo: string, body: () => Promise<A>): Promise<A> => {
  const file = path.join(runDirOf(repo), "conversation.md");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o444);
  try {
    return await body();
  } finally {
    fs.chmodSync(file, 0o644);
  }
};

test("a run that ends within the grace without its halt record written is unconfirmed", { skip: asRoot }, async () => {
  const repo = tempRepo();
  const h = await harness(repo, [asking("Which database?")], undefined, [], undefined, SHORT);
  const id = await started(h);
  await pendingAsk(h, id);
  const began = Date.now();
  const report = await readOnlyRecord(repo, () => run(h.manager.haltAll("write EPIPE")));
  assert.ok(Date.now() - began < SHORT.graceMs, `haltAll took ${Date.now() - began} ms`);
  assert.deepEqual(report, { halted: [], unconfirmed: [id] });
  assert.equal(endCode(h, id), 1);
});

test("a faulted run interrupted from outside without its halt record written is unconfirmed", { skip: asRoot }, async () => {
  const repo = tempRepo();
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const turn = Effect.uninterruptible(Effect.sleep(`${SHORT.graceMs + 200} millis`)).pipe(Effect.andThen(Effect.never));
  const h = await harness(repo, [{ steps: [{ output: noQuestions, plan: "v1" }] }], reviewing(repo, () => reach(), turn), [], undefined, SHORT);
  const id = await started(h);
  await reached;
  const report = await readOnlyRecord(repo, () => run(h.manager.haltAll("write EPIPE")));
  assert.deepEqual(report, { halted: [], unconfirmed: [id] });
  assert.equal(endCode(h, id), 1);
});

// ---- Issue #185: the countdown of a chained run's questions, the hold and a late answer ----

/** A manager with the chain on (its default) over a project whose questions wait `seconds`. */
const chained = async (scripts: TestOptions[], config: Record<string, unknown>): Promise<Harness> => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, "plan-review"), { recursive: true });
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), JSON.stringify(config));
  const h = await harness(repo, scripts);
  const queue = [...scripts];
  const tracker = fakeTrackerOf(ITEMS);
  const manager = await run(makeRunManager((ui) => ({ ...testWiring(repo, { tracker, ...(queue.shift() ?? {}) }).wiring, ui: Effect.succeed(ui) }), repo, [], "test", trackerAccessOf(tracker), DEFAULT_SETTINGS).pipe(Effect.provide(platformLayer)));
  await run(manager.subscribe((b: Broadcast) => Effect.sync(() => void (b._tag === "event" ? h.received.push(b) : undefined))).pipe(Scope.provide(h.scope)));
  return { ...h, manager, tracker };
};

test("a hold of another incarnation or of an ended run is refused; a hold of a prompt that does not wait does nothing", async () => {
  const h = await harness(tempRepo(), [converging]);
  const id = await started(h);
  await ended(h, id);
  assert.notEqual(await run(h.manager.hold("another", id, 1)), null);
  assert.notEqual(await run(h.manager.hold(h.manager.incarnation, id, 1)), null);
});

test("a chained run's question counts down the configured wait; an answer after it is refused as expired", async () => {
  const h = await chained([askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] })], { answerTimeoutSeconds: 1 });
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  assert.ok(asked.countdown !== null);
  assert.equal(asked.countdown.untilMs - asked.countdown.fromMs, 1000);
  await until("the expiry", () => eventsOf(h, id).some((e) => e._tag === "AnswerExpired"), 10_000);
  assert.deepEqual(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "late")), { refused: answerExpiredText, mode: "implementation" });
  await ended(h, id);
});

test("an answer after a review limit's expiry is refused with the text that the review went on", async () => {
  const h = await chained(
    [{ steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }], reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }], execs: [finished], config: { maxRounds: 1 } }],
    // The manager reads the wait from the project's file; the program takes its configuration from the scripted wiring.
    { answerTimeoutSeconds: 1 },
  );
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  assert.equal(asked.countdown?.then, "extend");
  await until("the expiry", () => eventsOf(h, id).some((e) => e._tag === "AnswerExpired"), 10_000);
  assert.deepEqual(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "3")), { refused: limitAnswerExpiredText, mode: "implementation" });
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

test("a manual run with the mode off counts nothing down", async () => {
  const h = await harness(tempRepo(), [askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] })]);
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  assert.equal(asked.countdown, null);
  await run(h.manager.stop(h.manager.incarnation, id));
  await ended(h, id);
});

test("turning the mode off while a question counts down stops the countdown at its end, and the run keeps waiting", async () => {
  const h = await chained([askedInPlanReview({ steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] })], { answerTimeoutSeconds: 1 });
  const id = await started(h);
  const asked = await pendingAsk(h, id);
  assert.ok(asked.countdown !== null);
  await run(h.manager.setChain(OFF_SETTINGS));
  await until("the countdown's stop", () => eventsOf(h, id).some((e) => e._tag === "CountdownStopped" && e.reason === "chainOff"), 10_000);
  assert.ok(!eventsOf(h, id).some((e) => e._tag === "AnswerExpired"));
  assert.equal(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "PostgreSQL")), null);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});
