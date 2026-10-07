import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { RunError } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import type { RunEvent } from "../src/protocol.ts";
import { makeWebUi, type WebUi } from "../src/webUi.ts";

// Plan step 3.2: the web Ui turns the Ui calls into events and waits for the first answer to a prompt.
const run = Effect.runPromise;
const withUi = async (): Promise<{ ui: WebUi; events: RunEvent[] }> => {
  const events: RunEvent[] = [];
  const ui = await run(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  return { ui, events };
};
/** Waits until the Ui has a pending prompt. */
const pendingPrompt = async (ui: WebUi): Promise<number> => {
  for (let i = 0; i < 200; i++) {
    const p = await run(ui.pending);
    if (p !== null) return p.prompt;
    await sleep(2);
  }
  throw new Error("no prompt became pending");
};

test("say, notify, and a prompt with its answer become events in order", async () => {
  const { ui, events } = await withUi();
  await run(ui.say("hello"));
  await run(ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }));
  const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  assert.equal(await run(ui.answer(prompt, "keep it")), true);
  assert.equal(await run(Fiber.join(fiber)), "keep it");
  assert.deepEqual(
    events.map((e) => e._tag),
    ["Said", "Notified", "Asked", "Answered"],
  );
  const asked = events[2];
  assert.ok(asked._tag === "Asked");
  assert.equal(asked.kind, "decision");
  assert.deepEqual(events[3], { _tag: "Answered", prompt, text: "keep it" });
  assert.equal(await run(ui.pending), null);
});

test("the first answer wins; a later one is ignored", async () => {
  const { ui, events } = await withUi();
  const fiber = Effect.runFork(ui.ask(prompts.execInputPrompt));
  const prompt = await pendingPrompt(ui);
  assert.equal(await run(ui.answer(prompt, "first")), true);
  assert.equal(await run(ui.answer(prompt, "second")), false);
  assert.equal(await run(Fiber.join(fiber)), "first");
  assert.equal(events.filter((e) => e._tag === "Answered").length, 1);
});

test("q at an ask prompt and /quit at a message prompt stop the run, as src/input.ts reads them", async () => {
  const { ui } = await withUi();
  const stopped = async (effect: Effect.Effect<string, RunError>, answer: string) => {
    const fiber = Effect.runFork(effect);
    await run(ui.answer(await pendingPrompt(ui), answer));
    const exit = await run(Effect.exit(Fiber.join(fiber)));
    assert.ok(Exit.isFailure(exit) && String(exit.cause).includes("UserStopped"), `${answer} did not stop`);
  };
  await stopped(ui.ask(prompts.execInputPrompt), "q");
  await stopped(ui.askMessage(prompts.interviewMessagePrompt), "/quit");
  const fiber = Effect.runFork(ui.askMessage(prompts.interviewMessagePrompt));
  await run(ui.answer(await pendingPrompt(ui), "q"));
  assert.equal(await run(Fiber.join(fiber)), "q", "q is a message like any other");
});

test("two concurrent asks are asked one after the other and answered in order", async () => {
  const { ui, events } = await withUi();
  const first = Effect.runFork(ui.ask("first > "));
  const second = Effect.runFork(ui.ask("second > "));
  const p1 = await pendingPrompt(ui);
  await sleep(10);
  assert.equal(events.filter((e) => e._tag === "Asked").length, 1, "the second prompt was shown before the first was answered");
  await run(ui.answer(p1, "one"));
  assert.equal(await run(Fiber.join(first)), "one");
  const p2 = await pendingPrompt(ui);
  assert.notEqual(p2, p1);
  await run(ui.answer(p2, "two"));
  assert.equal(await run(Fiber.join(second)), "two");
});

test("interrupting a waiting ask clears the pending prompt, and a late answer is refused", async () => {
  const { ui } = await withUi();
  const fiber = Effect.runFork(ui.ask(prompts.execInputPrompt));
  const prompt = await pendingPrompt(ui);
  await run(Fiber.interrupt(fiber));
  assert.equal(await run(ui.pending), null);
  assert.equal(await run(ui.answer(prompt, "late")), false);
});

// Finding 11 of docs/gui-review.md (src/webUi.ts:61): an answer interrupted while Answered is being delivered is not lost.
test("an answer interrupted while Answered is in the sink still resolves the asking fiber", async () => {
  const entered = await run(Deferred.make<void>());
  const release = await run(Deferred.make<void>());
  const ui = await run(makeWebUi((e) => (e._tag === "Answered" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)));
  const asking = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  const answering = Effect.runFork(ui.answer(prompt, "the decision"));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(answering));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  const asked = await run(Fiber.await(asking).pipe(Effect.timeout("2 seconds"), Effect.exit));
  assert.ok(Exit.isSuccess(asked), "the asking fiber was stranded");
  assert.ok(Exit.isSuccess(asked.value) && asked.value.value === "the decision");
  assert.equal(await run(ui.pending), null);
  assert.equal(await run(ui.answer(prompt, "again")), false);
});

test("of two concurrent answers to one prompt exactly one is taken", async () => {
  const { ui, events } = await withUi();
  const asking = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  const taken = await run(Effect.all([ui.answer(prompt, "one"), ui.answer(prompt, "two")], { concurrency: 2 }));
  assert.deepEqual(taken.filter((t) => t).length, 1);
  assert.equal(events.filter((e) => e._tag === "Answered").length, 1);
  await run(Fiber.join(asking));
});
