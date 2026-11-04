// Issue #243: a question open beside the running run (openBeside): presented and recorded before the caller goes on,
// answerable while it does, its answer stored in the Ui's own take, and cancelled on the page when its fiber is interrupted.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber, Option, Scope, type Layer } from "effect";
import { numberedOptions, openBeside, type OfferedOption, type QuestionDraft } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import type { RunEvent } from "../src/protocol.ts";
import type { DecisionAnalysis } from "../src/schema.ts";
import { OpenQuestions, type Services, Store } from "../src/services.ts";
import { makeWebUi, type WebUi } from "../src/webUi.ts";
import { para, plain, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const options: readonly OfferedOption[] = numberedOptions([
  { label: "SQLite", description: "a file" },
  { label: "PostgreSQL", description: "a server" },
]);
const draft: QuestionDraft = { origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, history: [], explanations: [], question: plain("Which database?"), options, decision: null };
const analysis: DecisionAnalysis = {
  decision: "Which database?",
  columns: [
    { kind: "argued", option: "SQLite", advantages: [], disadvantages: [] },
    { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [] },
  ],
  recommendation: { option: "SQLite", reason: "r" },
};
const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000 && !condition(); i++) await sleep(2);
  if (!condition()) throw new Error("the condition never held");
};
const setUp = async (opts: TestOptions) => {
  const t = testLayer(tempRepo(), opts);
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  return t;
};
const webUi = async (): Promise<{ ui: WebUi; events: RunEvent[] }> => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  return { ui, events };
};
const besidePrompt = async (events: readonly RunEvent[], count = 1): Promise<number> => {
  await until(() => events.filter((e) => e._tag === "Asked" && e.beside !== null).length >= count);
  const found = events.filter((e) => e._tag === "Asked" && e.beside !== null);
  const last = found[found.length - 1];
  return last._tag === "Asked" ? last.prompt : -1;
};
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const run = <A, E>(layer: Layer.Layer<Services>, e: Effect.Effect<A, E, Services | Scope.Scope>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
const open = (offer: boolean) => Effect.gen(function* () {
  const scope = yield* Effect.scope;
  return yield* openBeside(scope, prompts.decisionPrompt, draft, () => true, { offer });
});
/** Waits until the handle holds an answer. */
const answerOf = (handle: { answer: Effect.Effect<Option.Option<string>> }) =>
  Effect.gen(function* () {
    for (;;) {
      const a = yield* handle.answer;
      if (Option.isSome(a)) return a.value;
      yield* Effect.sleep("2 millis");
    }
  });

test("the question is presented and recorded before openBeside returns, and the caller goes on while it is unanswered", async () => {
  const { layer, probe } = await setUp({ answers: [] });
  const seen = await run(layer, Effect.gen(function* () {
    const handle = yield* open(false);
    const presented = probe.ui.notified.some((e) => e._tag === "QuestionPresented");
    const recorded = conversation(probe.dir).includes("Which database?");
    return { presented, recorded, answer: yield* handle.answer, number: handle.number };
  }));
  assert.deepEqual(seen, { presented: true, recorded: true, answer: Option.none(), number: 1 });
});

test("a scripted beside answer is the handle's answer", async () => {
  const { layer } = await setUp({ answers: [{ beside: "2" }] });
  assert.equal(await run(layer, Effect.flatMap(open(false), answerOf)), "2");
});

test("with offer false, /decide is rejected and the question asked again", async () => {
  const { layer, probe } = await setUp({ answers: [{ beside: "/decide" }, { beside: "1" }] });
  assert.equal(await run(layer, Effect.flatMap(open(false), answerOf)), "1");
  assert.equal(probe.ui.notified.filter((e) => e._tag === "AnswerRejected").length, 1);
  assert.equal(probe.planner.history.size ?? 0, 0);
});

test("with offer true, /decide runs a decision while the caller goes on; the next answer is recorded as its choice", async () => {
  const { layer, probe } = await setUp({ answers: [{ beside: "/decide" }, { beside: "2" }], steps: [{ output: analysis }], reviews: [{ issues: [] }] });
  assert.equal(await run(layer, Effect.flatMap(open(true), answerOf)), "2");
  assert.equal(probe.ui.notified.filter((e) => e._tag === "DecisionAnalyzed").length, 1);
  await until(() => fs.existsSync(path.join(probe.dir, "decision-1/chosen.json")));
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, "PostgreSQL");
  assert.ok(!prompts.offersOf(probe.ui.asked[1]).decide, "asked again without the offer");
});

test("q at a beside question ends the run through OpenQuestions.quitted", async () => {
  const { layer } = await setUp({ answers: [{ beside: "q" }] });
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* open(false);
    return yield* (yield* OpenQuestions).quitted;
  })).pipe(Effect.provide(layer)));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes("UserStopped"));
});

test("with the web Ui: an answer taken and the fiber interrupted at once, before any yield, still leaves the answer", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  const answer = await run(layer, Effect.gen(function* () {
    const handle = yield* open(false);
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    yield* web.ui.answer(prompt, "2");
    yield* Fiber.interrupt(handle.fiber);
    return yield* handle.answer;
  }));
  assert.deepEqual(answer, Option.some("2"));
});

test("with the web Ui: an answer while the analysis is prepared, the fiber interrupted at once: answer kept and the decision's abandoned records written", async () => {
  const web = await webUi();
  const opened = signal();
  const { layer, probe } = await setUp({ ui: web.ui, steps: [{ output: analysis, gate: () => new Promise(() => {}), onCall: () => opened.resolve() }] });
  const answer = await run(layer, Effect.gen(function* () {
    const handle = yield* open(true);
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    yield* web.ui.answer(prompt, "/decide");
    yield* Effect.promise(() => opened.promise);
    const during = yield* Effect.promise(async () => {
      await until(() => web.events.some((e) => e._tag === "Asked" && e.deciding !== null));
      const d = web.events.filter((e) => e._tag === "Asked" && e.deciding !== null).pop();
      return d?._tag === "Asked" ? d.prompt : -1;
    });
    yield* web.ui.answer(during, "2");
    yield* Fiber.interrupt(handle.fiber);
    return yield* handle.answer;
  }));
  assert.deepEqual(answer, Option.some("2"));
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, "PostgreSQL");
  assert.ok(conversation(probe.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("with the web Ui: interrupting the fiber cancels the question on the page", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  await run(layer, Effect.gen(function* () {
    const handle = yield* open(false);
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    yield* Fiber.interrupt(handle.fiber);
    assert.ok(web.events.some((e) => e._tag === "PromptCancelled" && e.prompt === prompt));
    assert.equal(yield* web.ui.pending, null);
  }));
});

test("a question forked in a scope that outlives the presenting effect stays answerable after it returns", async () => {
  const web = await webUi();
  const { layer } = await setUp({ ui: web.ui });
  const answer = await run(layer, Effect.gen(function* () {
    const outer = yield* Scope.make();
    const handle = yield* Effect.scoped(openBeside(outer, prompts.decisionPrompt, draft, () => true, { offer: false }));
    const prompt = yield* Effect.promise(() => besidePrompt(web.events));
    assert.equal(yield* web.ui.answer(prompt, "1"), "taken");
    const a = yield* answerOf(handle);
    yield* Scope.close(outer, Exit.void);
    return a;
  }));
  assert.equal(answer, "1");
});
