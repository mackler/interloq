// What the GitLab adapter decides without I/O: an issue's id, state and item, and the bodies of a state change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { CLOSE_BODY, GITLAB_CONNECT_ATTEMPTS, GITLAB_DESCRIPTION_LIMIT, type GitlabIssue, closedRefusalText, connectionRefused, descriptionTooLongText, gitlabPageProblem, gitlabStatusFailure, iidOf, nextPageOf, itemOfIssue, noStateLabelText, relabelBody, stateOfIssue } from "../src/gitlabIssues.ts";
import { TrackerAuthRefused, TrackerItemNotFound } from "../src/errors.ts";
import { GITLAB_LABELED_STATES } from "../src/schema.ts";
import type { ItemId } from "../src/tracker.ts";
import { GITLAB_LABELS } from "./gitlabLabels.ts";

const issue = (over: Partial<GitlabIssue>): GitlabIssue => ({ iid: 42, title: "A task", description: "The text.", state: "opened", labels: [], ...over });

test("a closed issue is deployed whatever its labels", () => {
  for (const labels of [[], ["Refined"], ["Refined", "Implementing"], ["bug"]]) {
    const state = stateOfIssue(GITLAB_LABELS, { state: "closed", labels });
    assert.ok(Result.isSuccess(state), JSON.stringify(labels));
    assert.equal(state.success, "deployed");
  }
});

test("an open issue with one state label is that label's state, other labels ignored", () => {
  for (const state of GITLAB_LABELED_STATES) {
    const read = stateOfIssue(GITLAB_LABELS, { state: "opened", labels: ["bug", GITLAB_LABELS[state], "frontend"] });
    assert.ok(Result.isSuccess(read));
    assert.equal(read.success, state);
  }
});

test("an open issue with no state label is NoStateLabel, naming every label it carries", () => {
  const read = stateOfIssue(GITLAB_LABELS, { state: "opened", labels: ["bug", "refined"] });
  assert.ok(Result.isFailure(read));
  assert.deepEqual(read.failure, { _tag: "NoStateLabel", labels: ["bug", "refined"] });
});

test("an open issue with two state labels is Ambiguous, naming both in the issue's order", () => {
  const read = stateOfIssue(GITLAB_LABELS, { state: "opened", labels: ["Implementing", "bug", "Unrefined"] });
  assert.ok(Result.isFailure(read));
  assert.deepEqual(read.failure, { _tag: "Ambiguous", labels: ["Implementing", "Unrefined"] });
});

test("an issue's item: its iid in decimal, its title, its description or the empty string, its state", () => {
  const item = itemOfIssue(GITLAB_LABELS, issue({ labels: ["Refined"] }));
  assert.ok(Result.isSuccess(item));
  assert.deepEqual(item.success, { id: "42", title: "A task", body: "The text.", state: "refined" });
  const nullBody = itemOfIssue(GITLAB_LABELS, issue({ description: null, state: "closed" }));
  assert.ok(Result.isSuccess(nullBody));
  assert.deepEqual(nullBody.success, { id: "42", title: "A task", body: "", state: "deployed" });
});

test("iidOf takes a positive decimal integer without leading zeros that is a safe integer", () => {
  const cases: ReadonlyArray<[string, number | null]> = [
    ["42", 42], ["1", 1], ["0", null], ["042", null], ["#42", null], ["a1", null], ["-3", null], ["4.2", null], [" 42", null], ["12345678901234567890", null],
  ];
  for (const [text, expected] of cases) {
    const iid = iidOf(text as ItemId);
    assert.deepEqual(Option.getOrNull(iid), expected, text);
  }
});

test("relabelBody adds the target's label and removes the other three state labels, in the states' order", () => {
  assert.deepEqual(relabelBody(GITLAB_LABELS, "unrefined"), { add_labels: "Unrefined", remove_labels: "Refined,Implementing,Implemented" });
  assert.deepEqual(relabelBody(GITLAB_LABELS, "refined"), { add_labels: "Refined", remove_labels: "Unrefined,Implementing,Implemented" });
  assert.deepEqual(relabelBody(GITLAB_LABELS, "implementing"), { add_labels: "Implementing", remove_labels: "Unrefined,Refined,Implemented" });
  assert.deepEqual(relabelBody(GITLAB_LABELS, "implemented"), { add_labels: "Implemented", remove_labels: "Unrefined,Refined,Implementing" });
});

test("the close body closes the issue and names no label", () => {
  assert.deepEqual(CLOSE_BODY, { state_event: "close" });
});

test("the refusal texts name the issue and what was not done", () => {
  assert.equal(closedRefusalText(42, "its state was not set to refined"), "issue #42 is closed, and Interloq never reopens a closed issue, so its state was not set to refined");
  assert.match(noStateLabelText({ _tag: "NoStateLabel", labels: ["bug", "refined"] }, 7), /issue #7 .*"bug", "refined"/u);
  assert.match(noStateLabelText({ _tag: "NoStateLabel", labels: [] }, 7), /issue #7 .*no label/u);
});

test("nextPageOf reads X-Next-Page: absent, empty or not a positive integer is the last page", () => {
  const cases: ReadonlyArray<[string | undefined, number | null]> = [["2", 2], ["17", 17], [undefined, null], ["", null], ["0", null], ["-1", null], ["x", null], ["2.5", null], ["02", null]];
  for (const [header, expected] of cases) assert.deepEqual(Option.getOrNull(nextPageOf(header)), expected, String(header));
});

test("gitlabPageProblem finds a repeated issue and a next page not after the current one", () => {
  const page = [{ iid: 3 }, { iid: 2 }];
  assert.equal(gitlabPageProblem(1, Option.some(2), new Set(), page), null);
  assert.equal(gitlabPageProblem(1, Option.none(), new Set(), page), null);
  assert.match(gitlabPageProblem(2, Option.some(3), new Set([2]), page) ?? "", /issue #2 came twice/u);
  assert.match(gitlabPageProblem(1, Option.some(2), new Set(), [{ iid: 5 }, { iid: 5 }]) ?? "", /issue #5 came twice/u);
  assert.match(gitlabPageProblem(2, Option.some(2), new Set(), page) ?? "", /next page 2 .* page 2/u);
  assert.match(gitlabPageProblem(3, Option.some(1), new Set(), page) ?? "", /next page 1 .* page 3/u);
});

test("the status of GitLab's answer maps to the tracker's errors", () => {
  const item = { kind: "item", id: "42" as ItemId } as const;
  const listing = { kind: "listing", what: "the refined issues" } as const;
  assert.equal(gitlabStatusFailure(200, "GET", item), null);
  assert.equal(gitlabStatusFailure(204, "PUT", item), null);
  for (const status of [401, 403]) assert.deepEqual(gitlabStatusFailure(status, "GET", item), new TrackerAuthRefused({ tracker: "GitLab", status }));
  assert.deepEqual(gitlabStatusFailure(404, "GET", item), new TrackerItemNotFound({ id: "42" }));
  for (const [status, target] of [[404, listing], [410, item], [422, item], [500, listing]] as const) {
    const failure = gitlabStatusFailure(status, "GET", target);
    assert.equal(failure?._tag, "TrackerUnreachable", String(status));
    assert.match(failure?._tag === "TrackerUnreachable" ? failure.message : "", new RegExp(`GitLab answered GET ${target.kind === "item" ? "42" : "the refined issues"} with status ${status}`, "u"));
  }
});

test("connectionRefused recognizes ECONNREFUSED in the cause chain and in an aggregate of refused errors, and nothing else", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });
  assert.equal(connectionRefused(refused), true);
  assert.equal(connectionRefused(fetchFailed(refused)), true);
  assert.equal(connectionRefused(fetchFailed(new AggregateError([refused, refused]))), true);
  assert.equal(connectionRefused(fetchFailed(new AggregateError([refused, reset]))), false);
  assert.equal(connectionRefused(fetchFailed(new AggregateError([]))), false);
  assert.equal(connectionRefused(reset), false);
  assert.equal(connectionRefused(fetchFailed(reset)), false);
  assert.equal(connectionRefused("ECONNREFUSED"), false);
  assert.equal(connectionRefused(undefined), false);
  assert.equal(GITLAB_CONNECT_ATTEMPTS, 3);
});

test("an aggregate carrying Node's own code ECONNREFUSED is judged by its errors alone (W1-R1-1)", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const timeout = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });
  const asNode = (errors: readonly Error[]) => Object.assign(new AggregateError(errors), { code: "ECONNREFUSED" });
  assert.equal(connectionRefused(asNode([refused, reset])), false);
  assert.equal(connectionRefused(fetchFailed(asNode([refused, reset]))), false);
  assert.equal(connectionRefused(asNode([refused, timeout])), false);
  assert.equal(connectionRefused(fetchFailed(asNode([refused, timeout]))), false);
  assert.equal(connectionRefused(asNode([refused, refused])), true);
  assert.equal(connectionRefused(fetchFailed(asNode([refused, refused]))), true);
  assert.equal(connectionRefused(asNode([])), false);
});

test("descriptionTooLongText names the length and the limit", () => {
  assert.equal(descriptionTooLongText({ _tag: "DescriptionTooLong", limit: GITLAB_DESCRIPTION_LIMIT, length: 1_000_001 }), "the refinement would make the issue's description 1000001 characters long, more than GitLab's limit of 1000000");
});
