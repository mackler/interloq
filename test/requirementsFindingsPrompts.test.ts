import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as prompts from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import { describe } from "../src/errors.ts";
import { FINDING_PROBLEM_KINDS, type FindingProblem } from "../src/requirementsFindings.ts";
import { findingsValidation } from "../src/subjects.ts";
import { TEST_ROOT } from "./helpers.ts";

// Issue #47: the prompt that tells Claude Code how to classify the requirements review's accepted findings, and the
// validation that checks the classification, in one test.
const KINDS = S.RequirementFinding.members.map((m) => m.fields.kind.literal);

test("the response prompt names the field, the four kinds, their fields and the document", () => {
  const p = prompts.requirementsRespondPrompt(TEST_ROOT, 1);
  assert.deepEqual(KINDS, ["answered", "corrected", "unresolved", "reopened"]);
  for (const word of ["findings", ...KINDS.map((k) => `'${k}'`), "source", "changed", "requirements"]) assert.ok(p.includes(word), word);
  assert.ok(p.includes(prompts.FINDINGS_RULES));
  assert.match(p, /Never put the point of an accepted finding in questions_for_user/);
  assert.ok(!p.includes("must be put to the user"));
  assert.ok(!p.includes("do not amend the file yourself"));
  for (const field of ["source", "changed"] as const) assert.ok(S.RequirementFinding.members.some((m) => field in m.fields));
  assert.ok("findings" in S.RequirementsResponse.fields && "requirements" in S.RequirementsResponse.fields);
});

test("the second interview's opening lists the interviewed findings and what changed", () => {
  const p = prompts.interviewGapsPrompt(TEST_ROOT, "r.json", [
    { id: "G-R1-1", kind: "unresolved" },
    { id: "G-R1-3", kind: "reopened", changed: "the retry setting was removed" },
  ]);
  assert.ok(p.includes("G-R1-1") && p.includes("G-R1-3"));
  assert.ok(p.includes("the retry setting was removed"));
  assert.match(p, /state in the question's history what changed/);
  assert.ok(!p.includes("Treat each accepted issue as an agreed question"));
  assert.match(p, /premise the user denied/);
});

test("the application of decisions returns the document and modifies no file", () => {
  const p = prompts.requirementsApplyDecisionsPrompt(TEST_ROOT);
  assert.match(p, /'requirements'/);
  assert.match(p, /Do not modify any file/);
  assert.ok("requirements" in S.RequirementsWrite.fields);
});

const disposition = (id: string, action: S.Disposition["action"]): S.Disposition => ({ id, action, rationale: "r", duplicate_of: "", reverses: "", concern: "c", remedy: "r", resolution: null });
const response = (findings: S.RequirementFinding[], requirements: string | null, ids: [string, S.Disposition["action"]][]): S.RequirementsResponse => ({
  dispositions: ids.map(([id, a]) => disposition(id, a)),
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  findings,
  requirements,
});
const CURRENT = "# Requirements\n";

test("the validation refuses each problem with FindingsInvalid and a repair from the same texts", () => {
  const cases: [S.RequirementsResponse, FindingProblem["kind"]][] = [
    [response([], CURRENT + "x", [["A", "accepted"]]), "missing"],
    [response([{ id: "A", kind: "unresolved" }], null, [["A", "rejected"]]), "notAccepted"],
    [response([{ id: "A", kind: "unresolved" }, { id: "A", kind: "unresolved" }], null, [["A", "accepted"]]), "duplicate"],
    [response([{ id: "A", kind: "answered", source: " " }], CURRENT + "x", [["A", "accepted"]]), "blankSource"],
    [response([{ id: "A", kind: "reopened", changed: "" }], null, [["A", "accepted"]]), "blankChange"],
    [response([{ id: "A", kind: "corrected" }], CURRENT, [["A", "accepted"]]), "documentUnchanged"],
  ];
  assert.deepEqual(cases.map(([, k]) => k), [...FINDING_PROBLEM_KINDS]);
  for (const [output, kind] of cases) {
    const result = findingsValidation(CURRENT)(output);
    assert.ok(Result.isFailure(result), kind);
    const { error, repair } = result.failure;
    assert.equal(error._tag, "FindingsInvalid");
    if (error._tag !== "FindingsInvalid") continue;
    assert.equal(error.problems.length, 1);
    assert.equal(error.problems[0]!.kind, kind);
    assert.equal(describe(error), prompts.findingsInvalidText(error.problems));
    assert.ok(describe(error).includes(prompts.findingProblemText(error.problems[0]!)));
    assert.ok(repair.includes(prompts.findingProblemText(error.problems[0]!)), kind);
    assert.ok(repair.includes(prompts.FINDINGS_RULES));
  }
  const valid = findingsValidation(CURRENT)(response([{ id: "A", kind: "answered", source: "user-decisions.md: yes" }], CURRENT + "yes\n", [["A", "accepted"]]));
  assert.ok(Result.isSuccess(valid));
});

test("each finding has its line", () => {
  assert.match(prompts.requirementsFindingLine({ id: "A", kind: "answered", source: "user-decisions.md: yes" }), /A: you answered this already \(user-decisions\.md: yes\)/);
  assert.match(prompts.requirementsFindingLine({ id: "B", kind: "corrected" }), /B: corrected in requirements\.md/);
  assert.match(prompts.requirementsFindingLine({ id: "C", kind: "unresolved" }), /C: put to you in the second interview/);
  assert.match(prompts.requirementsFindingLine({ id: "D", kind: "reopened", changed: "x changed" }), /D: put to you again, because x changed/);
});
