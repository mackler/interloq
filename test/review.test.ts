import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer, Result } from "effect";
import { UserStopped } from "../src/errors.ts";
import { decodeValidating, decodeWithRepair, planningCall, type Repair } from "../src/review.ts";
import { Planner } from "../src/services.ts";
import { noDecider, pathsOf, ScriptedPlanner, ScriptedUi, questionOf } from "./helpers.ts";
import * as S from "../src/schema.ts";
import { Decider, RunConfig, Store, type StoreShape, Ui } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

const store = async (): Promise<StoreShape> => {
  const s = await Effect.runPromise(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  return s;
};

// Finding 22 of docs/functional-design-review.md: keeping an invalid reply serialized it with JSON.stringify
// outside any error channel, so a reply with a BigInt or a cycle was a defect instead of a repair turn.
for (const [what, reply] of [["a BigInt", { questions_for_user: 1n }], ["a cycle", (() => { const c: Record<string, unknown> = { questions_for_user: "x" }; c.self = c; return c; })()]] as const) {
  test(`an invalid reply containing ${what} is kept with the serialization failure named, and the repair turn runs`, async () => {
    const s = await store();
    const prompts: string[] = [];
    const repair = (r: Repair) => Effect.sync(() => (prompts.push(r.prompt), { questions_for_user: [] }));
    const output = await Effect.runPromise(decodeWithRepair("claude", S.PlanWriteResult, reply, repair).pipe(Effect.provide(Layer.succeed(Store, s))));
    assert.deepEqual(output, { questions_for_user: [] });
    assert.equal(prompts.length, 1, "the repair turn did not run");
    assert.match(fs.readFileSync(path.join(s.dir, "invalid-replies", "claude-1.json"), "utf8"), /reply not serializable/);
  });
}

// Plan step 3.4 (finding 25): the repair is reported in the result instead of being tracked in a mutable binding.
test("planningCall reports whether a repair turn was needed", async () => {
  const repo = tempRepo();
  const s = await Effect.runPromise(makeStore(repo, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  const planner = new ScriptedPlanner(pathsOf(repo), [{ output: { questions_for_user: "x" } }, { output: { questions_for_user: [] } }, { output: { questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] } }], []);
  const layer = Layer.mergeAll(Layer.succeed(Store, s), Layer.succeed(Planner, planner), Layer.succeed(Decider, noDecider), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig));
  const repaired = await Effect.runPromise(planningCall("first", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.output, { questions_for_user: [] });
  const direct = await Effect.runPromise(planningCall("second", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(direct.repaired, false);
  assert.deepEqual(direct.output, { questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] });
});

// Plan step S10 (issue #30): one kind of second turn for a defective reply, the Repair, whose kind names its budget.
test("decodeValidating hands its repair a Repair of kind schema, then of kind validation, each budget once", async () => {
  const s = await store();
  const kinds: string[] = [];
  const replies: unknown[] = [{ questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] }, { questions_for_user: [] }];
  const repair = (r: Repair) => Effect.sync(() => (kinds.push(r.kind), replies.shift()));
  const validate = (v: { questions_for_user: readonly unknown[] }) =>
    v.questions_for_user.length === 0 ? Result.succeed({ value: v, notes: [] }) : Result.fail({ error: new UserStopped({ where: "x" }), repair: "no questions, please" });
  const out = await Effect.runPromise(decodeValidating("claude", S.PlanWriteResult, { questions_for_user: "x" }, repair, validate as never).pipe(Effect.provide(Layer.succeed(Store, s))));
  assert.deepEqual(out.value, { questions_for_user: [] });
  assert.deepEqual(kinds, ["schema", "validation"]);
});

// Issue #26 (plan step S19): Codex turns and planning calls are retried after a transport fault, with the guard's
// baselines taken once per call and compared after every attempt and before every retry.
import { finished, issue, respond, runFails, runTask, testLayer } from "./helpers.ts";
import * as prompts from "../src/prompts.ts";
import type { Config } from "../src/schema.ts";

const issue26 = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";
const quick: Partial<Config> = { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 };
const noQuestions = { questions_for_user: [] };
/** A store that runs `effect` right after the retry line is appended to conversation.md: during the backoff. */
const duringBackoff = (effect: () => void) => (s: StoreShape): StoreShape => ({
  ...s,
  converse: (markdown) => s.converse(markdown).pipe(Effect.tap(() => Effect.sync(() => (markdown.includes("connection lost, retry") ? effect() : undefined)))),
});

test("(a) a Codex turn that fails with the message of #26 is retried, and the run converges", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts[0], probe.reviewer.prompts[1], "the retry repeats the turn");
  assert.equal(probe.reviewer.callPhases[1], probe.reviewer.callPhases[0], "the retry is in the same thread");
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRetrying" && e.agent === "codex"));
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRecovered"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.transportRetryLine("codex", 1, 1, 0.01, issue26)));
});

test("(b) a project change during the failed turn halts with ProjectChanged, and there is no retry", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], fault: issue26, touchProject: true }], config: quick });
  await runFails(layer, "ProjectChanged");
  assert.equal(probe.reviewer.prompts.length, 1);
});

test("(c) a project change during the backoff halts with ProjectChanged before a second attempt", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [] }],
    config: quick,
    store: duringBackoff(() => fs.appendFileSync(path.join(repo, "a.txt"), "outside\n")),
  });
  await runFails(layer, "ProjectChanged");
  assert.equal(probe.reviewer.prompts.length, 1);
});

test("(e) a transport fault, then an invalid reply: one schema repair turn, then success", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [], raw: "not a review" }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts.length, 4);
});

test("(f) a planning call that faults and then succeeds: the same prompt again, in the same session", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, fault: "read ECONNRESET" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[0], probe.planner.prompts[1]);
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRetrying" && e.agent === "claude"));
});

test("(k) Stop at the exhaustion pause halts with AgentUnreachable, and the checkpoint is the last committed transition", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [], fault: issue26 }],
    answers: [prompts.TRANSPORT_ANSWERS.stop],
    config: quick,
  });
  await runFails(layer, "AgentUnreachable", /Codex could not be reached after 2 attempts/);
  assert.equal(probe.ui.asked[0], prompts.withOffer(prompts.transportPrompt));
  const { readCheckpoint } = await import("../src/records.ts");
  const checkpoint = await Effect.runPromise(readCheckpoint(probe.dir).pipe(Effect.provide(platformLayer)));
  // The halt comes during the first review, before any transition of planning 1 was committed.
  assert.deepEqual([checkpoint?.subject, checkpoint?.stage], ["run", "started"]);
});

test("(l) a corrective turn that faults and then succeeds: the loop continues, and the corrective budget is spent once", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]) },
      { output: respond([["P1-R1-1", "accepted"]]), fault: "read ECONNRESET" },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[2], prompts.correctivePrompt("plan.json", 1, ["P1-R1-1"]));
  assert.equal(probe.planner.prompts[3], probe.planner.prompts[2], "the retry repeats the corrective turn");
  assert.deepEqual(probe.ui.asked, []);
});
