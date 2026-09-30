import assert from "node:assert/strict";
import { programWritten } from "../src/questionContext.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { CodexCallFailed, describe, haltMessage, ProjectChanged, TransportFault } from "../src/errors.ts";
import { DECIDE, parseTransportAnswer } from "../src/input.ts";
import { transportOptions } from "../src/offer.ts";
import { platformLayer } from "../src/platform.ts";
import * as prompts from "../src/prompts.ts";
import { withTransportRetry } from "../src/retry.ts";
import * as S from "../src/schema.ts";
import { Decider, type DeciderShape, RunConfig, Store, Ui } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { promptOf } from "../src/userPrompts.ts";
import { noDecider, ScriptedUi, tempRepo } from "./helpers.ts";
import { para } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";

// Issue #26 (plan step S18): a call that failed from a transport fault is made again with backoff; when the retries are
// exhausted, the user chooses between another set of retries and a stop.

const fault = (message = "stream disconnected before completion") => new TransportFault({ agent: "codex", message, status: null });

type Script = ReadonlyArray<"fault" | "ok" | "other">;
/** An attempt that follows a script, and records its numbers. */
const scripted = (script: Script) => {
  const calls: number[] = [];
  const attempt = (n: number): Effect.Effect<string, TransportFault | CodexCallFailed> =>
    Effect.suspend((): Effect.Effect<string, TransportFault | CodexCallFailed> => {
      calls.push(n);
      const step = script[calls.length - 1] ?? "ok";
      return step === "fault" ? Effect.fail(fault()) : step === "other" ? Effect.fail(new CodexCallFailed({ message: "usage limit" })) : Effect.succeed(`reply ${n}`);
    });
  return { calls, attempt };
};

const setup = async (answers: string[], decider: DeciderShape = noDecider) => {
  const repo = tempRepo();
  const store = await Effect.runPromise(makeStore(repo, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const ui = new ScriptedUi(answers);
  const config = { ...S.defaultConfig, maxTransportRetries: 2, transportRetryDelaySeconds: 0.01 };
  const layer = Layer.mergeAll(Layer.succeed(Store, { ...store, saveChoice: () => Effect.void }), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, config), Layer.succeed(Decider, decider));
  const conversation = () => fs.readFileSync(path.join(store.dir, "conversation.md"), "utf8");
  return { layer, ui, conversation };
};
const exitOf = <A, E>(effect: Effect.Effect<A, E, Store | Ui | RunConfig | Decider>, layer: Layer.Layer<Store | Ui | RunConfig | Decider>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
const errorOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `not a typed error: ${Cause.pretty(exit.cause)}`);
  return error.value;
};

test("a fault, then success: one retry, notified and said, then recovered", async () => {
  const { layer, ui, conversation } = await setup([]);
  const { calls, attempt } = scripted(["fault", "ok"]);
  const exit = await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void), layer);
  assert.deepEqual(exit, Exit.succeed("reply 2"));
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(ui.notified.filter((e) => e._tag === "TransportRetrying" || e._tag === "TransportRecovered"), [
    { _tag: "TransportRetrying", agent: "codex", attempt: 1, of: 2, delaySeconds: 0.01, fault: "stream disconnected before completion" },
    { _tag: "TransportRecovered", agent: "codex" },
  ]);
  const line = prompts.transportRetryLine("codex", 1, 2, 0.01, "stream disconnected before completion");
  assert.ok(ui.said.includes(line), "the retry line was not said");
  assert.ok(conversation().includes(line), "the retry line is not in conversation.md");
});

test("faults beyond the retries, then Retry again, then success: the backoff restarts", async () => {
  const { layer, ui } = await setup([prompts.TRANSPORT_ANSWERS.retry]);
  const { calls, attempt } = scripted(["fault", "fault", "fault", "fault", "ok"]);
  const exit = await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void), layer);
  assert.deepEqual(exit, Exit.succeed("reply 5"));
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  assert.equal(ui.asked.length, 1);
  assert.deepEqual(ui.notified.filter((e) => e._tag === "TransportRetrying").map((e) => (e._tag === "TransportRetrying" ? e.attempt : 0)), [1, 2, 1]);
});

test("faults beyond the retries, then Stop: AgentUnreachable with the agent, the attempts and the last fault", async () => {
  const { layer, conversation } = await setup([prompts.TRANSPORT_ANSWERS.stop]);
  const { calls, attempt } = scripted(["fault", "fault", "fault"]);
  const error = errorOf(await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void), layer));
  assert.equal(error._tag, "AgentUnreachable");
  assert.deepEqual(calls, [1, 2, 3]);
  assert.match(describe(error as never), /Codex could not be reached after 3 attempts: stream disconnected before completion\. The records are preserved\./);
  assert.match(haltMessage(error) ?? "", /^HALTED: /);
  assert.match(conversation(), /\*\*User decision:\*\* stop/);
});

test("a failure that is not a transport fault is not retried", async () => {
  const { layer } = await setup([]);
  const { calls, attempt } = scripted(["other"]);
  const error = errorOf(await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void), layer));
  assert.equal(error._tag, "CodexCallFailed");
  assert.deepEqual(calls, [1]);
});

test("beforeRetry failing halts with its error, and no further attempt is made", async () => {
  const { layer } = await setup([]);
  const { calls, attempt } = scripted(["fault", "ok"]);
  const guard = Effect.fail(new ProjectChanged({ during: "review", fileLabel: null, changes: [{ kind: "content_changed", path: "a.txt" }] }));
  const error = errorOf(await exitOf(withTransportRetry("codex", "the review", attempt, guard), layer));
  assert.equal(error._tag, "ProjectChanged");
  assert.deepEqual(calls, [1]);
});

test("an interruption during the backoff ends the call: no further attempt", async () => {
  const { layer } = await setup([]);
  const { calls, attempt } = scripted(["fault", "ok"]);
  const slow = Layer.merge(layer, Layer.succeed(RunConfig, { ...S.defaultConfig, maxTransportRetries: 2, transportRetryDelaySeconds: 60 }));
  const fiber = Effect.runFork(withTransportRetry("codex", "the review", attempt, Effect.void).pipe(Effect.provide(slow)));
  await new Promise((r) => setTimeout(r, 100));
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  assert.deepEqual(calls, [1]);
});

test("Help me decide at the exhaustion pause runs a decision and asks again", async () => {
  const requests: unknown[] = [];
  const decider: DeciderShape = {
    at: () => decider,
    explain: (request) => Effect.succeed(programWritten(request)),
    decide: (request) => Effect.sync(() => (requests.push(request), { decision: 1, analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } }, result: "converged" as const })),
  };
  const { layer, ui } = await setup([DECIDE, prompts.TRANSPORT_ANSWERS.retry], decider);
  const { attempt } = scripted(["fault", "fault", "fault", "ok"]);
  const exit = await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void), layer);
  assert.deepEqual(exit, Exit.succeed("reply 4"));
  assert.equal(requests.length, 1);
  assert.deepEqual((requests[0] as { options: { label: string }[] }).options.map((o) => o.label), [prompts.TRANSPORT_RETRY_AGAIN, prompts.TRANSPORT_STOP]);
  assert.equal(ui.asked.length, 2);
});

// The seams of the pause: the page's buttons, the terminal's parser and decision support's options, from one source.
// S8: the pause's options are its cards, each sending the answer it shows; the widget adds only the offer and the quit.
test("every option of the exhaustion pause sends the answer its label names, and exactly one option matches it", () => {
  const intended = { [prompts.TRANSPORT_RETRY_AGAIN]: "retry", [prompts.TRANSPORT_STOP]: "stop" } as const;
  const widget = promptOf(prompts.withOffer(prompts.transportPrompt));
  assert.equal(widget.kind, "transport");
  assert.deepEqual(widget.choices.filter((c) => c.sends !== "q" && c.sends !== DECIDE), []);
  assert.ok(widget.choices.some((c) => c.label === prompts.HELP_ME_DECIDE && c.sends === DECIDE), "the pause carries no offer");
  const options = transportOptions();
  assert.deepEqual(options.map((o) => o.label), [prompts.TRANSPORT_RETRY_AGAIN, prompts.TRANSPORT_STOP]);
  for (const option of options) {
    const sends = "token" in option.answer ? option.answer.token : "";
    assert.equal(parseTransportAnswer(sends), intended[option.label as keyof typeof intended]);
    assert.deepEqual(options.filter((o) => o.matches(sends)).map((o) => o.label), [option.label]);
  }
  for (const answer of ["", " ", "x", "2", "p"]) assert.equal(parseTransportAnswer(answer), null, answer);
});

// S10 and S12 (G-R1-1): the exhaustion pause for Codex gets its context from a context call; the pause for Claude Code
// shows the program's paragraph at once, since a context call would need the agent that cannot be reached.
test("the exhaustion pause for Codex is explained by a context call; the pause for Claude Code is not", async () => {
  const explained: unknown[] = [];
  const decider: DeciderShape = {
    at: () => decider,
    decide: () => Effect.die(new Error("no decision was expected")),
    explain: (request) => Effect.sync(() => (explained.push(request), { context: { blocks: para("Written by Claude Code."), by: "agent" as const }, explanations: [] })),
  };
  for (const agent of ["codex", "claude"] as const) {
    explained.length = 0;
    const { layer, ui } = await setup([prompts.TRANSPORT_ANSWERS.stop], decider);
    const attempt = () => Effect.fail(new TransportFault({ agent, message: "read ECONNRESET", status: null }));
    await exitOf(withTransportRetry(agent, "the review", attempt, Effect.void), layer);
    const [q] = ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
    if (agent === "codex") {
      assert.equal(explained.length, 1);
      assert.deepEqual(q.context, { blocks: para("Written by Claude Code."), by: "agent" });
    } else {
      assert.deepEqual(explained, [], "a context call was made for the pause of the unreachable Claude Code");
      assert.deepEqual(q.context, { blocks: para(prompts.fallbackContext(q.origin)), by: "program" });
    }
  }
});

// S52 (W5-R1-1): the exhaustion pause's question names the agent and the call; the attempts and the whole fault are in
// its details, so that a long fault cannot push the answers out of view.
test("at the exhaustion pause, the details hold the attempts and the whole fault; the question does not", async () => {
  const long = `stream disconnected: <endpoint> ${"e".repeat(2500)}`;
  const { layer, ui } = await setup([prompts.TRANSPORT_ANSWERS.stop]);
  await exitOf(withTransportRetry("claude", "the review", () => Effect.fail(new TransportFault({ agent: "claude", message: long, status: null })), Effect.void), layer);
  const [q] = ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
  assert.ok(!piecesText(q.question).includes(long.slice(0, 40)), piecesText(q.question));
  assert.deepEqual(q.details, prompts.transportDetails(3, long));
});
