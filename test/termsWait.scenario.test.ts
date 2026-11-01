// Issue #217: Explain the terms keeps the question open beside the request for its terms, as Help me decide keeps it
// beside its decision (issue #153). An answer the question accepts given during the request ends it and is the answer;
// a "/decide", a second "/terms" or a rejected answer then is rejected and the question stays open.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, type Layer } from "effect";
import { askOffering, byLine, numberedOptions, type OfferedOption, type QuestionDraft } from "../src/offer.ts";
import { TERMS_REQUEST } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import type { DecisionAnalysis } from "../src/schema.ts";
import { type Services, Store, Ui } from "../src/services.ts";
import { para, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const options: readonly OfferedOption[] = numberedOptions([
  { label: "SQLite", description: "a file" },
  { label: "PostgreSQL", description: "a server" },
]);
const draft: QuestionDraft = {
  origin: { kind: "relayed" },
  context: { blocks: para("c"), by: "agent" },
  history: [],
  explanations: [],
  question: [{ text: "Which database?", ref: "", code: false }],
  options,
  decision: null,
};
/** The draft with one explanation, referred to from its question. */
const withTerms: QuestionDraft = {
  ...draft,
  explanations: [{ id: "t1", term: "database", senses: ["where the data is kept"] }],
  question: [{ text: "Which ", ref: "", code: false }, { text: "database", ref: "t1", code: false }, { text: "?", ref: "", code: false }],
};
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
/** A request for the terms that waits on `gate`, then yields the draft with its explanation; `called` and `interrupted` observe it. */
const gatedTerms = (gate: Promise<void>) => {
  const seen = { called: false, interrupted: false };
  const request = (_question: number) =>
    Effect.callback<QuestionDraft>((resume) => {
      seen.called = true;
      void gate.then(() => resume(Effect.succeed(withTerms)));
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => (seen.interrupted = true))));
  return { seen, request };
};
const asking = (layer: Layer.Layer<Services>, request: (q: number) => Effect.Effect<QuestionDraft>, acceptable: (a: string) => boolean = () => true) =>
  Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering(byLine((p) => ui.ask(p)), "Pick > ", draft, acceptable, request);
  }).pipe(Effect.provide(layer)));
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`askOffering failed: ${String(exit.cause)}`);
  return exit.value;
};
const explainedCount = (notified: readonly { _tag: string }[]) => notified.filter((e) => e._tag === "QuestionExplained").length;

test("(a) an answer during the request is the answer: the request is interrupted and nothing about terms is recorded", async () => {
  const gate = signal();
  const { seen, request } = gatedTerms(gate.promise);
  const called = signal();
  const { layer, probe } = await setUp({ answers: [TERMS_REQUEST, { during: "2", when: async () => { await until(() => seen.called); called.resolve(); } }] });
  assert.equal(succeeded(await asking(layer, request)), "2");
  assert.ok(seen.interrupted, "the request was interrupted");
  assert.equal(explainedCount(probe.ui.notified), 0);
  assert.ok(probe.ui.said.includes(prompts.termsAbandonedLine(1)));
  const text = conversation(probe.dir);
  assert.ok(text.includes("Which database?"), "the question's record is in conversation.md");
  assert.ok(!text.includes(prompts.termsRequestedHeading(1)), "nothing about terms is recorded");
  assert.ok(!text.includes(prompts.termsAbandonedLine(1)), "the abandoned line is said on the page alone");
});

test("(b) /decide, /terms and a rejected answer during the request are rejected; the explanations follow; no offer during the wait", async () => {
  const gate = signal();
  const { request } = gatedTerms(gate.promise);
  const { layer, probe } = await setUp({ answers: [TERMS_REQUEST, { during: "" }, { during: "/decide" }, { during: TERMS_REQUEST }, "1"] });
  const done = asking(layer, request, (a) => a !== "");
  await until(() => probe.ui.order.filter((o) => o === "during").length === 3);
  gate.resolve();
  assert.equal(succeeded(await done), "1");
  const tags = probe.ui.notified.map((e) => e._tag);
  assert.equal(tags.filter((t) => t === "AnswerRejected").length, 3);
  const at = tags.indexOf("QuestionExplained");
  assert.ok(at >= 0, "QuestionExplained was notified");
  const next = probe.ui.notified[at + 1];
  assert.ok(next !== undefined && next._tag === "QuestionPresented" && next.question.number === 1 && next.question.explanations.length === 1);
  const duringPrompts = probe.ui.asked.slice(1, 4);
  for (const p of duringPrompts) {
    assert.ok(!p.includes(prompts.TERMS_OFFER_LINE), `no terms line during the wait: ${p}`);
    assert.notEqual(p, prompts.withOffer("Pick > "), "no offer during the wait");
    assert.equal(p, "Pick > ");
  }
});

test("(c) no answer during the request: it runs to its end and the question is presented again with its explanations", async () => {
  const gate = signal();
  gate.resolve();
  const { request } = gatedTerms(gate.promise);
  const { layer, probe } = await setUp({ answers: [TERMS_REQUEST, "1"] });
  assert.equal(succeeded(await asking(layer, request)), "1");
  assert.equal(explainedCount(probe.ui.notified), 1);
  const presented = probe.ui.notified.filter((e) => e._tag === "QuestionPresented");
  assert.equal(presented.length, 2);
});

test("(d) after a decision's analysis, an answer during the request is recorded as the decision's choice", async () => {
  const gate = signal();
  const { seen, request } = gatedTerms(gate.promise);
  const { layer, probe } = await setUp({
    answers: ["/decide", TERMS_REQUEST, { during: "2", when: () => until(() => seen.called) }],
    steps: [{ output: analysis }],
    reviews: [{ issues: [] }],
  });
  assert.equal(succeeded(await asking(layer, request)), "2");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(probe.dir, "decision-1/chosen.json"), "utf8")), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
});

test("(e) q during the request ends the run", async () => {
  const gate = signal();
  const { seen, request } = gatedTerms(gate.promise);
  const { layer } = await setUp({ answers: [TERMS_REQUEST, { during: "q", when: () => until(() => seen.called) }] });
  const exit = await asking(layer, request);
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /UserStopped/);
});
