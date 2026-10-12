// The seam between setting a state on a GitLab issue and reading it back (issue #66: properties over the pure core).
import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { GITLAB_DESCRIPTION_LIMIT, refinedDescription, relabelBody, stateOfIssue } from "../src/gitlabIssues.ts";
import { readRefinement, refinementOf, withRefinement } from "../src/refinement.ts";
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

test("refinedDescription fails exactly when the refined text is over the limit, and otherwise reads back the refinement", () => {
  const arbText = fc.oneof(fc.string({ maxLength: 40 }), fc.integer({ min: GITLAB_DESCRIPTION_LIMIT - 200, max: GITLAB_DESCRIPTION_LIMIT + 50 }).map((n) => "d".repeat(n)));
  const arbRefinement = fc.string({ minLength: 1, maxLength: 60 }).map((s) => refinementOf(s)).filter(Result.isSuccess).map((r) => r.success);
  fc.assert(fc.property(arbText, arbRefinement, (text, refinement) => {
    const plain = withRefinement(text, refinement);
    const refined = refinedDescription(text, refinement);
    if (Result.isFailure(plain)) return Result.isFailure(refined) && refined.failure._tag === "SectionMalformed";
    if (plain.success.length > GITLAB_DESCRIPTION_LIMIT) return Result.isFailure(refined) && refined.failure._tag === "DescriptionTooLong" && refined.failure.length === plain.success.length;
    if (Result.isFailure(refined)) return false;
    const back = readRefinement(refined.success);
    return Result.isSuccess(back) && Option.isSome(back.success) && back.success.value === refinement;
  }), { numRuns: 100, seed: 20261012 });
});
