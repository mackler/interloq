// Issue #131 (S16): the preparation pass inside the real run manager, over scripted agents, the fake tracker and the real
// plan-review/chain.json: the switch, the marks, Refine's stop and durable release, the server's fault, and a restart.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { Effect, Layer, Result, Scope } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { runCommentKey } from "../src/itemComments.ts";
import { platformLayer } from "../src/platform.ts";
import { digestOf, preparationOf, preparedComments } from "../src/preparedComments.ts";
import type { ListedItem, RunEvent } from "../src/protocol.ts";
import { type Broadcast, type EventBroadcast, type HaltBounds, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
import { OFF_SETTINGS } from "../src/chain.ts";
import { Tracker, type TrackerShape } from "../src/services.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { type FakeItem, type FakeTracker, seededId } from "./fakeTracker.ts";
import { fakeTrackerOf, issue, questionEntry, respond, scriptedItem, startOf, summaryReply, type TestOptions, tempRepo, testWiring, type WiringProbe } from "./helpers.ts";

const run = Effect.runPromise;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (let waited = 0; !(await check()); waited += 10) {
    if (waited > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
};
const FAST = { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 };
const marked = (id: string, title = `item ${id}`): FakeItem => ({ ...scriptedItem, id: Result.getOrThrow(itemIdOf(id)), title, body: `The text of ${id}.`, state: "unrefined", marked: true });
const q = (id: string) => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
/** A preparation of one question, its review clean. */
const PREPARE_ONE: TestOptions = { steps: [{ output: { questions: [q("Q1")] } }], reviews: [{ issues: [] }] };
/** A preparation whose question review reaches its idle limit, so the item is set aside. */
const PAUSING: TestOptions = {
  config: { maxIdleRounds: 1 },
  steps: [{ output: { questions: [q("Q1")] } }, { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [q("Q1")] } }],
  reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [issue("Q-R2-1")] }],
};
/** A refinement run of a prepared item of one question: the answer, the summary and the requirements review alone. */
const ASKED_ONE: TestOptions = { closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }], reviews: [{ issues: [] }] };
const BOUNDS: HaltBounds = { graceMs: 2_000, interruptMs: 1_000 };

type Harness = { manager: RunManager; tracker: FakeTracker; repo: string; probes: WiringProbe[]; received: Broadcast[]; queue: TestOptions[] };
const harness = async (items: readonly FakeItem[], scripts: TestOptions[], options: { repo?: string; tracker?: FakeTracker; trackerOf?: (t: TrackerShape) => TrackerShape } = {}): Promise<Harness> => {
  const repo = options.repo ?? tempRepo();
  const tracker = options.tracker ?? fakeTrackerOf(items);
  const shown = options.trackerOf === undefined ? tracker.tracker : options.trackerOf(tracker.tracker);
  const queue = [...scripts];
  const probes: WiringProbe[] = [];
  const shared = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pr-shared-")), "config.json");
  fs.writeFileSync(shared, "{}");
  const access = { sharedConfig: shared, tracker: () => Result.succeed(Layer.succeed(Tracker, shown)) };
  const factory = (ui: Parameters<Parameters<typeof makeRunManager>[0]>[0]) => {
    const options_ = queue.shift() ?? {};
    const { wiring, probe } = testWiring(repo, { ...options_, tracker, config: { ...FAST, ...options_.config } });
    probes.push(probe);
    return { ...wiring, ui: Effect.succeed(ui), tracker: () => Result.succeed(Layer.succeed(Tracker, shown)) };
  };
  // The project's config is written by every wiring; make it before the manager's first listing too.
  fs.mkdirSync(path.join(repo, "plan-review"), { recursive: true });
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), JSON.stringify(FAST));
  const manager = await run(makeRunManager(factory, repo, [], "test", access, OFF_SETTINGS, BOUNDS).pipe(Effect.provide(platformLayer)));
  const received: Broadcast[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b) => Effect.sync(() => void received.push(b))).pipe(Scope.provide(scope)));
  return { manager, tracker, repo, probes, received, queue };
};
const itemIn = async (h: Harness, id: string) => (await run(h.tracker.items)).find((i) => i.id === id)!;
const foundOf = async (h: Harness, id: string) => {
  const item = await itemIn(h, id);
  return preparationOf(item.comments ?? [], item, null);
};
const listed = async (h: Harness): Promise<readonly ListedItem[]> => {
  const answer = await run(h.manager.listItems("refinement"));
  return answer.result._tag === "Listed" ? answer.result.items : assert.fail("the listing failed");
};
const markOfItem = async (h: Harness, id: string) => (await listed(h)).find((i) => i.id === id)?.preparation ?? null;
const chainFile = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.repo, "plan-review", "chain.json"), "utf8"));
const eventsOf = (h: Harness, id: number): RunEvent[] => h.received.flatMap((b) => (b._tag === "event" && b.run === id ? [(b as EventBroadcast).event] : []));
const startRefinement = async (h: Harness, item: string): Promise<number> => {
  const id = await run(h.manager.start(startOf("refinement", item)));
  assert.equal(typeof id, "number", `refused: ${(id as Refusal).refused}`);
  return id as number;
};
const firstAsk = async (h: Harness, id: number) => {
  let asked: Extract<RunEvent, { _tag: "Asked" }> | undefined;
  await until("a prompt", () => (asked = eventsOf(h, id).find((e): e is Extract<RunEvent, { _tag: "Asked" }> => e._tag === "Asked")) !== undefined);
  return asked!;
};
const endedWith = async (h: Harness, id: number) => {
  await until(`run ${id}'s end`, () => eventsOf(h, id).some((e) => e._tag === "Ended"));
  return eventsOf(h, id).flatMap((e) => (e._tag === "Ended" ? [e.code] : []))[0];
};
const preparedQuestion = (h: Harness, n: number) => h.probes[n]!;

test("the switch turned on prepares a marked item, not an unmarked one; Refine then asks its first question with no list, review or terms call", async () => {
  const unmarked: FakeItem = { ...marked("31"), marked: false };
  const h = await harness([unmarked, marked("21")], [PREPARE_ONE, ASKED_ONE]);
  await run(h.manager.setPreparation(true));
  await until("the preparation", async () => (await foundOf(h, "21"))._tag === "Prepared");
  assert.deepEqual(await markOfItem(h, "21"), { _tag: "Prepared", questions: 1 });
  assert.equal(await markOfItem(h, "31"), null);
  assert.equal((await itemIn(h, "31")).comments, undefined);
  const before = await itemIn(h, "21");
  assert.deepEqual([before.state, before.body], ["unrefined", "The text of 21."]);
  const id = await startRefinement(h, "21");
  const asked = await firstAsk(h, id);
  const runProbe = preparedQuestion(h, 1);
  assert.equal(runProbe.planner.prompts.length + runProbe.planner.termsPrompts.length + runProbe.reviewer.prompts.length, 0);
  assert.equal(await run(h.manager.answer("test", id, asked.prompt, "A")), null);
  assert.equal(await endedWith(h, id), 0);
  assert.equal((await itemIn(h, "21")).state, "refined");
});

test("a pass whose first item pauses sets it aside and prepares the next; the marks show both", async () => {
  // Newest first: 22 is listed before 21 by the fake (the reverse of the order given).
  const h = await harness([marked("21"), marked("22")], [PAUSING, PREPARE_ONE]);
  await run(h.manager.setPreparation(true));
  await until("both done", async () => (await foundOf(h, "22"))._tag === "SetAside" && (await foundOf(h, "21"))._tag === "Prepared");
  assert.equal((await markOfItem(h, "22"))?._tag, "SetAside");
  assert.deepEqual(await markOfItem(h, "21"), { _tag: "Prepared", questions: 1 });
});

test("an item whose title changes after it was prepared is prepared again on the next wake, and a refinement before that ignores the old preparation", async () => {
  const h = await harness([marked("21")], [PREPARE_ONE, { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] }, PREPARE_ONE]);
  await run(h.manager.setPreparation(true));
  await until("the preparation", async () => (await foundOf(h, "21"))._tag === "Prepared");
  await run(h.tracker.edit("21" as ItemId, (i) => ({ ...i, title: "A new title" })));
  assert.equal((await foundOf(h, "21"))._tag, "Stale");
  // Turning the switch off holds the pass while a refinement of the edited item runs the whole phase.
  await run(h.manager.setPreparation(false));
  const id = await startRefinement(h, "21");
  assert.equal(await endedWith(h, id), 0);
  assert.equal(h.probes[1]!.planner.prompts.length, 1, "the refinement did not make its own list call");
  await run(h.tracker.edit("21" as ItemId, (i) => ({ ...i, state: "unrefined" })));
  await run(h.manager.setPreparation(true));
  await until("prepared again", async () => (await foundOf(h, "21"))._tag === "Prepared");
});

test("a partly written preparation is deleted and the item prepared again", async () => {
  const key = runCommentKey("2026-10-01T00-00-00-000Z-preparation-21");
  const texts = Result.getOrThrow(preparedComments(key, [{ entry: q("Q1"), terms: null }], { _tag: "Prepared", key, digest: digestOf(marked("21")), count: 1, generation: 1, date: "d" }));
  const partial = texts.slice(0, 1).map((c, i) => ({ id: seededId(`old-${i}`), body: c.text, created: "t" }));
  const h = await harness([{ ...marked("21"), comments: partial }], [PREPARE_ONE]);
  await run(h.manager.setPreparation(true));
  await until("prepared again", async () => (await foundOf(h, "21"))._tag === "Prepared");
  assert.ok(((await itemIn(h, "21")).comments ?? []).every((c) => c.id !== partial[0]!.id));
});

test("turning the switch off and on releases a set-aside item, which is prepared again", async () => {
  const h = await harness([marked("21")], [PAUSING, PREPARE_ONE]);
  await run(h.manager.setPreparation(true));
  await until("set aside", async () => (await foundOf(h, "21"))._tag === "SetAside");
  await run(h.manager.setPreparation(false));
  await run(h.manager.setPreparation(true));
  await until("prepared", async () => (await foundOf(h, "21"))._tag === "Prepared");
});

test("the switch off holds: chain.json says off, a listing and a run's end prepare nothing, and a restart prepares nothing", async () => {
  const h = await harness([marked("21"), marked("22")], [PREPARE_ONE, ASKED_ONE]);
  await run(h.manager.setPreparation(true));
  await run(h.manager.setPreparation(false));
  assert.equal(chainFile(h).preparation.settings.enabled, false);
  await listed(h);
  await sleep(200);
  const prepared = h.probes.length;
  const again = await harness([], [PREPARE_ONE], { repo: h.repo, tracker: h.tracker });
  await listed(again);
  await sleep(200);
  assert.equal(again.probes.length, 0);
  assert.ok(prepared <= 1);
});

test("Refine whose comments cannot be read is refused with the tracker's notice; a second Refine starts and records the release", async () => {
  let refusing = false;
  const failing = (t: TrackerShape): TrackerShape => ({ ...t, comments: (id) => (refusing ? Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) : t.comments(id)) });
  const h = await harness([marked("21")], [PAUSING, ASKED_ONE], { trackerOf: failing });
  await run(h.manager.setPreparation(true));
  await until("set aside", async () => (await foundOf(h, "21"))._tag === "SetAside");
  // Off, so the pass reads no comments meanwhile.
  await run(h.manager.setPreparation(false));
  const before = fs.readFileSync(path.join(h.repo, "plan-review", "chain.json"), "utf8");
  refusing = true;
  const refused = await run(h.manager.start(startOf("refinement", "21")));
  refusing = false;
  assert.equal(typeof refused, "object", "the start was not refused");
  assert.match((refused as Refusal).refused, /down/u);
  assert.equal(fs.readFileSync(path.join(h.repo, "plan-review", "chain.json"), "utf8"), before);
  assert.deepEqual(await run(h.manager.current), { refinement: [], implementation: null });
  const id = await startRefinement(h, "21");
  // The release is persisted by a detached continuation, so it is awaited rather than read at once.
  await until("the release recorded", () => chainFile(h).preparation.released.some((r: { item: string }) => r.item === "21"), 120_000);
  await run(h.manager.stop("test", id));
});

test("Refine while the item's preparation is held: the refinement starts and the preparation's comments are all gone", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let comments = 0;
  const holding = (t: TrackerShape): TrackerShape => ({ ...t, comment: (id, text) => Effect.suspend(() => (++comments === 1 ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(t.comment(id, text))) });
  const h = await harness([marked("21")], [{ ...PREPARE_ONE, steps: [{ output: { questions: [q("Q1"), q("Q2")] } }] }, ASKED_ONE], { trackerOf: holding });
  await run(h.manager.setPreparation(true));
  await until("the first comment write", () => comments >= 1);
  const id = await startRefinement(h, "21");
  release();
  await until("no preparation comment", async () => (await foundOf(h, "21")).ids.length === 0);
  await run(h.manager.stop("test", id));
});

test("a server fault during a preparation: the pass ends at once, chain.json keeps the switch on, and a restart resumes", async () => {
  const h = await harness([marked("21"), marked("22")], [{ ...PREPARE_ONE, steps: [{ output: { questions: [q("Q1")] }, hang: true }] }]);
  await run(h.manager.setPreparation(true));
  await until("the preparation's call", () => h.probes.length === 1 && h.probes[0]!.planner.prompts.length === 1);
  await run(h.manager.haltAll("boom"));
  await listed(h);
  await sleep(200);
  assert.equal(h.probes.length, 1);
  assert.equal(chainFile(h).preparation.settings.enabled, true);
  const again = await harness([], [PREPARE_ONE, PREPARE_ONE], { repo: h.repo, tracker: h.tracker });
  await until("resumed", async () => (await foundOf(again, "22"))._tag === "Prepared" && (await foundOf(again, "21"))._tag === "Prepared");
});

test("a server fault while a stopped preparation's cleanup is blocked: haltAll still ends the refinement within its bounds", async () => {
  const never = new Promise<void>(() => {});
  const blocking = (t: TrackerShape): TrackerShape => ({ ...t, deleteComment: () => Effect.promise(() => never) });
  const h = await harness([marked("21"), marked("22")], [{ steps: [{ output: { questions: [q("Q1")] } }], reviews: [{ issues: [] }] }, { ...ASKED_ONE, closings: [] }, { ...PREPARE_ONE, steps: [{ output: { questions: [q("Q1")] }, hang: true }] }], { trackerOf: blocking });
  await run(h.manager.setPreparation(true));
  await until("item 22's comments", async () => ((await itemIn(h, "22")).comments ?? []).length > 0);
  const id = await startRefinement(h, "22");
  const t0 = Date.now();
  const report = await run(h.manager.haltAll("boom"));
  assert.ok(Date.now() - t0 < BOUNDS.graceMs + BOUNDS.interruptMs + 2_000);
  assert.ok([...report.halted, ...report.unconfirmed].includes(id));
});

test("a NotWritten item is marked set aside, still after a restart, and prepared again once its title is edited", async () => {
  let failing = true;
  const refusing = (t: TrackerShape): TrackerShape => ({ ...t, comment: (id, text) => (failing ? Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) : t.comment(id, text)) });
  const h = await harness([marked("21")], [PREPARE_ONE], { trackerOf: refusing });
  await run(h.manager.setPreparation(true));
  await until("the failure in chain.json", () => fs.existsSync(path.join(h.repo, "plan-review", "chain.json")) && chainFile(h).preparation.failures.length === 1);
  assert.equal((await markOfItem(h, "21"))?._tag, "SetAside");
  const again = await harness([], [PREPARE_ONE], { repo: h.repo, tracker: h.tracker, trackerOf: refusing });
  await listed(again);
  await sleep(200);
  assert.equal(again.probes.length, 0);
  assert.equal((await markOfItem(again, "21"))?._tag, "SetAside");
  failing = false;
  await run(h.tracker.edit("21" as ItemId, (i) => ({ ...i, title: "edited" })));
  await listed(again);
  await until("prepared", async () => (await foundOf(again, "21"))._tag === "Prepared");
});

test("the switch survives a restart: a manager made again over chain.json resumes preparing", async () => {
  const h = await harness([marked("21")], []);
  await run(h.manager.setPreparation(true));
  await run(h.manager.haltAll("restart"));
  const again = await harness([], [PREPARE_ONE], { repo: h.repo, tracker: h.tracker });
  assert.equal((await run(again.manager.preparation)).settings.enabled, true);
  await until("prepared", async () => (await foundOf(again, "21"))._tag === "Prepared");
  await run(again.manager.setPreparation(false));
  assert.equal(chainFile(again).preparation.settings.enabled, false);
});


test("Refine on a set-aside item whose deletion is held: chain.json holds the release at once, and the pass prepares the item after the run ends", async () => {
  let open: () => void = () => {};
  const held = new Promise<void>((r) => (open = r));
  let holding = false;
  const gated = (t: TrackerShape): TrackerShape => ({ ...t, deleteComment: (id, c) => Effect.suspend(() => (holding ? Effect.promise(() => held) : Effect.void)).pipe(Effect.andThen(t.deleteComment(id, c))) });
  const h = await harness([marked("21")], [PAUSING, { steps: [{ hang: true }] }, PREPARE_ONE], { trackerOf: gated });
  await run(h.manager.setPreparation(true));
  await until("set aside", async () => (await foundOf(h, "21"))._tag === "SetAside");
  holding = true;
  const id = await startRefinement(h, "21");
  assert.ok(chainFile(h).preparation.released.some((r: { item: string }) => r.item === "21"));
  await run(h.manager.stop("test", id));
  await endedWith(h, id);
  // The set-aside comment is still there; the release alone makes the item eligible, and the pass prepares it again.
  await until("the new preparation's list call", () => h.probes.length === 3 && h.probes[2]!.planner.prompts.length === 1);
  assert.equal((await foundOf(h, "21"))._tag, "SetAside");
  holding = false;
  open();
  await until("prepared, the old comment gone", async () => (await foundOf(h, "21"))._tag === "Prepared" && ((await itemIn(h, "21")).comments ?? []).length === 2);
});

test("Refine on a set-aside item whose deletion fails for good, then a restart: the item is prepared, and the release is dropped once its comment is gone", async () => {
  let failing = true;
  const refusing = (t: TrackerShape): TrackerShape => ({ ...t, deleteComment: (id, c) => (failing ? Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) : t.deleteComment(id, c)) });
  const h = await harness([marked("21")], [PAUSING, { steps: [{ hang: true }] }], { trackerOf: refusing });
  await run(h.manager.setPreparation(true));
  await until("set aside", async () => (await foundOf(h, "21"))._tag === "SetAside");
  const id = await startRefinement(h, "21");
  await run(h.manager.stop("test", id));
  await endedWith(h, id);
  await run(h.manager.haltAll("restart"));
  failing = false;
  const again = await harness([], [PREPARE_ONE], { repo: h.repo, tracker: h.tracker, trackerOf: refusing });
  await until("prepared", async () => (await foundOf(again, "21"))._tag === "Prepared");
  await listed(again);
  await until("the release dropped", () => chainFile(again).preparation.released.length === 0);
});

test("three at once: an implementation run, a held preparation, and a refinement of a prepared item whose decision survives a commit", async () => {
  const key = runCommentKey("2026-10-01T00-00-00-000Z-preparation-23");
  const entry = q("Q1");
  const prepared: FakeItem = { ...marked("23"), marked: false };
  const texts = Result.getOrThrow(preparedComments(key, [{ entry, terms: { id: "Q1", explanations: [], context: entry.context, history: entry.history, question: entry.question, reason: entry.reason, proposed_answers: entry.proposed_answers } }], { _tag: "Prepared", key, digest: digestOf(prepared), count: 1, generation: 1, date: "d" }));
  const refined: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("5")), state: "refined" };
  const commitInRepo = (repo: string) => {
    fs.writeFileSync(path.join(repo, "committed-meanwhile.txt"), "x\n");
    execFileSync("git", ["-C", repo, "add", "committed-meanwhile.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "meanwhile"]);
  };
  const analysis = { decision: "question Q1?", columns: [{ kind: "argued", option: "A", advantages: [], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "A", reason: "r" } };
  let repoOf = "";
  const h = await harness(
    [refined, marked("22"), { ...prepared, comments: texts.map((c, i) => ({ id: seededId(`p-${i}`), body: c.text, created: "t" })) }],
    [
      { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }], execScripts: [{ hang: true }] },
      { steps: [{ output: { questions: [q("Q1")] }, hang: true }] },
      { steps: [{ output: analysis, onCall: () => commitInRepo(repoOf) }], reviews: [{ issues: [] }, { issues: [] }], closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }] },
    ],
  );
  repoOf = h.repo;
  const implementation = await run(h.manager.start(startOf("implementation", "5")));
  assert.equal(typeof implementation, "number");
  await run(h.manager.setPreparation(true));
  await until("the preparation's call", () => h.probes.length >= 2 && h.probes[1]!.planner.prompts.length === 1);
  const id = await startRefinement(h, "23");
  const first = await firstAsk(h, id);
  assert.equal(await run(h.manager.answer("test", id, first.prompt, "/decide")), null);
  // The decision completes although a commit landed during its analysis call: a refinement run's guards compare no project snapshot.
  const analyzedAt = () => eventsOf(h, id).findIndex((e) => e._tag === "Notified" && e.event._tag === "DecisionAnalyzed");
  await until("the analysis", () => analyzedAt() >= 0).catch((e) => { console.error(JSON.stringify(eventsOf(h, id).map((x) => x._tag === "Notified" ? x.event._tag : x._tag === "Said" ? `Said:${x.text.slice(0, 160)}` : x._tag))); throw e; });
  await until("the question asked again after the analysis", () => eventsOf(h, id).slice(analyzedAt()).some((e) => e._tag === "Asked"));
  const again = eventsOf(h, id).slice(analyzedAt()).find((e): e is Extract<RunEvent, { _tag: "Asked" }> => e._tag === "Asked")!;
  assert.equal(await run(h.manager.answer("test", id, again.prompt, "A")), null);
  assert.equal(await endedWith(h, id), 0);
  assert.ok(fs.existsSync(path.join(h.repo, "committed-meanwhile.txt")), "the commit was not made during the analysis");
  await run(h.manager.stop("test", implementation as number));
  await run(h.manager.setPreparation(false));
});

test("W1-R1-2: Refine on a set-aside item whose mark was removed and whose deletion fails keeps the release; with the mark restored the item is prepared and the release then dropped", async () => {
  let failing = true;
  const refusing = (t: TrackerShape): TrackerShape => ({ ...t, deleteComment: (id, c) => (failing ? Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })) : t.deleteComment(id, c)) });
  const h = await harness([marked("21")], [PAUSING, { steps: [{ hang: true }] }, PREPARE_ONE], { trackerOf: refusing });
  await run(h.manager.setPreparation(true));
  await until("set aside", async () => (await foundOf(h, "21"))._tag === "SetAside");
  await run(h.tracker.edit("21" as ItemId, (i) => ({ ...i, marked: false })));
  const id = await startRefinement(h, "21");
  await until("the release recorded", () => chainFile(h).preparation.released.length === 1);
  await run(h.manager.stop("test", id));
  await endedWith(h, id);
  await listed(h);
  await sleep(300);
  assert.deepEqual(chainFile(h).preparation.released.map((r: { item: string }) => r.item), ["21"]);
  assert.equal((await foundOf(h, "21"))._tag, "SetAside");
  failing = false;
  await run(h.tracker.edit("21" as ItemId, (i) => ({ ...i, marked: true })));
  await listed(h);
  await until("prepared", async () => (await foundOf(h, "21"))._tag === "Prepared");
  await listed(h);
  await until("the release dropped", () => chainFile(h).preparation.released.length === 0);
  await run(h.manager.haltAll("end"));
});
