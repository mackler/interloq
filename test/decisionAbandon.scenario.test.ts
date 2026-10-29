// Issue #153 (requirements Q1): the question stays answerable while its decision's analysis is prepared, and an answer
// given then abandons the decision: the loop is interrupted, and the answer is recorded as the choice made for it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, type Layer } from "effect";
import { askOffering, byLine, byMessage, numberedOptions, type OfferedOption, type QuestionDraft } from "../src/offer.ts";
import { TERMS_REQUEST } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import { readCheckpoint } from "../src/records.ts";
import { renderChoice } from "../src/render.ts";
import type { DecisionAnalysis } from "../src/schema.ts";
import { type Services, Store, type StoreShape, Ui } from "../src/services.ts";
import { promptOf } from "../src/userPrompts.ts";
import { platformLayer } from "../src/platform.ts";
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
/** A promise and the function that resolves it. */
const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Resolves once the condition holds. */
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
const asking = (layer: Layer.Layer<Services>, acceptable: (a: string) => boolean = () => true) =>
  Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering(byLine((p) => ui.ask(p)), "Pick > ", draft, acceptable);
  }).pipe(Effect.provide(layer)));
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const analyzed = (notified: readonly { _tag: string }[]) => notified.filter((e) => e._tag === "DecisionAnalyzed").length;
const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`askOffering failed: ${String(exit.cause)}`);
  return exit.value;
};
/** The records of an abandoned decision 1 with the answer "2" (PostgreSQL). */
const abandonedRecords = async (dir: string, said: readonly string[]) => {
  assert.deepEqual(json(dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
  const text = conversation(dir);
  assert.ok(text.includes(prompts.decisionAbandonedLine(1)), "the abandoned line is in conversation.md");
  assert.ok(text.includes(renderChoice(1, "2", "PostgreSQL")), "the choice is in conversation.md");
  assert.ok(said.includes(prompts.decisionAbandonedLine(1)), "the abandoned line was said to the page");
  assert.ok((await Effect.runPromise(readCheckpoint(dir).pipe(Effect.provide(platformLayer)))) !== null);
};

test("(a) an answer while the analysis call runs abandons the decision: returned, recorded, the call interrupted", async () => {
  const opened = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "2", when: () => opened.promise }],
    steps: [{ output: analysis, gate: () => new Promise(() => {}), onCall: () => opened.resolve() }],
  });
  assert.equal(succeeded(await asking(layer)), "2");
  assert.equal(analyzed(probe.ui.notified), 0);
  assert.ok(!fs.existsSync(path.join(probe.dir, "decision-1/analysis.json")), "the analysis call was interrupted before its output");
  await abandonedRecords(probe.dir, probe.ui.said);
});

test("(b) an answer during the decision's Codex review abandons it; the analysis written is kept", async () => {
  const reviewing = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "2", when: () => reviewing.promise }],
    steps: [{ output: analysis }],
    reviews: [{ issues: [], gate: () => (reviewing.resolve(), new Promise(() => {})) }],
  });
  assert.equal(succeeded(await asking(layer)), "2");
  assert.equal(analyzed(probe.ui.notified), 0);
  assert.ok(fs.existsSync(path.join(probe.dir, "decision-1/analysis.json")), "the analysis written so far is kept");
  await abandonedRecords(probe.dir, probe.ui.said);
});

test("(c) an answer while the decision is being allocated: the allocation completes and the decision is recorded", async () => {
  const reached = signal();
  const store = (s: StoreShape): StoreShape => ({
    ...s,
    openDecision: (q) => s.openDecision(q).pipe(Effect.tap(() => Effect.promise(async () => (reached.resolve(), await sleep(100))))),
  });
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "2", when: () => reached.promise }],
    steps: [{ output: analysis, gate: () => new Promise(() => {}) }],
    store,
  });
  assert.equal(succeeded(await asking(layer)), "2");
  await abandonedRecords(probe.dir, probe.ui.said);
});

test("(d) a rejected answer, /decide and /terms during the wait: the question is presented again and the decision goes on", async () => {
  const answered = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "" }, { during: "/decide" }, { during: TERMS_REQUEST }, "2"],
    steps: [{ output: analysis, gate: () => answered.promise }],
    reviews: [{ issues: [] }],
  });
  const done = asking(layer, (a) => a !== "");
  await until(() => probe.ui.order.filter((o) => o === "during").length === 3);
  answered.resolve();
  assert.equal(succeeded(await done), "2");
  assert.equal(probe.ui.notified.filter((e) => e._tag === "AnswerRejected").length, 3);
  assert.equal(analyzed(probe.ui.notified), 1, "the decision finished with its analysis");
  assert.ok(!conversation(probe.dir).includes(prompts.decisionAbandonedLine(1)));
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, "PostgreSQL");
});

test("(d) a blank message during the wait at an interview message prompt is rejected", async () => {
  const answered = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "" }, "2"],
    steps: [{ output: analysis, gate: () => answered.promise }],
    reviews: [{ issues: [] }],
  });
  const done = Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering(byMessage((m) => ui.askMessage(m)), prompts.interviewMessagePrompt, draft, (m) => m !== "");
  }).pipe(Effect.provide(layer)));
  await until(() => probe.ui.order.includes("during"));
  answered.resolve();
  assert.equal(succeeded(await done), "2");
  assert.equal(probe.ui.notified.filter((e) => e._tag === "AnswerRejected").length, 1);
});

test("(e) q during the wait stops the run and records nothing as abandoned", async () => {
  const opened = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "q", when: () => opened.promise }],
    steps: [{ output: analysis, gate: () => new Promise(() => {}), onCall: () => opened.resolve() }],
  });
  const exit = await asking(layer);
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes("UserStopped"));
  assert.ok(!conversation(probe.dir).includes(prompts.decisionAbandonedLine(1)));
  assert.ok(!fs.existsSync(path.join(probe.dir, "decision-1/chosen.json")));
});

test("(f) no answer during the wait: the analysis, the question asked again without the offer, the choice recorded", async () => {
  const { layer, probe } = await setUp({ answers: ["/decide", "2"], steps: [{ output: analysis }], reviews: [{ issues: [] }] });
  assert.equal(succeeded(await asking(layer)), "2");
  assert.equal(analyzed(probe.ui.notified), 1);
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, "PostgreSQL");
  assert.ok(!conversation(probe.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("(g) the question open while its analysis is prepared offers neither Help me decide nor the terms", async () => {
  const opened = signal();
  const { layer, probe } = await setUp({
    answers: ["/decide", { during: "2", when: () => opened.promise }],
    steps: [{ output: analysis, gate: () => new Promise(() => {}), onCall: () => opened.resolve() }],
  });
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering(byLine((p) => ui.ask(p)), "Pick > ", draft, () => true, () => Effect.succeed(draft));
  }).pipe(Effect.provide(layer)));
  assert.equal(succeeded(exit), "2");
  assert.equal(probe.ui.order.filter((o) => o === "during").length, 1);
  const during = probe.ui.asked[1];
  const offers = prompts.offersOf(during);
  assert.ok(!offers.decide && !offers.terms, during);
  assert.ok(!promptOf(during).choices.some((c) => c.label === prompts.HELP_ME_DECIDE), during);
});
