// Issue #251: the seam of one limit wait for every agent. A Claude Code limit and a Codex limit with the same reset,
// limit type and message produce the same wait: the same events, the same lines said and written in the same order,
// the same records in usage.jsonl and the same sleeps, apart from the agent's name.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Exit, Layer } from "effect";
import { UsageLimited } from "../src/errors.ts";
import { CODEX_USAGE_LIMIT_TYPE, type LimitReset } from "../src/limitReset.ts";
import { platformLayer } from "../src/platform.ts";
import { withTransportRetry } from "../src/retry.ts";
import * as S from "../src/schema.ts";
import { Decider, RunConfig, Store, Ui } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { noDecider, ScriptedUi, steppingClock, tempRepo, TEST_ROOT } from "./helpers.ts";

const START = Date.UTC(2026, 10, 3, 19, 13);
const MESSAGE = "You've hit your usage limit. Try again later.";

type Agent = "claude" | "codex";
type Observed = Readonly<{ events: unknown[]; said: string[]; conversation: string; usage: unknown[]; sleeps: number[]; exit: unknown }>;

const observe = async (agent: Agent, reset: LimitReset): Promise<Observed> => {
  const store = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const ui = new ScriptedUi([]);
  const layer = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, S.defaultConfig), Layer.succeed(Decider, noDecider));
  let calls = 0;
  const attempt = (_n: number) =>
    Effect.suspend(() => (++calls === 1 ? Effect.fail(new UsageLimited({ agent, message: MESSAGE, reset, limitType: CODEX_USAGE_LIMIT_TYPE })) : Effect.succeed(`reply ${calls}`)));
  const { clock, sleeps } = steppingClock(START);
  const exit = await Effect.runPromiseExit(withTransportRetry(agent, "review", "the plan", attempt, Effect.void).pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(layer)));
  const read = (file: string) => fs.readFileSync(path.join(store.dir, file), "utf8");
  const usage = read("usage.jsonl").trim().split("\n").map((l) => JSON.parse(l) as unknown);
  const events = ui.notified.filter((e) => e._tag === "UsageLimitWaiting" || e._tag === "UsageLimitLifted");
  return { events, said: [...ui.said], conversation: read("conversation.md"), usage, sleeps: [...sleeps], exit: Exit.isSuccess(exit) ? exit.value : "failed" };
};

/** Claude Code's observation with its name and field replaced by Codex's. */
const asCodex = (o: Observed): Observed => JSON.parse(JSON.stringify(o).replaceAll("Claude Code", "Codex").replaceAll('"agent":"claude"', '"agent":"codex"')) as Observed;

for (const [name, reset] of [["a known reset an hour ahead", { kind: "instant", atMs: START + 3_600_000 }], ["no known reset", { kind: "unknown" }]] as const) {
  test(`a Claude Code limit and a Codex limit with ${name} wait alike, apart from the agent's name`, async () => {
    const claude = await observe("claude", reset);
    const codex = await observe("codex", reset);
    assert.equal(codex.exit, "reply 2");
    assert.ok(codex.events.length >= 1);
    assert.deepEqual(asCodex(claude), codex);
  });
}
