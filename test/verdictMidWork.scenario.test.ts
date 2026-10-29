// Issue #186 (requirements Q1 with Q2): an execution call may report that the item is not refined. Its work review is
// replaced by Codex's review of the verdict in Code review k: a verdict that stands parks the run's work on the item's
// branch (the working branch back at the start commit) and sends the item back, exit 0; one Claude Code withdraws
// after Codex's objection is followed by planning phase k+1, revised from the withdrawn verdict.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { RUNS_DIR, type RunRoot } from "../src/artifacts.ts";
import { parseComment } from "../src/itemComments.ts";
import { parkBranchOf } from "../src/park.ts";
import { program } from "../src/program.ts";
import { revisePlanAfterExecutionPrompt, verdictGivenLine } from "../src/prompts.ts";
import type { ExecOutcome } from "../src/schema.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { finished, issue, respond, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const MISSING = "The requirements do not say whether a deleted note can be restored.";
const notRefined: ExecOutcome = { status: "not_refined", summary: "S1 done", question: MISSING, remainingWork: "S2", userInput: null, checks: [] };
const noQuestions = { questions_for_user: [] };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const verdictResponse = (dispositions: Parameters<typeof respond>[0], missing = MISSING) => ({ ...respond(dispositions), missing });

const runIt = async (options: TestOptions) => {
  const repo = tempRepo();
  const start = git(repo, "rev-parse", "HEAD");
  const { wiring, probe } = testWiring(repo, options);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  return { code, probe, repo, start };
};
const heldItem = async (probe: WiringProbe) => {
  const items = await Effect.runPromise(probe.tracker?.items ?? Effect.succeed([]));
  const found = items.find((i) => i.id === scriptedItem.id);
  assert.ok(found !== undefined);
  return found;
};
const rootOf = (probe: WiringProbe): RunRoot => `${RUNS_DIR}/${path.basename(probe.dir)}` as RunRoot;

test("an execution that commits and then reports not_refined, with nothing raised against it, is parked and sent back, exit 0", async () => {
  const { code, probe, repo, start } = await runIt({
    steps: [{ output: noQuestions, plan: "v1" }],
    // The plan review; then Codex's review of the verdict, in place of the work review.
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [notRefined],
  });
  assert.equal(code, 0);
  const item = await heldItem(probe);
  assert.equal(item.state, "unrefined");
  const sent = (item.comments ?? []).filter((c) => parseComment(c.body)?._tag === "SentBack");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.body.includes(MISSING));
  assert.equal(git(repo, "rev-parse", "HEAD"), start, "the working branch is back at the start commit");
  const branch = Result.getOrThrow(parkBranchOf(scriptedItem.id, rootOf(probe)));
  assert.notEqual(git(repo, "rev-parse", branch), start, "the run's commit is on the item's branch");
  assert.equal(JSON.parse(fs.readFileSync(path.join(probe.dir, "verdict-1", "verdict.json"), "utf8")).verdict.origin, "execution");
  // The verdict's review is said as Code review 1's, as the rail shows it.
  const given = verdictGivenLine("<label>").split("<label>");
  assert.ok(probe.ui.said.some((l) => l.startsWith("Code review") && l.endsWith(given[1]!)), probe.ui.said.join("\n"));
  assert.ok(probe.reviewer.prompts[1]!.includes("V1-R1-1"), "the second review is the verdict's");
});

test("a verdict of an execution that Claude Code withdraws after Codex's objection leads to planning phase 2 and is implemented", async () => {
  const { code, probe } = await runIt({
    steps: [{ output: noQuestions, plan: "v1" }, { output: verdictResponse([["V1-R1-1", "accepted"]], "") }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [issue("V1-R1-1", "The requirements say a deleted note is gone.")] }, { issues: [] }, { issues: [] }],
    execs: [notRefined, finished],
  });
  assert.equal(code, 0);
  assert.equal((await heldItem(probe)).state, "implemented");
  const revision = revisePlanAfterExecutionPrompt(rootOf(probe), "task", false, 1, { _tag: "VerdictWithdrawn", verdict: 1 }, NO_STEP_CHECKS);
  assert.ok(probe.planner.prompts.includes(revision), probe.planner.prompts.map((p) => p.slice(0, 100)).join("\n"));
  assert.equal(probe.planner.execPrompts.length, 2);
});
