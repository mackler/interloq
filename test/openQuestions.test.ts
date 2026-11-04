// Issue #243: the OpenQuestions service, the run's registry of disputes put to the developer beside the run, with the
// producers of their questions, and the end of the run by a question answered q.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, type Layer } from "effect";
import { UserStopped } from "../src/errors.ts";
import { numberedOptions, openBeside, type QuestionDraft } from "../src/offer.ts";
import type { OpenDispute } from "../src/openDisputes.ts";
import * as prompts from "../src/prompts.ts";
import type { RunEvent } from "../src/protocol.ts";
import type { BesideKey } from "../src/reviewState.ts";
import { OpenQuestions, type Services, Store } from "../src/services.ts";
import { makeWebUi, type WebUi } from "../src/webUi.ts";
import { para, plain, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const options = [
  { label: prompts.REVIEWER_POSITION, description: "do the change" },
  { label: prompts.PLANNER_POSITION, description: "keep it" },
];
const draft: QuestionDraft = { origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, history: [], explanations: [], question: plain("Which outcome?"), options: numberedOptions(options), decision: null };
const dispute = (key: string, owner: OpenDispute["owner"] = { _tag: "Run" }): OpenDispute => ({ key: key as BesideKey, heading: "Planning phase 1", subject: { plan: 1 }, phase: 1, round: 1, id: null, recordSubject: "s", reviewer: "do the change", planner: "keep it", options, owner });
const setUp = async (opts: TestOptions) => {
  const t = testLayer(tempRepo(), opts);
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  return t;
};
const run = <A, E>(layer: Layer.Layer<Services>, e: Effect.Effect<A, E, Services>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
/** A dispute's question opened in the run's scope, as the review loop opens it. */
const openDispute = (d: OpenDispute) =>
  Effect.gen(function* () {
    const open = yield* OpenQuestions;
    yield* open.opened(d);
    const handle = yield* openBeside(open.scope, prompts.decisionPrompt, draft, () => true, { offer: false, onAccepted: (text) => open.answered(d.key, text) });
    yield* open.attach(d.key, handle.fiber);
    return { open, handle };
  });
const webUi = async (): Promise<{ ui: WebUi; events: RunEvent[] }> => {
  const events: RunEvent[] = [];
  return { ui: await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e)))), events };
};
const besidePrompt = async (events: readonly RunEvent[]): Promise<number> => {
  for (let i = 0; i < 500; i++) {
    const found = events.filter((e) => e._tag === "Asked" && e.beside !== null).pop();
    if (found?._tag === "Asked") return found.prompt;
    await sleep(2);
  }
  throw new Error("no beside prompt");
};

test("a dispute answered through its question is peeked while in its loop, and stays until acknowledged", async () => {
  const { layer } = await setUp({ answers: [{ beside: "1" }] });
  const result = await run(layer, Effect.gen(function* () {
    const { open, handle } = yield* openDispute(dispute("k1"));
    yield* Fiber.await(handle.fiber);
    const first = yield* open.peek(["k1" as BesideKey]);
    const again = yield* open.peek(["k1" as BesideKey]);
    yield* open.acknowledge(["k1" as BesideKey]);
    const gone = yield* open.peek(["k1" as BesideKey]);
    return { first, again, gone };
  }));
  assert.equal(result.first.length, 1);
  assert.equal(result.first[0]!.applies, true);
  assert.deepEqual(result.again, result.first);
  assert.deepEqual(result.gone, []);
});

test("an answered Run-owned dispute not acknowledged before its loop ended is taken after it; a decision's is not", async () => {
  const { layer } = await setUp({ answers: [] });
  const taken = await run(layer, Effect.gen(function* () {
    const open = yield* OpenQuestions;
    yield* open.opened(dispute("run"));
    yield* open.opened(dispute("dec", { _tag: "Decision", decision: 1 }));
    yield* open.answered("run" as BesideKey, prompts.PLANNER_POSITION);
    yield* open.answered("dec" as BesideKey, prompts.REVIEWER_POSITION);
    yield* open.loopEnded(["run" as BesideKey, "dec" as BesideKey]);
    return yield* open.takeAfterLoop;
  }));
  assert.deepEqual(taken.map((a) => [a.dispute.key, a.applies]), [["run", false]]);
});

test("with the web Ui, an answer taken and then a withdrawal at once, before any yield: the answer is kept, nothing withdrawn", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  const w = await run(layer, Effect.gen(function* () {
    const { open } = yield* openDispute(dispute("k1"));
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    yield* web.ui.answer(prompt, "1");
    return yield* open.withdrawAll;
  }));
  assert.deepEqual(w.withdrawn, []);
  assert.deepEqual(w.answered.map((a) => a.dispute.key), ["k1"]);
});

test("withdrawAll interrupts an open dispute's question, cancelling its prompt", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  const w = await run(layer, Effect.gen(function* () {
    const { open } = yield* openDispute(dispute("k1"));
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    const w = yield* open.withdrawAll;
    assert.ok(web.events.some((e) => e._tag === "PromptCancelled" && e.prompt === prompt));
    assert.equal(yield* web.ui.pending, null);
    return w;
  }));
  assert.deepEqual(w.withdrawn.map((d) => d.key), ["k1"]);
});

test("quit makes quitted fail with UserStopped", async () => {
  const { layer } = await setUp({ answers: [] });
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const open = yield* OpenQuestions;
    yield* open.quit(new UserStopped({ where: "limit" }));
    return yield* open.quitted;
  }).pipe(Effect.provide(layer)));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes("UserStopped"));
});

// W1-R1-1: the Ui's take and a withdrawal decided in one place, the registry, so no answer accepted is lost.
const heldWebUi = async () => {
  const events: RunEvent[] = [];
  const suspended = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const ui = await Effect.runPromise(
    makeWebUi((e) =>
      e._tag === "Answered"
        ? Deferred.succeed(suspended, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => void events.push(e))))
        : Effect.sync(() => void events.push(e)),
    ),
  );
  return { ui, events, suspended, release };
};

test("W1-R1-1: withdrawAll while an answer's Answered publication is held: the answer's result and the registry agree", async () => {
  const web = await heldWebUi();
  const { layer } = await setUp({ ui: web.ui });
  const { result, w } = await run(layer, Effect.gen(function* () {
    const { open } = yield* openDispute(dispute("k1"));
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    const answering = yield* Effect.forkDetach(web.ui.answer(prompt, "1"));
    yield* Effect.raceFirst(Deferred.await(web.suspended), Effect.andThen(Fiber.await(answering), Effect.void));
    const w = yield* open.withdrawAll;
    yield* Deferred.succeed(web.release, undefined);
    return { result: yield* Fiber.join(answering), w };
  }));
  const kept = w.answered.some((a) => a.dispute.key === "k1");
  const withdrawn = w.withdrawn.some((d) => d.key === "k1");
  if (result === "taken") assert.ok(kept && !withdrawn, "an answer taken is in the withdrawal's answered");
  else {
    assert.equal(result, "notWaiting");
    assert.ok(withdrawn && !kept, "an answer not taken leaves the dispute withdrawn");
    assert.ok(!web.events.some((e) => e._tag === "Answered"), "no Answered is published for it");
  }
});

test("W1-R1-1: withdrawAll before the answer: the answer is not waiting and nothing is published", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  const result = await run(layer, Effect.gen(function* () {
    const { open } = yield* openDispute(dispute("k1"));
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    yield* open.withdrawAll;
    return yield* web.ui.answer(prompt, "1");
  }));
  assert.equal(result, "notWaiting");
  assert.ok(!web.events.some((e) => e._tag === "Answered"));
});
