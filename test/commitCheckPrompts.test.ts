// Issue #176 (requirements Q2): the prompts that ask for the plan's commit step, the plan review's criterion, the execution
// prompt's sentence and the revision's cause, tested with the check they rely on (Rules for changes: a prompt and its
// check together).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { EARLIER_ROOT, tempRepo, TEST_ROOT } from "./helpers.ts";

const checks: S.StepChecks = Result.getOrThrow(S.stepChecksOf({ checkCommands: [], suiteCommand: "npm test" }));
const suite = checks.suite;
const paths: readonly [string, ...string[]] = ["b.txt", "lib/c.ts"];

test("every prompt that asks for the whole plan carries the commit step rule", () => {
  const plans = {
    initialPlanPrompt: prompts.initialPlanPrompt(TEST_ROOT, "t", true, checks),
    revisePlanPrompt: prompts.revisePlanPrompt(TEST_ROOT, checks),
    planApplyDecisionsPrompt: prompts.planApplyDecisionsPrompt(TEST_ROOT, checks),
    planRespondPrompt: prompts.planRespondPrompt(TEST_ROOT, 1, 1, checks),
    revisePlanAfterExecutionPrompt: prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", true, 1, { _tag: "ExecutionEnded", stopped: false, workReview: "converged" }, checks),
    earlierPlanPrompt: prompts.earlierPlanPrompt(TEST_ROOT, "t", true, EARLIER_ROOT, checks),
  };
  for (const [name, text] of Object.entries(plans)) assert.ok(text.includes(prompts.PLAN_COMMIT_STEP_RULE), name);
});

test("the plan review's first round gives Codex the rule and the criterion", () => {
  const review = prompts.planReviewPrompt(TEST_ROOT, 1, 1, false, checks, "continued");
  assert.ok(review.includes(prompts.PLAN_COMMIT_STEP_RULE));
  assert.ok(review.includes(prompts.COMMIT_STEP_REVIEW_CRITERION));
});

test("the execution prompt says the work is not finished while the run's changes are uncommitted", () => {
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true, checks).includes(prompts.EXECUTION_COMMIT_SENTENCE));
});

test("the revision after an uncommitted check names every file, with and without a suite", () => {
  for (const s of [suite, null]) {
    const text = prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 2, { _tag: "Uncommitted", paths, suite: s }, checks);
    for (const p of paths) assert.ok(text.includes(p), p);
    assert.equal(s !== null && text.includes(`\`${s}\``), s !== null);
    const line = prompts.uncommittedLine("Code review 2", paths, s);
    for (const p of paths) assert.ok(line.includes(p), p);
  }
});

test("the seam: the rule states the exclusions the Store's check applies", async () => {
  // The rule names three exclusions; the check must apply each.
  for (const words of ["git ignores and does not track", "configured to ignore", "already uncommitted when the run began"]) {
    assert.ok(prompts.PLAN_COMMIT_STEP_RULE.includes(words), words);
  }
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  execFileSync("git", ["-C", repo, "add", ".gitignore"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"]);
  fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted when the run began\n");
  const store = await Effect.runPromise(makeStore(repo, TEST_ROOT, ["scratch"]).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("t"));
  await Effect.runPromise(store.writeBaseline());
  fs.writeFileSync(path.join(repo, "dirty.txt"), "changed again\n");
  fs.writeFileSync(path.join(repo, "out.log"), "ignored\n");
  fs.mkdirSync(path.join(repo, "scratch"));
  fs.writeFileSync(path.join(repo, "scratch", "x"), "configured to ignore\n");
  assert.deepEqual(await Effect.runPromise(store.uncommittedSinceStart()), { _tag: "Committed" });
  fs.writeFileSync(path.join(repo, "b.txt"), "the run's\n");
  assert.deepEqual(await Effect.runPromise(store.uncommittedSinceStart()), { _tag: "Uncommitted", paths: ["b.txt"] });
});
