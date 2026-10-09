// The program's own records on disk (findings 6, 7, 9, 15 and 16 of docs/functional-design-review.md;
// decisions Q5 and Q6). The value schemas of the entries are in src/schema.ts; this module holds the file
// shapes, the readers, and the checkpoint. Every file carries `version: 2`; nothing else is read.

import { Effect, FileSystem, Path, type PlatformError, Result, Schema } from "effect";
import { type Artifact, LOG_SUBJECTS, pathOf, type SubjectId, subjectOf } from "./artifacts.ts";
import { FileSystemError, StateFileInvalid } from "./errors.ts";
import * as S from "./schema.ts";
import type { LogEntry, QuestionsFile, UsageRecord } from "./schema.ts";
import { decodeRecord, decodeText, parseJson } from "./state.ts";

/** The version of every record file. */
export const VERSION = 2;
const V2 = Schema.Literal(2);
const Strings = Schema.Array(Schema.String);

// ---- files ----------------------------------------------------------------------------------------

export const LogFile = Schema.Struct({ version: V2, entries: Schema.Array(S.LogEntry) });
export type LogFile = typeof LogFile.Type;
export const logFile = (entries: readonly LogEntry[]): LogFile => ({ version: VERSION, entries });
export const questionsFile = (task: string, questions: QuestionsFile["questions"]): QuestionsFile => ({ version: VERSION, task, questions });

const IssueRecord = Schema.Struct({ id: S.IssueId, severity: S.Severity, location: Schema.String, problem: Schema.String, evidence: Schema.String });
export const ValidatedReviewRecord = Schema.Struct({ issues: Schema.Array(IssueRecord) });
const DispositionRecord = Schema.Struct({ id: S.IssueId, action: S.Action, rationale: Schema.String, duplicateOf: Schema.NullOr(S.IssueId), reverses: Schema.NullOr(S.IssueId) });
const SelfCorrectionRecord = Schema.Struct({ id: S.IssueId, newAction: Schema.Literals(["accepted", "rejected", "plan_error"]), explanation: Schema.String, generated: Schema.Boolean });
const NoteRecord = Schema.Struct({ id: S.IssueId, field: Schema.Literals(["duplicate_of", "reverses"]), named: Schema.String, reason: Schema.Literals(["unknown", "not_accepted"]) });
/** The response part of a validated round (src/round.ts `ValidatedRound` without its review). */
export const ValidatedResponseRecord = Schema.Struct({
  dispositions: Schema.Array(DispositionRecord),
  selfCorrections: Schema.Array(SelfCorrectionRecord),
  reviewerFeedback: Schema.String,
  questionsForUser: Schema.Array(S.UserQuestion),
});
const ProblemsRecord = Schema.Struct({ duplicateIssues: Strings, missing: Strings, duplicateDispositions: Strings, unknownDispositions: Strings, emptyIds: Strings, collidingIds: Strings });
/** `subject` is the subject directory (question-review, requirements-review, planning-<k>). `reconstructed` is always false now: it marked records rebuilt from files of the shape before Q5. */
const roundBase = { subject: Schema.String, phase: S.NonNegativeInt, round: S.NonNegativeInt, reconstructed: Schema.Boolean };
const validatedFields = { kind: Schema.Literal("validated"), ...roundBase, review: ValidatedReviewRecord, response: ValidatedResponseRecord, notes: Schema.Array(NoteRecord) };
const noResponseFields = { kind: Schema.Literal("no_response"), ...roundBase, review: ValidatedReviewRecord };
const invalidFields = { kind: Schema.Literal("invalid"), ...roundBase, review: S.Review, response: Schema.NullOr(S.PlannerResponse), problems: ProblemsRecord };
/** One round of a subject: completed and validated, or without a response (converged or interrupted). The `invalid` variant is read but never written: an invalid round halts. */
export const RoundRecord = Schema.Union([Schema.Struct(validatedFields), Schema.Struct(noResponseFields), Schema.Struct(invalidFields)]);
export const RoundFile = Schema.Union([Schema.Struct({ version: V2, ...validatedFields }), Schema.Struct({ version: V2, ...noResponseFields }), Schema.Struct({ version: V2, ...invalidFields })]);
export type RoundRecord = typeof RoundRecord.Type;

/** The tree of the project at the start of the run (decision Q7): the work reviews diff against it. */
export const Baseline = Schema.Struct({ version: V2, tree: Schema.NonEmptyString, time: Schema.String });
export type Baseline = typeof Baseline.Type;

// ---- decision support ------------------------------------------------------------------------------

/** Where a decision took place: the phase of the run as src/uiEvents.ts names it. */
const PhaseRecord = Schema.Union([Schema.Struct({ kind: Schema.Literal("questions") }), Schema.Struct({ kind: Schema.Literals(["planning", "execution", "work"]), n: S.NonNegativeInt })]);
/** decision-<k>/question.json: the question the user was asked, with its options, the phase in which it was asked and its label (W1-R1-2). */
export const DecisionQuestionFile = Schema.Struct({ version: V2, decision: S.PositiveInt, phase: PhaseRecord, label: Schema.String, question: Schema.String, options: Schema.Array(S.QuestionOption) });
export type DecisionQuestionFile = typeof DecisionQuestionFile.Type;
/** decision-<k>/analysis.json: the reviewed file of decision k, the validated analysis. */
export const AnalysisFile = Schema.Struct({ version: V2, analysis: S.DecisionAnalysis });
/** plan-review/terms.json (S17): the explanations of the agreed questions' terms. */
export const TermsFile = Schema.Struct({ version: V2, entries: Schema.Array(S.TermsEntry) });
/** decision-<k>/chosen.json (decision Q4): the user's answer after the analysis, and the option it chose (null for free text). */
export const ChoiceFile = Schema.Struct({ version: V2, decision: S.PositiveInt, answer: Schema.String, option: Schema.NullOr(Schema.String) });
export type ChoiceFile = typeof ChoiceFile.Type;

// ---- readers ------------------------------------------------------------------------------------

const all = <A, E>(results: readonly Result.Result<A, E>[]): Result.Result<readonly A[], E> => {
  const values: A[] = [];
  for (const r of results) {
    if (Result.isFailure(r)) return Result.fail(r.failure);
    values.push(r.success);
  }
  return Result.succeed(values);
};

/** The entries of a log file. */
export const readLog = (file: string, text: string): Result.Result<readonly LogEntry[], StateFileInvalid> => {
  const decoded = decodeText(file, LogFile, text);
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success.entries) : Result.fail(decoded.failure);
};

/** The lines of usage.jsonl; a failure names the line. */
export const readUsage = (file: string, text: string): Result.Result<readonly UsageRecord[], StateFileInvalid> =>
  all(
    text
      .split("\n")
      .filter((l) => l !== "")
      .map((line, i) => {
        const decoded = decodeText(file, S.UsageRecord, line);
        return Result.isSuccess(decoded) ? decoded : Result.fail(new StateFileInvalid({ file, message: `line ${i + 1}: ${decoded.failure.message}` }));
      }),
  );

export const readQuestions = (file: string, text: string): Result.Result<QuestionsFile, StateFileInvalid> => decodeText(file, S.QuestionsFile, text);

// ---- checkpoint (finding 16; Q6) --------------------------------------------------------------------

export type RecordsError = StateFileInvalid | FileSystemError;
type Fs = FileSystem.FileSystem | Path.Path;

/** The stage of the last committed transition; `started` is written by `init`. */
export const CheckpointStage = Schema.Literals(["started", "reviewed", "responded", "logged", "decided", "executed"]);
export const Checkpoint = Schema.Struct({ version: V2, subject: Schema.String, phase: S.NonNegativeInt, round: S.NonNegativeInt, stage: CheckpointStage, time: Schema.String });
export type Checkpoint = typeof Checkpoint.Type;
/** What the procedure reports as committed; the store adds the version and the time. */
export type CheckpointPoint = Readonly<{ subject: string; phase: number; round: number; stage: Checkpoint["stage"] }>;

const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
  Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));
const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => io("read", file, fs.exists(file));
  const readText = (file: string) => io("read", file, fs.readFileString(file));
  const readJson = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out, options?: { readonly onExcessProperty: "ignore" | "error" }) =>
    readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(parseJson(file, text))), Effect.flatMap((json) => Effect.fromResult(decodeRecord(file, schema, json, options))));
  const readIfExists = <A>(file: string, read: (file: string) => Effect.Effect<A, RecordsError>): Effect.Effect<A | null, RecordsError> =>
    exists(file).pipe(Effect.flatMap((present) => (present ? read(file) : Effect.succeed(null))));
  return { path, exists, readText, readJson, readIfExists };
});

/**
 * The checkpoint of a run directory, verified: the records the named transition implies exist and decode
 * (the logs for `started` — baseline.json is no longer written by init, issue #120 —, question.json and analysis.json of a decision, review and round record from `reviewed` on, the response from
 * `responded` on, the log for `logged` and `decided`, the execution result for `executed`); null when there is no checkpoint file.
 */
export const readCheckpoint = (runDir: string): Effect.Effect<Checkpoint | null, RecordsError, Fs> =>
  Effect.gen(function* () {
    const { path, exists, readJson, readIfExists, readText } = yield* files;
    const file = path.join(runDir, pathOf({ kind: "checkpoint" }));
    const checkpoint = yield* readIfExists(file, (f) => readJson(f, Checkpoint));
    if (checkpoint === null) return null;
    const invalid = (what: string) => Effect.fail(new StateFileInvalid({ file, message: `the checkpoint names ${what}` }));
    // The agents' raw replies are decoded with excess properties ignored.
    const lenient = { onExcessProperty: "ignore" as const };
    const required = <Out extends Schema.ConstraintDecoder<unknown>>(artifact: Artifact, schema: Out, options?: typeof lenient): Effect.Effect<Out["Type"], RecordsError> => {
      const target = path.join(runDir, pathOf(artifact));
      return exists(target).pipe(Effect.flatMap((present) => (present ? readJson(target, schema, options) : invalid(`a missing record: ${pathOf(artifact)}`))));
    };
    const logDecodes = (subject: SubjectId) => {
      const log = path.join(runDir, pathOf({ kind: "log", subject }));
      return exists(log).pipe(Effect.flatMap((present) => (present ? readText(log).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(log, text)))) : invalid(`a missing log: ${pathOf({ kind: "log", subject })}`))));
    };
    switch (checkpoint.stage) {
      case "started":
        for (const subject of LOG_SUBJECTS) yield* logDecodes(subject);
        break;
      case "executed":
        yield* required({ kind: "execution", phase: checkpoint.phase }, S.ExecOutcome);
        break;
      default: {
        const subject = subjectOf(checkpoint.subject);
        if (subject === null) return yield* invalid(`an unknown subject directory: ${checkpoint.subject}`);
        const { round, stage } = checkpoint;
        if (typeof subject === "object" && "decision" in subject) {
          yield* required({ kind: "decisionQuestion", decision: subject.decision }, DecisionQuestionFile);
          yield* required({ kind: "analysis", decision: subject.decision }, AnalysisFile);
        }
        yield* required({ kind: "review", subject, round }, S.Review, lenient);
        const record = yield* required({ kind: "round", subject, round }, RoundFile);
        if (stage === "responded" || stage === "logged") {
          yield* required({ kind: "response", subject, round }, S.PlannerResponse, lenient);
          if (record.kind !== "validated") return yield* invalid(`a ${stage} round whose record is ${record.kind}`);
        }
        if (stage === "logged" || stage === "decided") yield* logDecodes(subject);
      }
    }
    return checkpoint;
  });

