// Issue #131: the Ui of an unattended preparation, which no one answers: every question fails at once with NoAnswer
// that ends the preparation, never one that extends a review's limit, naming the question last presented.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { NoAnswer } from "../src/errors.ts";
import { unattendedUi } from "../src/preparationUi.ts";
import type { PresentedQuestion } from "../src/question.ts";

const presented = (number: number, text: string): PresentedQuestion => ({
  number,
  origin: { kind: "roundLimit", subject: "questions", rounds: 3 } as never,
  context: { kind: "agent", blocks: [] } as never,
  history: [],
  explanations: [],
  question: [{ text, ref: "", code: false }],
  options: [],
  attached: null,
  decision: null,
});
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

test("ask fails at once with NoAnswer ending the preparation, naming the last question presented", async () => {
  const { ui, lastQuestion } = await run(unattendedUi);
  assert.equal(await run(lastQuestion), null);
  await run(ui.notify({ _tag: "QuestionPresented", question: presented(1, "Raise the limit?") }));
  const exit = await Effect.runPromiseExit(ui.ask("Raise the limit?\nmore", "extend"));
  assert.ok(Exit.isFailure(exit));
  const error = await run(Effect.flip(ui.ask("Raise the limit?\nmore", "extend")));
  assert.ok(error instanceof NoAnswer);
  assert.deepEqual([error.where, error.seconds, error.question, error.then], ["Raise the limit?", 0, { number: 1, text: "Raise the limit?" }, "abandon"]);
  assert.deepEqual(await run(lastQuestion), { number: 1, text: "Raise the limit?" });
});

test("askMessage fails alike; nextQuestion counts from 1; askDuring runs the work and returns Done", async () => {
  const { ui } = await run(unattendedUi);
  const error = await run(Effect.flip(ui.askMessage("Your reply")));
  assert.ok(error instanceof NoAnswer && error.then === "abandon" && error.question === null);
  assert.deepEqual([await run(ui.nextQuestion), await run(ui.nextQuestion)], [1, 2]);
  const done = await run(Effect.scoped(Effect.flatMap(ui.enterQuestion(1), (frame) => frame.askDuring("p", "line", Effect.succeed(7)))));
  assert.deepEqual(done, { _tag: "Done", value: 7 });
});
