import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  AcceptedWithoutChange,
  AgentReplyInvalid,
  AgentUnreachable,
  AnalysisInvalid,
  CheckCommandInvalid,
  ClaudeCallFailed,
  ClaudeSessionTooLong,
  CodexCallFailed,
  ConfigInvalid,
  CorrectionInvalid,
  DecisionFormatUnreadable,
  describe,
  FileSystemError,
  GitError,
  haltMessage,
  InterviewTurnInvalid,
  Interrupted,
  PlanInvalid,
  ProjectChanged,
  QuestionInvalid,
  QuestionListInvalid,
  RecordsChanged,
  ReviewedFileChanged,
  RoundInvalid,
  RoundLimitStop,
  type RunError,
  ServerFault,
  SkipConditionInvalid,
  StateFileInvalid,
  SuiteStopped,
  TrackerStepFailed,
  UserStopped,
} from "../src/errors.ts";
import { defectRecord, endedOutcome, haltRecord, serverFaultRecord } from "../src/prompts.ts";

const word = endedOutcome(1);
const prefix = `**${word.charAt(0).toUpperCase()}${word.slice(1)} (exit code 1):** `;

test("a halt's, a defect's and the server fault's records carry the code and its word, and their text unchanged", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const halt = haltRecord(text);
      assert.ok(halt.startsWith(prefix), halt);
      assert.ok(halt.endsWith("\n"));
      assert.equal(halt, `${prefix}${text}\n`);
      const defect = defectRecord(text);
      assert.ok(defect.startsWith(prefix), defect);
      assert.ok(defect.includes(text));
      assert.ok(defect.endsWith("\n"));
      const fault = serverFaultRecord(text);
      assert.ok(fault.startsWith(prefix), fault);
      assert.ok(fault.includes(text));
    }),
    { numRuns: 200 },
  );
});

/** One sample per member of the union: a new member fails the type check until it has one. */
const samples: { readonly [K in RunError["_tag"]]: Extract<RunError, { _tag: K }> } = {
  UserStopped: new UserStopped({ where: "planning" }),
  ProjectChanged: new ProjectChanged({ during: "planning", fileLabel: null, changes: [{ kind: "content_changed", path: "a.txt" }] }),
  ReviewedFileChanged: new ReviewedFileChanged({ fileLabel: "plan.json", changes: [{ kind: "added", path: "b.txt" }] }),
  RecordsChanged: new RecordsChanged({ changes: [{ kind: "content_changed", path: "plan.md" }] }),
  AcceptedWithoutChange: new AcceptedWithoutChange({ fileLabel: "plan.json", accepted: 2 }),
  RoundInvalid: new RoundInvalid({ duplicateIssues: ["A"], missing: [], duplicateDispositions: [], unknownDispositions: [], emptyIds: [], collidingIds: [], blankEffects: [] }),
  QuestionListInvalid: new QuestionListInvalid({ duplicateIds: ["Q1"], emptyIds: 0, cycle: [] }),
  RoundLimitStop: new RoundLimitStop({ heading: "Planning phase 1" }),
  ClaudeCallFailed: new ClaudeCallFailed({ message: "authentication failed" }),
  ClaudeSessionTooLong: new ClaudeSessionTooLong({ message: "Prompt is too long" }),
  CheckCommandInvalid: new CheckCommandInvalid({ problems: [{ _tag: "MissingScript", command: "npm run x", script: "x" }] }),
  CodexCallFailed: new CodexCallFailed({ message: "turn failed" }),
  AgentReplyInvalid: new AgentReplyInvalid({ agent: "Codex", issue: "schema mismatch", files: ["invalid-replies/a.json"] }),
  ConfigInvalid: new ConfigInvalid({ file: "/p/plan-review/config.json", path: "maxRounds", message: "Expected number" }),
  StateFileInvalid: new StateFileInvalid({ file: "issue-log.json", message: "unexpected end" }),
  FileSystemError: new FileSystemError({ operation: "write", path: "requirements.md", message: "EACCES" }),
  GitError: new GitError({ args: ["status"], message: "not a repository" }),
  DecisionFormatUnreadable: new DecisionFormatUnreadable({ file: "/opt/interloq/docs/decision-making.md", message: "ENOENT" }),
  AnalysisInvalid: new AnalysisInvalid({ columns: null, duplicateIds: ["A1"], emptyIds: 0, recommendation: null, blankUnclear: [] }),
  PlanInvalid: new PlanInvalid({ duplicateIds: ["S1"], emptyIds: 0, removedDone: [], changedDone: [] }),
  CorrectionInvalid: new CorrectionInvalid({ changedIds: ["A"], other: [] }),
  QuestionInvalid: new QuestionInvalid({ questions: [{ where: "Q1", problems: [{ kind: "entryCount", subject: "2" }] }] }),
  SkipConditionInvalid: new SkipConditionInvalid({ problems: [{ kind: "selfReference", id: "Q1" }] }),
  InterviewTurnInvalid: new InterviewTurnInvalid({ problems: [{ kind: "followUpIdBlank" }] }),
  AgentUnreachable: new AgentUnreachable({ agent: "codex", attempts: 4, lastFault: "ECONNRESET\nsecond line" }),
  TrackerStepFailed: new TrackerStepFailed({ item: "193", step: "setImplementing", cause: "refused", done: null, check: null }),
  ServerFault: new ServerFault({ message: "boom" }),
  SuiteStopped: new SuiteStopped({ command: "npm test", suite: 2, stops: 2, reason: "timedOut" }),
  Interrupted: new Interrupted({ where: "planning" }),
};

test("over the whole union, the page's halt text and the record are derived from the one describe", () => {
  for (const sample of Object.values(samples)) {
    const text = describe(sample);
    assert.equal(haltMessage(sample), `HALTED: ${text}`, sample._tag);
    assert.ok(haltRecord(text).includes(text), sample._tag);
  }
});
