// Issue #153 (requirements Q1, G-R1-1): the seam of askOffering, the decision loop and the real web Ui. The question
// stays open while its analysis is prepared; a question the decision loop asks takes its place, and it returns, the same
// prompt again, once that question's whole asking has ended.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { askOffering, byLine, numberedOptions, type OfferedOption, type QuestionDraft } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import type { Asked, RunEvent } from "../src/protocol.ts";
import type { DecisionAnalysis } from "../src/schema.ts";
import { Store, type StoreShape, Ui } from "../src/services.ts";
import { makeWebUi, type WebUi } from "../src/webUi.ts";
import { issue, para, plain, respond, tempRepo, testLayer, type TestOptions } from "./helpers.ts";
import type { UiEvent } from "../src/uiEvents.ts";

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
const response = (disposition: "rejected" | "accepted") => ({ ...respond([["D1-R1-1", disposition]]), analysis });
const never = () => new Promise<void>(() => {});

type Harness = Readonly<{ ui: WebUi; events: RunEvent[]; dir: string; fiber: Fiber.Fiber<string, unknown> }>;
const start = async (opts: TestOptions): Promise<Harness> => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const t = testLayer(tempRepo(), { ...opts, ui });
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  const fiber = Effect.runFork(Effect.gen(function* () {
    const u = yield* Ui;
    return yield* askOffering(byLine((p) => u.ask(p)), "Pick > ", draft);
  }).pipe(Effect.provide(t.layer)));
  return { ui, events, dir: t.probe.dir, fiber };
};
const askeds = (h: Harness): Asked[] => h.events.flatMap((e) => (e._tag === "Asked" ? [e] : []));
/**
 * How long `next` waits for an event. A deadline in time, not a count of polls: a count of polls shrinks under the load
 * of the parallel `npm test` while the decision loop it waits for slows down (issue #200's suite run 2, where test 2
 * gave up after 13 s). A found event returns at once, so this bounds only a loop that is stuck.
 */
const NEXT_DEADLINE_MS = 60_000;
/** Resolves with the first event at or after `from` that satisfies the predicate. */
const next = async <E extends RunEvent>(h: Harness, from: number, pred: (e: RunEvent) => e is E): Promise<E> => {
  const began = Date.now();
  const until = began + NEXT_DEADLINE_MS;
  while (Date.now() < until) {
    const found = h.events.slice(from).find(pred);
    if (found !== undefined) return found;
    await sleep(5);
  }
  throw new Error(`no such event after ${from} in ${Date.now() - began} ms: ${h.events.slice(from).map((e) => e._tag).join(", ")}`);
};
const isFrame = (question: number) => (e: RunEvent): e is Asked => e._tag === "Asked" && e.deciding === question;
/** The Ui event a Notified frame carries, of the given tag. */
const ui = <T extends UiEvent["_tag"]>(tag: T) => (e: RunEvent): e is Extract<RunEvent, { _tag: "Notified" }> & { event: Extract<UiEvent, { _tag: T }> } =>
  e._tag === "Notified" && e.event._tag === tag;
const isForeground = (e: RunEvent): e is Asked => e._tag === "Asked" && e.deciding === null;
const answer = (h: Harness, prompt: number, text: string) => Effect.runPromise(h.ui.answer(prompt, text));
const result = async (h: Harness): Promise<string> => {
  const exit = await Effect.runPromise(Fiber.await(h.fiber));
  if (!Exit.isSuccess(exit)) throw new Error(`askOffering failed: ${String(exit.cause)}`);
  return exit.value;
};
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const chosen = (dir: string, k: number) => JSON.parse(fs.readFileSync(path.join(dir, `decision-${k}/chosen.json`), "utf8"));
/** Answers the first prompt Help me decide and returns the frame's Asked of question 1. */
const decide = async (h: Harness): Promise<Asked> => {
  const first = await next(h, 0, isForeground);
  assert.equal(await answer(h, first.prompt, "/decide"), "taken");
  return next(h, 0, isFrame(1));
};

test("1. an answer to the question open while its analysis is prepared abandons the decision", async () => {
  const h = await start({ steps: [{ output: analysis, gate: never }] });
  const frame = await decide(h);
  // The decision is allocated (its progress said) before the answer, so it has records to abandon.
  await next(h, 0, ui("AnalysisProgress"));
  assert.ok(!frame.choices.some((c) => c.label === prompts.HELP_ME_DECIDE), "no Help me decide while the analysis is prepared");
  assert.equal(frame.countdown, null);
  assert.equal(await answer(h, frame.prompt, "2"), "taken");
  assert.equal(await result(h), "2");
  assert.ok(!h.events.some(ui("DecisionAnalyzed")));
  assert.deepEqual(chosen(h.dir, 1), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
  assert.ok(conversation(h.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("2. G-R1-1: the decision's cycle limit takes the question's place; the question returns, the same prompt, after it", async () => {
  const h = await start({
    config: { maxRounds: 1 },
    steps: [{ output: analysis }, { output: response("rejected") }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [], gate: never }],
  });
  const frame = await decide(h);
  const limitAt = h.events.indexOf(frame);
  const limit = await next(h, limitAt, isForeground);
  assert.equal(await answer(h, frame.prompt, "2"), "notWaiting", "the question is not answerable while the cycle limit is shown");
  const before = askeds(h).filter(isFrame(1)).length;
  assert.equal(await answer(h, limit.prompt, "1"), "taken");
  const again = await next(h, h.events.indexOf(limit) + 1, isFrame(1));
  assert.equal(again.prompt, frame.prompt, "the same prompt is published again");
  assert.equal(askeds(h).filter(isFrame(1)).length, before + 1);
  assert.equal(await answer(h, frame.prompt, "2"), "taken");
  assert.equal(await result(h), "2");
  assert.ok(conversation(h.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("3. Help me decide on the cycle limit: the question beneath stays hidden through the nested decision and its abandonment", async () => {
  const allocating: { reached: () => void; release: () => void } = { reached: () => {}, release: () => {} };
  const reached = new Promise<void>((r) => (allocating.reached = r));
  const released = new Promise<void>((r) => (allocating.release = r));
  let opened = 0;
  const store = (s: StoreShape): StoreShape => ({
    ...s,
    openDecision: (q) => s.openDecision(q).pipe(Effect.tap(() => (++opened === 2 ? Effect.promise(async () => (allocating.reached(), await released)) : Effect.void))),
  });
  const h = await start({
    config: { maxRounds: 1 },
    store,
    steps: [{ output: analysis }, { output: response("rejected") }, { output: analysis, gate: never }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [], gate: never }],
  });
  const outer = await decide(h);
  const limit = await next(h, h.events.indexOf(outer), isForeground);
  const outerCount = () => askeds(h).filter(isFrame(1)).length;
  const count = outerCount();
  assert.equal(await answer(h, limit.prompt, "/decide"), "taken");
  await reached;
  assert.equal(outerCount(), count, "no outer Asked between the foreground /decide and the inner frame");
  assert.equal(await answer(h, outer.prompt, "2"), "notWaiting");
  allocating.release();
  const limitQuestion = h.events.flatMap((e) => (ui("QuestionPresented")(e) ? [e.event.question.number] : [])).at(-1) ?? 0;
  const inner = await next(h, h.events.indexOf(limit), isFrame(limitQuestion));
  assert.equal(await answer(h, outer.prompt, "2"), "notWaiting", "the outer stays hidden while the inner is prepared");
  assert.equal(outerCount(), count);
  assert.equal(await answer(h, inner.prompt, "1"), "taken");
  const again = await next(h, h.events.indexOf(inner) + 1, isFrame(1));
  assert.equal(again.prompt, outer.prompt);
  // The inner abandonment was recorded before the outer question returned.
  const saidAt = h.events.findIndex((e) => e._tag === "Said" && e.text === prompts.decisionAbandonedLine(2));
  // The frame republishes the same Asked object, so its last occurrence is the one published again.
  assert.ok(saidAt >= 0 && saidAt < h.events.lastIndexOf(again), "the inner abandonment is said before the outer question returns");
  assert.deepEqual(chosen(h.dir, 2).answer, "1");
  assert.equal(await answer(h, outer.prompt, "2"), "taken");
  assert.equal(await result(h), "2");
  assert.ok(conversation(h.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("3a. a rejected answer at the decision's unchanged pause: no outer Asked in between, and the outer returns after Proceed", async () => {
  const h = await start({
    steps: [{ output: analysis }, { output: response("accepted") }, { output: response("accepted") }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [], gate: never }],
  });
  const outer = await decide(h);
  const pause = await next(h, h.events.indexOf(outer), isForeground);
  assert.equal(pause.kind, "unchanged");
  const count = askeds(h).filter(isFrame(1)).length;
  assert.equal(await answer(h, pause.prompt, "nonsense"), "taken");
  const askedAgain = await next(h, h.events.indexOf(pause) + 1, (e): e is Asked => isForeground(e) && e.prompt !== pause.prompt);
  const between = h.events.slice(h.events.indexOf(pause), h.events.indexOf(askedAgain));
  assert.ok(between.some(ui("AnswerRejected")));
  assert.equal(askeds(h).filter(isFrame(1)).length, count, "no outer Asked between the rejected answer and the pause asked again");
  assert.equal(await answer(h, outer.prompt, "2"), "notWaiting");
  assert.equal(await answer(h, askedAgain.prompt, "proceed"), "taken");
  const again = await next(h, h.events.indexOf(askedAgain) + 1, isFrame(1));
  assert.equal(again.prompt, outer.prompt);
  assert.equal(await answer(h, outer.prompt, "2"), "taken");
  assert.equal(await result(h), "2");
});

test("4. the analysis finishes first: PromptWithdrawn before DecisionAnalyzed, and the question asked again answers normally", async () => {
  const h = await start({ steps: [{ output: analysis }], reviews: [{ issues: [] }] });
  const frame = await decide(h);
  const analyzed = await next(h, 0, ui("DecisionAnalyzed"));
  const withdrawn = h.events.findIndex((e) => e._tag === "PromptWithdrawn" && e.prompt === frame.prompt);
  assert.ok(withdrawn >= 0 && withdrawn < h.events.indexOf(analyzed));
  assert.equal(await answer(h, frame.prompt, "2"), "notWaiting");
  const asked = await next(h, h.events.indexOf(analyzed), isForeground);
  assert.equal(await answer(h, asked.prompt, "2"), "taken");
  assert.equal(await result(h), "2");
  assert.equal(chosen(h.dir, 1).option, "PostgreSQL");
  assert.ok(!conversation(h.dir).includes(prompts.decisionAbandonedLine(1)));
});

test("5. Stop task during the wait records no abandonment", async () => {
  const h = await start({ steps: [{ output: analysis, gate: never }] });
  await decide(h);
  await Effect.runPromise(Fiber.interrupt(h.fiber));
  assert.ok(!conversation(h.dir).includes(prompts.decisionAbandonedLine(1)));
  assert.ok(!fs.existsSync(path.join(h.dir, "decision-1/chosen.json")));
});
