import assert from "node:assert/strict";
import { test } from "node:test";
import type { Disposition, RequirementFinding } from "../src/schema.ts";
import { findingsProblems, interviewedOf, writtenOf } from "../src/requirementsFindings.ts";

// Issue #47: Claude Code classifies each accepted finding of the requirements review; the program checks it on data.
const d = (id: string, action: Disposition["action"]): Disposition => ({ id, action, rationale: "r", duplicate_of: "", reverses: "" });
const CURRENT = "# Requirements\n\nThe summary.\n";
const CHANGED = "# Requirements\n\nThe summary.\n\nThe answer.\n";

test("a valid classification has no problem", () => {
  const ds = [d("G-R1-1", "accepted"), d("G-R1-2", "partially_accepted"), d("G-R1-3", "rejected")];
  const fs: RequirementFinding[] = [{ id: "G-R1-1", kind: "answered", source: "user-decisions.md: yes" }, { id: "G-R1-2", kind: "unresolved" }];
  assert.deepEqual(findingsProblems(ds, fs, CHANGED, CURRENT), []);
});

test("no accepted disposition, no findings and no document is no problem", () => {
  assert.deepEqual(findingsProblems([d("G-R1-1", "rejected")], [], null, CURRENT), []);
});

test("an accepted id without a finding is missing, two findings for one id a duplicate", () => {
  const ds = [d("A", "accepted"), d("B", "partially_accepted")];
  const fs: RequirementFinding[] = [{ id: "B", kind: "unresolved" }, { id: "B", kind: "reopened", changed: "x" }];
  assert.deepEqual(findingsProblems(ds, fs, null, CURRENT), [
    { kind: "missing", id: "A" },
    { kind: "duplicate", id: "B" },
  ]);
});

test("a finding for a disposition not accepted, or an unknown id, is notAccepted", () => {
  const ds = [d("A", "rejected"), d("B", "no_change_needed"), d("C", "clarification_requested")];
  const fs: RequirementFinding[] = ["A", "B", "C", "Z"].map((id) => ({ id, kind: "unresolved" as const }));
  assert.deepEqual(
    findingsProblems(ds, fs, null, CURRENT),
    ["A", "B", "C", "Z"].map((id) => ({ kind: "notAccepted", id })),
  );
});

test("a blank source or a blank change is refused", () => {
  const ds = [d("A", "accepted"), d("B", "accepted")];
  const fs: RequirementFinding[] = [{ id: "A", kind: "answered", source: " \n\t" }, { id: "B", kind: "reopened", changed: "" }];
  assert.deepEqual(findingsProblems(ds, fs, CHANGED, CURRENT), [
    { kind: "blankSource", id: "A" },
    { kind: "blankChange", id: "B" },
  ]);
});

test("answered or corrected findings need a changed document", () => {
  const ds = [d("A", "accepted"), d("B", "accepted"), d("C", "accepted")];
  const fs: RequirementFinding[] = [{ id: "A", kind: "answered", source: "s" }, { id: "B", kind: "unresolved" }, { id: "C", kind: "corrected" }];
  assert.deepEqual(findingsProblems(ds, fs, null, CURRENT), [{ kind: "documentUnchanged", ids: ["A", "C"] }]);
  assert.deepEqual(findingsProblems(ds, fs, CURRENT.trimEnd() + "\n\n  ", CURRENT), [{ kind: "documentUnchanged", ids: ["A", "C"] }]);
});

test("a document changed although every finding is unresolved is no problem", () => {
  assert.deepEqual(findingsProblems([d("A", "accepted")], [{ id: "A", kind: "unresolved" }], CHANGED, CURRENT), []);
});

test("problems are listed by kind, then by id", () => {
  const ds = [d("B", "accepted"), d("A", "accepted"), d("C", "accepted")];
  const fs: RequirementFinding[] = [{ id: "C", kind: "answered", source: "" }, { id: "Y", kind: "unresolved" }, { id: "X", kind: "unresolved" }];
  assert.deepEqual(
    findingsProblems(ds, fs, null, CURRENT).map((p) => p.kind),
    ["missing", "missing", "notAccepted", "notAccepted", "blankSource", "documentUnchanged"],
  );
  assert.deepEqual(
    findingsProblems(ds, fs, null, CURRENT).slice(0, 4),
    [{ kind: "missing", id: "A" }, { kind: "missing", id: "B" }, { kind: "notAccepted", id: "X" }, { kind: "notAccepted", id: "Y" }],
  );
});

test("the interviewed and the written findings, in the response's order", () => {
  const fs: RequirementFinding[] = [
    { id: "A", kind: "reopened", changed: "c" },
    { id: "B", kind: "corrected" },
    { id: "C", kind: "unresolved" },
    { id: "D", kind: "answered", source: "s" },
  ];
  assert.deepEqual(interviewedOf(fs).map((f) => f.id), ["A", "C"]);
  assert.deepEqual(writtenOf(fs).map((f) => f.id), ["B", "D"]);
});
