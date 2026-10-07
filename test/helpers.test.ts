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
  await Effect.runPromise(Effect.andThen(ui.notify({ _tag: "PhaseBegan", phase: { kind: "questions" } }), ui.notify({ _tag: "AgentCallEnded", agent: "codex", ok: true })));
  assert.deepEqual(ui.notified.map((e) => e._tag), ["PhaseBegan", "AgentCallEnded"]);
});
