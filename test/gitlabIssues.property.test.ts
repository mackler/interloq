// The seam between setting a state on a GitLab issue and reading it back (issue #66: properties over the pure core).
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { relabelBody, stateOfIssue } from "../src/gitlabIssues.ts";
import { GITLAB_LABELED_STATES } from "../src/schema.ts";
import { GITLAB_LABELS } from "./gitlabLabels.ts";

const RUNS = { numRuns: 200, seed: 20261012 };
const stateLabels: readonly string[] = Object.values(GITLAB_LABELS);
const arbOther = fc.string({ maxLength: 6 }).filter((l) => !stateLabels.includes(l));
// An issue carries each label at most once: GitLab keeps its labels as a set.
const arbLabels = fc.uniqueArray(fc.oneof(fc.constantFrom(...stateLabels), arbOther), { maxLength: 6 });
const arbTarget = fc.constantFrom(...GITLAB_LABELED_STATES);

/** GitLab's application of add_labels and remove_labels to an issue's labels, as its documentation describes it. */
const applied = (labels: readonly string[], body: Readonly<{ add_labels: string; remove_labels: string }>): readonly string[] => {
  const removed = new Set(body.remove_labels.split(","));
  const kept = labels.filter((l) => !removed.has(l));
  const added = body.add_labels.split(",").filter((l) => !kept.includes(l));
  return [...kept, ...added];
};

test("an open issue with any labels, relabeled to a state, reads as that state with its other labels unchanged", () => {
  fc.assert(fc.property(arbLabels, arbTarget, (labels, target) => {
    const after = applied(labels, relabelBody(GITLAB_LABELS, target));
    const read = stateOfIssue(GITLAB_LABELS, { state: "opened", labels: after });
    const others = (ls: readonly string[]) => JSON.stringify(ls.filter((l) => !stateLabels.includes(l)));
    return Result.isSuccess(read) && read.success === target && others(after) === others(labels);
  }), RUNS);
});

test("a closed issue is deployed whatever its labels", () => {
  fc.assert(fc.property(arbLabels, (labels) => {
    const read = stateOfIssue(GITLAB_LABELS, { state: "closed", labels });
    return Result.isSuccess(read) && read.success === "deployed";
  }), RUNS);
});
