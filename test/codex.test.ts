import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { ThreadEvent, TurnOptions } from "@openai/codex-sdk";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { makeCodexReviewer } from "../src/codex.ts";
import { describe, type RunError } from "../src/errors.ts";
import type { AgentSdk } from "../src/sdk.ts";
import { agentJsonSchema } from "../src/jsonSchema.ts";
import * as S from "../src/schema.ts";
import { type ReviewerShape, RunConfig, Sdk, Store, Ui } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { command, FakeSdk, fileChange, turn, turnFailed, type TurnAnswer, webSearch } from "./fakeSdk.ts";
import { ScriptedUi, tempRepo } from "./helpers.ts";

const run = Effect.runPromise;

/** A Codex reviewer over a fake SDK and a store on a temporary repository. */
const reviewer = async (turns: TurnAnswer[], config: Partial<typeof S.Config.Type> = {}): Promise<{ reviewer: ReviewerShape; sdk: FakeSdk; ui: ScriptedUi; dir: string; project: string }> => {
  const store = await run(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  const sdk = new FakeSdk([], turns);
  const ui = new ScriptedUi([]);
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, { ...S.defaultConfig, ...config }));
  return { reviewer: await run(makeCodexReviewer.pipe(Effect.provide(deps))), sdk, ui, dir: store.dir, project: store.project };
};

const tag = (e: unknown): string => (e as RunError)._tag;

test("startPhase starts a thread with danger-full-access, approval never, the project as working directory", async () => {
  const fake = await reviewer([]);
  await run(fake.reviewer.startPhase);
  assert.equal(fake.sdk.threads.length, 1);
  assert.deepEqual(fake.sdk.threads[0].options, {
    workingDirectory: fake.project,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
  });
});

test("the configured model is passed, and no model key is set when codexModel is null", async () => {
  const withModel = await reviewer([], { codexModel: "gpt-x" });
  await run(withModel.reviewer.startPhase);
  assert.equal(withModel.sdk.threads[0].options?.model, "gpt-x");

  const without = await reviewer([]);
  await run(without.reviewer.startPhase);
  assert.ok(!("model" in (without.sdk.threads[0].options ?? {})), "model must be absent when codexModel is null");
});

test("review passes agentJsonSchema(Review) as outputSchema and records usage", async () => {
  const fake = await reviewer([turn(JSON.stringify({ issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }))]);
  const session = await run(fake.reviewer.startPhase);
  const text = await run(session.review("review the plan"));

  assert.deepEqual(JSON.parse(text).issues.map((i: { id: string }) => i.id), ["A"]);
  assert.deepEqual(fake.sdk.threads[0].calls[0].turnOptions?.outputSchema, agentJsonSchema(S.Review));
  assert.equal(fake.sdk.threads[0].calls[0].input, "review the plan");
  const usage = JSON.parse(fs.readFileSync(path.join(fake.dir, "usage.jsonl"), "utf8").trim());
  assert.equal(usage.agent, "codex");
  assert.equal(usage.version, 2);
  assert.equal(usage.thread, "thread-1");
  assert.deepEqual([usage.input_tokens, usage.output_tokens], [10, 5]);
});

test("a failed turn fails with CodexCallFailed", async () => {
  const fake = await reviewer([new Error("the model is overloaded")]);
  const session = await run(fake.reviewer.startPhase);
  await assert.rejects(run(session.review("review the plan")), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("the reviewer returns a reply without an issues array unchanged to the caller", async () => {
  const fake = await reviewer([turn(JSON.stringify({ findings: [] }))]);
  const session = await run(fake.reviewer.startPhase);
  assert.equal(await run(session.review("review the plan")), JSON.stringify({ findings: [] }));
});

// Finding 11 / recommendation C: the session is a value bound to its thread, not a nullable Ref in the adapter.
test("each startPhase returns a session bound to its own thread, and calls do not cross", async () => {
  const empty = JSON.stringify({ issues: [] });
  const fake = await reviewer([turn(empty), turn(empty), turn(empty)]);
  const first = await run(fake.reviewer.startPhase);
  const second = await run(fake.reviewer.startPhase);
  await run(second.review("second phase"));
  await run(first.review("first phase"));
  await run(first.review("first phase again"));

  assert.equal(fake.sdk.threads.length, 2);
  assert.deepEqual(fake.sdk.threads[0].calls.map((c) => c.input), ["first phase", "first phase again"]);
  assert.deepEqual(fake.sdk.threads[1].calls.map((c) => c.input), ["second phase"]);
});

// Finding 11 of docs/functional-design-review.md: startup failures were defects, not typed errors.
const typedFailure = async <E>(effect: Effect.Effect<unknown, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  return error.value;
};

test("a startThread that throws makes startPhase fail with CodexCallFailed, not a defect", async () => {
  const store = await run(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  const fake = new FakeSdk();
  const sdk: AgentSdk = { inheritedEnv: fake.inheritedEnv, query: (params) => fake.query(params), stepReporter: (handler) => fake.stepReporter(handler), startThread: () => { throw new Error("spawn codex ENOENT"); } };
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig));
  const codex = await run(makeCodexReviewer.pipe(Effect.provide(deps)));
  const error = await typedFailure(codex.startPhase);
  assert.equal(error._tag, "CodexCallFailed");
  assert.match(describe(error), /spawn codex ENOENT/);
});

test("interrupting a review aborts the Codex turn and returns the event generator", async () => {
  let sawAbort = false;
  let returned = false;
  const waitForAbort = (options: TurnOptions | undefined): AsyncGenerator<ThreadEvent> =>
    (async function* () {
      try {
        yield { type: "turn.started" } as ThreadEvent;
        await new Promise<never>((_, reject) => {
          const signal = options?.signal;
          if (signal === undefined) return reject(new Error("the turn has no abort signal"));
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("The operation was aborted"));
          });
        });
      } finally {
        returned = true;
      }
    })();
  const fake = await reviewer([waitForAbort]);
  const session = await run(fake.reviewer.startPhase);
  const reached = fake.sdk.nextCall();
  const fiber = Effect.runFork(session.review("review the plan"));
  await reached;
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.equal(sawAbort, true, "the Codex turn was not aborted");
  assert.equal(returned, true, "the event generator was not closed");
  assert.deepEqual(fake.ui.notified.at(-1), { _tag: "AgentCallEnded", agent: "codex", ok: false });
});

// Plan step 1.8: the turn is streamed, so the activity line can show Codex's tool use.
test("a streamed turn notifies its start, one tool use per item, and its end, in order", async () => {
  const events = [...command("c1", "git diff"), ...fileChange("f1", "a.ts", "b.ts"), ...webSearch("w1", "effect v4")];
  const fake = await reviewer([turn(JSON.stringify({ issues: [] }), undefined, events)]);
  const session = await run(fake.reviewer.startPhase);
  await run(session.review("review"));
  assert.deepEqual(fake.ui.notified, [
    { _tag: "AgentCallStarted", agent: "codex", purpose: "review" },
    { _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff" },
    { _tag: "ToolUsed", agent: "codex", tool: "edit", target: "a.ts, b.ts" },
    { _tag: "ToolUsed", agent: "codex", tool: "search", target: "effect v4" },
    { _tag: "AgentCallEnded", agent: "codex", ok: true },
  ]);
});

test("the final response is the text of the last agent message", async () => {
  const earlier = [{ type: "item.completed", item: { id: "m0", type: "agent_message", text: "thinking" } }] as ThreadEvent[];
  const fake = await reviewer([turn("final", undefined, earlier)]);
  const session = await run(fake.reviewer.startPhase);
  assert.equal(await run(session.review("review")), "final");
});

test("turn.failed, a stream error event, and a turn without an agent message fail with CodexCallFailed", async () => {
  const noReply = [{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }] as ThreadEvent[];
  const streamError = [{ type: "error", message: "stream lost" }] as ThreadEvent[];
  for (const [events, text] of [[turnFailed("rate limited"), /rate limited/], [streamError, /stream lost/], [noReply, /no reply/]] as const) {
    const fake = await reviewer([[...events]]);
    const session = await run(fake.reviewer.startPhase);
    const error = await typedFailure(session.review("review"));
    assert.equal(error._tag, "CodexCallFailed");
    assert.match(describe(error as RunError), text);
    assert.deepEqual(fake.ui.notified.at(-1), { _tag: "AgentCallEnded", agent: "codex", ok: false });
  }
});

// Issue #26: Codex's error events are notices; a failure is TransportFault when src/transport.ts says so.
const reconnecting = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";
const errorEvent = (message: string): ThreadEvent => ({ type: "error", message }) as ThreadEvent;

test("an error notice followed by a completed turn succeeds, and the notice is notified as AgentReconnecting", async () => {
  const empty = JSON.stringify({ issues: [] });
  const fake = await reviewer([turn(empty, undefined, [errorEvent(reconnecting)])]);
  const session = await run(fake.reviewer.startPhase);
  assert.equal(await run(session.review("review")), empty);
  assert.deepEqual(
    fake.ui.notified.filter((e) => e._tag === "AgentReconnecting"),
    [{ _tag: "AgentReconnecting", agent: "codex", by: "sdk", attempt: null, of: null, delayMs: null, detail: reconnecting }],
  );
});

test("a notice followed by turn.failed with a stream-disconnected message is TransportFault", async () => {
  const fake = await reviewer([[errorEvent(reconnecting), ...turnFailed("stream disconnected before completion")]]);
  const session = await run(fake.reviewer.startPhase);
  await assert.rejects(run(session.review("review")), (e: unknown) => (e as { _tag: string; agent: string })._tag === "TransportFault" && (e as { agent: string }).agent === "codex");
});

test("turn.failed with a usage limit is CodexCallFailed", async () => {
  const fake = await reviewer([turnFailed("You've hit your usage limit.")]);
  const session = await run(fake.reviewer.startPhase);
  await assert.rejects(run(session.review("review")), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("a rejected runStreamed with ECONNRESET is TransportFault", async () => {
  const fake = await reviewer([new Error("read ECONNRESET")]);
  const session = await run(fake.reviewer.startPhase);
  await assert.rejects(run(session.review("review")), (e: unknown) => (e as { _tag: string })._tag === "TransportFault");
});

// W1-R1-2: the thrown value's network code is classified, not only its text.
import { rejecting } from "./fakeSdk.ts";
const failureOf = async (answer: Parameters<typeof reviewer>[0][number]) => {
  const fake = await reviewer([answer]);
  const session = await run(fake.reviewer.startPhase);
  return typedFailure(session.review("review"));
};

test("a stream that rejects with a bare { code: ECONNRESET } is TransportFault, and its message names the code", async () => {
  const error = await failureOf(rejecting({ code: "ECONNRESET" }));
  assert.equal(error._tag, "TransportFault");
  assert.match((error as { message: string }).message, /ECONNRESET/);
  assert.doesNotMatch((error as { message: string }).message, /object Object/);
});

test("runStreamed rejecting with an Error whose message omits its ETIMEDOUT code is TransportFault", async () => {
  assert.equal((await failureOf(Object.assign(new Error("socket closed"), { code: "ETIMEDOUT" })))._tag, "TransportFault");
});

test("a rejection with { code: ENOENT } is CodexCallFailed", async () => {
  assert.equal((await failureOf(rejecting({ code: "ENOENT" })))._tag, "CodexCallFailed");
});
