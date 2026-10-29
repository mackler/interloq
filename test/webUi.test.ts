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
  assert.equal(await run(ui.answer(prompt, "keep it")), "taken");
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
  const fiber = Effect.runFork(ui.ask(prompts.optionOrTextPrompt));
  const prompt = await pendingPrompt(ui);
  assert.equal(await run(ui.answer(prompt, "first")), "taken");
  assert.equal(await run(ui.answer(prompt, "second")), "notWaiting");
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
  await stopped(ui.ask(prompts.optionOrTextPrompt), "q");
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
  const fiber = Effect.runFork(ui.ask(prompts.optionOrTextPrompt));
  const prompt = await pendingPrompt(ui);
  await run(Fiber.interrupt(fiber));
  assert.equal(await run(ui.pending), null);
  assert.equal(await run(ui.answer(prompt, "late")), "notWaiting");
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
  assert.equal(await run(ui.answer(prompt, "again")), "notWaiting");
});

test("of two concurrent answers to one prompt exactly one is taken", async () => {
  const { ui, events } = await withUi();
  const asking = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  const taken = await run(Effect.all([ui.answer(prompt, "one"), ui.answer(prompt, "two")], { concurrency: 2 }));
  assert.deepEqual(taken.filter((t) => t === "taken").length, 1);
  assert.equal(events.filter((e) => e._tag === "Answered").length, 1);
  await run(Fiber.join(asking));
});

// ---- Issue #185: the countdown on the server's clock, the hold and the expiry ----

const withTiming = async (limitMs: Effect.Effect<number | null>): Promise<{ ui: WebUi; events: RunEvent[] }> => {
  const events: RunEvent[] = [];
  const ui = await run(makeWebUi((e) => Effect.sync(() => void events.push(e)), { limitMs }));
  return { ui, events };
};
const question = (n: number, text: string): RunEvent extends never ? never : Parameters<WebUi["notify"]>[0] => ({
  _tag: "QuestionPresented",
  question: {
    number: n,
    origin: { kind: "planner", heading: "Planning phase 1" },
    context: [],
    history: [],
    question: [{ text, ref: "", code: false }],
    explanations: [],
    options: [],
    attached: null,
  },
} as unknown as Parameters<WebUi["notify"]>[0]);
const askedOf = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { _tag: "Asked" }> => e._tag === "Asked");

test("a counting prompt carries the wait the server times, and expires with NoAnswer naming the question", async () => {
  const limit = 60;
  const { ui, events } = await withTiming(Effect.succeed(limit));
  await run(ui.notify(question(4, "Which format?")));
  const exit = Effect.runPromiseExit(ui.ask(prompts.decisionPrompt, "extend"));
  const prompt = await pendingPrompt(ui);
  const countdown = askedOf(events)[0].countdown;
  assert.ok(countdown !== null);
  // The seam: the length the page counts down is the one the server times, from one value.
  assert.equal(countdown.untilMs - countdown.fromMs, limit);
  assert.equal(countdown.then, "extend");
  const result = await exit;
  assert.ok(Exit.isFailure(result));
  const error = result.cause.reasons.find((r) => r._tag === "Fail");
  assert.deepEqual(error?._tag === "Fail" && { ...error.error }, { _tag: "NoAnswer", where: prompts.decisionPrompt, seconds: 0, question: { number: 4, text: "Which format?" }, then: "extend" });
  assert.deepEqual(events.at(-1), { _tag: "AnswerExpired", prompt, seconds: 0, then: "extend" });
  assert.deepEqual(await run(ui.answer(prompt, "late")), { _tag: "expired", then: "extend" });
  assert.equal(await run(ui.pending), null);
});

test("an answer before the end is taken; nothing expires afterward", async () => {
  const { ui, events } = await withTiming(Effect.succeed(80));
  const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  assert.equal(await run(ui.answer(prompt, "yes")), "taken");
  assert.equal(await run(Fiber.join(fiber)), "yes");
  await sleep(150);
  assert.ok(!events.some((e) => e._tag === "AnswerExpired"));
});

test("a late timer: an answer after the deadline is refused as expired and fails the ask; a hold then is refused", async () => {
  const release = await run(Deferred.make<void>());
  let reads = 0;
  // The first read times the prompt; the timer's own read at the deadline is held back.
  const limitMs = Effect.suspend(() => (++reads === 1 ? Effect.succeed(30) : Deferred.await(release).pipe(Effect.as(30))));
  const { ui, events } = await withTiming(limitMs);
  const exit = Effect.runPromiseExit(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  await sleep(80);
  assert.equal(await run(ui.hold(prompt)), false);
  // The answer's own read of the limit is the third; it is released so the answer can see that the chain still holds.
  await run(Deferred.succeed(release, undefined));
  assert.deepEqual(await run(ui.answer(prompt, "too late")), { _tag: "expired", then: "abandon" });
  const result = await exit;
  assert.ok(Exit.isFailure(result));
  assert.ok(!events.some((e) => e._tag === "Answered"));
  assert.equal(events.filter((e) => e._tag === "AnswerExpired").length, 1);
});

test("a hold before the end stops the countdown for good; the answer is still taken", async () => {
  const { ui, events } = await withTiming(Effect.succeed(50));
  const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
  const prompt = await pendingPrompt(ui);
  assert.equal(await run(ui.hold(prompt)), true);
  assert.equal(await run(ui.hold(prompt)), false);
  assert.deepEqual(events.at(-1), { _tag: "CountdownStopped", prompt, reason: "held" });
  await sleep(120);
  assert.ok(!events.some((e) => e._tag === "AnswerExpired"));
  assert.equal(await run(ui.answer(prompt, "done")), "taken");
  assert.equal(await run(Fiber.join(fiber)), "done");
});

test("no limit at the ask: no countdown; the limit gone at the deadline: CountdownStopped(chainOff), then it waits", async () => {
  const none = await withTiming(Effect.succeed(null));
  const f1 = Effect.runFork(none.ui.ask(prompts.decisionPrompt));
  const p1 = await pendingPrompt(none.ui);
  assert.equal(askedOf(none.events)[0].countdown, null);
  assert.equal(await run(none.ui.answer(p1, "a")), "taken");
  await run(Fiber.join(f1));
  let reads = 0;
  const off = await withTiming(Effect.sync(() => (++reads === 1 ? 30 : null)));
  const f2 = Effect.runFork(off.ui.ask(prompts.decisionPrompt));
  const p2 = await pendingPrompt(off.ui);
  await sleep(100);
  assert.deepEqual(off.events.at(-1), { _tag: "CountdownStopped", prompt: p2, reason: "chainOff" });
  assert.equal(await run(off.ui.answer(p2, "b")), "taken");
  assert.equal(await run(Fiber.join(f2)), "b");
});

// Work review 1 of issue #185 (W1-R1-3): the hold carried after /decide or /terms applies only to the prompt that presents
// the same question again; a question asked in between, inside decision support or the terms request, counts down.
for (const request of ["/decide", "/terms"]) {
  test(`an answer ${request} makes only the same question presented again start held`, async () => {
    const { ui, events } = await withTiming(Effect.succeed(5_000));
    for (const [n, answer] of [[3, request], [4, "x"], [3, "y"], [5, "z"]] as const) {
      await run(ui.notify(question(n, `Question ${n}?`)));
      const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
      await run(ui.answer(await pendingPrompt(ui), answer));
      await run(Fiber.join(fiber));
    }
    assert.deepEqual(askedOf(events).map((a) => a.countdown !== null), [true, true, false, true]);
  });
}
// Work review 3 of issue #185 (W3-R1-1): the carried holds are kept per question, so a decision asked inside a decision
// keeps both: the inner question and the outer one each return held.
test("nested /decide answers: each question presented again starts held", async () => {
  const { ui, events } = await withTiming(Effect.succeed(5_000));
  for (const [n, answer] of [[3, "/decide"], [4, "/decide"], [4, "x"], [3, "y"], [5, "z"]] as const) {
    await run(ui.notify(question(n, `Question ${n}?`)));
    const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
    await run(ui.answer(await pendingPrompt(ui), answer));
    await run(Fiber.join(fiber));
  }
  assert.deepEqual(askedOf(events).map((a) => a.countdown !== null), [true, true, false, false, true]);
});
test("an answer /decide with no question presented carries nothing", async () => {
  const { ui, events } = await withTiming(Effect.succeed(5_000));
  for (const answer of ["/decide", "x"]) {
    const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
    await run(ui.answer(await pendingPrompt(ui), answer));
    await run(Fiber.join(fiber));
  }
  assert.deepEqual(askedOf(events).map((a) => a.countdown !== null), [true, true]);
});

test("an interruption during the countdown withdraws the prompt and publishes no expiry", async () => {
  const { ui, events } = await withTiming(Effect.succeed(60));
  const fiber = Effect.runFork(ui.ask(prompts.decisionPrompt));
  await pendingPrompt(ui);
  await run(Fiber.interrupt(fiber));
  await sleep(120);
  assert.equal(await run(ui.pending), null);
  assert.ok(!events.some((e) => e._tag === "AnswerExpired"));
});
