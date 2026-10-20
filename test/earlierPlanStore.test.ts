import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { type RunRoot, runRootOf } from "../src/artifacts.ts";
import { platformLayer } from "../src/platform.ts";
import { PLAN_FILE_LABEL, reviewConvergedMarkdown } from "../src/prompts.ts";
import type { Baseline } from "../src/records.ts";
import { subjectHeading } from "../src/render.ts";
import type { RecordedPlan } from "../src/schema.ts";
import type { StoreShape } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { itemIdOf } from "../src/tracker.ts";
import { tempRepo, TEST_ROOT } from "./helpers.ts";

// Issue #180 (S3): the store reads the item's earlier implementation runs and gives the plan of the newest one whose plan
// review ended in agreement, its statuses carried, with its baseline; it sets that plan aside where the baseline is gone (F1);
// adoptBaseline makes the work review's diff and the commit check start from the earlier run's start (Q4).

const run = Effect.runPromise;
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
const storeOf = (repo: string): Promise<StoreShape> => run(makeStore(repo, TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
const item = (id: string) => Result.getOrThrow(itemIdOf(id));
const treeOf = (repo: string): string => git(repo, "write-tree").trim();
const planOf = (status: "started" | "done" | "pending"): RecordedPlan => ({ stages: [{ number: 1, title: "T", steps: [{ id: "S1", number: 1, label: "one", text: "t", status: "done" }, { id: "S2", number: 2, label: "two", text: "t", status }] }] });

type EarlierRun = { kind?: "no_response" | "validated"; agreed?: boolean; conversation?: boolean; plan?: RecordedPlan; baseline?: Baseline | null };
/** Writes an earlier run's records under plan-review/<root>/ as the store and the review loop write them. */
const earlier = (repo: string, root: RunRoot, options: EarlierRun) => {
  const dir = path.join(repo, "plan-review", root);
  fs.mkdirSync(path.join(dir, "planning-1"), { recursive: true });
  const kind = options.kind ?? "no_response";
  const base = { version: 2, subject: "planning-1", phase: 1, round: 1, reconstructed: false, review: { issues: [] } };
  const record = kind === "no_response" ? { ...base, kind } : { ...base, kind, response: { dispositions: [], selfCorrections: [], reviewerFeedback: "", questionsForUser: [] }, notes: [] };
  fs.writeFileSync(path.join(dir, "planning-1", "round-1.json"), JSON.stringify(record));
  if (options.conversation ?? true) fs.writeFileSync(path.join(dir, "conversation.md"), `# Conversation record\n\n${(options.agreed ?? true) ? reviewConvergedMarkdown(subjectHeading({ plan: 1 }), 1, PLAN_FILE_LABEL) : ""}`);
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ version: 2, plan: options.plan ?? planOf("pending") }));
  const baseline = options.baseline === undefined ? { version: 2, tree: treeOf(repo), uncommitted: [], start_commit: null, time: "2026-10-16T09:00:00.000Z" } : options.baseline;
  if (baseline !== null) fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(baseline));
};
const OLD = runRootOf("implementation", "80", "2026-10-15T09:00:00.000Z");
const NEW = runRootOf("implementation", "80", "2026-10-16T09:00:00.000Z");

test("taken: of two qualifying runs the newest, a run of another item ignored, a running step read back as unfinished", async () => {
  const repo = tempRepo();
  earlier(repo, OLD, { plan: planOf("done") });
  earlier(repo, NEW, { plan: planOf("started") });
  earlier(repo, runRootOf("implementation", "800", "2026-10-17T09:00:00.000Z"), {});
  const got = await run((await storeOf(repo)).earlierPlan(item("80")));
  assert.equal(got._tag, "EarlierPlanTaken");
  assert.ok(got._tag === "EarlierPlanTaken");
  assert.equal(got.root, NEW);
  assert.deepEqual(got.plan.stages[0].steps.map((s) => s.status), ["done", "unfinished"]);
  assert.equal(got.baseline.tree, treeOf(repo));
});

test("none: no runs directory, only validated rounds, a round without the agreement block, a run without conversation.md", async () => {
  assert.deepEqual(await run((await storeOf(tempRepo())).earlierPlan(item("80"))), { _tag: "NoEarlierPlan" });
  for (const options of [{ kind: "validated" as const }, { agreed: false }, { conversation: false }]) {
    const repo = tempRepo();
    earlier(repo, NEW, options);
    assert.deepEqual(await run((await storeOf(repo)).earlierPlan(item("80"))), { _tag: "NoEarlierPlan" }, JSON.stringify(options));
  }
});

test("set aside: a baseline naming a tree git does not have, and no baseline.json; an older qualifying run is not tried instead", async () => {
  for (const baseline of [{ version: 2 as const, tree: "0123456789abcdef0123456789abcdef01234567", uncommitted: [], start_commit: null, time: "t" }, null]) {
    const repo = tempRepo();
    earlier(repo, OLD, {});
    earlier(repo, NEW, { baseline });
    assert.deepEqual(await run((await storeOf(repo)).earlierPlan(item("80"))), { _tag: "EarlierPlanSetAside", root: NEW });
  }
});

test("an adopted baseline: the change record holds what was committed since it, and the commit check counts what it did not list", async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty at the earlier start\n");
  const baseline: Baseline = { version: 2, tree: treeOf(repo), uncommitted: ["dirty.txt"], start_commit: null, time: "2026-10-16T09:00:00.000Z" };
  fs.writeFileSync(path.join(repo, "a.txt"), "committed between the runs\n");
  git(repo, "commit", "-qam", "between");
  fs.writeFileSync(path.join(repo, "left.txt"), "left by the earlier run\n");
  const store = await storeOf(repo);
  await run(store.init("task"));
  await run(store.adoptBaseline(baseline));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, "baseline.json"), "utf8")), { ...baseline, start_commit: git(repo, "rev-parse", "HEAD").trim() });
  await run(store.changeRecord(1));
  const diff = fs.readFileSync(path.join(store.dir, "work-review-1", "changes.diff"), "utf8");
  assert.ok(diff.includes("committed between the runs") && diff.includes("left by the earlier run"), diff);
  assert.deepEqual(await run(store.uncommittedSinceStart()), { _tag: "Uncommitted", paths: ["left.txt"] });
});
