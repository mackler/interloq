import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect";
import { UserStopped, type RunError } from "../src/errors.ts";
import { planningCall, type Validation } from "../src/review.ts";
import { claudePlannerLayer } from "../src/claude.ts";
import { codexReviewerLayer } from "../src/codex.ts";
import { defaultConfig } from "../src/schema.ts";
import { Planner, Reviewer, RunConfig, Sdk, type Services, Store, Ui } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { storeLayer } from "../src/store.ts";
import { FakeSdk, init, messages, success, turn, type Script } from "./fakeSdk.ts";
import { finished, pathsOf, type PlanningStep, runFails, runTask, ScriptedPlanner, ScriptedReviewer, ScriptedUi, scriptedPlan, tempRepo, testLayer, withDecider, currentOf, questionEntry } from "./helpers.ts";

// Decision Q5: an invalid structured reply in a planning, interview or review call gets one repair
// turn in the same session or thread; a second invalid reply stops the run, and both replies are kept.
const REPAIR = /^Your structured output did not match the required schema/;
const noQuestions = { questions_for_user: [] };
const kept = (dir: string, name: string): string => fs.readFileSync(path.join(dir, "invalid-replies", name), "utf8");
const config = { ...defaultConfig, questionPhase: false };

test("an invalid planner reply gets one repair turn and the corrected reply is used", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { dispositions: "x" } }, { output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts.length, 2);
  assert.match(probe.planner.prompts[1], REPAIR);
  assert.match(probe.planner.prompts[1], /questions_for_user/);
  assert.deepEqual(JSON.parse(kept(probe.dir, "claude-1.json")), { dispositions: "x" });
  assert.deepEqual(probe.ui.asked, []);
});

test("a second invalid planner reply stops the run with AgentReplyInvalid naming both files", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { dispositions: "x" } }, { output: { dispositions: "y" } }] });
  await runFails(layer, "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.deepEqual(JSON.parse(kept(probe.dir, "claude-2.json")), { dispositions: "y" });
});

test("an invalid Codex review gets one repair turn in the same thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: '{"findings":[]}' }, { issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  // The review, its repair turn in the same thread, then the work review in a thread of its own.
  assert.equal(probe.reviewer.prompts.length, 3);
  assert.match(probe.reviewer.prompts[1], REPAIR);
  assert.match(probe.reviewer.prompts[1], /issues/);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2]);
  assert.equal(kept(probe.dir, "codex-1.json"), '{"findings":[]}');
});

test("a Codex reply that is not JSON is treated as invalid, not as a crash", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: "not json" }, { issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.reviewer.prompts[1], REPAIR);
  assert.match(probe.reviewer.prompts[1], /JSON/);
  assert.equal(kept(probe.dir, "codex-1.json"), "not json");
});

test("a second invalid Codex reply stops the run with AgentReplyInvalid naming both files", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: "not json" }, { issues: [], raw: '{"findings":[]}' }] });
  await runFails(layer, "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
});

test("an interview turn is validated the same way", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    steps: [
      { output: { questions: [questionEntry("Q1", "Which database should the service use?", [["PostgreSQL", "p"], ["SQLite", "s"]], { context: "c" })] } },
      { output: { message_to_user: 1 } },
      { output: { message_to_user: "Noted.", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: [], answered_ids: [], complete: true, summary: "# Requirements\n\nhello" } },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.planner.prompts[2], REPAIR);
  assert.match(fs.readFileSync(probe.requirements, "utf8"), /hello/);
  assert.deepEqual(JSON.parse(kept(probe.dir, "claude-1.json")), { message_to_user: 1 });
});

// The same behaviour through the real adapters and the fake SDKs.

/** Store, scripted Ui, config and the fake SDK for one repository. */
const base = (repo: string, sdk: FakeSdk): Layer.Layer<Store | Ui | RunConfig | Sdk> =>
  Layer.mergeAll(Layer.provide(storeLayer(repo, []), platformLayer), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, config), Layer.succeed(Sdk, sdk));
const dirOf = (repo: string): string => path.join(repo, "plan-review");

/** The five services with a real Codex adapter over a fake SDK and a scripted planner. */
const withCodex = (repo: string, sdk: FakeSdk, planner: ScriptedPlanner): Layer.Layer<Services> => {
  const deps = base(repo, sdk);
  return withDecider(Layer.mergeAll(deps, Layer.succeed(Planner, planner), Layer.provide(codexReviewerLayer, deps)));
};

test("a Codex reply without an issues array gets one repair turn in the same thread and the corrected review is used", async () => {
  const repo = tempRepo();
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"issues":[]}'), turn('{"issues":[]}')]);
  const layer = withCodex(repo, sdk, new ScriptedPlanner(pathsOf(repo), [{ output: noQuestions, plan: "v1" }], [finished]));
  assert.equal(await runTask(layer), 1);
  // The plan review with its repair turn, then the work review's own thread.
  assert.equal(sdk.threads.length, 2);
  assert.equal(sdk.threads[0].calls.length, 2);
  assert.match(sdk.threads[0].calls[1].input, REPAIR);
  assert.equal(kept(dirOf(repo), "codex-1.json"), '{"x":1}');
});

test("a Codex reply without an issues array twice fails with AgentReplyInvalid", async () => {
  const repo = tempRepo();
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"y":2}')]);
  const layer = withCodex(repo, sdk, new ScriptedPlanner(pathsOf(repo), [{ output: noQuestions, plan: "v1" }], []));
  await runFails(layer, "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
  assert.equal(sdk.threads[0].calls.length, 2);
});

/** A Claude Code call that ends without structured output (issue #6: the plan is the output, so none is written). */
const planWithoutOutput = (_plan: string): Script => () => (async function* () {
  yield init("s-1");
  yield success(null, "forgot the output");
})();
const report = { status: "finished", summary: "done", question: "", remaining_work: "" };

/** The five services with a real Claude Code adapter over a fake SDK and a scripted reviewer. */
const withClaude = (repo: string, sdk: FakeSdk, reviewer: ScriptedReviewer): Layer.Layer<Services> => {
  const deps = base(repo, sdk);
  return withDecider(Layer.mergeAll(deps, Layer.provide(claudePlannerLayer, deps), Layer.succeed(Reviewer, reviewer)));
};

test("a Claude Code planning call without structured output gets one repair turn in the same session", async () => {
  const repo = tempRepo();
  const paths = pathsOf(repo);
  const sdk = new FakeSdk([planWithoutOutput(paths.plan), messages(init("s-1"), success({ ...noQuestions, plan: scriptedPlan("v1") })), messages(init("s-1"), success(report))]);
  const layer = withClaude(repo, sdk, new ScriptedReviewer(paths, [{ issues: [] }, { issues: [] }]));
  assert.equal(await runTask(layer), 1);
  assert.equal(sdk.calls.length, 3);
  assert.match(sdk.calls[1].prompt, REPAIR);
  assert.equal(sdk.calls[1].options.resume, "s-1");
  assert.equal(kept(dirOf(repo), "claude-1.json"), "null");
});

test("a Claude Code planning call without structured output twice fails with AgentReplyInvalid", async () => {
  const repo = tempRepo();
  const paths = pathsOf(repo);
  const sdk = new FakeSdk([planWithoutOutput(paths.plan), messages(init("s-1"), success(null))]);
  const layer = withClaude(repo, sdk, new ScriptedReviewer(paths, []));
  await runFails(layer, "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.equal(sdk.calls.length, 2);
});

// Issue #37, decision Q1: a reply that decodes but fails the program's validation gets one validation repair turn,
// besides the one schema repair; the budgets are separate, and a second failure of the same kind halts.
const Toy = Schema.Struct({ n: Schema.Number });
const VALIDATION_REPAIR = "n must be even; return it again.";
const even: Validation<{ readonly n: number }> = (output) =>
  output.n % 2 === 0 ? Result.succeed({ value: { n: output.n * 10 }, notes: [`**Note:** ${output.n} accepted.\n\n`] }) : Result.fail({ error: new UserStopped({ where: `odd ${output.n}` }), repair: VALIDATION_REPAIR });
const call = async (steps: PlanningStep[], touch = false) => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, { steps: steps.map((s, i) => (touch && i === 1 ? { ...s, touchProject: true } : s)) });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      return yield* planningCall("prompt", Toy, "planning", "records", even);
    }).pipe(Effect.provide(layer)),
  );
  return { exit, probe };
};
const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  return exit.value;
};
const failedWith = (exit: Exit.Exit<unknown, RunError>): RunError => {
  assert.ok(Exit.isFailure(exit), "the call succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};

test("a reply that fails validation gets the validation repair turn, and the valid reply is used with its notes", async () => {
  const { exit, probe } = await call([{ output: { n: 1 } }, { output: { n: 2 } }]);
  const result = succeeded(exit);
  assert.deepEqual([result.output, result.repaired], [{ n: 20 }, true]);
  assert.deepEqual(probe.planner.prompts, ["prompt", VALIDATION_REPAIR]);
  assert.deepEqual(JSON.parse(kept(probe.dir, "claude-1.json")), { n: 1 });
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Note:\*\* 2 accepted\./);
});

test("a schema failure, then a validation failure, then a valid reply: two repair turns", async () => {
  const { exit, probe } = await call([{ output: { n: "x" } }, { output: { n: 3 } }, { output: { n: 4 } }]);
  assert.deepEqual(succeeded(exit).output, { n: 40 });
  assert.match(probe.planner.prompts[1], REPAIR);
  assert.equal(probe.planner.prompts[2], VALIDATION_REPAIR);
  assert.deepEqual([JSON.parse(kept(probe.dir, "claude-1.json")), JSON.parse(kept(probe.dir, "claude-2.json"))], [{ n: "x" }, { n: 3 }]);
});

test("a validation failure, then a schema failure, then a valid reply: two repair turns", async () => {
  const { exit, probe } = await call([{ output: { n: 3 } }, { output: { n: "x" } }, { output: { n: 6 } }]);
  assert.deepEqual(succeeded(exit).output, { n: 60 });
  assert.deepEqual([probe.planner.prompts[1], REPAIR.test(probe.planner.prompts[2])], [VALIDATION_REPAIR, true]);
});

test("two validation failures halt with the validation's error, both replies kept", async () => {
  const { exit, probe } = await call([{ output: { n: 1 } }, { output: { n: 3 } }, { output: { n: 4 } }]);
  const error = failedWith(exit);
  assert.deepEqual([error._tag, (error as UserStopped).where], ["UserStopped", "odd 3"]);
  assert.equal(probe.planner.prompts.length, 2);
  assert.deepEqual(JSON.parse(kept(probe.dir, "claude-2.json")), { n: 3 });
});

test("two schema failures halt with AgentReplyInvalid, even when the validation repair is unused", async () => {
  const { exit } = await call([{ output: { n: "x" } }, { output: { n: "y" } }, { output: { n: 2 } }]);
  assert.equal(failedWith(exit)._tag, "AgentReplyInvalid");
});

test("the validation repair turn is guarded like the first call", async () => {
  const { exit } = await call([{ output: { n: 1 } }, { output: { n: 2 } }], true);
  assert.equal(failedWith(exit)._tag, "ProjectChanged");
});
