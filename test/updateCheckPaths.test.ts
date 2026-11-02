import assert from "node:assert/strict";
import { test } from "node:test";
import { type Artifact, pathOf, RECORDS_DIR, recordPath } from "../src/artifacts.ts";
import * as prompts from "../src/prompts.ts";
import { RUN_ROOT_FOR_TESTS as ROOT } from "./issueUpdateRoot.ts";

// Issue #216, work review 1 (W1-R1-1): the check prompt says check in its prose and keeps every record path literal.

const ARTIFACTS: readonly Artifact[] = [{ kind: "issue" }, { kind: "issueBefore" }, { kind: "cited" }, { kind: "log", subject: "update" }, ...[1, 2, 3].map((round): Artifact => ({ kind: "review", subject: "update", round }))];
const OTHER_RECORDS = ["reviewer-feedback.md", "user-decisions.md"];
const FULL = new Set([...ARTIFACTS.map((a) => recordPath(ROOT, a)), ...OTHER_RECORDS.map((f) => `${RECORDS_DIR}/${ROOT}/${f}`)]);
const BARE = new Set(ARTIFACTS.map(pathOf));

const PATH_TOKEN = /\S*\/\S*|\S+\.(json|md|jsonl|diff|log)\b/gu;
const trimmed = (token: string): string => token.replace(/[.,;:)]+$/u, "");
const CASES = [
  ["round 1", prompts.updateCheckPrompt(ROOT, 1, "continued")],
  ["a later round in the continued thread", prompts.updateCheckPrompt(ROOT, 2, "continued")],
  ["a later round in a new thread", prompts.updateCheckPrompt(ROOT, 3, "new")],
] as const;

for (const [name, prompt] of CASES) {
  test(`every path the check prompt names is the program's own: ${name}`, () => {
    const paths = (prompt.match(PATH_TOKEN) ?? []).map(trimmed).filter((p) => p !== "CLAUDE.md");
    assert.ok(paths.length > 0);
    for (const p of paths) {
      if (p.includes("/")) {
        assert.ok(p.startsWith(`${RECORDS_DIR}/runs/`), p);
        assert.ok(FULL.has(p), p);
      } else assert.ok(BARE.has(p), p);
    }
  });
}

test("asCheck rewords prose and leaves a path unchanged", () => {
  assert.equal(prompts.asCheck("plan-review/runs/x/update-check/review-2.json"), "plan-review/runs/x/update-check/review-2.json");
  assert.equal(prompts.asCheck("Read the review in review-2.json."), "Read the check in review-2.json.");
  assert.equal(prompts.asCheck("Review it; it was reviewed."), "Check it; it was checked.");
});
