// What the GitLab adapter decides without I/O: an issue's id, state and item, and the bodies of a state change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { CLOSE_BODY, type GitlabIssue, closedRefusalText, iidOf, itemOfIssue, noStateLabelText, relabelBody, stateOfIssue } from "../src/gitlabIssues.ts";
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
