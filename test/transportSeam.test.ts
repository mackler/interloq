import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { makeClaudePlanner } from "../src/claude.ts";
import { makeCodexReviewer } from "../src/codex.ts";
import { platformLayer } from "../src/platform.ts";
import * as S from "../src/schema.ts";
import { Decider, RunConfig, Sdk, Store, Ui } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { NETWORK_CODES } from "../src/transport.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FakeSdk, init, messages, rejecting, type Script } from "./fakeSdk.ts";
import { noDecider, ScriptedUi, tempRepo , TEST_ROOT } from "./helpers.ts";

// W1-R1-2: the two adapters read a thrown value's code the same way. Every network code of src/transport.ts, thrown
// without it in the message, makes a Codex turn and a Claude Code planning call fail alike with TransportFault.
/** Issue #201: the failure's tag and its network code, where it carries one. */
const faultOf = (effect: Effect.Effect<unknown, unknown>): Promise<{ tag: string; networkCode: unknown }> =>
  Effect.runPromise(Effect.result(effect)).then((r) =>
    r._tag === "Failure" ? { tag: (r.failure as { _tag: string })._tag, networkCode: (r.failure as { networkCode?: unknown }).networkCode ?? null } : { tag: "success", networkCode: null },
  );

const setUp = async (sdk: FakeSdk) => {
  const store = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  return Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig));
};

for (const code of NETWORK_CODES) {
  test(`${code} without its name in the message is a TransportFault for both agents`, async () => {
    const thrown = { code, message: "the connection failed" };
    const codexSdk = new FakeSdk([], [rejecting(thrown)]);
    const codex = await Effect.runPromise(makeCodexReviewer.pipe(Effect.provide(await setUp(codexSdk))));
    const session = await Effect.runPromise(codex.startPhase);
    const script: Script = () => (async function* () {
      yield init();
      throw thrown;
    })();
    const claudeSdk = new FakeSdk([script]);
    const claude = await Effect.runPromise(makeClaudePlanner.pipe(Effect.provide(await setUp(claudeSdk))));
    const [codexFault, claudeFault] = [await faultOf(session.review("review", S.Review)), await faultOf(claude.planning("plan", S.PlanWriteResult).pipe(Effect.provideService(Decider, noDecider)))];
    // Issue #201: both adapters carry the code thrown as the fault's network code.
    assert.deepEqual([codexFault, claudeFault], [{ tag: "TransportFault", networkCode: code }, { tag: "TransportFault", networkCode: code }]);
  });
}

// Issue #201: a network code named only in a text is the fault's network code.
const planningFault = async (script: Script) => {
  const claude = await Effect.runPromise(makeClaudePlanner.pipe(Effect.provide(await setUp(new FakeSdk([script])))));
  return faultOf(claude.planning("plan", S.PlanWriteResult).pipe(Effect.provideService(Decider, noDecider)));
};

test("an error result naming EAI_AGAIN (the incident of 30 Oct 2026) fails a planning call with TransportFault carrying the code", async () => {
  const result = { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)", total_cost_usd: 0, num_turns: 1 } as unknown as SDKMessage;
  assert.deepEqual(await planningFault(messages(init(), result)), { tag: "TransportFault", networkCode: "EAI_AGAIN" });
});

test("a stream thrown with ENETUNREACH in its message and no code fails a planning call with TransportFault carrying the code", async () => {
  const script: Script = () => (async function* () {
    yield init();
    throw new Error("connect ENETUNREACH");
  })();
  assert.deepEqual(await planningFault(script), { tag: "TransportFault", networkCode: "ENETUNREACH" });
});

test("a Codex turn thrown with ENOTFOUND in its message and no code fails with TransportFault carrying the code", async () => {
  const codex = await Effect.runPromise(makeCodexReviewer.pipe(Effect.provide(await setUp(new FakeSdk([], [rejecting(new Error("getaddrinfo ENOTFOUND api.openai.com"))])))));
  const session = await Effect.runPromise(codex.startPhase);
  assert.deepEqual(await faultOf(session.review("review", S.Review)), { tag: "TransportFault", networkCode: "ENOTFOUND" });
});
