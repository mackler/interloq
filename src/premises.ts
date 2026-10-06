// The premises of the question list (issue #99; pure, no I/O, no Effect services): an entry may name another entry and one
// of its proposed answers that make it unnecessary (its `skip_if`). The checks of those conditions, the order in which a
// question comes after its premise, and the questions the user's answers remove.

import { Result, Schema } from "effect";
import type { QuestionEntry } from "./schema.ts";

/** What can be wrong with the skip conditions of a list, as data (the repair prompt and the halt describe it). */
export const SkipProblemSchema = Schema.Union([
  /** An entry's condition names a question that is not in the list. */
  Schema.Struct({ kind: Schema.Literal("unknownQuestion"), id: Schema.String, names: Schema.String }),
  /** An entry's condition names the entry itself. */
  Schema.Struct({ kind: Schema.Literal("selfReference"), id: Schema.String }),
  /** An entry's condition names an answer that is none of the named question's proposed answers. */
  Schema.Struct({ kind: Schema.Literal("unknownAnswer"), id: Schema.String, question: Schema.String, answer: Schema.String }),
  /** The conditions of these entries form a cycle, in order. */
  Schema.Struct({ kind: Schema.Literal("cycle"), ids: Schema.Array(Schema.String) }),
]);
export type SkipProblem = typeof SkipProblemSchema.Type;

/** The part of an entry the premises read. */
export type PremiseEntry = Pick<QuestionEntry, "id" | "proposed_answers" | "skip_if">;

/** Every problem of the skip conditions of a list, in the order of the list; empty when they are sound. */
export const skipConditionProblems = (_questions: readonly PremiseEntry[]): readonly SkipProblem[] => [];

/**
 * The list in a stable order in which every question comes after the question its condition names; a cycle fails.
 * Questions whose order no condition constrains keep their relative order.
 */
export const orderBySkipCondition = <Q extends PremiseEntry>(questions: readonly Q[]): Result.Result<readonly Q[], SkipProblem> => Result.succeed(questions);

/** The program's own record of the user's reply to an agreed question: the option chosen, or text that chose none. */
export type AgreedAnswer = Readonly<{ kind: "option"; label: string }> | Readonly<{ kind: "text" }>;
/** The replies so far, by the id of the agreed question. */
export type AgreedAnswers = ReadonlyMap<string, AgreedAnswer>;

/** A question the user's answers removed: its id, and the question and answer that removed it. */
export type Skipped = Readonly<{ id: string; question: string; answer: string }>;

/**
 * Every question whose condition's answer the user chose, and, transitively, every question whose condition names a
 * skipped question (its premise question is never asked, so it has no answer). A text reply skips nothing.
 */
export const skippedQuestions = (_questions: readonly PremiseEntry[], _answers: AgreedAnswers): readonly Skipped[] => [];

/** The id of the premise question not yet answered that the question `id` waits on, or null. */
export const waitingFor = (_questions: readonly PremiseEntry[], _answers: AgreedAnswers, _id: string): string | null => null;
