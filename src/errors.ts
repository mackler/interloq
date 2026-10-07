// Typed errors: one per cause that ends a run, and one per I/O or parse failure that used to escape
// raw. `describe` produces the text that the program prints. Replaces the single Halt class.
import { Data, Result, Schema } from "effect";
import { type Change, renderChange } from "./snapshot.ts";
import { type SkipProblem, SkipProblemSchema, type TurnSkipProblem, TurnSkipProblemSchema } from "./premises.ts";
import { interviewTurnInvalidText, skipConditionInvalidText, agentUnreachableText, analysisInvalidText, correctionInvalidText, cycleInvalidText, cycleLimitStopText, decisionFormatUnreadableText, planInvalidText, QUESTION_PROBLEM_KINDS, type QuestionProblems, questionInvalidText } from "./prompts.ts";

export class UserStopped extends Data.TaggedError("UserStopped")<{ readonly where: string }> {}
export class ProjectChanged extends Data.TaggedError("ProjectChanged")<{ readonly during: "planning" | "review"; readonly fileLabel: string | null; readonly changes: readonly Change[] }> {}
export class ReviewedFileChanged extends Data.TaggedError("ReviewedFileChanged")<{ readonly fileLabel: string; readonly changes: readonly Change[] }> {}
/** A record under plan-review/ changed during a read-only call (a work response; finding 1 of docs/gui-review.md). */
export class RecordsChanged extends Data.TaggedError("RecordsChanged")<{ readonly changes: readonly Change[] }> {}
export class AcceptedWithoutChange extends Data.TaggedError("AcceptedWithoutChange")<{ readonly fileLabel: string; readonly accepted: number }> {}
/** A review or a response whose structure is invalid: decision Q3 of the functional design review, a halt without a repair turn. */
export class RoundInvalid extends Data.TaggedError("RoundInvalid")<{
  readonly duplicateIssues: readonly string[];
  readonly missing: readonly string[];
  readonly duplicateDispositions: readonly string[];
  readonly unknownDispositions: readonly string[];
  /** What carried an empty id ("an issue of the review", "a disposition of the response"). */
  readonly emptyIds: readonly string[];
  /** Generated self-correction ids that already exist in the log. */
  readonly collidingIds: readonly string[];
}> {}
/** A question list whose structure is invalid (duplicate or empty ids): a halt without a repair turn, by analogy with Q3 (step 4.6). */
export class QuestionListInvalid extends Data.TaggedError("QuestionListInvalid")<{ readonly duplicateIds: readonly string[]; readonly emptyIds: number; readonly cycle: readonly string[] }> {}
export class RoundLimitStop extends Data.TaggedError("RoundLimitStop")<{ readonly heading: string }> {}
export class ClaudeCallFailed extends Data.TaggedError("ClaudeCallFailed")<{ readonly message: string }> {}
export class CodexCallFailed extends Data.TaggedError("CodexCallFailed")<{ readonly message: string }> {}
/**
 * A failure of an agent call that src/transport.ts identifies as a dropped connection, a reset, a timeout or a 5xx
 * (issue #26). Not a RunError: the callers retry it (src/retry.ts), and only AgentUnreachable leaves a run.
 */
/** The retries of a transport fault were exhausted and the user chose to stop (issue #26, Q2). */
export class AgentUnreachable extends Data.TaggedError("AgentUnreachable")<{ readonly agent: "claude" | "codex"; readonly attempts: number; readonly lastFault: string }> {}
export class TransportFault extends Data.TaggedError("TransportFault")<{ readonly agent: "claude" | "codex"; readonly message: string; readonly status: number | null }> {}
export class AgentReplyInvalid extends Data.TaggedError("AgentReplyInvalid")<{ readonly agent: string; readonly issue: string; readonly files: string[] }> {}
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{ readonly file: string; readonly path: string; readonly message: string }> {}
export class StateFileInvalid extends Data.TaggedError("StateFileInvalid")<{ readonly file: string; readonly message: string }> {}
export class FileSystemError extends Data.TaggedError("FileSystemError")<{ readonly operation: string; readonly path: string; readonly message: string }> {}
export class GitError extends Data.TaggedError("GitError")<{ readonly args: string[]; readonly message: string }> {}
/** A decision analysis whose structure is invalid (decision support, D9): a halt without a repair turn, like RoundInvalid. */
export class AnalysisInvalid extends Data.TaggedError("AnalysisInvalid")<{
  readonly columns: Readonly<{ expected: readonly string[]; got: readonly string[] }> | null;
  readonly duplicateIds: readonly string[];
  readonly emptyIds: number;
  /** The recommended option that names no option, with the options it matches after normalization (none, or more than one). */
  readonly recommendation: Readonly<{ given: string; matches: readonly string[] }> | null;
  /** The options of the unclear columns whose statement of what is unclear is blank (issue #35, Q8). */
  readonly blankUnclear: readonly string[];
}> {}
/**
 * A plan whose structure is invalid beyond its schema (issue #6, G-R1-1): empty or repeated step ids, or a revision that
 * removes a done step or changes its label or text. The plan gets the validation repair turn of behaviour 10.
 */
/**
 * A corrective reply (issue #30) that changed what it may not: a disposition other than those it was allowed to change,
 * a reference of one it was, or another part of the response. A halt after its own repair turn, like AnalysisInvalid.
 */
export class CorrectionInvalid extends Data.TaggedError("CorrectionInvalid")<{ readonly changedIds: readonly string[]; readonly other: readonly string[] }> {}
export class PlanInvalid extends Data.TaggedError("PlanInvalid")<{
  readonly duplicateIds: readonly string[];
  readonly emptyIds: number;
  /** Done steps (by id) that the revision no longer contains. */
  readonly removedDone: readonly string[];
  /** Done steps (by id) whose label or text the revision changed. */
  readonly changedDone: readonly string[];
}> {}
/**
 * A question put to the user that breaks a mechanically checkable rule of QUESTION_RULES (S2): each question named by
 * where it is, with its problems. The reply gets the validation repair turn of behaviour 10; a second failure halts.
 */
export class QuestionInvalid extends Data.TaggedError("QuestionInvalid")<{ readonly questions: QuestionProblems }> {}
/**
 * A question list whose skip conditions (issue #99) name an unknown question or answer, the entry itself, or form a cycle:
 * the validation repair turn of behaviour 10, then a halt.
 */
export class SkipConditionInvalid extends Data.TaggedError("SkipConditionInvalid")<{ readonly problems: readonly SkipProblem[] }> {}
/** An interview turn that asks a skipped question or one before its premise, or omits a skipped one from its summary (issue #99). */
export class InterviewTurnInvalid extends Data.TaggedError("InterviewTurnInvalid")<{ readonly problems: readonly TurnSkipProblem[] }> {}
/** A report of report_step that names no step of the plan (Q3): an error for Claude Code, not a halt. */
export class UnknownStep extends Data.TaggedError("UnknownStep")<{ readonly id: string }> {}
/** docs/decision-making.md of the program could not be read before the run (decision support, D7). */
export class DecisionFormatUnreadable extends Data.TaggedError("DecisionFormatUnreadable")<{ readonly file: string; readonly message: string }> {}
export class Interrupted extends Data.TaggedError("Interrupted")<{ readonly where: string }> {}

export type RunError =
  | UserStopped
  | ProjectChanged
  | ReviewedFileChanged
  | RecordsChanged
  | AcceptedWithoutChange
  | RoundInvalid
  | QuestionListInvalid
  | RoundLimitStop
  | ClaudeCallFailed
  | CodexCallFailed
  | AgentReplyInvalid
  | ConfigInvalid
  | StateFileInvalid
  | FileSystemError
  | GitError
  | DecisionFormatUnreadable
  | AnalysisInvalid
  | PlanInvalid
  | CorrectionInvalid
  | QuestionInvalid
  | SkipConditionInvalid
  | InterviewTurnInvalid
  | AgentUnreachable
  | Interrupted;

const indent = (changes: readonly Change[]): string => changes.map((change) => `\n  ${renderChange(change)}`).join("");

/** The text that the program prints for an error. */
export const describe = (error: RunErrorFields): string => {
  switch (error._tag) {
    case "UserStopped":
      return "stopped by the user";
    case "ProjectChanged":
      return error.during === "planning"
        ? `the project outside plan-review/ changed during a planning-phase call. Either Claude Code changed it, or another process did (for example another Claude Code session in the same project).${indent(error.changes)}`
        : `the project or ${error.fileLabel} changed during a Codex review. Either Codex changed it, or another process did.${indent(error.changes)}`;
    case "ReviewedFileChanged":
      return `the project or ${error.fileLabel} changed during a Codex review. Either Codex changed it, or another process did.${indent(error.changes)}`;
    case "RecordsChanged":
      return `a record under plan-review/ changed during a read-only response of Claude Code (a work response may not change any file). Either Claude Code changed it, or another process did.${indent(error.changes)}`;
    case "AcceptedWithoutChange":
      return `Claude Code accepted ${error.accepted} issues in full or in part but ${error.fileLabel} is unchanged`;
    case "RoundInvalid": {
      const parts: string[] = [];
      if (error.duplicateIssues.length > 0) parts.push(`Codex returned more than one issue with the id: ${error.duplicateIssues.join(", ")}`);
      if (error.missing.length > 0) parts.push(`Claude Code returned no disposition for: ${error.missing.join(", ")}`);
      if (error.duplicateDispositions.length > 0) parts.push(`Claude Code returned more than one disposition for: ${error.duplicateDispositions.join(", ")}`);
      if (error.unknownDispositions.length > 0) parts.push(`Claude Code returned a disposition for an id that is not in the review: ${error.unknownDispositions.join(", ")}`);
      if (error.emptyIds.length > 0) parts.push(`an empty id in ${error.emptyIds.join(" and ")}`);
      if (error.collidingIds.length > 0) parts.push(`a generated self-correction id already exists in the log: ${error.collidingIds.join(", ")}`);
      return cycleInvalidText(parts);
    }
    case "QuestionListInvalid": {
      const parts: string[] = [];
      if (error.duplicateIds.length > 0) parts.push(`more than one question with the id: ${error.duplicateIds.join(", ")}`);
      if (error.emptyIds > 0) parts.push(`${error.emptyIds} question(s) without an id`);
      if (error.cycle.length > 0) parts.push(`the skip conditions of ${error.cycle.join(", ")} form a cycle`);
      return `the question list is invalid: ${parts.join("; ")}`;
    }
    case "RoundLimitStop":
      return cycleLimitStopText(error.heading);
    case "ClaudeCallFailed":
      return `Claude Code planning call failed: ${error.message}`;
    case "CodexCallFailed":
      return `Codex review failed: ${error.message}`;
    case "AgentUnreachable":
      return agentUnreachableText(error.agent, error.attempts, error.lastFault);
    case "AgentReplyInvalid":
      return `the reply of ${error.agent} does not match its schema: ${error.issue}. The reply is kept in ${error.files.join(", ")}`;
    case "ConfigInvalid":
      return `${error.file} is not a valid configuration: ${error.message} (at ${error.path})`;
    case "StateFileInvalid":
      return `${error.file} could not be read: ${error.message}`;
    case "FileSystemError":
      return `${error.operation} failed for ${error.path}: ${error.message}`;
    case "GitError":
      return `git ${error.args.join(" ")} failed: ${error.message}`;
    case "DecisionFormatUnreadable":
      return decisionFormatUnreadableText(error.file, error.message);
    case "AnalysisInvalid": {
      const parts: string[] = [];
      if (error.columns !== null) parts.push(`columns ${error.columns.expected.join(", ")} expected, ${error.columns.got.join(", ") || "none"} given`);
      if (error.duplicateIds.length > 0) parts.push(`more than one entry or argument with the id: ${error.duplicateIds.join(", ")}`);
      if (error.emptyIds > 0) parts.push(`${error.emptyIds} empty id(s)`);
      if (error.recommendation !== null)
        parts.push(
          error.recommendation.matches.length > 1
            ? `the analysis recommends ${error.recommendation.given}, which matches more than one option: ${error.recommendation.matches.join(", ")}`
            : `the analysis recommends ${error.recommendation.given}, which is not an option`,
        );
      if (error.blankUnclear.length > 0) parts.push(`the unclear column of ${error.blankUnclear.join(", ")} states nothing`);
      return analysisInvalidText(parts);
    }
    case "CorrectionInvalid":
      return correctionInvalidText(error.changedIds, error.other);
    case "PlanInvalid":
      return planInvalidText(error);
    case "QuestionInvalid":
      return questionInvalidText(error.questions);
    case "SkipConditionInvalid":
      return skipConditionInvalidText(error.problems);
    case "InterviewTurnInvalid":
      return interviewTurnInvalidText(error.problems);
    case "Interrupted":
      return `interrupted during ${error.where}`;
  }
};

/**
 * The data of each error, as a schema: `describe` reads only these fields, so a value that was decoded
 * from an unknown source (the entry point's catch) is described like an instance (finding 10).
 */
const Strings = Schema.Array(Schema.String);
const ChangeData = Schema.Struct({
  kind: Schema.Literals(["added", "removed", "content_changed", "type_changed", "status_changed"]),
  path: Schema.String,
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
});
const RunErrorData = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("UserStopped"), where: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ProjectChanged"), during: Schema.Literals(["planning", "review"]), fileLabel: Schema.NullOr(Schema.String), changes: Schema.Array(ChangeData) }),
  Schema.Struct({ _tag: Schema.Literal("ReviewedFileChanged"), fileLabel: Schema.String, changes: Schema.Array(ChangeData) }),
  Schema.Struct({ _tag: Schema.Literal("RecordsChanged"), changes: Schema.Array(ChangeData) }),
  Schema.Struct({ _tag: Schema.Literal("AcceptedWithoutChange"), fileLabel: Schema.String, accepted: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("RoundInvalid"),
    duplicateIssues: Strings,
    missing: Strings,
    duplicateDispositions: Strings,
    unknownDispositions: Strings,
    emptyIds: Strings,
    collidingIds: Strings,
  }),
  Schema.Struct({ _tag: Schema.Literal("QuestionListInvalid"), duplicateIds: Strings, emptyIds: Schema.Number, cycle: Strings }),
  Schema.Struct({ _tag: Schema.Literal("RoundLimitStop"), heading: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ClaudeCallFailed"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("CodexCallFailed"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("AgentReplyInvalid"), agent: Schema.String, issue: Schema.String, files: Strings }),
  Schema.Struct({ _tag: Schema.Literal("ConfigInvalid"), file: Schema.String, path: Schema.String, message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("StateFileInvalid"), file: Schema.String, message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("FileSystemError"), operation: Schema.String, path: Schema.String, message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("GitError"), args: Strings, message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("DecisionFormatUnreadable"), file: Schema.String, message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("AnalysisInvalid"),
    columns: Schema.NullOr(Schema.Struct({ expected: Strings, got: Strings })),
    duplicateIds: Strings,
    emptyIds: Schema.Number,
    recommendation: Schema.NullOr(Schema.Struct({ given: Schema.String, matches: Strings })),
    blankUnclear: Strings,
  }),
  Schema.Struct({ _tag: Schema.Literal("CorrectionInvalid"), changedIds: Strings, other: Strings }),
  Schema.Struct({ _tag: Schema.Literal("PlanInvalid"), duplicateIds: Strings, emptyIds: Schema.Number, removedDone: Strings, changedDone: Strings }),
  Schema.Struct({
    _tag: Schema.Literal("QuestionInvalid"),
    questions: Schema.Array(Schema.Struct({ where: Schema.String, problems: Schema.Array(Schema.Struct({ kind: Schema.Literals(QUESTION_PROBLEM_KINDS), subject: Schema.String })) })),
  }),
  Schema.Struct({ _tag: Schema.Literal("SkipConditionInvalid"), problems: Schema.Array(SkipProblemSchema) }),
  Schema.Struct({ _tag: Schema.Literal("InterviewTurnInvalid"), problems: Schema.Array(TurnSkipProblemSchema) }),
  Schema.Struct({ _tag: Schema.Literal("AgentUnreachable"), agent: Schema.Literals(["claude", "codex"]), attempts: Schema.Number, lastFault: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Interrupted"), where: Schema.String }),
]);
/** The fields of one of the program's errors; every `RunError` instance is one. */
export type RunErrorFields = typeof RunErrorData.Type;
const decodeRunErrorData = Schema.decodeUnknownResult(RunErrorData);

/** The error's fields when the value carries one of our tags with that tag's payload; null otherwise. */
export const decodeRunError = (error: unknown): RunErrorFields | null => {
  const decoded = decodeRunErrorData(error);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

/**
 * What the entry point prints for an error, or null if the error is none of ours, in which case the
 * entry point rethrows it. Keeps that decision out of the untested main.ts.
 */
export const haltMessage = (error: unknown): string | null => {
  const decoded = decodeRunError(error);
  return decoded === null ? null : `HALTED: ${describe(decoded)}`;
};
