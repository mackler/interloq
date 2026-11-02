import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result, Schema } from "effect";
import { relabeled, stateOf } from "../src/githubIssues.ts";
import { relabelBody, stateOfIssue } from "../src/gitlabIssues.ts";
import { GithubTrackerConfig, GitlabTrackerConfig, stageLabelsOfConfig } from "../src/schema.ts";
import { ITEM_STATES } from "../src/tracker.ts";
import { LABELS } from "./githubLabels.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";

// Issue #216 (requirements Q1): the state obsolete, whose label is optional in both trackers' configuration.

const github = Schema.decodeUnknownResult(GithubTrackerConfig, { onExcessProperty: "error" });
const gitlab = Schema.decodeUnknownResult(GitlabTrackerConfig, { onExcessProperty: "error" });
const gh = (more: Record<string, unknown>) => github({ kind: "github", owner: "o", repo: "r", labels: LABELS, ...more });
const gl = (more: Record<string, unknown>) => gitlab({ kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS, ...more });

test("a configuration without obsoleteLabel decodes with null, and a given label decodes", () => {
  assert.equal(Result.getOrThrow(gh({})).obsoleteLabel, null);
  assert.equal(Result.getOrThrow(gl({})).obsoleteLabel, null);
  assert.equal(Result.getOrThrow(gh({ obsoleteLabel: "stage: obsolete" })).obsoleteLabel, "stage: obsolete");
  assert.equal(Result.getOrThrow(gl({ obsoleteLabel: "Obsolete" })).obsoleteLabel, "Obsolete");
});

test("an obsolete label equal to a state label or the preparation's mark, blank, or on GitLab with a comma, is refused", () => {
  assert.ok(Result.isFailure(gh({ obsoleteLabel: LABELS.refined })));
  assert.ok(Result.isFailure(gh({ obsoleteLabel: "mark", prepareLabel: "mark" })));
  assert.ok(Result.isFailure(gh({ obsoleteLabel: "  " })));
  assert.ok(Result.isFailure(gl({ obsoleteLabel: GITLAB_LABELS.implemented })));
  assert.ok(Result.isFailure(gl({ obsoleteLabel: "a,b" })));
  assert.ok(Result.isFailure(gl({ obsoleteLabel: "mark", prepareLabel: "mark" })));
});

const ghConfig = Result.getOrThrow(gh({ obsoleteLabel: "stage: obsolete" }));
const glConfig = Result.getOrThrow(gl({ obsoleteLabel: "Obsolete" }));
const ghStages = stageLabelsOfConfig(ghConfig);
const glStages = stageLabelsOfConfig(glConfig);

test("stageLabelsOfConfig gives obsolete only where configured", () => {
  assert.equal(ghStages.obsolete, "stage: obsolete");
  assert.equal(stageLabelsOfConfig(Result.getOrThrow(gh({}))).obsolete, undefined);
  assert.equal(glStages.deployed, undefined);
});

test("an obsolete GitHub issue is never read as unrefined, and relabeling to any state removes the obsolete label", () => {
  const arbLabels = fc.array(fc.oneof(fc.constantFrom(...Object.values(ghStages) as string[]), fc.string({ maxLength: 6 })), { maxLength: 6 });
  fc.assert(fc.property(arbLabels, fc.constantFrom(...ITEM_STATES), (labels, state) => {
    const after = Result.getOrThrow(relabeled(labels, ghStages, state));
    const read = stateOf(ghStages, { open: true, labelNames: after });
    return Result.isSuccess(read) && read.success === state;
  }), { numRuns: 200, seed: 20261102 });
  assert.deepEqual(stateOf(ghStages, { open: true, labelNames: ["stage: obsolete"] }), Result.succeed("obsolete"));
  assert.equal(Result.isFailure(stateOf(ghStages, { open: true, labelNames: ["stage: obsolete", LABELS.refined] })), true);
});

test("a GitLab issue relabeled to obsolete reads as obsolete, and back", () => {
  const apply = (labels: readonly string[], body: { add_labels: string; remove_labels: string }) => [...labels.filter((l) => !body.remove_labels.split(",").includes(l)), body.add_labels];
  const obs = apply(["bug", "Refined"], Result.getOrThrow(relabelBody(glStages, "obsolete")));
  assert.deepEqual(stateOfIssue(glStages, { state: "opened", labels: obs }), Result.succeed("obsolete"));
  const back = apply(obs, Result.getOrThrow(relabelBody(glStages, "refined")));
  assert.deepEqual(stateOfIssue(glStages, { state: "opened", labels: back }), Result.succeed("refined"));
});

test("relabeling to obsolete with no label configured is refused", () => {
  const plain = stageLabelsOfConfig(Result.getOrThrow(gh({})));
  const r = relabeled([], plain, "obsolete");
  assert.ok(Result.isFailure(r) && r.failure._tag === "NoObsoleteLabel");
  const g = relabelBody(stageLabelsOfConfig(Result.getOrThrow(gl({}))), "obsolete");
  assert.ok(Result.isFailure(g) && g.failure._tag === "NoObsoleteLabel");
});
