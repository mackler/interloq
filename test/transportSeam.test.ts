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
import { FakeSdk, init, rejecting, type Script } from "./fakeSdk.ts";
import { noDecider, ScriptedUi, tempRepo , TEST_ROOT } from "./helpers.ts";

// W1-R1-2: the two adapters read a thrown value's code the same way. Every network code of src/transport.ts, thrown
// without it in the message, makes a Codex turn and a Claude Code planning call fail alike with TransportFault.
const tagOf = (effect: Effect.Effect<unknown, unknown>): Promise<string> =>
  Effect.runPromise(Effect.result(effect)).then((r) => (r._tag === "Failure" ? (r.failure as { _tag: string })._tag : "success"));

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
    const [codexTag, claudeTag] = [await tagOf(session.review("review")), await tagOf(claude.planning("plan", S.PlanWriteResult).pipe(Effect.provideService(Decider, noDecider)))];
    assert.deepEqual([codexTag, claudeTag], ["TransportFault", "TransportFault"]);
  });
}
