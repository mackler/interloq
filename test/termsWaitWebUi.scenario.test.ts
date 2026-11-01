// Issue #217: the seam of askOffering's request for terms, the real web Ui and the page's reducer. The question stays
// open while its terms are written, through rejected answers, and the page's view holds it throughout.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { askOffering, byLine, numberedOptions, type OfferedOption, type QuestionDraft } from "../src/offer.ts";
import { TERMS_REQUEST } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import type { Asked, RunEvent } from "../src/protocol.ts";
import { Store, Ui } from "../src/services.ts";
import { makeWebUi, type WebUi } from "../src/webUi.ts";
import { emptyRun, foldEvent, type RunView } from "../web/src/state.ts";
import { para, tempRepo, testLayer } from "./helpers.ts";

const options: readonly OfferedOption[] = numberedOptions([
  { label: "SQLite", description: "a file" },
  { label: "PostgreSQL", description: "a server" },
]);
const draft: QuestionDraft = { origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, history: [], explanations: [], question: [{ text: "Which database?", ref: "", code: false }], options, decision: null };
const withTerms: QuestionDraft = {
  ...draft,
  explanations: [{ id: "t1", term: "database", senses: ["where the data is kept"] }],
  question: [{ text: "Which ", ref: "", code: false }, { text: "database", ref: "t1", code: false }, { text: "?", ref: "", code: false }],
};

type Harness = Readonly<{ ui: WebUi; events: RunEvent[]; release: () => void; fiber: Fiber.Fiber<string, unknown> }>;
const start = async (): Promise<Harness> => {
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const t = testLayer(tempRepo(), { ui });
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const terms = (_n: number) => Effect.promise(() => gate.then(() => withTerms));
  const fiber = Effect.runFork(Effect.gen(function* () {
    const u = yield* Ui;
    return yield* askOffering(byLine((p) => u.ask(p)), "Pick > ", draft, (a) => a !== "x", terms);
  }).pipe(Effect.provide(t.layer)));
  return { ui, events, release, fiber };
};
const DEADLINE_MS = 60_000;
const next = async <E extends RunEvent>(h: Harness, from: number, pred: (e: RunEvent) => e is E): Promise<E> => {
  const until = Date.now() + DEADLINE_MS;
  while (Date.now() < until) {
    const found = h.events.slice(from).find(pred);
    if (found !== undefined) return found;
    await sleep(5);
  }
  throw new Error(`no such event after ${from}: ${h.events.slice(from).map((e) => e._tag).join(", ")}`);
};
const isAsked = (e: RunEvent): e is Asked => e._tag === "Asked";
const isFrame = (e: RunEvent): e is Asked => e._tag === "Asked" && e.deciding === 1;
const isForeground = (e: RunEvent): e is Asked => e._tag === "Asked" && e.deciding === null;
const answer = (h: Harness, prompt: number, text: string) => Effect.runPromise(h.ui.answer(prompt, text));
const result = async (h: Harness): Promise<string> => {
  const exit = await Effect.runPromise(Fiber.await(h.fiber));
  if (!Exit.isSuccess(exit)) throw new Error(`askOffering failed: ${String(exit.cause)}`);
  return exit.value;
};
/** The page's view after each event, folded by the page's reducer. */
const views = (events: readonly RunEvent[]): RunView[] => {
  const out: RunView[] = [];
  events.reduce((run, event) => {
    const after = foldEvent(run, { time: "2026-11-01T00:00:00.000Z", event });
    out.push(after);
    return after;
  }, emptyRun(1));
  return out;
};
const sends = (a: Asked) => a.choices.map((c) => c.sends);

test("(a) the question stays open while its terms are written, through rejections, and is explained", async () => {
  const h = await start();
  const first = await next(h, 0, isAsked);
  assert.ok(sends(first).includes(TERMS_REQUEST));
  await answer(h, first.prompt, TERMS_REQUEST);
  const frame = await next(h, 0, isFrame);
  assert.ok(!sends(frame).includes(TERMS_REQUEST) && !sends(frame).includes("/decide"));
  assert.equal((await Effect.runPromise(h.ui.pending))?.prompt, frame.prompt);
  await answer(h, frame.prompt, "/decide");
  const reopened = await next(h, h.events.indexOf(frame) + 1, isFrame);
  await answer(h, reopened.prompt, "x");
  const third = await next(h, h.events.indexOf(reopened) + 1, isFrame);
  assert.equal(h.events.filter((e) => e._tag === "Notified" && e.event._tag === "AnswerRejected").length, 2);
  h.release();
  const explained = await next(h, h.events.indexOf(third) + 1, isForeground);
  const tags = h.events.slice(h.events.indexOf(third) + 1).map((e) => (e._tag === "Notified" ? e.event._tag : e._tag));
  assert.deepEqual(tags, ["PromptWithdrawn", "QuestionExplained", "QuestionPresented", "Asked"]);
  await answer(h, explained.prompt, "1");
  assert.equal(await result(h), "1");
  const firstAt = h.events.indexOf(first);
  const finalAnswer = h.events.findIndex((e) => e._tag === "Answered" && e.prompt === explained.prompt);
  const seen = views(h.events);
  for (let i = firstAt; i < finalAnswer; i++) {
    assert.ok(seen[i].pending !== null, `the question is pending after ${h.events[i]._tag} (${i})`);
    assert.equal(seen[i].pending?.question?.number, 1);
  }
  assert.equal(seen[finalAnswer].pending, null);
  assert.equal(seen[finalAnswer - 1].pending?.question?.explanations.length, 1);
});

test("(b) an answer during the wait is the answer: closed by PromptClosed, never explained", async () => {
  const h = await start();
  const first = await next(h, 0, isAsked);
  await answer(h, first.prompt, TERMS_REQUEST);
  const frame = await next(h, 0, isFrame);
  await answer(h, frame.prompt, "2");
  assert.equal(await result(h), "2");
  assert.ok(!h.events.some((e) => e._tag === "Notified" && e.event._tag === "QuestionExplained"));
  const said = h.events.findIndex((e) => e._tag === "Said" && e.text === prompts.termsAbandonedLine(1));
  const closed = h.events.findIndex((e) => e._tag === "PromptClosed" && e.prompt === frame.prompt);
  assert.ok(said >= 0 && closed > said, h.events.map((e) => e._tag).join(", "));
  const seen = views(h.events);
  for (let i = h.events.indexOf(first); i < closed; i++) assert.equal(seen[i].pending?.question?.number, 1, `pending after ${h.events[i]._tag}`);
  assert.equal(seen[closed].pending, null);
});
