import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import type { RunError } from "../src/errors.ts";
import { ScriptedUi } from "./helpers.ts";

// Finding 31 of docs/functional-design-review.md: the scripted Ui treated "q" as quit in askMessage, while the
// live interface ends the run on "/quit" only; the doubles must share the command parsing of src/input.ts.
test("ScriptedUi.askMessage returns q as a message and fails with UserStopped on /quit, as src/input.ts reads them", async () => {
  const ui = new ScriptedUi(["q", "/quit"]);
  assert.equal(await Effect.runPromise(ui.askMessage("You > ")), "q");
  await assert.rejects(Effect.runPromise(ui.askMessage("You > ")), (e: unknown) => (e as RunError)._tag === "UserStopped");
});

test("ScriptedUi.ask fails with UserStopped on q and returns /quit as an answer, as src/input.ts reads them", async () => {
  const ui = new ScriptedUi(["/quit", "q"]);
  assert.equal(await Effect.runPromise(ui.ask("Decision > ")), "/quit");
  await assert.rejects(Effect.runPromise(ui.ask("Decision > ")), (e: unknown) => (e as RunError)._tag === "UserStopped");
});

test("a waiting answer is a typed script step, not a magic string", async () => {
  const ui = new ScriptedUi([{ wait: true }, "<wait>"]);
  const asked = ui.nextAsk();
  const fiber = Effect.runFork(ui.ask("Decision > "));
  await asked;
  assert.equal(ui.asked.length, 1);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(await Effect.runPromise(ui.ask("Decision > ")), "<wait>");
});

test("ScriptedUi records the notified events in order", async () => {
  const ui = new ScriptedUi([]);
  await Effect.runPromise(Effect.andThen(ui.notify({ _tag: "PhaseBegan", phase: { kind: "questions" } }), ui.notify({ _tag: "AgentCallEnded", agent: "codex", ok: true, callId: "codex-1" })));
  assert.deepEqual(ui.notified.map((e) => e._tag), ["PhaseBegan", "AgentCallEnded"]);
});

// Issue #243: a beside question takes only a `beside` answer from the head of the script, calling onTaken first.
test("ScriptedUi.askBeside takes a beside answer at the head, calls onTaken, and never takes an answer scripted for ask", async () => {
  const taken: string[] = [];
  const onTaken = (t: string) => Effect.sync(() => { taken.push(t); return "kept" as const; });
  const ui = new ScriptedUi([{ beside: "p" }, "1"]);
  const text = await Effect.runPromise(Effect.scoped(Effect.flatMap(ui.enterQuestion(1), (h) => h.askBeside("limit", "line", onTaken))));
  assert.equal(text, "p");
  assert.deepEqual(taken, ["p"]);
  assert.ok(ui.order.includes("beside"));
  // The head is now an ordinary answer: the beside question stays unanswered and the ask takes it.
  const open = Effect.runFork(Effect.scoped(Effect.flatMap(ui.enterQuestion(2), (h) => h.askBeside("limit", "line", onTaken))));
  assert.equal(await Effect.runPromise(ui.ask("q?")), "1");
  await Effect.runPromise(Fiber.interrupt(open));
  assert.deepEqual(taken, ["p"]);
  const quit = new ScriptedUi([{ beside: "q" }]);
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.flatMap(quit.enterQuestion(1), (h) => h.askBeside("limit", "line", onTaken))));
  assert.ok(exit._tag === "Failure" && JSON.stringify(exit.cause).includes("UserStopped"));
  const wrong = new ScriptedUi([{ beside: "p" }]);
  await assert.rejects(Effect.runPromise(wrong.ask("q?")), /beside the run/);
  const during = new ScriptedUi([{ during: "2" }]);
  const d = await Effect.runPromise(Effect.scoped(Effect.flatMap(during.enterQuestion(1), (h) => h.askDuring("d", "line", Effect.never, onTaken))));
  assert.deepEqual(d, { _tag: "Answered", text: "2" });
  assert.deepEqual(taken, ["p", "q", "2"]);
});
