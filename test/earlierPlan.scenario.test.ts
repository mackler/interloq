import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import type { RunRoot } from "../src/artifacts.ts";
import * as prompts from "../src/prompts.ts";
import type { Baseline } from "../src/records.ts";
import { readRefinement } from "../src/refinement.ts";
import { subjectHeading } from "../src/render.ts";
import { implementationRun } from "../src/run.ts";
import { NO_STEP_CHECKS, type RecordedPlan } from "../src/schema.ts";
import { EARLIER_ROOT, TEST_ROOT, fakeTrackerOf, finished, issue, respond, scriptedItem, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

// Issue #180 (S5): an implementation run starts, without asking, from the plan of the newest earlier implementation run
// of its item whose plan review ended in agreement: that plan, its done steps kept and its running steps unfinished, is
// written as the run's plan.json, the earlier baseline is adopted, Claude Code revises the plan and Codex reviews the
// revision before the execution (Q1 to Q5). Without such a run, or where its baseline is gone, the run plans as before.

const step = (id: string, number: number, status: RecordedPlan["stages"][number]["steps"][number]["status"]) => ({ id, number, label: `Step ${id}`, text: `The text of ${id}.`, status });
const EARLIER_PLAN: RecordedPlan = { stages: [{ number: 1, title: "Plan", steps: [step("S1", 1, "done"), step("S2", 2, "started"), step("S3", 3, "pending")] }] };
const LATER_PLAN: RecordedPlan = { stages: [{ number: 1, title: "Plan", steps: [step("S1", 1, "done"), step("S9", 2, "pending")] }] };
const revision = (plan: RecordedPlan) => ({ questions_for_user: [], plan: { stages: plan.stages.map((s) => ({ ...s, steps: s.steps.map(({ status: _, ...rest }) => rest) })) } });
const treeOf = (repo: string): string => execFileSync("git", ["-C", repo, "write-tree"], { encoding: "utf8" }).trim();

type Earlier = { agreed?: boolean; plan?: RecordedPlan; tree?: string; secondPhase?: boolean };
/** An earlier run of item 1 as its records leave it: a planning round without a response and, where it agreed, the block its loop writes. */
const earlierRun = (repo: string, root: RunRoot, options: Earlier): Baseline => {
  const dir = path.join(repo, "plan-review", root);
  const round = (phase: number, n: number) => {
    fs.mkdirSync(path.join(dir, `planning-${phase}`), { recursive: true });
    fs.writeFileSync(path.join(dir, `planning-${phase}`, `round-${n}.json`), JSON.stringify({ version: 2, kind: "no_response", subject: `planning-${phase}`, phase, round: n, reconstructed: false, review: { issues: [] } }));
  };
  round(1, 1);
  if (options.secondPhase) round(2, 1);
  const agreedBlock = (options.agreed ?? true) ? prompts.reviewConvergedMarkdown(subjectHeading({ plan: 1 }), 1, prompts.PLAN_FILE_LABEL) : "";
  fs.writeFileSync(path.join(dir, "conversation.md"), `# Conversation record\n\n${agreedBlock}`);
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ version: 2, plan: options.plan ?? EARLIER_PLAN }));
  const baseline: Baseline = { version: 2, tree: options.tree ?? treeOf(repo), uncommitted: [], start_commit: null, time: "2025-12-31T00:00:00.000Z" };
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(baseline));
  return baseline;
};

const implement = async (repo: string, options: TestOptions) => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { layer, probe } = testLayer(repo, { ...options, tracker });
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(scriptedItem.body)));
  const exit = await Effect.runPromiseExit(implementationRun(`${scriptedItem.title}\n\n${scriptedItem.body}`, scriptedItem.id, section, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  return probe;
};
const statusesOf = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")).plan.stages.flatMap((s: RecordedPlan["stages"][number]) => s.steps.map((st) => `${st.id}:${st.status}`));
const conversationOf = (dir: string): string => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const initialText = (probe: { planner: { prompts: readonly string[] } }) => probe.planner.prompts.some((p) => p.startsWith("Produce an implementation plan"));

test("a qualifying earlier run: its plan, statuses carried, is revised by Claude Code and reviewed by Codex before the execution; its baseline is adopted", async () => {
  const repo = tempRepo();
  const baseline = earlierRun(repo, EARLIER_ROOT, {});
  const startHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let atRevision: readonly string[] = [];
  const dir = path.join(repo, "plan-review", TEST_ROOT);
  const probe = await implement(repo, {
    steps: [{ output: revision(EARLIER_PLAN), onCall: () => (atRevision = statusesOf(path.join(dir, "plan.json"))) }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.ok(!initialText(probe), "the run wrote a plan of its own");
  assert.equal(probe.planner.prompts[0], prompts.earlierPlanPrompt(TEST_ROOT, `${scriptedItem.title}\n\n${scriptedItem.body}`, Option.isSome(Result.getOrThrow(readRefinement(scriptedItem.body))), EARLIER_ROOT, NO_STEP_CHECKS));
  assert.deepEqual(atRevision, ["S1:done", "S2:unfinished", "S3:pending"]);
  assert.match(probe.reviewer.prompts[0], /plan\.json/);
  assert.equal(probe.planner.execPrompts.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(probe.dir, "baseline.json"), "utf8")), { ...baseline, start_commit: startHead });
  const line = prompts.earlierPlanTakenLine(EARLIER_ROOT);
  assert.ok(conversationOf(probe.dir).includes(line));
  assert.ok(probe.ui.said.includes(line));
});

test("no qualifying earlier run: its conversation.md lacks the agreement block, and the run plans from nothing", async () => {
  const repo = tempRepo();
  earlierRun(repo, EARLIER_ROOT, { agreed: false });
  const probe = await implement(repo, { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.ok(initialText(probe), "the run did not plan from nothing");
  assert.ok(!conversationOf(probe.dir).includes(EARLIER_ROOT));
});

test("a qualifying run whose baseline tree is gone: the plan is set aside, said and written, and a fresh baseline is written", async () => {
  const repo = tempRepo();
  earlierRun(repo, EARLIER_ROOT, { tree: "0123456789abcdef0123456789abcdef01234567" });
  const probe = await implement(repo, { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.ok(initialText(probe), "the run did not plan from nothing");
  const line = prompts.earlierPlanSetAsideLine(EARLIER_ROOT);
  assert.ok(conversationOf(probe.dir).includes(line));
  assert.ok(probe.ui.said.includes(line));
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(probe.dir, "baseline.json"), "utf8")).tree, "0123456789abcdef0123456789abcdef01234567");
});

test("a qualifying run whose plan.json holds a later revision never agreed: that revision is the plan taken (G-R1-1)", async () => {
  const repo = tempRepo();
  earlierRun(repo, EARLIER_ROOT, { plan: LATER_PLAN, secondPhase: true });
  const dir = path.join(repo, "plan-review", TEST_ROOT);
  let atRevision: readonly string[] = [];
  await implement(repo, { steps: [{ output: revision(LATER_PLAN), onCall: () => (atRevision = statusesOf(path.join(dir, "plan.json"))) }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.deepEqual(atRevision, ["S1:done", "S9:pending"]);
});

// Issue #186 (requirements Q6, S19): a newest earlier run whose parking completed: the run takes no plan and no baseline
// from it, and its first plan starts by bringing that run's branch onto the working branch. One whose parking did not
// complete plans from the working branch, with no rule about the branch, and says so.
const BRANCH = "interloq/halted/1/earlier";
// Issue #185: the branch path of issue #186 is a send-back's; a halt's or an abandonment's parking is merged (test/parkedMerge.scenario.test.ts).
const parkedRecord = (repo: string, record: object) => fs.writeFileSync(path.join(repo, "plan-review", EARLIER_ROOT, "parked.json"), JSON.stringify(record));
const completed = { _tag: "Parked", version: 2, branch: BRANCH, commit: "c", start_commit: "s", committed: [], recorded: true, time: "t", ending: "sentBack" };
const intended = { _tag: "Intended", version: 2, branch: BRANCH, start_commit: "s", time: "t" };
const baselineTime = (dir: string): string => JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"), "utf8")).time;

test("an earlier run whose parking completed: the first plan's prompt names its branch and the rule, and no baseline is adopted", async () => {
  const repo = tempRepo();
  earlierRun(repo, EARLIER_ROOT, {});
  parkedRecord(repo, completed);
  const probe = await implement(repo, { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const rule = prompts.parkedBranchFirstStepRule(BRANCH);
  assert.ok(probe.planner.prompts[0]!.startsWith("Produce an implementation plan") && probe.planner.prompts[0]!.includes(rule));
  assert.ok(probe.reviewer.prompts[0]!.includes(rule) && probe.reviewer.prompts[0]!.includes(prompts.PARKED_BRANCH_REVIEW_CRITERION));
  assert.notEqual(baselineTime(probe.dir), "2025-12-31T00:00:00.000Z", "the earlier run's baseline was adopted");
  const line = prompts.earlierRunParkedLine(EARLIER_ROOT, BRANCH);
  assert.ok(conversationOf(probe.dir).includes(line));
  assert.ok(probe.ui.said.includes(line));
});

test("an earlier run whose parking completed and a verdict Claude Code withdraws: the plan after it and the plan review name the branch and the rule", async () => {
  const repo = tempRepo();
  earlierRun(repo, EARLIER_ROOT, {});
  parkedRecord(repo, completed);
  const probe = await implement(repo, {
    steps: [{ output: { reply: { kind: "notRefined", missing: "m" } } }, { output: { ...respond([["V1-R1-1", "accepted"]]), missing: "" } }, { output: {}, plan: "v1" }],
    reviews: [{ issues: [issue("V1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  const rule = prompts.parkedBranchFirstStepRule(BRANCH);
  const after = probe.planner.prompts.find((p) => p.startsWith("Codex's review of your verdict"));
  assert.ok(after?.includes(rule), "the plan after the withdrawn verdict lacks the rule");
  const planReview = probe.reviewer.prompts.find((p) => p.startsWith("Review the implementation plan"));
  assert.ok(planReview?.includes(rule) && planReview.includes(prompts.PARKED_BRANCH_REVIEW_CRITERION));
});

test("an earlier run whose parking did not complete, with no branch or an unrelated one: no rule, no baseline adopted, and the line", async () => {
  for (const unrelated of [false, true]) {
    const repo = tempRepo();
    earlierRun(repo, EARLIER_ROOT, {});
    parkedRecord(repo, intended);
    if (unrelated) execFileSync("git", ["-C", repo, "branch", BRANCH]);
    const probe = await implement(repo, { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
    for (const p of [...probe.planner.prompts, ...probe.reviewer.prompts]) assert.ok(!p.includes("parked its work on the branch"), `unrelated: ${unrelated}`);
    assert.notEqual(baselineTime(probe.dir), "2025-12-31T00:00:00.000Z");
    assert.ok(conversationOf(probe.dir).includes(prompts.earlierParkingIncompleteLine(EARLIER_ROOT, BRANCH)), `unrelated: ${unrelated}`);
  }
});
