import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { retryDelays } from "../src/retry.ts";
import { networkRetryDelaySeconds } from "../src/retryPolicy.ts";
import { refinementRun } from "../src/run.ts";
import * as S from "../src/schema.ts";
import type { ClaudeFailure } from "../src/transport.ts";
import { sourceOf, finished, type PlanningStep, scriptedItem, scriptedStart, steppingClock, tempRepo, testLayer, testWiring } from "./helpers.ts";

// Issue #201: an agent unreachable for longer than the transport budget, its failure carrying a network code, is tried
// again on the Clock with nothing asked, and the run continues once the agent answers; a fault without a code keeps the
// question; Stop task during such a wait ends the run with 130.
const START = Date.UTC(2026, 9, 30, 16, 37);
const config = S.defaultConfig;
const configuredMs = retryDelays(config).map((d) => d * 1000);
const networkMs = (k: number) => networkRetryDelaySeconds(config, k) * 1000;
const noQuestions = { questions_for_user: [] };

/** The refusal of 30 Oct 2026: the error result's text names the code, and no other fact is kept. */
const INCIDENT = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";
const noFacts: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null };
const unreachable: PlanningStep = { failure: { message: `Claude Code returned an error result: ${INCIDENT}`, facts: { ...noFacts, resultText: INCIDENT } } };

test("a refinement whose question-list call is unreachable beyond its retries tries again with nothing asked and ends successfully", async () => {
  const failures = 6;
  const { layer, probe } = testLayer(tempRepo(), { mode: "refinement", steps: [...Array.from({ length: failures }, () => unreachable), { output: { questions: [] } }], reviews: [{ issues: [] }] });
  const { clock, sleeps } = steppingClock(START);
  const exit = await Effect.runPromiseExit(refinementRun(sourceOf("task"), scriptedItem.id, "checked").pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock)));
  assert.ok(Exit.isSuccess(exit), String(exit));
  assert.ok(!probe.ui.notified.some((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "transport"), "the transport question was asked");
  assert.deepEqual(probe.ui.asked, []);
  const tries = failures - configuredMs.length;
  assert.deepEqual(sleeps, [...configuredMs, ...Array.from({ length: tries }, (_, k) => networkMs(k + 1))]);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  for (let k = 1; k <= tries; k++) {
    const line = probe.ui.notified.find((e) => e._tag === "NetworkRetrying" && e.attempt === k);
    assert.ok(line !== undefined && line._tag === "NetworkRetrying" && conversation.includes(prompts.networkRetryLine("claude", line.what, "EAI_AGAIN", k, networkMs(k) / 1000)), `try ${k} not written`);
  }
});

const codexUnreachable = (faultCode: "ECONNREFUSED" | undefined, count: number) => Array.from({ length: count }, () => ({ issues: [], fault: "connect ECONNREFUSED 1.2.3.4:443", ...(faultCode === undefined ? {} : { faultCode }) }));

test("an implementation whose plan review's Codex turn is unreachable beyond its retries continues with nothing asked and finishes 0", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [...codexUnreachable("ECONNREFUSED", 5), { issues: [] }, { issues: [] }], execs: [finished] });
  const { clock } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.equal(probe.ui.notified.filter((e) => e._tag === "NetworkRetrying").length, 5 - configuredMs.length);
});

test("a Codex fault without a network code still asks at exhaustion; Stop ends the run 1 with AgentUnreachable", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: codexUnreachable(undefined, configuredMs.length + 1), answers: [{ beside: prompts.TRANSPORT_ANSWERS.stop }] });
  const { clock } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 1);
  assert.equal(probe.ui.asked.length, 1);
  assert.match(probe.ui.said.join("\n"), /HALTED: Codex could not be reached/);
  assert.ok(!probe.ui.notified.some((e) => e._tag === "NetworkRetrying"));
});

test("Stop task during a network wait ends the run with 130, interrupted, and no further attempt", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [...codexUnreachable("ECONNREFUSED", 10), { issues: [] }, { issues: [] }], execs: [finished] });
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((r) => (reached = r));
  const { clock } = steppingClock(START, (ms) => (ms === networkMs(1) ? Effect.suspend(() => (reached(), Effect.never)) : Effect.void));
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  const ended = await Promise.race([waiting.then(() => false), Effect.runPromise(Fiber.await(fiber)).then(() => true)]);
  assert.equal(ended, false, "the run ended before the network wait began");
  const reviewsBefore = probe.reviewer.prompts.length;
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  assert.equal(probe.reviewer.prompts.length, reviewsBefore);
  assert.ok(probe.ui.notified.some((e) => e._tag === "NetworkRetrying"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes("**Interrupted by the user.**"));
});
