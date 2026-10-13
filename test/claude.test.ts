import assert from "node:assert/strict";
import { programWritten } from "../src/questionContext.ts";
import { renderQuestionRecord } from "../src/render.ts";
import { blocksMarkdown, piecesText, plainBlocks } from "../src/pieces.ts";
import type { ContextRequest } from "../src/prompts.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { CanUseTool, HookCallback, HookInput, HookJSONOutput, Options, PermissionResult, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Clock, Effect, Fiber, Layer } from "effect";
import { claudeEnv, makeClaudePlanner, makeClaudePlannerWith, toSdkAnswers } from "../src/claude.ts";
import { FileSystemError, type RunError } from "../src/errors.ts";
import { agentJsonSchema } from "../src/jsonSchema.ts";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { Decider, type DeciderShape, Planner, type PlannerShape, RunConfig, RunKind, Sdk, Store, type StoreShape, Ui } from "../src/services.ts";
import { runRootOf } from "../src/artifacts.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { changed, notification, started } from "./backgroundMessages.ts";
import { assistantText, assistantTool, failure, FakeSdk, init, limitError, limitResult, messages, rateLimit, reportStep, success, type Script } from "./fakeSdk.ts";
import { noDecider, noReporter, ScriptedUi, steppingClock, tempRepo, questionOf, para, plain, term , TEST_ROOT } from "./helpers.ts";
import { planningCall } from "../src/review.ts";
import { USAGE_LIMIT_MARGIN_SECONDS } from "../src/retry.ts";

/** Runs an effect with a Decider that no test here expects to be used, unless a test gives its own. */
const run = <A, E>(effect: Effect.Effect<A, E, Decider>, decider: DeciderShape = noDecider): Promise<A> => Effect.runPromise(effect.pipe(Effect.provideService(Decider, decider)));

/** A Claude Code planner over a fake SDK, a scripted Ui and a store on a temporary repository. */
const planner = async (scripts: Script[], answers: string[] = [], config: Partial<typeof S.Config.Type> = {}, storeOverride: Partial<StoreShape> = {}, backgroundBoundMs: number = prompts.BACKGROUND_WAIT_BOUND_MS): Promise<{ planner: PlannerShape; sdk: FakeSdk; ui: ScriptedUi; dir: string; project: string; deps: Layer.Layer<Store | Ui | Sdk | RunConfig | RunKind> }> => {
  const store = await run(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  const ui = new ScriptedUi(answers);
  const sdk = new FakeSdk(scripts);
  const deps = Layer.mergeAll(Layer.succeed(Store, { ...store, ...storeOverride }), Layer.succeed(Ui, ui), Layer.succeed(Sdk, sdk), Layer.succeed(RunConfig, { ...S.defaultConfig, ...config }), Layer.succeed(RunKind, { mode: "implementation" }));
  return { planner: await run(makeClaudePlannerWith({ backgroundBoundMs }).pipe(Effect.provide(deps))), sdk, ui, dir: store.dir, project: store.project, deps };
};

// The schema of most planning calls in these tests; the output the fake returns matches it where the output is read.
const schema = S.PlanWriteResult;
const hook = (options: Options): HookCallback => {
  const hooks = options.hooks?.PreToolUse;
  assert.ok(hooks !== undefined && hooks.length > 0, "the call registered no PreToolUse hook");
  return hooks[0].hooks[0];
};
const runHook = (options: Options, toolName: string, toolInput: Record<string, unknown> = {}): Promise<HookJSONOutput> =>
  hook(options)({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput } as PreToolUseHookInput, undefined, { signal: new AbortController().signal });
const decision = (output: HookJSONOutput): string | undefined =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
const permission = (options: Options): CanUseTool => {
  assert.ok(options.canUseTool !== undefined, "the call registered no canUseTool");
  return options.canUseTool;
};
const tag = (e: unknown): string => (e as RunError)._tag;
// The third argument of canUseTool carries fields the adapter does not read.
const callContext = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal }) as Parameters<CanUseTool>[2];
/** Resolves when the call's abort signal fires. */
const aborted = (options: Options): Promise<void> => {
  const signal = options.abortController?.signal;
  assert.ok(signal !== undefined, "the call has no abort controller");
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
};

test("a planning call returns the structured output and records usage", async () => {
  const fake = await planner([messages(init("session-7"), assistantTool("Read", { file_path: "/x" }), success({ questions_for_user: [questionOf({ context: "c", question: "q?", terms: [], options: [] })] }, "done"))]);
  const call = await run(fake.planner.planning("write the plan", schema));

  assert.deepEqual(call.output, { questions_for_user: [questionOf({ context: "c", question: "q?", terms: [], options: [] })] });
  assert.equal(call.resultText, "done");
  assert.equal(call.costUsd, 0.25);
  assert.equal(Effect.runSync(fake.planner.sessionId), "session-7");
  const usage = fs.readFileSync(path.join(fake.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].agent, usage[0].session, usage[0].num_turns, usage[0].total_cost_usd], ["claude", "session-7", 3, 0.25]);
});

test("a failed planning call fails with ClaudeCallFailed", async () => {
  const fake = await planner([messages(init(), failure("error_during_execution"))]);
  await assert.rejects(run(fake.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "ClaudeCallFailed");
});

test("a successful planning call without structured output returns it as absent to the caller", async () => {
  const fake = await planner([messages(init(), success(null, "no schema output"))]);
  const call = await run(fake.planner.planning("write the plan", schema));
  assert.equal(call.output ?? null, null);
  assert.equal(call.resultText, "no schema output");
});

test("the planning hook denies an edit outside plan-review/ and permits one inside", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  const options = fake.sdk.calls[0].options;

  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "notes.md") })), undefined);
  // Issue #6 (F1): plan.json and plan.md are the program's; Claude Code returns the plan and writes neither.
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "plan.md") })), "deny");
  assert.equal(decision(await runHook(options, "Edit", { file_path: path.relative(fake.project, path.join(fake.dir, "plan.json")) })), "deny");
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.project, "src/x.ts") })), "deny");
  assert.equal(decision(await runHook(options, "Edit", { file_path: "../outside.txt" })), "deny");
});

// Issue #120, S4: two runs may be in progress at once; a planning call of one may write under its own run's records
// directory alone, never under the other run's, and the denial names its own.
test("the planning hook denies an edit under another run's records directory and permits one under its own", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  const options = fake.sdk.calls[0].options;
  const other = path.join(fake.project, "plan-review", runRootOf("refinement", "7", "2026-10-09T10:15:00.000Z"));
  fs.mkdirSync(other, { recursive: true });
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(other, "notes.md") })), "deny");
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.project, "plan-review", "loose.md") })), "deny");
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "notes.md") })), undefined);
  const denied = (await runHook(options, "Write", { file_path: path.join(other, "notes.md") })) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  assert.ok(denied.hookSpecificOutput?.permissionDecisionReason?.includes(`plan-review/${TEST_ROOT}/`));
});

// Finding 21: the target is resolved on the file system, so a symlink under plan-review/ cannot lead outside it.
test("the planning hook denies an edit through a symlink that leaves plan-review/", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  fs.mkdirSync(path.join(fake.project, "src"), { recursive: true });
  fs.symlinkSync(path.relative(fake.dir, path.join(fake.project, "src")), path.join(fake.dir, "out"));
  const options = fake.sdk.calls[0].options;
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "out", "x.ts") })), "deny");
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "notes", "new.md") })), undefined, "a new file under plan-review/ must stay allowed");
  assert.equal(decision(await runHook(options, "Write", { file_path: path.relative(fake.project, path.join(fake.dir, "out", "y.ts")) })), "deny", "a relative path through the link");
});

test("planning canUseTool relays AskUserQuestion to the user and returns the answers", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const relayed: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    relayed.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success({});
  })();
  const fake = await planner([script], ["2"]);
  await run(fake.planner.planning("write the plan", schema));

  assert.deepEqual(relayed[0], { behavior: "allow", updatedInput: { questions, answers: { "A or B?": "B" } } });
  assert.match(fs.readFileSync(path.join(fake.dir, "conversation.md"), "utf8"), /\*\*User answer:\*\* B/);
});

test("a planning call denies every tool other than an edit or a question", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  const result = await permission(fake.sdk.calls[0].options)("Bash", { command: "ls" }, callContext());
  assert.equal(result?.behavior, "deny");
});

// The model that serves the session is announced once, and again when it changes.
test("the model reported by Claude Code's init message is said once per change", async () => {
  const fake = await planner([
    messages(init("s-1", "claude-test-1"), success({})),
    messages(init("s-1", "claude-test-1"), success({})),
    messages(init("s-1", "claude-test-2"), success({})),
  ]);
  for (let i = 0; i < 3; i++) await run(fake.planner.planning("plan", schema));
  const announced = fake.ui.said.filter((line) => line.startsWith("Claude Code model: "));
  assert.deepEqual(announced, ["Claude Code model: claude-test-1", "Claude Code model: claude-test-2"]);
});

test("the session id of the first call is resumed by the next call", async () => {
  const fake = await planner([messages(init("session-3"), success({})), messages(init("session-3"), success({}))]);
  await run(fake.planner.planning("first", schema));
  await run(fake.planner.planning("second", schema));
  assert.equal(fake.sdk.calls[0].options.resume, undefined);
  assert.equal(fake.sdk.calls[1].options.resume, "session-3");
});

// Decision support, plan step 2.4 (D4, decision Q3): a decision loop runs in a fresh session and never touches the main one.
test("a fresh planner starts its own session, resumes it, and leaves the main session untouched", async () => {
  const fake = await planner([messages(init("main-1"), success({})), messages(init("fresh-1"), success({})), messages(init("fresh-1"), success({})), messages(init("main-1"), success({}))]);
  await run(fake.planner.planning("main first", schema));
  const fresh = await run(fake.planner.fresh);
  await run(fresh.planning("fresh first", schema));
  await run(fresh.planning("fresh second", schema));
  await run(fake.planner.planning("main second", schema));
  assert.deepEqual(fake.sdk.calls.map((c) => c.options.resume), [undefined, undefined, "fresh-1", "main-1"]);
  assert.equal(await run(fresh.sessionId), "fresh-1");
  assert.equal(await run(fake.planner.sessionId), "main-1");
});

test("the configured model is passed, and no model key is set when claudeModel is null", async () => {
  const withModel = await planner([messages(init(), success({}))], [], { claudeModel: "opus" });
  await run(withModel.planner.planning("write the plan", schema));
  assert.equal(withModel.sdk.calls[0].options.model, "opus");

  const without = await planner([messages(init(), success({}))]);
  await run(without.planner.planning("write the plan", schema));
  assert.ok(!("model" in without.sdk.calls[0].options), "model must be absent when claudeModel is null");
});

test("the planning call passes the agent JSON Schema of the given Effect schema as outputFormat, and the project directory", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", S.PlannerResponse));
  const options = fake.sdk.calls[0].options;
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema: agentJsonSchema(S.PlannerResponse) });
  assert.equal(options.cwd, fake.project);
  assert.equal(options.permissionMode, "default");
});

// Issue #78: every call carries the inherited environment with BASH_MAX_TIMEOUT_MS set to the ceiling, the same value the
// planning prompts' rule states.
test("a planning call and an execution call carry the inherited environment with the command ceiling", async () => {
  const fake = await planner([messages(init(), success({ questions_for_user: [] })), messages(init(), success({ status: "finished", summary: "done", question: "", remaining_work: "" }))]);
  await run(fake.planner.planning("write the plan", schema));
  await run(fake.planner.executing("implement the plan", noReporter));
  const expected = claudeEnv(fake.sdk.inheritedEnv, prompts.COMMAND_CEILING_MS);
  assert.equal(expected.BASH_MAX_TIMEOUT_MS, String(prompts.COMMAND_CEILING_MS));
  assert.equal(expected.PATH, fake.sdk.inheritedEnv.PATH);
  assert.deepEqual(fake.sdk.calls.map((c) => c.options.env), [expected, expected]);
});

test("the execution call passes the agent JSON Schema of ExecReport as outputFormat", async () => {
  const fake = await planner([messages(init(), success({ status: "finished", summary: "done", question: "", remaining_work: "" }))]);
  await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(fake.sdk.calls[0].options.outputFormat, { type: "json_schema", schema: agentJsonSchema(S.ExecReport) });
});

test("execution AskUserQuestion is a stop: needs_input with the answer, even without a report", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const denials: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    denials.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success(null);
  })();
  const fake = await planner([script], ["A"]);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));

  assert.equal(denials[0]?.behavior, "deny");
  assert.equal(outcome.status, "needs_input");
  assert.equal(outcome.question, "A or B?");
  assert.equal(outcome.userInput, "A or B? -> A");
  assert.equal(fake.sdk.calls[0].options.permissionMode, "auto");
  assert.ok(fake.ui.said.includes("\nClaude Code has stopped implementation with a question."), fake.ui.said.join("\n"));
});

test("after a stop, the hook denies tools but permits the final structured output", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const seen: (string | undefined)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    seen.push(decision(await runHook(call.options, "Write")));
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    seen.push(decision(await runHook(call.options, "Write")));
    seen.push(decision(await runHook(call.options, "Bash")));
    seen.push(decision(await runHook(call.options, "StructuredOutput")));
    yield success({ status: "needs_input", summary: "s", question: "", remaining_work: "w" });
  })();
  const fake = await planner([script], ["A"]);
  await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(seen, [undefined, "deny", "deny", undefined]);
});

test("an invalid execution report after a recorded stop still yields needs_input with the user's answer", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({ status: "bogus", summary: 7 });
  })();
  const fake = await planner([script], ["A"]);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "needs_input");
  assert.equal(outcome.userInput, "A or B? -> A");
  assert.equal(outcome.summary, "");
  assert.equal(fake.sdk.calls.length, 1);
});

test("an invalid execution report without a stop yields aborted, and no repair prompt is sent", async () => {
  const fake = await planner([messages(init(), success({ status: "bogus" }, "text only"))]);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.summary, "text only");
  assert.match(outcome.question, /ended without a status report/);
  assert.equal(fake.sdk.calls.length, 1);
});

// Issue #5: Claude Code's prose is attributed as data; the page attributes it; the text carries no prefix.
test("Claude Code's prose in an execution call is a ClaudeSaid event, trimmed, and no line is said with the [claude] prefix", async () => {
  const fake = await planner([messages(init(), assistantText("  working  "), success(null, "text only"))]);
  await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(fake.ui.notified.filter((e) => e._tag === "ClaudeSaid"), [{ _tag: "ClaudeSaid", text: "working" }]);
  assert.ok(!fake.ui.said.some((l) => l.startsWith("[claude]")), "Claude Code's prose was said with the prefix");
});

test("execution without a report and without a stop is aborted", async () => {
  const fake = await planner([messages(init(), assistantText("working"), success(null, "text only"))]);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.summary, "text only");
});

// Finding 17: malformed callback data is a typed failure of the call, never a throw inside the callback.
test("a questions value that is not an array yields a deny in the callback and ClaudeCallFailed naming the field after the call", async () => {
  const results: (PermissionResult | { thrown: string } | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    results.push(await permission(call.options)("AskUserQuestion", { questions: "nope" }, callContext()).catch((e: unknown) => ({ thrown: String(e) })));
    yield success({ wrote_plan: true, questions_for_user: [] });
  })();
  const fake = await planner([script]);
  await assert.rejects(run(fake.planner.planning("plan", schema)), (e: unknown) => tag(e) === "ClaudeCallFailed" && /questions/.test((e as { message: string }).message));
  assert.equal((results[0] as PermissionResult).behavior, "deny", `the callback did not deny: ${JSON.stringify(results[0])}`);
});

// Finding 20: the stop state belongs to one execution call.
test("a second execution call cannot see the first call's stop", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  let stopped: () => void = () => undefined;
  let checked: () => void = () => undefined;
  const firstStopped = new Promise<void>((resolve) => (stopped = resolve));
  const secondChecked = new Promise<void>((resolve) => (checked = resolve));
  const seen: (string | undefined)[] = [];
  const first: Script = (call) => (async function* () {
    yield init("s-1");
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    stopped();
    await secondChecked;
    yield success({ status: "needs_input", summary: "s", question: "", remaining_work: "w" });
  })();
  const second: Script = (call) => (async function* () {
    yield init("s-2");
    await firstStopped;
    seen.push(decision(await runHook(call.options, "Write")));
    checked();
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([first, second], ["A"]);
  const [one, two] = await run(Effect.all([fake.planner.executing("first", noReporter), fake.planner.executing("second", noReporter)], { concurrency: "unbounded" }));
  assert.equal(one.status, "needs_input");
  assert.deepEqual(seen, [undefined], "the second call's hook saw the first call's stop");
  assert.equal(two.status, "finished");
});

test("an execution permission request asks the user; y allows, anything else denies", async () => {
  const results: string[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    results.push((await permission(call.options)("Bash", { command: "rm -rf /" }, callContext()))?.behavior ?? "none");
    results.push((await permission(call.options)("Bash", { command: "ls" }, callContext()))?.behavior ?? "none");
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([script], ["y", "n"]);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(results, ["allow", "deny"]);
  assert.equal(outcome.status, "finished");
});

test("interrupting a planning call aborts the Agent SDK call", async () => {
  let sawAbort = false;
  const script: Script = (call) => (async function* () {
    yield init();
    await aborted(call.options);
    sawAbort = true;
    throw new Error("The operation was aborted");
  })();
  const fake = await planner([script]);
  const reached = fake.sdk.nextCall();
  const fiber = Effect.runFork(fake.planner.planning("write the plan", schema).pipe(Effect.provideService(Decider, noDecider)));
  await reached;
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.equal(sawAbort, true, "the SDK call was not aborted");
});

test("a UserStopped inside canUseTool ends the call with UserStopped", async () => {
  const script: Script = (call) => (async function* () {
    yield init();
    try {
      await permission(call.options)("Bash", { command: "ls" }, callContext());
    } catch {
      // The adapter answers the SDK; the failure reaches the caller of the call.
    }
    if (call.options.abortController !== undefined) await aborted(call.options);
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([script], ["q"]);
  await assert.rejects(run(fake.planner.executing("implement the plan", noReporter)), (e: unknown) => tag(e) === "UserStopped");
});

test("a failure while recording usage aborts the SDK call, closes its stream, and fails the call with that error", async () => {
  // Found by a Codex review: a typed failure inside the message loop left the iterator open and
  // the call un-aborted, so the Claude Code process could outlive the HALTED message.
  let closed = false;
  const script: Script = (call) => (async function* () {
    try {
      yield init();
      yield success({});
      await aborted(call.options);
    } finally {
      closed = true;
    }
  })();
  const failing: Partial<StoreShape> = { recordUsage: () => Effect.fail(new FileSystemError({ operation: "append to", path: "usage.jsonl", message: "disk full" })) };
  const fake = await planner([script], [], {}, failing);
  await assert.rejects(run(fake.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "FileSystemError");
  assert.equal(closed, true, "the SDK stream was not closed");
  assert.equal(fake.sdk.calls[0].options.abortController?.signal.aborted, true, "the SDK call was not aborted");
});

test("an SDK that fails to start is a call error: ClaudeCallFailed for planning, aborted for execution", async () => {
  // Found by a Codex review: a synchronous throw of sdk.query (for example a missing CLI binary)
  // became a defect that bypassed the HALTED output and the aborted outcome.
  const failing: Script = () => {
    throw new Error("spawn claude ENOENT");
  };
  const planning = await planner([failing]);
  await assert.rejects(run(planning.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "ClaudeCallFailed" && /spawn claude ENOENT/.test(String((e as { message: string }).message)));
  const executing = await planner([failing]);
  const outcome = await run(executing.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "aborted");
  assert.match(outcome.question, /spawn claude ENOENT/);
});

// Finding 18 of docs/functional-design-review.md: parseInt accepted a prefix, so "1 please explain" chose option 1.
test("only a whole in-range number chooses an option; anything else is the answer as typed", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const answersFor = async (reply: string): Promise<string> => {
    let relayed: Record<string, string> = {};
    const script: Script = (call) => (async function* () {
      yield init();
      const result = await permission(call.options)("AskUserQuestion", { questions }, callContext());
      relayed = ((result as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers) ?? {};
      yield success({});
    })();
    const fake = await planner([script], [reply]);
    await run(fake.planner.planning("write the plan", schema));
    return relayed["A or B?"] ?? "";
  };
  assert.equal(await answersFor("1 please explain"), "1 please explain");
  assert.equal(await answersFor("1.5"), "1.5");
  assert.equal(await answersFor("0"), "0");
  assert.equal(await answersFor("3"), "3");
  assert.equal(await answersFor(" 2 "), "B");
});

// Step 2.5 of the plan: answers are collected by question index; two questions with the same text are
// answered separately, the later one wins in the SDK object, and the record says so once.
test("two questions with identical text are answered separately; the later answer reaches the SDK, with one note in the record", async () => {
  const questions = [{ question: "Same?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }, { question: "Same?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  let relayed: Record<string, string> = {};
  const script: Script = (call) => (async function* () {
    yield init();
    const result = await permission(call.options)("AskUserQuestion", { questions }, callContext());
    relayed = ((result as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers) ?? {};
    yield success({});
  })();
  const fake = await planner([script], ["1", "2"]);
  await run(fake.planner.planning("write the plan", schema));
  assert.deepEqual(relayed, { "Same?": "B" });
  const conversation = fs.readFileSync(path.join(fake.dir, "conversation.md"), "utf8");
  assert.equal(conversation.match(/\*\*User answer:\*\*/g)?.length, 2, "both answers are recorded");
  assert.equal(conversation.match(/\*\*Duplicate question text:\*\*/g)?.length, 1, "exactly one note");
  const edge = toSdkAnswers(questions, new Map([[0, "A"], [1, "B"]]));
  assert.deepEqual(edge.answers, { "Same?": "B" });
  assert.deepEqual(edge.duplicates, ["Same?"]);
  assert.deepEqual(toSdkAnswers([{ question: "X?" }, { question: "Y?" }], new Map([[0, "a"], [1, "b"]])), { answers: { "X?": "a", "Y?": "b" }, duplicates: [] });
});

// Plan step 1.7 (decision Q5): the adapter reports its activity; the run says its lines for the interview only.
const activity = (ui: ScriptedUi) => ui.notified.filter((e) => e._tag === "AgentCallStarted" || e._tag === "ToolUsed" || e._tag === "AgentCallEnded" || e._tag === "QuestionPresented");

test("a planning call notifies its start, every tool use other than StructuredOutput, and its end", async () => {
  const fake = await planner([messages(init(), assistantTool("Read", { file_path: "/x" }), assistantTool("Grep", { pattern: "foo" }), assistantTool("StructuredOutput", {}), success({ questions_for_user: [] }))]);
  await run(fake.planner.planning("write the plan", schema, "planning"));
  assert.deepEqual(activity(fake.ui), [
    { _tag: "AgentCallStarted", agent: "claude", purpose: "planning" },
    { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "/x" },
    { _tag: "ToolUsed", agent: "claude", tool: "Grep", target: "foo" },
    { _tag: "AgentCallEnded", agent: "claude", ok: true },
  ]);
  assert.ok(!fake.ui.said.some((l) => l.includes("[claude: Read")), "a planning call printed its tool use");
});

test("an interview call says its lines for the tool use", async () => {
  const fake = await planner([messages(init(), assistantTool("Read", { file_path: "/x" }), success({}))]);
  await run(fake.planner.planning("interview", schema, "interview"));
  assert.ok(fake.ui.said.includes("  [claude: Read /x]"));
  assert.deepEqual(activity(fake.ui)[0], { _tag: "AgentCallStarted", agent: "claude", purpose: "interview" });
});

test("a call that fails ends with AgentCallEnded ok false", async () => {
  const fake = await planner([messages(init(), failure("error_during_execution"))]);
  await run(Effect.result(fake.planner.planning("write the plan", schema, "planning")));
  assert.deepEqual(activity(fake.ui).at(-1), { _tag: "AgentCallEnded", agent: "claude", ok: false });
});

test("a stream failure ends the call with AgentCallEnded ok false", async () => {
  const script: Script = () => (async function* () {
    yield init();
    throw new Error("stream broke");
  })();
  const fake = await planner([script]);
  await run(Effect.result(fake.planner.planning("write the plan", schema, "planning")));
  assert.deepEqual(activity(fake.ui).at(-1), { _tag: "AgentCallEnded", agent: "claude", ok: false });
});

test("an interrupted call ends with AgentCallEnded ok false", async () => {
  const script: Script = (call) => (async function* () {
    yield init();
    await aborted(call.options);
    throw new Error("The operation was aborted");
  })();
  const fake = await planner([script]);
  const reached = fake.sdk.nextCall();
  const fiber = Effect.runFork(fake.planner.planning("write the plan", schema, "planning").pipe(Effect.provideService(Decider, noDecider)));
  await reached;
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.deepEqual(activity(fake.ui).at(-1), { _tag: "AgentCallEnded", agent: "claude", ok: false });
});

test("a relayed question is notified with its options before the user is asked", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({});
  })();
  const fake = await planner([script], ["2"]);
  await run(fake.planner.planning("write the plan", schema, "planning"));
  const presented = activity(fake.ui).filter((e) => e._tag === "QuestionPresented");
  assert.equal(presented.length, 1);
  const q = presented[0]._tag === "QuestionPresented" ? presented[0].question : null;
  assert.equal(q === null ? null : piecesText(q.question), "A or B?");
  assert.deepEqual(q?.origin, { kind: "relayed" });
  assert.deepEqual(q?.options, [{ label: plain("A"), description: plain("a"), answer: { token: "1" } }, { label: plain("B"), description: plain("b"), answer: { token: "2" } }]);
});

// S8: a relayed question reaches the user as its QuestionPresented event, so the adapter says none of its lines.
test("a relayed question says no line of its own: it is presented as an event", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({});
  })();
  const fake = await planner([script], ["2"]);
  await run(fake.planner.planning("write the plan", schema, "planning"));
  assert.deepEqual(fake.ui.said.filter((l) => !l.startsWith("Claude Code model: ")), []);
});

test("an execution call notifies its start with the purpose execution", async () => {
  const fake = await planner([messages(init(), success({ status: "finished", summary: "s", question: "", remaining_work: "" }))]);
  await run(fake.planner.executing("go", noReporter));
  assert.deepEqual(activity(fake.ui)[0], { _tag: "AgentCallStarted", agent: "claude", purpose: "execution" });
  assert.deepEqual(activity(fake.ui).at(-1), { _tag: "AgentCallEnded", agent: "claude", ok: true });
});

// Stage A (finding 1 of docs/gui-review.md): a work response is read-only by capability, not by a list of tool names.
test("a read-only planning call registers one hook without a matcher that denies every tool but the structured output", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("answer the review", schema, "planning", "readOnly"));
  const options = fake.sdk.calls[0].options;
  const hooks = options.hooks?.PreToolUse ?? [];
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].matcher, undefined, "a matcher would let an unlisted tool pass");
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Read", "AskUserQuestion", "FutureTool"]) {
    assert.equal(decision(await runHook(options, tool, { file_path: path.join(fake.dir, "plan.md"), command: "ls" })), "deny", tool);
  }
  assert.equal(decision(await runHook(options, "StructuredOutput", {})), undefined);
});

test("a read-only planning call's permission callback denies a question without relaying it, and an edit", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("answer the review", schema, "planning", "readOnly"));
  const options = fake.sdk.calls[0].options;
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  assert.equal((await permission(options)("AskUserQuestion", { questions }, callContext()))?.behavior, "deny");
  assert.deepEqual(fake.ui.asked, [], "the question reached the user");
  assert.equal((await permission(options)("Write", { file_path: path.join(fake.dir, "plan.md") }, callContext()))?.behavior, "deny");
});

test("each call carries its own capability: a read-only call and then a records call on the same planner", async () => {
  const fake = await planner([messages(init(), success({})), messages(init(), success({}))]);
  await run(fake.planner.planning("answer the review", schema, "planning", "readOnly"));
  await run(fake.planner.planning("write the plan", schema));
  assert.equal(decision(await runHook(fake.sdk.calls[0].options, "Write", { file_path: path.join(fake.dir, "notes.md") })), "deny");
  assert.equal(decision(await runHook(fake.sdk.calls[1].options, "Write", { file_path: path.join(fake.dir, "notes.md") })), undefined);
});

// Decision support, plan step 3.5: a relayed question with options and a permission request carry the offer.
const recordingDecider = (): { decider: DeciderShape; requests: unknown[]; explained: ContextRequest[] } => {
  const requests: unknown[] = [];
  const explained: ContextRequest[] = [];
  const decider: DeciderShape = {
    at: () => decider,
    explain: (request) => Effect.sync(() => (explained.push(request), programWritten(request))),
    decide: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { decision: requests.length, analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } }, result: "converged" as const };
      }),
  };
  return { decider, requests, explained };
};

test("a relayed question with options offers Help me decide, presents the question again, and relays the answer", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const relayed: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    relayed.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success({});
  })();
  const fake = await planner([script], ["/decide", "2"]);
  const { decider, requests } = recordingDecider();
  await run(fake.planner.planning("write the plan", schema), decider);
  const [{ shown, ...request }] = requests as { shown: { context: string; terms: string; details: string } }[];
  assert.deepEqual(request, { question: "A or B?", options: questions[0].options, number: 1 });
  // S37: the analysis is given the question as the user was shown it.
  assert.deepEqual(shown, { context: prompts.fallbackContext({ kind: "relayed" }), history: "", terms: "", details: "" });
  // Issue #133: the offer on the first ask alone; the question asked beside its analysis carries none.
  assert.ok(fake.ui.asked[0].startsWith(prompts.OFFER_LINE));
  assert.ok(fake.ui.asked.slice(1).every((a) => !a.startsWith(prompts.OFFER_LINE)));
  assert.equal(fake.ui.notified.filter((e) => e._tag === "QuestionPresented").length, 2, "the question is presented again after the analysis");
  assert.ok(fake.ui.notified.some((e) => e._tag === "DecisionAnalyzed"));
  assert.deepEqual(relayed[0], { behavior: "allow", updatedInput: { questions, answers: { "A or B?": "B" } } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fake.dir, "decision-1", "chosen.json"), "utf8")).option, "B");
});

test("an execution permission request offers Help me decide over Allow and Deny", async () => {
  const results: string[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    results.push((await permission(call.options)("Bash", { command: "rm -rf build" }, callContext()))?.behavior ?? "none");
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([script], ["/decide", "y"]);
  const { decider, requests, explained } = recordingDecider();
  await run(fake.planner.executing("implement the plan", noReporter), decider);
  assert.deepEqual(results, ["allow"]);
  const request = requests[0] as { question: string; options: { label: string }[] };
  assert.equal(request.question, prompts.permissionQuestion("Bash", { command: "rm -rf build" }));
  assert.ok(!request.question.includes("rm -rf build"));
  // S12: the context call is given the tool and its input in prose, not the input's JSON.
  assert.equal(explained.length, 1);
  assert.match(explained[0].facts, /its tool Bash with this input:\ncommand \(The command\): rm -rf build\n/);
  assert.ok(!explained[0].facts.includes("{"), explained[0].facts);
  assert.deepEqual(request.options.map((o) => o.label), [prompts.PERMISSION_ALLOW, prompts.PERMISSION_DENY]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fake.dir, "decision-1", "chosen.json"), "utf8")).option, prompts.PERMISSION_ALLOW);
});

// W1-R1-1, W1-R1-2: a blank answer to a relayed question is asked again, presented again, and not recorded.
test("a relayed question answered /decide, blank, 2 records option 2 and relays B", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const relayed: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    relayed.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success({});
  })();
  const fake = await planner([script], ["/decide", "", "2"]);
  const { decider } = recordingDecider();
  await run(fake.planner.planning("write the plan", schema), decider);
  assert.deepEqual(relayed[0], { behavior: "allow", updatedInput: { questions, answers: { "A or B?": "B" } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fake.dir, "decision-1", "chosen.json"), "utf8")), { version: 2, decision: 1, answer: "2", option: "B" });
});

test("a blank answer to a relayed question presents it again before the retry, with two options and with one", async () => {
  for (const options of [[{ label: "A", description: "a" }, { label: "B", description: "b" }], [{ label: "A", description: "a" }]]) {
    const questions = [{ question: "Which?", options }];
    const script: Script = (call) => (async function* () {
      yield init();
      await permission(call.options)("AskUserQuestion", { questions }, callContext());
      yield success({});
    })();
    const fake = await planner([script], ["", "1"]);
    await run(fake.planner.planning("write the plan", schema));
    assert.equal(fake.ui.notified.filter((e) => e._tag === "QuestionPresented").length, 2, `${options.length} option(s)`);
  }
});

// Issue #6 (Q2, Q3, P1-R1-4): an execution call offers report_step, answered by the reporter of its phase; the tool
// needs no permission, is denied after a stop like every other tool, is absent from planning calls, and the plan's
// files cannot be edited by a tool during execution.
const report = { status: "finished", summary: "done", question: "", remaining_work: "" };
/** Every PreToolUse hook of a call whose matcher admits the tool, in order; the first decision that is given. */
const runHooks = async (options: Options, toolName: string, toolInput: Record<string, unknown> = {}): Promise<string | undefined> => {
  for (const entry of options.hooks?.PreToolUse ?? []) {
    if (entry.matcher !== undefined && !entry.matcher.split("|").includes(toolName)) continue;
    for (const h of entry.hooks) {
      const d = decision(await h({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput } as PreToolUseHookInput, undefined, { signal: new AbortController().signal }));
      if (d !== undefined) return d;
    }
  }
  return undefined;
};

test("an execution call offers report_step without a permission prompt, and each report reaches the reporter", async () => {
  const reports: string[] = [];
  const reporter = (id: string, status: "started" | "done") => Effect.sync(() => (reports.push(`${id}:${status}`), { text: `ok ${id}`, isError: id === "S9" }));
  const answers: unknown[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    answers.push(await permission(call.options)(prompts.REPORT_STEP_TOOL_NAME, { id: "S1", status: "started" }, callContext()));
    answers.push(await reportStep(call.options, "S1", "started"));
    answers.push(await reportStep(call.options, "S9", "done"));
    yield success(report);
  })();
  const fake = await planner([script]);
  await run(fake.planner.executing("implement the plan", reporter));
  const options = fake.sdk.calls[0].options;
  assert.ok(options.allowedTools?.includes(prompts.REPORT_STEP_TOOL_NAME));
  assert.deepEqual(answers, [{ behavior: "allow", updatedInput: { id: "S1", status: "started" } }, { text: "ok S1", isError: false }, { text: "ok S9", isError: true }]);
  assert.deepEqual(reports, ["S1:started", "S9:done"]);
  assert.deepEqual(fake.ui.asked, [], "report_step asked the user for permission");
});

test("report_step is denied after a stop, and a planning call offers no report_step", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const seen: (string | undefined)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    seen.push(await runHooks(call.options, prompts.REPORT_STEP_TOOL_NAME));
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    seen.push(await runHooks(call.options, prompts.REPORT_STEP_TOOL_NAME));
    yield success({ ...report, status: "needs_input" });
  })();
  const fake = await planner([script, messages(init(), success({ questions_for_user: [] }))], ["A"]);
  await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(seen, [undefined, "deny"]);
  await run(fake.planner.planning("write the plan", schema));
  assert.equal(fake.sdk.calls[1].options.mcpServers, undefined);
});

test("during execution an edit of plan.json or plan.md is denied; other edits are not", async () => {
  const fake = await planner([messages(init(), success(report))]);
  await run(fake.planner.executing("implement the plan", noReporter));
  const options = fake.sdk.calls[0].options;
  assert.equal(await runHooks(options, "Write", { file_path: path.join(fake.dir, "plan.json") }), "deny");
  assert.equal(await runHooks(options, "Edit", { file_path: path.relative(fake.project, path.join(fake.dir, "plan.md")) }), "deny");
  assert.equal(await runHooks(options, "Edit", { file_path: path.join(fake.project, "src", "x.ts") }), undefined);
});

// The seam of Q2: the prompt names the tool and the statuses exactly as the tool's constants define them.
test("the execution prompt names report_step and its statuses as the tool defines them", () => {
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true).includes(prompts.REPORT_STEP_TOOL));
  for (const status of prompts.REPORT_STEP_STATUSES) assert.ok(prompts.executePrompt(TEST_ROOT, "t", true).includes(`'${status}'`), status);
  assert.match(prompts.executePrompt(TEST_ROOT, "t", true), /plan-review\/runs\/[^/\s]+\/plan\.json/);
  assert.doesNotMatch(prompts.executePrompt(TEST_ROOT, "t", true), /marker/);
});

// Issue #53 (Q1, G-R1-1): any order, one step open at a time, a resumed step reported started again; nothing is refused.
test("the execution prompt allows any order with one step open at a time, and asks for a resumed step to be reported again", () => {
  assert.doesNotMatch(prompts.executePrompt(TEST_ROOT, "t", true), /in order/);
  assert.match(prompts.executePrompt(TEST_ROOT, "t", true), /in any order/);
  assert.match(prompts.executePrompt(TEST_ROOT, "t", true), /one step open at a time/);
  assert.match(prompts.resumeStepSentence, new RegExp(`'${prompts.REPORT_STEP_STATUSES[0]}' again`));
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true).includes(prompts.resumeStepSentence));
});

// Issue #26: a failed planning call is TransportFault when src/transport.ts says so, ClaudeCallFailed otherwise, and
// neither reaches the decoding, so neither spends a repair turn.
const throwing = (error: unknown, before: SDKMessage[] = []): Script => () => (async function* () {
  yield init();
  for (const m of before) yield m;
  throw error;
})();
const isErrorResult = (status: number): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: true, api_error_status: status, terminal_reason: "api_error", result: `API Error: ${status}`, structured_output: null, total_cost_usd: 0.1, num_turns: 1 }) as unknown as SDKMessage;
const failedTag = async (fake: Awaited<ReturnType<typeof planner>>): Promise<string> => {
  const result = await run(Effect.result(fake.planner.planning("write the plan", schema)));
  assert.ok(result._tag === "Failure", "the planning call succeeded");
  return (result.failure as { _tag: string })._tag;
};

test("a stream that throws ECONNRESET makes planning fail with TransportFault", async () => {
  const fake = await planner([throwing(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))]);
  assert.equal(await failedTag(fake), "TransportFault");
});

test("a success result with is_error and status 503 is TransportFault; with 400 it is ClaudeCallFailed; one call each", async () => {
  const f503 = await planner([messages(init(), isErrorResult(503))]);
  assert.equal(await failedTag(f503), "TransportFault");
  assert.equal(f503.sdk.calls.length, 1);
  const f400 = await planner([messages(init(), isErrorResult(400))]);
  assert.equal(await failedTag(f400), "ClaudeCallFailed");
  assert.equal(f400.sdk.calls.length, 1);
});

test("error_max_turns is ClaudeCallFailed", async () => {
  assert.equal(await failedTag(await planner([messages(init(), failure("error_max_turns"))])), "ClaudeCallFailed");
});

test("progress after an api_retry or an assistant error clears it: a later stream error without a code is ClaudeCallFailed", async () => {
  const retry = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 503, error: "server_error" } as unknown as SDKMessage;
  const serverError = { type: "assistant", error: "server_error", message: { content: [] } } as unknown as SDKMessage;
  assert.equal(await failedTag(await planner([throwing(new Error("broke"), [retry, assistantText("resumed")])])), "ClaudeCallFailed");
  assert.equal(await failedTag(await planner([throwing(new Error("broke"), [serverError, assistantText("fine")])])), "ClaudeCallFailed");
  assert.equal(await failedTag(await planner([throwing(new Error("broke"), [serverError])])), "TransportFault");
});

test("an api_retry with 429 before an ECONNRESET is ClaudeCallFailed (P1-R1-2)", async () => {
  const retry = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" } as unknown as SDKMessage;
  assert.equal(await failedTag(await planner([throwing(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), [retry])])), "ClaudeCallFailed");
});

test("an api_retry message is notified as AgentReconnecting", async () => {
  const retry = { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 1500, error_status: 503, error: "server_error" } as unknown as SDKMessage;
  const fake = await planner([messages(init(), retry, success({ questions_for_user: [] }))]);
  await run(fake.planner.planning("write the plan", schema));
  assert.deepEqual(fake.ui.notified.filter((e) => e._tag === "AgentReconnecting"), [
    { _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: 2, of: 10, delayMs: 1500, detail: "status 503, server_error" },
  ]);
});

test("a callback failure wins over a transport fault", async () => {
  const script: Script = ({ options }) => (async function* () {
    yield init();
    await permission(options)("AskUserQuestion", { questions: "nope" }, callContext());
    throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  })();
  const fake = await planner([script]);
  assert.equal(await failedTag(fake), "ClaudeCallFailed");
});

// Issue #26 (S20, Q4): an execution call that fails from a transport fault resumes its session with the continue prompt,
// with the same hooks, stop and report_step server; the retry is inside the adapter.
const econnreset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const quickRetry = { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 };

test("an execution call whose stream drops is resumed with the continue prompt and finishes; S1's report is received once", async () => {
  const reports: string[] = [];
  const reporter = (id: string, status: "started" | "done") => Effect.sync(() => (reports.push(`${id}:${status}`), { text: "ok", isError: false }));
  const first: Script = (call) => (async function* () {
    yield init("session-exec");
    await reportStep(call.options, "S1", "done");
    throw econnreset();
  })();
  const second: Script = () => (async function* () {
    yield init("session-exec");
    yield success(report);
  })();
  const fake = await planner([first, second], [], quickRetry);
  const outcome = await run(fake.planner.executing("implement the plan", reporter));
  assert.equal(outcome.status, "finished");
  assert.equal(fake.sdk.calls.length, 2);
  assert.equal(fake.sdk.calls[1].prompt, prompts.executionContinuePrompt);
  assert.equal(fake.sdk.calls[1].options.resume, "session-exec");
  assert.ok(fake.sdk.calls[1].options.allowedTools?.includes(prompts.REPORT_STEP_TOOL_NAME));
  assert.ok(prompts.executionContinuePrompt.includes(prompts.REPORT_STEP_TOOL_NAME), "the continue prompt names the tool the call offers");
  assert.deepEqual(reports, ["S1:done"]);
  assert.equal(fake.ui.notified.filter((e) => e._tag === "TransportRetrying").length, 1);
});

test("a valid finished report delivered before the stream drops stands: no second query (P1-R1-3)", async () => {
  const script: Script = () => (async function* () {
    yield init();
    yield success(report);
    throw econnreset();
  })();
  const fake = await planner([script], [], quickRetry);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "finished");
  assert.equal(fake.sdk.calls.length, 1);
});

test("a stop recorded before a transport fault ends the phase: no second query", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    throw econnreset();
  })();
  const fake = await planner([script], ["A"], quickRetry);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "needs_input");
  assert.equal(fake.sdk.calls.length, 1);
});

test("an execution call that fails for another reason is aborted, as before: no second query", async () => {
  const script: Script = () => (async function* () {
    yield init();
    throw new Error("broke");
  })();
  const fake = await planner([script], [], quickRetry);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(outcome.status, "aborted");
  assert.equal(fake.sdk.calls.length, 1);
});

test("faults beyond the retries, then Stop at the exhaustion pause: executing fails with AgentUnreachable", async () => {
  const dropping: Script = () => (async function* () {
    yield init();
    throw econnreset();
  })();
  const fake = await planner([dropping, dropping], [prompts.TRANSPORT_ANSWERS.stop], quickRetry);
  await assert.rejects(run(fake.planner.executing("implement the plan", noReporter)), (e: unknown) => tag(e) === "AgentUnreachable");
  assert.equal(fake.sdk.calls.length, 2);
});

// S14 (Q2, G-R1-2): a relayed question in the shape of RELAYED_SHAPE is shown from its own parts; any other is not denied,
// and a context call writes its context and terms while the execution call waits.
test("a relayed question in the shape is presented from its own parts, with no context call", async () => {
  const zod = { id: "z", term: "zod", senses: ["A library that checks the shape of data."] };
  const options = [{ label: "Declare it", description: "add it to package.json" }, { label: "Leave it", description: "keep it the SDK's" }];
  const text = prompts.relayedQuestionText({
    context: [{ kind: "paragraph", pieces: [...plain("Claude Code, the coding agent, checks the input of a tool with "), term("Zod", "z"), ...plain(", a library, now, while it carries out the plan, so that bad input is refused.")] }],
    history: para("You kept the library out of package.json on 9 Oct 2026."),
    question: [...plain("Should "), term("zod", "z"), ...plain(" be declared as a dependency?")],
    explanations: [zod],
    options: [{ label: plain("Declare it"), description: [...plain("add it to package.json")] }, { label: plain("Leave it"), description: plain("keep it the SDK's") }],
  });
  const questions = [{ question: text, options }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({ status: "needs_input", summary: "s", question: "q", remaining_work: "r" });
  })();
  const fake = await planner([script], ["1"]);
  const { decider, explained } = recordingDecider();
  await run(fake.planner.executing("implement the plan", noReporter), decider);
  assert.deepEqual(explained, []);
  const [q] = fake.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
  assert.equal(piecesText(q.question), "Should zod be declared as a dependency?");
  assert.equal(q.context.by, "agent");
  assert.match(blocksMarkdown(q.context.blocks), /^Claude Code, the coding agent/);
  assert.deepEqual(q.explanations, [zod]);
  assert.deepEqual(q.options.map((o) => piecesText(o.label)), ["Declare it", "Leave it"]);
  // Issue #133 (S4): the relayed history reaches the page.
  assert.deepEqual(q.history, para("You kept the library out of package.json on 9 Oct 2026."));
});

test("a relayed question without the shape is not denied: a context call writes its context from the question and the plan", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({ status: "needs_input", summary: "s", question: "q", remaining_work: "r" });
  })();
  const fake = await planner([script], ["2"]);
  fs.writeFileSync(path.join(fake.dir, "plan.md"), "# The plan\n\n1. Build it.\n");
  const { decider, explained } = recordingDecider();
  const outcome = await run(fake.planner.executing("implement the plan", noReporter), decider);
  assert.equal(explained.length, 1);
  assert.equal(piecesText(explained[0].question), "A or B?");
  assert.deepEqual(explained[0].origin, { kind: "relayed" });
  assert.match(explained[0].facts, /# The plan\n\n1\. Build it\./);
  const [q] = fake.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
  assert.equal(piecesText(q.question), "A or B?");
  assert.ok(outcome.status === "needs_input");
  assert.match(outcome.userInput ?? "", /A or B\? -> B/, "the recorded stop and its answer are unchanged");
});

// S33 (W1-R1-1): the context call's capability reads the project and changes nothing.
test("a readProject planning call's hook lets the read tools and the structured output through and denies every other tool", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("explain the question", schema, "context", "readProject"));
  const options = fake.sdk.calls[0].options;
  const hooks = options.hooks?.PreToolUse ?? [];
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].matcher, undefined, "a matcher would let an unlisted tool pass");
  for (const tool of ["Read", "Grep", "Glob", "StructuredOutput"]) assert.equal(decision(await runHook(options, tool, { file_path: path.join(fake.dir, "plan.md"), pattern: "x" })), undefined, tool);
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "AskUserQuestion", "WebFetch", "FutureTool"]) {
    assert.equal(decision(await runHook(options, tool, { file_path: path.join(fake.dir, "notes.md"), command: "ls" })), "deny", tool);
  }
  assert.equal((await permission(options)("Write", { file_path: path.join(fake.dir, "notes.md") }, callContext()))?.behavior, "deny");
});

// S34 (W1-R1-2, P2-R1-2): a permission request shows every field of the tool's input, named in plain words or, for a
// field Interloq has no words for, under its own name explained as a term, whether or not the context call succeeded.
const permissionAsked = async (tool: string, input: Record<string, unknown>, explain?: DeciderShape["explain"]) => {
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)(tool, input, callContext());
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([script], ["n"]);
  const { decider } = recordingDecider();
  await run(fake.planner.executing("implement the plan", noReporter), explain === undefined ? decider : { ...decider, explain });
  const [q] = fake.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
  return { q, conversation: fs.readFileSync(path.join(fake.dir, "conversation.md"), "utf8") };
};

test("an Edit permission shows the file and both texts under plain labels, never the raw keys, with the program's context", async () => {
  const { q, conversation } = await permissionAsked("Edit", { file_path: "/tmp/config", old_string: "safe", new_string: "unsafe" });
  assert.equal(q.context.by, "program");
  // Issue #137: the input is attached as the request, its heading written by the record alone.
  assert.equal(q.attached?.kind, "request");
  assert.deepEqual(q.attached?.blocks, prompts.toolInputBlocks({ file_path: "/tmp/config", old_string: "safe", new_string: "unsafe" }));
  assert.ok(conversation.includes(`**${prompts.attachedHeading("request")}**`));
  assert.ok(!/what claude code would do/i.test(blocksMarkdown(q.attached?.blocks ?? [])), "no heading paragraph of its own");
  for (const text of [blocksMarkdown(q.attached?.blocks ?? []), renderQuestionRecord(q), conversation]) {
    for (const shown of ["/tmp/config", "safe", "unsafe"]) assert.ok(text.includes(shown), `${shown} in ${text}`);
    for (const raw of ["file_path", "old_string", "new_string"]) assert.ok(!text.includes(raw), `${raw} in ${text}`);
  }
});

test("an unknown field keeps its own name, explained as a term, with and without the context call", async () => {
  const overwrite = await permissionAsked("FutureTool", { overwrite: true });
  const dryRun = await permissionAsked("FutureTool", { dry_run: true });
  assert.notEqual(overwrite.q.attached, dryRun.q.attached);
  assert.deepEqual(overwrite.q.explanations, [{ id: "setting-1", term: "overwrite", senses: [prompts.unknownSettingExplanation] }]);
  assert.deepEqual(dryRun.q.explanations, [{ id: "setting-1", term: "dry_run", senses: [prompts.unknownSettingExplanation] }]);
  // The context call rewrites the explanation of the same id, which the name's code piece keeps referring to.
  const agent = await permissionAsked("FutureTool", { overwrite: true }, () =>
    Effect.succeed({ context: { blocks: plainBlocks("Written by Claude Code."), by: "agent" as const }, history: [], explanations: [{ id: "setting-1", term: "overwrite", senses: ["Replaces the file if it exists."] }] }),
  );
  assert.deepEqual(agent.q.explanations, [{ id: "setting-1", term: "overwrite", senses: ["Replaces the file if it exists."] }]);
  const named = (agent.q.attached?.blocks ?? []).flatMap((b) => (b.kind === "list" ? b.items.flatMap((i) => i.pieces) : [])).find((p) => p.code && p.ref !== "");
  assert.deepEqual(named, { text: "overwrite", ref: "setting-1", code: true });
});

test("the context call's facts name the unknown fields and ask for each to be explained as a term", async () => {
  const facts = prompts.permissionFacts("FutureTool", { overwrite: true, file_path: "/x" });
  assert.match(facts, /overwrite/);
  assert.match(facts, /file_path \(The file\): \/x/);
  assert.ok(facts.includes(prompts.unknownSettingsRequest(["overwrite"])));
});

// Issue #68: a call rejected for a usage limit with a stated reset is waited out and made again; without a reset it
// fails or is aborted exactly as before.
const LIMIT_START = Date.UTC(2026, 8, 30, 5, 32);
const LIMIT_RESET_S = LIMIT_START / 1000 + 9_000;
const LIMIT_MARGIN_MS = USAGE_LIMIT_MARGIN_SECONDS * 1000;
const rejectedWith = (resetsAt: number | undefined): SDKMessage[] => [rateLimit({ status: "rejected", rateLimitType: "five_hour", ...(resetsAt === undefined ? {} : { resetsAt }) }), limitError(), limitResult()];
const limitedCall = (resetsAt: number | undefined, before: (call: Parameters<Script>[0]) => Promise<void> = async () => undefined, rateEvent = true): Script => (call) => (async function* () {
  yield init("session-exec");
  await before(call);
  for (const m of rateEvent ? rejectedWith(resetsAt) : rejectedWith(resetsAt).slice(1)) yield m;
})();

test("a planning call rejected with a reset fails with UsageLimited carrying the instant; through planningCall it waits and is made again", async () => {
  const limitedOnce = await planner([limitedCall(LIMIT_RESET_S)]);
  const result = await run(Effect.result(limitedOnce.planner.planning("write the plan", schema)));
  assert.ok(result._tag === "Failure");
  const limited = result.failure as { _tag: string; message: string; resetsAtMs: number; limitType: string | null };
  assert.deepEqual([limited._tag, limited.message, limited.resetsAtMs, limited.limitType], ["UsageLimited", "You've hit your session limit", LIMIT_RESET_S * 1000, "five_hour"]);

  const fake = await planner([limitedCall(LIMIT_RESET_S), messages(init("session-exec"), success({ questions_for_user: [] }))]);
  const { clock, sleeps } = steppingClock(LIMIT_START);
  const called = planningCall("write the plan", schema).pipe(Effect.provideService(Planner, fake.planner), Effect.provide(fake.deps), Effect.provideService(Clock.Clock, clock));
  const out = await run(called);
  assert.deepEqual(out.output, { questions_for_user: [] });
  assert.deepEqual(sleeps, [9_000_000 + LIMIT_MARGIN_MS]);
  assert.equal(fake.sdk.calls.length, 2);
  assert.deepEqual(fake.ui.asked, []);
});

test("an execution call rejected with a reset waits, resumes its session with the continue prompt, and finishes; the step's end runs once", async () => {
  const reports: string[] = [];
  const reporter = (id: string, status: "started" | "done") => Effect.sync(() => (reports.push(`${id}:${status}`), { text: "ok", isError: false }));
  const first = limitedCall(LIMIT_RESET_S, (call) => reportStep(call.options, "S1", "started").then(() => undefined));
  const second: Script = (call) => (async function* () {
    yield init("session-exec");
    await reportStep(call.options, "S1", "done");
    yield success(report);
  })();
  const fake = await planner([first, second]);
  const { clock, sleeps } = steppingClock(LIMIT_START);
  const outcome = await run(fake.planner.executing("implement the plan", reporter).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(outcome.status, "finished");
  assert.deepEqual(sleeps, [9_000_000 + LIMIT_MARGIN_MS]);
  assert.equal(fake.sdk.calls.length, 2);
  assert.equal(fake.sdk.calls[1].prompt, prompts.executionContinuePrompt);
  assert.equal(fake.sdk.calls[1].options.resume, "session-exec");
  assert.ok(fake.sdk.calls[1].options.allowedTools?.includes(prompts.REPORT_STEP_TOOL_NAME));
  assert.ok(fake.sdk.calls[1].options.mcpServers?.[prompts.REPORT_STEP_SERVER] !== undefined);
  assert.deepEqual(reports, ["S1:started", "S1:done"]);
  assert.deepEqual(fake.ui.asked, []);
  assert.equal(fake.ui.notified.filter((e) => e._tag === "UsageLimitWaiting").length, 1);
});

test("without a reset, or with no rate-limit event at all: planning fails with ClaudeCallFailed and execution is aborted, with no wait", async () => {
  for (const [resetsAt, rateEvent] of [[undefined, true], [LIMIT_RESET_S, false]] as const) {
    const p = await planner([limitedCall(resetsAt, undefined, rateEvent)]);
    const result = await run(Effect.result(p.planner.planning("write the plan", schema)));
    assert.ok(result._tag === "Failure");
    assert.equal(tag(result.failure), "ClaudeCallFailed");
    const e = await planner([limitedCall(resetsAt, undefined, rateEvent)]);
    const { clock, sleeps } = steppingClock(LIMIT_START);
    const outcome = await run(e.planner.executing("implement the plan", noReporter).pipe(Effect.provideService(Clock.Clock, clock)));
    assert.equal(outcome.status, "aborted");
    assert.deepEqual(sleeps, []);
    assert.equal(e.sdk.calls.length, 1);
    assert.ok(!e.ui.notified.some((ev) => ev._tag === "UsageLimitWaiting"));
  }
});

test("a stop or a valid report before the rejection ends the execution call without a wait", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const stopped = await planner([limitedCall(LIMIT_RESET_S, (call) => permission(call.options)("AskUserQuestion", { questions }, callContext()).then(() => undefined))], ["A"]);
  assert.equal((await run(stopped.planner.executing("implement the plan", noReporter))).status, "needs_input");
  assert.equal(stopped.sdk.calls.length, 1);
  const reported: Script = () => (async function* () {
    yield init("session-exec");
    yield success(report);
    yield rateLimit({ status: "rejected", resetsAt: LIMIT_RESET_S, rateLimitType: "five_hour" });
    throw new Error("rate limited");
  })();
  const fake = await planner([reported]);
  assert.equal((await run(fake.planner.executing("implement the plan", noReporter))).status, "finished");
  assert.equal(fake.sdk.calls.length, 1);
});

// Issue #117: each execution phase runs on a fresh planner. The seam with behavior 14 and issue #68: a transport fault and
// a usage-limit wait inside that execution resume the phase's own session, and the run's main session is untouched.
test("issue #117: an execution on a fresh planner retries a transport fault and waits out a usage limit in its own session", async () => {
  const finishedExec: Script = () => (async function* () {
    yield init("exec-1");
    yield success(report);
  })();
  const dropped: Script = () => (async function* () {
    yield init("exec-1");
    throw econnreset();
  })();
  const limited: Script = () => (async function* () {
    yield init("exec-1");
    yield* rejectedWith(LIMIT_RESET_S);
  })();
  for (const [failing, config] of [[dropped, quickRetry], [limited, {}]] as const) {
    const fake = await planner([messages(init("main-1"), success({})), failing, finishedExec, messages(init("main-1"), success({}))], [], config);
    await run(fake.planner.planning("plan", schema));
    const executor = await run(fake.planner.fresh);
    const { clock } = steppingClock(LIMIT_START);
    const outcome = await run(executor.executing("implement the plan", noReporter).pipe(Effect.provideService(Clock.Clock, clock)));
    assert.equal(outcome.status, "finished");
    await run(fake.planner.planning("respond", schema));
    assert.deepEqual(fake.sdk.calls.map((c) => c.options.resume), [undefined, undefined, "exec-1", "main-1"]);
    assert.equal(fake.sdk.calls[2].prompt, prompts.executionContinuePrompt);
    assert.equal(await run(executor.sessionId), "exec-1");
    assert.equal(await run(fake.planner.sessionId), "main-1");
  }
});

// Issue #122: a rejection because the session is too long halts, from a planning call and from an execution call alike,
// after one attempt: it is neither retried nor waited for.
const tooLongResult = (): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: true, api_error_status: 400, terminal_reason: "api_error", result: "Prompt is too long", structured_output: null, total_cost_usd: 0.1, num_turns: 1 }) as unknown as SDKMessage;

test("a planning call refused because the prompt is too long fails with ClaudeSessionTooLong, one call", async () => {
  const fake = await planner([messages(init(), tooLongResult())]);
  assert.equal(await failedTag(fake), "ClaudeSessionTooLong");
  assert.equal(fake.sdk.calls.length, 1);
});

test("an execution call refused because the prompt is too long fails with ClaudeSessionTooLong after one attempt", async () => {
  const fake = await planner([messages(init("session-exec"), tooLongResult())], [], quickRetry);
  const result = await run(Effect.result(fake.planner.executing("implement the plan", noReporter)));
  assert.ok(result._tag === "Failure", "the execution call did not fail");
  assert.equal(tag(result.failure), "ClaudeSessionTooLong");
  assert.equal(fake.sdk.calls.length, 1);
  assert.ok(!fake.sdk.calls.some((c) => c.prompt === prompts.executionContinuePrompt));
});

// Issue #122: a request whose cost (the growth of its session's running total) is more than costWarningUsd is warned
// about, said on the page and written to conversation.md; the same function decides it as the records attribute it.
const conversationOf = (dir: string): string => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const warnings = (said: readonly string[]): readonly string[] => said.filter((t) => t.startsWith(prompts.costWarningLine("x", 1, 1).split(" ")[0]));

test("a planning call that costs more than costWarningUsd is warned about once, on the page and in conversation.md", async () => {
  const fake = await planner([messages(init("s-main"), success({ questions_for_user: [] }, "", 1)), messages(init("s-main"), success({ questions_for_user: [] }, "", 7))], [], { costWarningUsd: 5 });
  await run(fake.planner.planning("write the plan", schema));
  await run(fake.planner.planning("revise the plan", schema));
  const line = prompts.costWarningLine("s-main", 6, 5);
  assert.deepEqual(warnings(fake.ui.said), [line]);
  assert.equal(conversationOf(fake.dir).split(line).length - 1, 1);
});

test("with costWarningUsd 10 the same calls warn about nothing", async () => {
  const fake = await planner([messages(init("s-main"), success({ questions_for_user: [] }, "", 1)), messages(init("s-main"), success({ questions_for_user: [] }, "", 7))], [], { costWarningUsd: 10 });
  await run(fake.planner.planning("write the plan", schema));
  await run(fake.planner.planning("revise the plan", schema));
  assert.deepEqual(warnings(fake.ui.said), []);
  assert.ok(!conversationOf(fake.dir).includes(prompts.costWarningLine("s-main", 6, 10)));
});

test("an execution call that costs more than costWarningUsd is warned about", async () => {
  const fake = await planner([messages(init("s-exec"), success(report, "", 5.5))], [], { costWarningUsd: 5 });
  await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(warnings(fake.ui.said), [prompts.costWarningLine("s-exec", 5.5, 5)]);
});

// ---- issue #154 (decision Q1): an execution call waits for its background commands ----------------------------------

const stopHookOf = (options: Options): HookCallback => {
  const hooks = options.hooks?.Stop;
  assert.ok(hooks !== undefined && hooks.length > 0, "the call registered no Stop hook");
  assert.equal(hooks[0].timeout, prompts.BACKGROUND_HOOK_TIMEOUT_SECONDS);
  return hooks[0].hooks[0];
};
const reportHookOf = (options: Options): HookCallback => {
  const matcher = options.hooks?.PreToolUse?.find((m) => m.matcher === "StructuredOutput");
  assert.ok(matcher !== undefined, "the call registered no hook on StructuredOutput");
  assert.equal(matcher.timeout, prompts.BACKGROUND_HOOK_TIMEOUT_SECONDS);
  return matcher.hooks[0];
};
const shellTask = (id: string, command: string) => ({ id, type: "shell", status: "running", description: command, command });
const callStopHook = (options: Options, tasks: ReturnType<typeof shellTask>[] = []): Promise<HookJSONOutput> =>
  stopHookOf(options)({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: tasks, session_id: "s", transcript_path: "/t", cwd: "/" } as unknown as HookInput, undefined, { signal: new AbortController().signal });
const callReportHook = (options: Options): Promise<HookJSONOutput> =>
  reportHookOf(options)({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", tool_input: {} } as PreToolUseHookInput, undefined, { signal: new AbortController().signal });
const reasonOf = (output: HookJSONOutput): string => (output as { reason?: string; hookSpecificOutput?: { permissionDecisionReason?: string } }).reason ?? (output as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "";
const blockOf = (output: HookJSONOutput): string | undefined => (output as { decision?: string }).decision;
/** "pending" while the promise has not settled after a short real wait. */
const stillPending = async (promise: Promise<unknown>): Promise<boolean> => (await Promise.race([promise.then(() => "settled"), sleep(150).then(() => "pending")])) === "pending";
const SUITE = "sbt testFull > /tmp/full.log";
const finishedReport = { status: "finished", summary: "done", question: "", remaining_work: "" };
const endOf = (id: string, file: string) => ({ taskId: id, status: "completed" as const, outputFile: file, summary: `summary of ${id}` });

test("issue #154 regression: a turn ended while a background command runs waits for it, continues the same query, and finishes with nothing asked", async () => {
  const seen: { pendingAfterLevel?: boolean; stop?: HookJSONOutput } = {};
  const script: Script = (call) => (async function* () {
    yield init();
    yield assistantTool("Bash", { command: SUITE, run_in_background: true });
    yield started("t1");
    yield changed([["t1", false]]);
    yield assistantText("The suite is still running. I'll continue when it finishes.");
    const hook = callStopHook(call.options, [shellTask("t1", SUITE)]);
    // The SDK's usual order: the level signal without the task before its notification.
    yield changed([]);
    seen.pendingAfterLevel = await stillPending(hook);
    yield notification("t1", "completed", "/tmp/t1.out");
    seen.stop = await hook;
    yield success(finishedReport);
  })();
  const fake = await planner([script], [], {}, {}, 2_000);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(seen.pendingAfterLevel, true, "the level signal without the task ended the wait");
  assert.ok(seen.stop !== undefined);
  assert.equal(blockOf(seen.stop), "block");
  assert.equal(reasonOf(seen.stop), prompts.backgroundEndedText([endOf("t1", "/tmp/t1.out")]));
  assert.equal(outcome.status, "finished");
  assert.deepEqual(fake.ui.asked, []);
  assert.equal(fake.sdk.calls.length, 1, "the session was not continued in the same query");
  assert.ok(fake.ui.said.some((l) => l === prompts.backgroundEndedLine([endOf("t1", "/tmp/t1.out")])), fake.ui.said.join("\n"));
});

test("issue #154: the notification before the level signal ends the wait too", async () => {
  let stop: HookJSONOutput | undefined;
  const script: Script = (call) => (async function* () {
    yield init();
    yield started("t1");
    const hook = callStopHook(call.options, [shellTask("t1", SUITE)]);
    yield notification("t1", "completed", "/tmp/t1.out");
    yield changed([]);
    stop = await hook;
    yield success(finishedReport);
  })();
  const fake = await planner([script], [], {}, {}, 2_000);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(blockOf(stop ?? {}), "block");
  assert.equal(outcome.status, "finished");
});

test("issue #154: two tasks: no report is accepted while either runs, and each denial carries only the new ends", async () => {
  const results: { whileA?: boolean; a?: HookJSONOutput; whileB?: boolean; b?: HookJSONOutput; idle?: HookJSONOutput } = {};
  const script: Script = (call) => (async function* () {
    yield init();
    yield started("A");
    const first = callReportHook(call.options);
    results.whileA = await stillPending(first);
    yield notification("A", "completed", "/tmp/a.out");
    results.a = await first;
    yield started("B");
    const second = callReportHook(call.options);
    results.whileB = await stillPending(second);
    yield notification("B", "completed", "/tmp/b.out");
    results.b = await second;
    results.idle = await callReportHook(call.options);
    yield success(finishedReport);
  })();
  const fake = await planner([script], [], {}, {}, 2_000);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(results.whileA, true);
  assert.equal(results.whileB, true);
  assert.equal(decision(results.a ?? {}), "deny");
  assert.equal(reasonOf(results.a ?? {}), `${prompts.REPORT_WHILE_RUNNING_DENIED} ${prompts.backgroundEndedText([endOf("A", "/tmp/a.out")])}`);
  assert.equal(decision(results.b ?? {}), "deny");
  assert.equal(reasonOf(results.b ?? {}), `${prompts.REPORT_WHILE_RUNNING_DENIED} ${prompts.backgroundEndedText([endOf("B", "/tmp/b.out")])}`);
  assert.deepEqual(results.idle, {});
  assert.equal(outcome.status, "finished");
});

test("issue #154: past the bound of one wait the command still runs: the Stop hook blocks with stillRunningText, a report is denied, and the next wait ends with the command", async () => {
  const results: { stop1?: HookJSONOutput; report?: HookJSONOutput; stop2?: HookJSONOutput } = {};
  const script: Script = (call) => (async function* () {
    yield init();
    yield started("t1");
    results.stop1 = await callStopHook(call.options, [shellTask("t1", SUITE)]);
    results.report = await callReportHook(call.options);
    const again = callStopHook(call.options, [shellTask("t1", SUITE)]);
    yield notification("t1", "completed", "/tmp/t1.out");
    results.stop2 = await again;
    yield success(finishedReport);
  })();
  const fake = await planner([script], [], {}, {}, 200);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.equal(blockOf(results.stop1 ?? {}), "block");
  assert.equal(reasonOf(results.stop1 ?? {}), prompts.stillRunningText(["task t1"]));
  assert.equal(decision(results.report ?? {}), "deny");
  assert.equal(reasonOf(results.report ?? {}), prompts.stillRunningText(["task t1"]));
  assert.equal(reasonOf(results.stop2 ?? {}), prompts.backgroundEndedText([endOf("t1", "/tmp/t1.out")]));
  assert.equal(outcome.status, "finished");
  assert.ok(fake.ui.said.includes(prompts.backgroundStillRunningLine(["task t1"])), fake.ui.said.join("\n"));
});

test("issue #154: a call that ends with a task pending is aborted with backgroundKilledText, whatever its report", async () => {
  for (const status of ["finished", "continuing"]) {
    const script: Script = () => (async function* () {
      yield init();
      yield started("t1");
      yield success({ ...finishedReport, status });
    })();
    const fake = await planner([script]);
    const outcome = await run(fake.planner.executing("implement the plan", noReporter));
    assert.ok(outcome.status === "aborted", status);
    assert.equal(outcome.question, prompts.backgroundKilledText(["task t1"]));
  }
});

test("issue #154: with nothing pending a report is allowed at once and the Stop hook answers nothing", async () => {
  const results: HookJSONOutput[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    results.push(await callReportHook(call.options), await callStopHook(call.options));
    yield success(finishedReport);
  })();
  const fake = await planner([script]);
  assert.equal((await run(fake.planner.executing("implement the plan", noReporter))).status, "finished");
  assert.deepEqual(results, [{}, {}]);
});

test("issue #154: after a recorded stop neither hook waits, and the outcome is needs_input", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const results: HookJSONOutput[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    yield started("t1");
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    results.push(await callReportHook(call.options), await callStopHook(call.options, [shellTask("t1", SUITE)]));
    yield success({ ...finishedReport, status: "needs_input" });
  })();
  const fake = await planner([script], ["A"], {}, {}, 5_000);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(results, [{}, {}]);
  assert.equal(outcome.status, "needs_input");
});

test("issue #154: an interruption while a hook waits ends the call, and the hook answers nothing", async () => {
  let hook: Promise<HookJSONOutput> | null = null;
  let reached: () => void = () => {};
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  const script: Script = (call) => (async function* () {
    yield init();
    yield started("t1");
    hook = callStopHook(call.options, [shellTask("t1", SUITE)]);
    reached();
    await aborted(call.options);
  })();
  const fake = await planner([script], [], {}, {}, 60_000);
  const fiber = Effect.runFork(fake.planner.executing("implement the plan", noReporter).pipe(Effect.provideService(Decider, noDecider)));
  await Promise.race([waiting, sleep(10_000).then(() => assert.fail("the Stop hook was not reached within 10 s"))]);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.ok(hook !== null);
  assert.deepEqual(await Promise.race([hook, sleep(2_000).then(() => "still waiting")]), {});
});

test("issue #154: a transport retry starts its wait state afresh", async () => {
  let report: HookJSONOutput | undefined;
  const first: Script = () => (async function* () {
    yield init("session-exec");
    yield started("t1");
    throw econnreset();
  })();
  const second: Script = (call) => (async function* () {
    yield init("session-exec");
    report = await callReportHook(call.options);
    yield success(finishedReport);
  })();
  const fake = await planner([first, second], [], quickRetry);
  const outcome = await run(fake.planner.executing("implement the plan", noReporter));
  assert.deepEqual(report, {});
  assert.equal(outcome.status, "finished");
});
