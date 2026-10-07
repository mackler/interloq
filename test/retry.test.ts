import assert from "node:assert/strict";
import { programWritten } from "../src/questionContext.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Clock, Effect, Exit, Fiber, Layer, Option } from "effect";
import { CodexCallFailed, describe, haltMessage, ProjectChanged, TransportFault, UsageLimited } from "../src/errors.ts";
import { DECIDE, parseTransportAnswer } from "../src/input.ts";
import { transportOptions } from "../src/offer.ts";
import { platformLayer } from "../src/platform.ts";
import * as prompts from "../src/prompts.ts";
import { retryDelays, USAGE_LIMIT_MARGIN_SECONDS, withTransportRetry } from "../src/retry.ts";
import * as S from "../src/schema.ts";
import { Decider, type DeciderShape, RunConfig, Store, Ui } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { promptOf } from "../src/userPrompts.ts";
import { countdownView } from "../web/src/state.ts";
import { finished, issue, noDecider, respond, ScriptedUi, steppingClock, tempRepo, testLayer } from "./helpers.ts";
import { run } from "../src/run.ts";
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
  const usage = () => (fs.existsSync(path.join(store.dir, "usage.jsonl")) ? fs.readFileSync(path.join(store.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { layer, ui, conversation, usage, repo };
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
  // The wait's start and end are read from the Clock; the seam test below checks them on a stepping clock.
  const withoutWait = ui.notified.map((e) => (e._tag === "TransportRetrying" ? (({ fromMs: _f, untilMs: _u, ...rest }) => rest)(e) : e));
  assert.deepEqual(withoutWait.filter((e) => e._tag === "TransportRetrying" || e._tag === "TransportRecovered"), [
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

// The seams of the pause: the page's buttons, the parser of src/input.ts and decision support's options, from one source.
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

// Issue #68: a usage limit with a stated reset is waited out on the Clock, and the call is made again; nothing is asked.
const START = Date.UTC(2026, 8, 30, 5, 32);
const MARGIN_MS = USAGE_LIMIT_MARGIN_SECONDS * 1000;
const limited = (resetsAtMs: number, limitType: string | null = "five_hour") => new UsageLimited({ agent: "claude", message: "You've hit your session limit", resetsAtMs, limitType });
type LimitScript = ReadonlyArray<UsageLimited | "fault" | "ok">;
const limitScripted = (script: LimitScript) => {
  const calls: number[] = [];
  const attempt = (n: number): Effect.Effect<string, TransportFault | UsageLimited> =>
    Effect.suspend((): Effect.Effect<string, TransportFault | UsageLimited> => {
      calls.push(n);
      const step = script[calls.length - 1] ?? "ok";
      return step === "ok" ? Effect.succeed(`reply ${n}`) : step === "fault" ? Effect.fail(fault()) : Effect.fail(step);
    });
  return { calls, attempt };
};
const withClock = (clock: Clock.Clock) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Clock.Clock, clock);

test("a usage limit with a reset: one wait until the reset plus the margin, notified, said and recorded; then the call again, nothing asked", async () => {
  const { layer, ui, conversation, usage } = await setup([]);
  const { clock, sleeps } = steppingClock(START);
  const reset = START + 9_000_000;
  const { calls, attempt } = limitScripted([limited(reset), "ok"]);
  let guards = 0;
  const guard = Effect.sync(() => void guards++);
  const exit = await exitOf(withTransportRetry("claude", "the plan", attempt, guard).pipe(withClock(clock)), layer);
  assert.deepEqual(exit, Exit.succeed("reply 2"));
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(sleeps, [9_000_000 + MARGIN_MS]);
  assert.equal(guards, 1);
  const until = reset + MARGIN_MS;
  assert.deepEqual(ui.notified.filter((e) => e._tag === "UsageLimitWaiting" || e._tag === "UsageLimitLifted" || e._tag === "TransportRecovered"), [
    { _tag: "UsageLimitWaiting", agent: "claude", limitType: "five_hour", fromMs: START, untilMs: until },
    { _tag: "UsageLimitLifted", agent: "claude", waitedMs: until - START },
  ]);
  const waitLine = prompts.usageLimitWaitLine("claude", "five_hour", until);
  const liftedLine = prompts.usageLimitLiftedLine("claude", until - START);
  assert.ok(ui.said.includes(waitLine), "the wait line was not said");
  assert.ok(conversation().includes(waitLine) && conversation().includes(liftedLine), "the wait is not in conversation.md");
  assert.deepEqual(ui.asked, []);
  const waits = usage().filter((l) => l.kind === "usage_limit_wait");
  assert.equal(waits.length, 1);
  assert.equal(waits[0]?.outcome, "lifted");
  assert.equal(waits[0]?.ended, waits[0]?.until);
  assert.equal(waits[0]?.until, new Date(until).toISOString());
});

test("the wait lines name the limit and the instant it lifts in UTC, and the time waited", () => {
  const until = Date.UTC(2026, 8, 30, 8, 11);
  assert.equal(prompts.usageLimitWaitLine("claude", "five_hour", until), "Claude Code: five-hour session limit reached; Interloq waits until 2026-09-30 08:11 UTC, then continues");
  assert.equal(prompts.usageLimitLiftedLine("claude", 9_060_000), "Claude Code: the usage limit has lifted after 2:31:00; continuing");
  assert.equal(prompts.limitName("seven_day"), "weekly limit");
  assert.equal(prompts.limitName(null), "usage limit");
  assert.equal(prompts.limitName("something_new"), "usage limit");
});

test("a usage limit leaves the transport retries untouched: a later fault still gets its full set", async () => {
  const { layer, ui } = await setup([]);
  const { clock } = steppingClock(START);
  const { calls, attempt } = limitScripted([limited(START + 1000), "fault", "fault", "ok"]);
  const exit = await exitOf(withTransportRetry("claude", "the plan", attempt, Effect.void).pipe(withClock(clock)), layer);
  assert.deepEqual(exit, Exit.succeed("reply 4"));
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(ui.notified.filter((e) => e._tag === "TransportRetrying").map((e) => e._tag === "TransportRetrying" && e.attempt), [1, 2]);
});

test("a reset already past: one wait of the margin alone", async () => {
  const { layer } = await setup([]);
  const { clock, sleeps } = steppingClock(START);
  const { attempt } = limitScripted([limited(START - 3_600_000), "ok"]);
  await exitOf(withTransportRetry("claude", "the plan", attempt, Effect.void).pipe(withClock(clock)), layer);
  assert.deepEqual(sleeps, [MARGIN_MS]);
});

test("two limits in a row: two waits, then success", async () => {
  const { layer, usage } = await setup([]);
  const { clock, sleeps } = steppingClock(START);
  const { calls, attempt } = limitScripted([limited(START + 1000), limited(START + 1000 + MARGIN_MS + 5000), "ok"]);
  const exit = await exitOf(withTransportRetry("claude", "the plan", attempt, Effect.void).pipe(withClock(clock)), layer);
  assert.deepEqual(exit, Exit.succeed("reply 3"));
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(sleeps, [1000 + MARGIN_MS, 5000 + MARGIN_MS]);
  assert.equal(usage().filter((l) => l.kind === "usage_limit_wait").length, 2);
});

test("a project changed during the wait halts with the guard's ProjectChanged; no further attempt", async () => {
  const { layer, repo } = await setup([]);
  const { clock } = steppingClock(START, () => Effect.sync(() => fs.writeFileSync(path.join(repo, "outside.txt"), "x")));
  const { calls, attempt } = limitScripted([limited(START + 1000), "ok"]);
  const guard = Effect.suspend(() => (fs.existsSync(path.join(repo, "outside.txt")) ? Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes: [{ kind: "added", path: "outside.txt" }] })) : Effect.void));
  const error = errorOf(await exitOf(withTransportRetry("claude", "the plan", attempt, guard).pipe(withClock(clock)), layer));
  assert.equal(error._tag, "ProjectChanged");
  assert.deepEqual(calls, [1]);
});

test("an interruption one minute into a weekly wait: no further attempt, no lift, and the wait recorded as one minute", async () => {
  const { layer, ui, usage } = await setup([]);
  const WEEK = 7 * 24 * 3_600_000;
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((r) => (reached = r));
  // The sleep advances the clock by one minute only, then holds the wait open until the interruption.
  let time = START;
  const clock: Clock.Clock = {
    ...steppingClock(START).clock,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeMillisUnsafe: () => time,
    sleep: () => Effect.suspend(() => ((time += 60_000), reached(), Effect.never)),
  };
  const { calls, attempt } = limitScripted([limited(START + WEEK, "seven_day"), "ok"]);
  const fiber = Effect.runFork(withTransportRetry("claude", "the plan", attempt, Effect.void).pipe(withClock(clock), Effect.provide(layer)));
  const ended = Effect.runPromise(Fiber.await(fiber)).then(() => assert.fail("the call ended before the wait began"));
  await Promise.race([waiting, ended]);
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  assert.deepEqual(calls, [1]);
  assert.ok(!ui.notified.some((e) => e._tag === "UsageLimitLifted"));
  const waits = usage().filter((l) => l.kind === "usage_limit_wait");
  assert.equal(waits.length, 1);
  assert.equal(waits[0]?.outcome, "interrupted");
  assert.equal(waits[0]?.from, new Date(START).toISOString());
  assert.equal(waits[0]?.ended, new Date(START + 60_000).toISOString());
  assert.equal(waits[0]?.until, new Date(START + WEEK + MARGIN_MS).toISOString());
});

// The records guard of a read-only call (Claude Code's response to a work review) holds across the wait as across a
// backoff: the program's own writes pass, an outside write to a guarded record halts.
const workRunWithLimit = (onSleep: (repo: string) => void) => {
  const repo = tempRepo();
  const response = respond([["W1-R1-1", "rejected"]]);
  const { layer, probe } = testLayer(repo, {
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }, { output: response, limit: { resetsAtMs: START + 1000, limitType: "five_hour" } }, { output: response }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  const { clock } = steppingClock(START, () => Effect.sync(() => onSleep(repo)));
  return { exit: Effect.runPromiseExit(run("task").pipe(Effect.provide(layer), withClock(clock))), probe };
};

test("a read-only call's wait: the program's own writes pass the records guard, and the call is made again", async () => {
  const { exit, probe } = workRunWithLimit(() => undefined);
  assert.ok(Exit.isSuccess(await exit));
  assert.equal(probe.planner.capabilities[2], "readOnly");
  assert.equal(probe.planner.prompts.length, 3);
});

test("a read-only call's wait: an outside edit of conversation.md during it halts with RecordsChanged", async () => {
  const { exit, probe } = workRunWithLimit((repo) => fs.appendFileSync(path.join(repo, "plan-review", "conversation.md"), "an outside edit\n"));
  const error = errorOf(await exit);
  assert.equal(error._tag, "RecordsChanged");
  assert.equal(probe.planner.prompts.length, 2);
});

// Issue #63, the seam of the countdown: each retry announces the start and end of its wait, the end is retryDelays' wait
// after the start, the next attempt starts at that end exactly, and the page's countdown ends at that instant.
test("each retry announces its wait's start and end; the next attempt starts at the end, where the countdown ends", async () => {
  const { layer, ui } = await setup([]);
  const delays = retryDelays({ maxTransportRetries: 2, transportRetryDelaySeconds: 0.01 });
  const { clock, now } = steppingClock(START);
  const { attempt: scriptedAttempt } = scripted(["fault", "fault", "ok"]);
  const starts: number[] = [];
  const attempt = (n: number) => Effect.sync(() => void starts.push(now())).pipe(Effect.andThen(scriptedAttempt(n)));
  const exit = await exitOf(withTransportRetry("codex", "the review", attempt, Effect.void).pipe(withClock(clock)), layer);
  assert.deepEqual(exit, Exit.succeed("reply 3"));
  const waits = ui.notified.flatMap((e) => (e._tag === "TransportRetrying" ? [e] : []));
  assert.equal(waits.length, delays.length);
  waits.forEach((w, k) => {
    assert.equal(w.untilMs - w.fromMs, delays[k]! * 1000);
    assert.equal(w.fromMs, starts[k]);
    assert.equal(starts[k + 1], w.untilMs, "the next attempt starts at the announced end");
    assert.notEqual(countdownView(w, w.untilMs - 1), null);
    assert.equal(countdownView(w, w.untilMs), null);
  });
});
