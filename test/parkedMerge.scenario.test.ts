// Issue #185 (F1, G-R1-2): a later implementation run of an item whose earlier run halted or was abandoned with its work
// parked merges that branch at its start, after writing its own baseline, and continues from that run's agreed plan:
// the steps recorded done hold. A merge that conflicts is abandoned and every step is implemented again. Another item's
// change made between the runs is in neither diff. A send-back's parking still takes the path of issue #186.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import * as prompts from "../src/prompts.ts";
import { readRefinement } from "../src/refinement.ts";
import { subjectHeading } from "../src/render.ts";
import { implementationRun } from "../src/run.ts";
import { NO_STEP_CHECKS, type RecordedPlan } from "../src/schema.ts";
import type { ParkedEnding } from "../src/runEnding.ts";
import { EARLIER_ROOT, TEST_ROOT, fakeTrackerOf, finished, scriptedItem, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

const step = (id: string, number: number, status: RecordedPlan["stages"][number]["steps"][number]["status"]) => ({ id, number, label: `Step ${id}`, text: `The text of ${id}.`, status });
const PLAN: RecordedPlan = { stages: [{ number: 1, title: "Plan", steps: [step("S1", 1, "done"), step("S2", 2, "pending")] }] };
const revision = (plan: RecordedPlan) => ({ questions_for_user: [], plan: { stages: plan.stages.map((s) => ({ ...s, steps: s.steps.map(({ status: _, ...rest }) => rest) })) } });
const g = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const BRANCH = "interloq/halted/1/earlier";

/** An earlier run that agreed its plan and was parked, its work (parked.txt) on BRANCH; legacy: no ending recorded. */
const parkedRun = (repo: string, ending: ParkedEnding | "legacyHalt") => {
  g(repo, "config", "user.email", "t@t");
  g(repo, "config", "user.name", "t");
  const dir = path.join(repo, "plan-review", EARLIER_ROOT);
  fs.mkdirSync(path.join(dir, "planning-1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "planning-1", "round-1.json"), JSON.stringify({ version: 2, kind: "no_response", subject: "planning-1", phase: 1, round: 1, reconstructed: false, review: { issues: [] } }));
  const agreed = prompts.reviewConvergedMarkdown(subjectHeading({ plan: 1 }), 1, prompts.PLAN_FILE_LABEL);
  const start = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-b", BRANCH);
  fs.writeFileSync(path.join(repo, "a.txt"), "the parked run's work\n");
  g(repo, "commit", "-qam", "parked work");
  const commit = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-");
  const record = { _tag: "Parked", version: 2, branch: BRANCH, commit, start_commit: start, committed: [], recorded: true, time: "t", ...(ending === "legacyHalt" ? {} : { ending }) };
  const line = ending === "legacyHalt" ? prompts.parkedRecordLine({ ...record, ending: null } as never, "halted") : "";
  fs.writeFileSync(path.join(dir, "conversation.md"), `# Conversation record\n\n${agreed}\n${line}\n`);
  if (ending === "legacyHalt") fs.mkdirSync(path.join(dir, "verdict-1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ version: 2, plan: PLAN }));
  fs.writeFileSync(path.join(dir, "parked.json"), JSON.stringify(record));
};
/** Another item's change committed on the working branch between the two runs. */
const otherItem = (repo: string, file: string, text: string) => {
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, "add", file);
  g(repo, "commit", "-qm", "another item");
};
const task = `${scriptedItem.title}\n\n${scriptedItem.body}`;
const withRequirements = Option.isSome(Result.getOrThrow(readRefinement(scriptedItem.body)));
const implement = async (repo: string, options: TestOptions) => {
  const { layer, probe } = testLayer(repo, { ...options, tracker: fakeTrackerOf([scriptedItem]) });
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(scriptedItem.body)));
  const exit = await Effect.runPromiseExit(implementationRun(task, scriptedItem.id, section, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  return { probe, exit };
};
const statusesAt = (dir: string) => () => JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")).plan.stages.flatMap((s: RecordedPlan["stages"][number]) => s.steps.map((st) => `${st.id}:${st.status}`));
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const diffOf = (dir: string) => fs.readFileSync(path.join(dir, "work-review-1", "changes.diff"), "utf8");

for (const ending of ["abandoned", "halted", "legacyHalt"] as const) {
  test(`a parked ${ending} run: its branch merged, its done steps kept, the diff without another item's change`, async () => {
    const repo = tempRepo();
    parkedRun(repo, ending);
    otherItem(repo, "other.txt", "another item's file\n");
    let atRevision: readonly string[] = [];
    const { probe, exit } = await implement(repo, { steps: [{ output: revision(PLAN), onCall: () => (atRevision = statusesAt(path.join(repo, "plan-review", TEST_ROOT))()) }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
    assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
    assert.deepEqual(atRevision, ["S1:done", "S2:pending"]);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8").includes("the parked run's work"), true);
    assert.equal(probe.planner.prompts[0], prompts.earlierPlanPrompt(TEST_ROOT, task, withRequirements, EARLIER_ROOT, NO_STEP_CHECKS, "merged"));
    assert.ok(conversation(probe.dir).includes(prompts.parkedMergedLine(EARLIER_ROOT, BRANCH)));
    assert.ok(!diffOf(probe.dir).includes("other.txt"));
  });
}

test("a merge that conflicts is abandoned: every step pending, the line says so, the diff without the other item's change", async () => {
  const repo = tempRepo();
  parkedRun(repo, "abandoned");
  otherItem(repo, "a.txt", "another item's change\n");
  let atRevision: readonly string[] = [];
  const { probe, exit } = await implement(repo, { steps: [{ output: revision(PLAN), onCall: () => (atRevision = statusesAt(path.join(repo, "plan-review", TEST_ROOT))()) }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.deepEqual(atRevision, ["S1:pending", "S2:pending"]);
  assert.equal(probe.planner.prompts[0], prompts.earlierPlanPrompt(TEST_ROOT, task, withRequirements, EARLIER_ROOT, NO_STEP_CHECKS, "conflicted"));
  assert.match(conversation(probe.dir), /merging that branch into the working branch conflicted/);
  // The other item's change is in the baseline: no line of the diff adds it (the scripted execution edits a.txt itself).
  assert.ok(!diffOf(probe.dir).split("\n").includes("+another item's change"), diffOf(probe.dir));
});

test("a parked branch deleted before the later run halts it with git's message, no step reset", async () => {
  const repo = tempRepo();
  parkedRun(repo, "abandoned");
  g(repo, "branch", "-D", BRANCH);
  const { exit } = await implement(repo, {});
  assert.ok(Exit.isFailure(exit));
  assert.match(Cause.pretty(exit.cause), /GitError|merge/);
});

test("a parked send-back still takes the path of issue #186: the first-step rule of its branch in the plan's prompt", async () => {
  const repo = tempRepo();
  parkedRun(repo, "sentBack");
  const { probe } = await implement(repo, { steps: [{ output: { questions_for_user: [] }, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.ok(probe.planner.prompts[0]!.includes(prompts.parkedBranchFirstStepRule(BRANCH)));
});

// Work review 2 of issue #185 (W2-R1-2): a merge the developer left unfinished halts the later run before its own merge,
// the developer's merge untouched and no step reset.
test("a merge left unfinished in the repository halts the later run, MERGE_HEAD unchanged, no step reset", async () => {
  const repo = tempRepo();
  parkedRun(repo, "abandoned");
  g(repo, "checkout", "-q", "-b", "theirs");
  fs.writeFileSync(path.join(repo, "b.txt"), "theirs\n");
  g(repo, "add", "b.txt");
  g(repo, "commit", "-qm", "theirs");
  g(repo, "checkout", "-q", "-");
  fs.writeFileSync(path.join(repo, "b.txt"), "ours\n");
  g(repo, "add", "b.txt");
  g(repo, "commit", "-qm", "ours");
  try { g(repo, "merge", "-q", "theirs"); } catch { /* the conflict is the point */ }
  const mergeHead = g(repo, "rev-parse", "MERGE_HEAD");
  const { probe, exit } = await implement(repo, { steps: [{ output: revision(PLAN) }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.ok(Exit.isFailure(exit), "the run did not halt");
  const refused = prompts.parkedMergeRefusedText(BRANCH, { _tag: "State", state: { _tag: "InProgress", operation: "merge" } });
  assert.ok(Cause.pretty(exit.cause).includes(refused), Cause.pretty(exit.cause));
  assert.equal(g(repo, "rev-parse", "MERGE_HEAD"), mergeHead);
  const plan = path.join(probe.dir, "plan.json");
  if (fs.existsSync(plan)) assert.notDeepEqual(statusesAt(probe.dir)(), ["S1:pending", "S2:pending"]);
  assert.deepEqual(probe.planner.prompts, []);
});
