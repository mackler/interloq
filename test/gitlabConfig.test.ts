// The GitLab tracker's configuration: the project's full path and each of the four labeled states mapped to a distinct
// label; deployed has no label, since an item is deployed when its issue is closed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import { GITLAB_LABELED_STATES, GitlabTrackerConfig } from "../src/schema.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";

const decode = Schema.decodeUnknownResult(GitlabTrackerConfig, { onExcessProperty: "error" });
const GITLAB = { kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS };

test("a GitLab tracker with its project and four distinct labels decodes", () => {
  const decoded = decode(GITLAB);
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { ...GITLAB, prepareLabel: null });
});

test("labels with spaces and a project in a subgroup are accepted", () => {
  for (const tracker of [
    { ...GITLAB, labels: { ...GITLAB_LABELS, unrefined: "Ready", implementing: "In progress" } },
    { ...GITLAB, project: "group/subgroup/project" },
  ]) assert.ok(Result.isSuccess(decode(tracker)), JSON.stringify(tracker));
});

test("the labeled states are the four states other than deployed", () => {
  assert.deepEqual([...GITLAB_LABELED_STATES], ["unrefined", "refined", "implementing", "implemented"]);
});

test("a GitLab tracker with a bad project, a missing state, a deployed key, a bad label or an unknown key is refused", () => {
  const { project: _project, ...noProject } = GITLAB;
  const missing = Object.keys(GITLAB_LABELS).map((state): [string, unknown] => {
    const { [state as keyof typeof GITLAB_LABELS]: _gone, ...rest } = GITLAB_LABELS;
    return [`the label of ${state} missing`, { ...GITLAB, labels: rest }];
  });
  const cases: ReadonlyArray<[string, unknown]> = [
    ...missing,
    ["the project missing", noProject],
    ["the project blank", { ...GITLAB, project: "  " }],
    ["the project empty", { ...GITLAB, project: "" }],
    ["a project without a namespace", { ...GITLAB, project: "iou-notes" }],
    ["a project with an empty segment", { ...GITLAB, project: "adammackler//iou-notes" }],
    ["a project ending in a slash", { ...GITLAB, project: "adammackler/" }],
    ["a project with whitespace", { ...GITLAB, project: "adam mackler/iou-notes" }],
    ["a label for deployed", { ...GITLAB, labels: { ...GITLAB_LABELS, deployed: "Deployed" } }],
    ["a blank label", { ...GITLAB, labels: { ...GITLAB_LABELS, refined: " " } }],
    ["an empty label", { ...GITLAB, labels: { ...GITLAB_LABELS, refined: "" } }],
    ["a label that is a comma", { ...GITLAB, labels: { ...GITLAB_LABELS, refined: "," } }],
    ["a label of a comma between spaces", { ...GITLAB, labels: { ...GITLAB_LABELS, refined: " , " } }],
    ["a label with a comma", { ...GITLAB, labels: { ...GITLAB_LABELS, refined: "Ready,Next" } }],
    ["a token key", { ...GITLAB, token: "glpat-secret" }],
  ];
  for (const [what, tracker] of cases) assert.ok(Result.isFailure(decode(tracker)), `${what} was accepted`);
});

test("two states sharing a label are refused on the later state's path, naming the label", () => {
  const decoded = decode({ ...GITLAB, labels: { ...GITLAB_LABELS, implementing: "Refined" } });
  assert.ok(Result.isFailure(decoded));
  assert.match(decoded.failure.message, /implementing/u);
  assert.match(decoded.failure.message, /the label "Refined" of implementing is another state's too: each state needs a label of its own/u);
});

// Issue #131 (requirements Q3, F2): the label that marks an item for preparation, null where absent.
test("a GitLab tracker's prepareLabel defaults to null; a label decodes; a blank one, one with a comma or a state's label is refused", () => {
  const absent = decode(GITLAB);
  assert.ok(Result.isSuccess(absent));
  assert.equal(absent.success.prepareLabel, null);
  const given = decode({ ...GITLAB, prepareLabel: "Prepare" });
  assert.ok(Result.isSuccess(given));
  assert.equal(given.success.prepareLabel, "Prepare");
  for (const label of [" ", "Prepare,Now", GITLAB_LABELS.refined]) assert.ok(Result.isFailure(decode({ ...GITLAB, prepareLabel: label })), label);
});
