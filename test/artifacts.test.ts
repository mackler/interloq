import assert from "node:assert/strict";
import { test } from "node:test";
import { type Artifact, guardedRecord, LOG_SUBJECTS, pathOf, phaseOf, recordPath, reviewedFile, subjectDir, subjectOf } from "../src/artifacts.ts";
import { TEST_ROOT } from "./helpers.ts";

// Finding 28: one catalog of the records; every path the program writes or names comes from `pathOf`.
test("pathOf gives every record its path under plan-review/", () => {
  const cases: [Artifact, string][] = [
    [{ kind: "conversation" }, "conversation.md"],
    [{ kind: "decisions" }, "user-decisions.md"],
    [{ kind: "feedback" }, "reviewer-feedback.md"],
    [{ kind: "usage" }, "usage.jsonl"],
    [{ kind: "questions" }, "questions.json"],
    [{ kind: "requirements" }, "requirements.md"],
    [{ kind: "plan" }, "plan.md"],
    [{ kind: "planFile" }, "plan.json"],
    [{ kind: "checkpoint" }, "checkpoint.json"],
    [{ kind: "config" }, "config.json"],
    [{ kind: "log", subject: "questions" }, "questions-log.json"],
    [{ kind: "log", subject: "requirements" }, "requirements-log.json"],
    [{ kind: "log", subject: { plan: 3 } }, "issue-log.json"],
    [{ kind: "review", subject: "questions", round: 1 }, "question-review/review-1.json"],
    [{ kind: "response", subject: "requirements", round: 2 }, "requirements-review/cc-2.json"],
    [{ kind: "round", subject: { plan: 4 }, round: 3 }, "planning-4/round-3.json"],
    [{ kind: "planWrite", phase: 2 }, "planning-2/cc-0.json"],
    [{ kind: "execution", phase: 2 }, "execution-2/result.json"],
    [{ kind: "invalidReply", agent: "codex", n: 2 }, "invalid-replies/codex-2.json"],
  ];
  for (const [artifact, expected] of cases) assert.equal(pathOf(artifact), expected, JSON.stringify(artifact));
  assert.equal(recordPath(TEST_ROOT, { kind: "plan" }), `plan-review/${TEST_ROOT}/plan.md`);
});

test("subjects: directory names, phases, reviewed files, and the inverse of the directory name", () => {
  assert.equal(subjectDir("questions"), "question-review");
  assert.equal(subjectDir("requirements"), "requirements-review");
  assert.equal(subjectDir({ plan: 7 }), "planning-7");
  assert.deepEqual([phaseOf("questions"), phaseOf("requirements"), phaseOf({ plan: 7 })], [0, 0, 7]);
  assert.deepEqual([reviewedFile("questions"), reviewedFile("requirements"), reviewedFile({ plan: 1 })], [{ kind: "questions" }, { kind: "requirements" }, { kind: "planFile" }]);
  assert.deepEqual([subjectOf("question-review"), subjectOf("requirements-review"), subjectOf("planning-12"), subjectOf("planning-0"), subjectOf("execution-1"), subjectOf("planning-x")], ["questions", "requirements", { plan: 12 }, null, null, null]);
});

// Plan step 2.1: the work review is a fourth subject with its own directory per phase and one log.
test("the work review subject: directory, phase, log, reviewed file, baseline and change record", () => {
  assert.equal(subjectDir({ work: 2 }), "work-review-2");
  assert.deepEqual(subjectOf("work-review-3"), { work: 3 });
  assert.equal(subjectOf("work-review-0"), null);
  assert.equal(phaseOf({ work: 4 }), 4);
  assert.equal(pathOf({ kind: "log", subject: { work: 2 } }), "work-review-log.json");
  assert.equal(pathOf({ kind: "review", subject: { work: 1 }, round: 2 }), "work-review-1/review-2.json");
  assert.equal(pathOf({ kind: "baseline" }), "baseline.json");
  assert.equal(pathOf({ kind: "changes", phase: 3 }), "work-review-3/changes.diff");
  assert.deepEqual(reviewedFile({ work: 3 }), { kind: "changes", phase: 3 });
  assert.ok(LOG_SUBJECTS.some((s) => typeof s === "object" && "work" in s), "LOG_SUBJECTS lacks the work review log");
});

// Stage A (finding 1 of docs/gui-review.md): the records a read-only call must leave unchanged.
// Issue #120: the path is relative to the run's own records directory, which holds no archive.
test("guardedRecord exempts only the program's own writes during a call", () => {
  const exempt: Artifact[] = [{ kind: "usage" }, { kind: "invalidReply", agent: "claude", n: 1 }, { kind: "invalidReply", agent: "codex", n: 12 }];
  for (const a of exempt) assert.equal(guardedRecord(pathOf(a)), false, pathOf(a));
  // Every other kind of the catalog is guarded; a kind added later is guarded unless it is exempted by name.
  const guarded: Artifact[] = [
    { kind: "conversation" }, { kind: "decisions" }, { kind: "feedback" }, { kind: "questions" }, { kind: "requirements" }, { kind: "plan" }, { kind: "planFile" },
    { kind: "checkpoint" }, { kind: "config" }, { kind: "baseline" }, { kind: "changes", phase: 1 },
    ...LOG_SUBJECTS.map((subject): Artifact => ({ kind: "log", subject })),
    ...LOG_SUBJECTS.flatMap((subject) => (["review", "response", "round"] as const).map((kind): Artifact => ({ kind, subject, round: 1 }))),
    { kind: "planWrite", phase: 1 }, { kind: "execution", phase: 2 },
  ];
  for (const a of guarded) assert.equal(guardedRecord(pathOf(a)), true, pathOf(a));
  assert.equal(guardedRecord("notes/new.md"), true, "an unknown new file");
  assert.equal(guardedRecord("usage.jsonl.bak"), true);
  assert.equal(guardedRecord("invalid-repliesx/a.json"), true);
});

// Decision support, plan step 1.3: a decision is a fifth kind of subject, numbered across the run.
test("the decision subject: directory, log, its own files, reviewed file and the inverse of the directory name", () => {
  assert.equal(subjectDir({ decision: 2 }), "decision-2");
  assert.deepEqual(subjectOf("decision-3"), { decision: 3 });
  assert.equal(subjectOf("decision-0"), null);
  assert.equal(pathOf({ kind: "log", subject: { decision: 2 } }), "decision-log.json");
  assert.equal(pathOf({ kind: "review", subject: { decision: 1 }, round: 2 }), "decision-1/review-2.json");
  assert.equal(pathOf({ kind: "decisionQuestion", decision: 2 }), "decision-2/question.json");
  assert.equal(pathOf({ kind: "analysis", decision: 2 }), "decision-2/analysis.json");
  assert.equal(pathOf({ kind: "analysisWrite", decision: 2 }), "decision-2/cc-0.json");
  assert.equal(pathOf({ kind: "chosen", decision: 2 }), "decision-2/chosen.json");
  assert.deepEqual(reviewedFile({ decision: 4 }), { kind: "analysis", decision: 4 });
  assert.ok(LOG_SUBJECTS.some((s) => typeof s === "object" && "decision" in s), "LOG_SUBJECTS lacks the decision log");
  for (const a of [{ kind: "decisionQuestion", decision: 1 }, { kind: "analysis", decision: 1 }, { kind: "analysisWrite", decision: 1 }, { kind: "chosen", decision: 1 }] as const) assert.equal(guardedRecord(pathOf(a)), true, pathOf(a));
});

// S17 (issue #36, Q8): the explanations of the agreed questions' terms are a fifth subject, with its own directory, log,
// reviewed file, id prefix and checkpoint subject.
test("the terms subject: directory, phase, log, reviewed file, and the inverse of the directory name", () => {
  assert.equal(subjectDir("terms"), "terms-review");
  assert.equal(subjectOf("terms-review"), "terms");
  assert.equal(phaseOf("terms"), 0);
  assert.equal(pathOf({ kind: "log", subject: "terms" }), "terms-log.json");
  assert.equal(pathOf({ kind: "review", subject: "terms", round: 2 }), "terms-review/review-2.json");
  assert.deepEqual(reviewedFile("terms"), { kind: "terms" });
  assert.equal(pathOf({ kind: "terms" }), "terms.json");
  assert.ok(LOG_SUBJECTS.includes("terms"), "LOG_SUBJECTS lacks the terms log");
  assert.equal(guardedRecord(pathOf({ kind: "terms" })), true);
});
