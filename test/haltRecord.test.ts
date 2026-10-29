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
  VerdictInvalid,
  NotRefinedStopped,
  SendBackNotParked,
  SendBackIncomplete,
  TrackerStepFailed,
  UserStopped,
  NoAnswer,
  SendBackUnanswered,
} from "../src/errors.ts";
import { ABANDONED_EXIT_CODE, abandonedRecord, defectRecord, durationText, endedOutcome, haltRecord, noAnswerText, serverFaultRecord } from "../src/prompts.ts";

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
  VerdictInvalid: new VerdictInvalid({ problem: "blankMissing" }),
  NotRefinedStopped: new NotRefinedStopped({ item: "186", missing: "the retention period", reason: "refinementAskedNothing", park: { _tag: "Parked", branch: "interloq/halted/186/r", commit: "abc" } }),
  SendBackNotParked: new SendBackNotParked({ item: "186", message: "git branch failed: exists", park: { _tag: "ParkFailed", message: "git branch failed: exists" } }),
  SendBackIncomplete: new SendBackIncomplete({ item: "186", ending: "sentBack", park: { _tag: "NothingParked" }, cause: "the label could not be set" }),
  Interrupted: new Interrupted({ where: "planning" }),
  NoAnswer: new NoAnswer({ where: "Your answer:", seconds: 120, question: { number: 3, text: "Which file format?" }, then: "abandon" }),
  SendBackUnanswered: new SendBackUnanswered({ item: "185", step: "label", park: { _tag: "Parked", branch: "interloq/halted/185/r", commit: "abc" }, where: "Your answer:", seconds: 120, question: null, then: "abandon" }),
};

test("over the whole union, the page's halt text and the record are derived from the one describe", () => {
  for (const sample of Object.values(samples)) {
    const text = describe(sample);
    assert.equal(haltMessage(sample), `HALTED: ${text}`, sample._tag);
    assert.ok(haltRecord(text).includes(text), sample._tag);
  }
});

// Issue #186: the three halts of a send-back name the item and the reason.
test("the halts of a send-back name the item and why", () => {
  assert.match(describe(samples.NotRefinedStopped), /item 186.*asked the developer no question/);
  assert.match(describe(new NotRefinedStopped({ item: null, missing: "m", reason: "noTracker", park: null })), /no item in a tracker/);
  assert.match(describe(samples.SendBackNotParked), /item 186.*could not be parked: git branch failed: exists/);
  assert.match(describe(samples.SendBackIncomplete), /item 186.*no work to park.*the label could not be set/);
});

// Issue #185: the third ending, a run that got no answer within the wait.
test("an abandoned run's record carries exit code 2 and its own word, and names the question and the wait", () => {
  assert.equal(ABANDONED_EXIT_CODE, 2);
  assert.equal(endedOutcome(2), "abandoned");
  assert.equal(endedOutcome(0), "finished");
  assert.equal(endedOutcome(1), "halted");
  assert.equal(endedOutcome(130), "interrupted");
  const text = describe(samples.NoAnswer);
  assert.equal(abandonedRecord(text), `**Abandoned (exit code 2):** ${text}\n`);
  assert.match(text, /question 3/);
  assert.match(text, /Which file format\?/);
  assert.ok(text.includes(durationText(120_000)), text);
  assert.match(describe(samples.SendBackUnanswered), /item 185.*interloq\/halted\/185\/r.*setting of the label `unrefined`/);
});

test("the text of an unanswered question names the wait and the question, and never says give up", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000 }), fc.option(fc.record({ number: fc.integer({ min: 1, max: 999 }), text: fc.string() }), { nil: null }), (seconds, question) => {
      const text = noAnswerText(question, seconds);
      assert.ok(text.includes(durationText(seconds * 1000)), text);
      if (question !== null) {
        assert.ok(text.includes(question.text));
        assert.ok(text.includes(`question ${question.number}`));
      }
      assert.ok(!/give up/i.test(text.replace(question?.text ?? "", "")));
    }),
    { numRuns: 200 },
  );
});
