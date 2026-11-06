// Issue #215: a wait with a countdown that the developer ends early. The run's sleep ends at once, the refused request
// is made again with the same guards and session, a usage-limit wait is recorded with the outcome `ended`, and a refusal
// after it waits as planLimitWait plans. The clock is held, so a wait that ended did so by the press alone.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { NO_LIMIT_WAIT, planLimitWait } from "../src/limitReset.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { TrackerUnreachable } from "../src/errors.ts";
import { makeFakeTracker } from "./fakeTracker.ts";
import { sourceOf, ack, finished, heldClock, questionEntry, type ScriptedUi, scriptedItem, scriptedStart, summaryReply, tempRepo, testLayer, testWiring } from "./helpers.ts";

const START = Date.UTC(2026, 10, 1, 19, 30);
const RESET = START + 9_000_000;
const noQuestions = { questions_for_user: [] };
const timeout = { timeout: 120_000 };
const tick = () => new Promise((r) => setTimeout(r, 5));

type Announcing = Extract<UiEvent, { _tag: "UsageLimitWaiting" | "TransportRetrying" | "NetworkRetrying" | "TrackerRetrying" }>;
const announcing = (ui: ScriptedUi): Announcing[] =>
  ui.notified.filter((e): e is Announcing => e._tag === "UsageLimitWaiting" || e._tag === "TransportRetrying" || e._tag === "NetworkRetrying" || e._tag === "TrackerRetrying");
const endedEarly = (ui: ScriptedUi): number[] => ui.notified.flatMap((e) => (e._tag === "WaitEndedEarly" ? [e.wait] : []));

/** Presses the control of every wait announced, once, until `done` resolves; returns the presses' results. */
const pressEvery = (ui: ScriptedUi, done: Promise<unknown>): Promise<string[]> => {
  let over = false;
  void done.finally(() => (over = true));
  const pressed = new Set<number>();
  const results: string[] = [];
  return (async () => {
    while (!over) {
      for (const e of announcing(ui))
        if (!pressed.has(e.wait)) {
          pressed.add(e.wait);
          results.push(await Effect.runPromise(ui.endWait(e.wait)));
        }
      await tick();
    }
    return results;
  })();
};
const usageWaits = (dir: string) =>
  fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");

test("a usage-limit wait ended early: the call is made again at once and succeeds; the wait's outcome is ended and the checkpoint's note cleared", timeout, async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ limit: { reset: { kind: "instant", atMs: RESET }, limitType: "five_hour" } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  const presses = pressEvery(probe.ui, done);
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(await presses, ["ended"]);
  assert.equal(held.clock.currentTimeMillisUnsafe(), START, "the clock advanced");
  assert.equal(probe.planner.prompts.length, 2);
  assert.deepEqual(usageWaits(probe.dir).map((w) => w.outcome), ["ended"]);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(probe.dir, "checkpoint.json"), "utf8")) as Record<string, unknown>;
  assert.equal(checkpoint.waiting, null);
  const line = prompts.waitEndedLine({ kind: "usageLimit", agent: "claude", limitType: null });
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(line));
  assert.ok(probe.ui.said.includes(line));
  assert.ok(!probe.ui.notified.some((e) => e._tag === "UsageLimitLifted"));
  const [waiting] = announcing(probe.ui);
  assert.deepEqual(endedEarly(probe.ui), [waiting?.wait]);
});

test("a call refused again after the early end waits as planLimitWait plans for the new refusal, under a new id", timeout, async () => {
  const limit = { limit: { reset: { kind: "instant" as const, atMs: RESET }, limitType: "five_hour" } };
  const { wiring, probe } = testWiring(tempRepo(), { steps: [limit, limit, { output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  const presses = pressEvery(probe.ui, done);
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(await presses, ["ended", "ended"]);
  const first = planLimitWait({ kind: "instant", atMs: RESET }, START, NO_LIMIT_WAIT);
  const second = planLimitWait({ kind: "instant", atMs: RESET }, START, first.next);
  const waits = announcing(probe.ui);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]?._tag === "UsageLimitWaiting" && waits[1]?._tag === "UsageLimitWaiting");
  assert.equal(waits[1].untilMs, second.untilMs);
  assert.deepEqual(waits[1].basis, second.basis);
  assert.notEqual(waits[0].wait, waits[1].wait);
  assert.deepEqual(usageWaits(probe.dir).map((w) => w.outcome), ["ended", "ended"]);
});

test("a Codex review's backoff ended early: the turn is made again at once, and the early end names the wait announced", timeout, async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], fault: "socket hang up" }, { issues: [] }, { issues: [] }], execs: [finished] });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  const presses = pressEvery(probe.ui, done);
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(await presses, ["ended"]);
  assert.equal(held.clock.currentTimeMillisUnsafe(), START);
  const tags = probe.ui.notified.filter((e) => e._tag === "TransportRetrying" || e._tag === "WaitEndedEarly");
  assert.equal(tags[0]?._tag, "TransportRetrying");
  assert.equal(tags[1]?._tag, "WaitEndedEarly");
  assert.equal(tags[0]?.wait, tags[1]?.wait);
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.waitEndedLine({ kind: "retry", agent: "codex" })));
});

test("a wait for the network ended early: the call is made again at once", timeout, async () => {
  const unreachable = Array.from({ length: 4 }, () => ({ issues: [], fault: "getaddrinfo EAI_AGAIN api.openai.com", faultCode: "EAI_AGAIN" as const }));
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [...unreachable, { issues: [] }, { issues: [] }], execs: [finished] });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  const presses = pressEvery(probe.ui, done);
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(await presses, ["ended", "ended", "ended", "ended"]);
  assert.equal(held.clock.currentTimeMillisUnsafe(), START);
  const network = probe.ui.notified.find((e) => e._tag === "NetworkRetrying");
  assert.ok(network !== undefined && endedEarly(probe.ui).includes(network.wait));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.waitEndedLine({ kind: "network", agent: "codex" })));
});

// G-R1-1: a question can be pending while the clarification's worker waits; ending the wait leaves the question as it is.
test("G-R1-1: during the first clarification, a worker request's backoff ended early leaves the pending question pending and answerable", timeout, async () => {
  const q = (id: string): S.QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { default_answer: "A", skip_if: null });
  let pressedThen: () => void = () => undefined;
  const afterPress = new Promise<void>((r) => (pressedThen = r));
  const { layer, probe } = testLayer(tempRepo(), {
    mode: "refinement",
    steps: [{ output: { questions: [q("Q1"), q("Q2")] } }],
    reviews: [{ issues: [] }, { issues: [] }],
    answers: ["A", { text: "B", when: () => afterPress }],
    replies: [{ fault: "stream disconnected before completion" }, { output: ack() }, { output: ack() }],
    closings: [{ output: summaryReply("# Requirements\n\nQ1, Q2: A, B.") }],
  });
  const held = heldClock(START);
  const fiber = Effect.runFork(refinementRun(sourceOf("task"), scriptedItem.id, "unchecked").pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, held.clock)));
  const q2Presented = () => probe.ui.notified.filter((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "clarification" && e.question.origin.id === "Q2").length;
  while (announcing(probe.ui).length === 0 || q2Presented() === 0) await tick();
  const [wait] = announcing(probe.ui);
  assert.ok(wait !== undefined && wait._tag === "TransportRetrying");
  assert.equal(await Effect.runPromise(probe.ui.endWait(wait.wait)), "ended");
  while (probe.planner.clarificationPrompts.length < 2) await tick();
  pressedThen();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.ok(Exit.isSuccess(exit), String(exit));
  assert.equal(q2Presented(), 1, "Q2 was presented again");
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*User:\*\* B/);
  assert.equal(held.clock.currentTimeMillisUnsafe(), START);
});

test("a tracker repeat's wait ended early: the write is made again at once and the run goes on", timeout, async () => {
  const fake = await Effect.runPromise(makeFakeTracker([{ ...scriptedItem, state: "refined" }]));
  await Effect.runPromise(fake.failNext("setState", new TrackerUnreachable({ tracker: "GitHub", message: "no answer", status: null })));
  const { wiring, probe } = testWiring(tempRepo(), { tracker: fake, steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  const presses = pressEvery(probe.ui, done);
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(await presses, ["ended"]);
  assert.equal(held.clock.currentTimeMillisUnsafe(), START);
  const [waiting] = announcing(probe.ui);
  assert.ok(waiting !== undefined && waiting._tag === "TrackerRetrying");
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.waitEndedLine({ kind: "tracker", tracker: "GitHub", what: waiting.what })));
});
