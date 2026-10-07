// The premises of the question list (issue #99; pure, no I/O, no Effect services): an entry may name another entry and one
// of its proposed answers that make it unnecessary (its `skip_if`). The checks of those conditions, the order in which a
// question comes after its premise, and the questions the user's answers remove.

import { Result, Schema } from "effect";
import { piecesText } from "./pieces.ts";
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

/** The id a question's condition names, when it names another question of the list. */
const premiseOf = (questions: readonly PremiseEntry[], q: PremiseEntry): string | null =>
  q.skip_if !== null && q.skip_if.question !== q.id && questions.some((p) => p.id === q.skip_if?.question) ? q.skip_if.question : null;

/**
 * The cycle a question's chain of premises runs into, from the first question of the cycle met; empty when the chain ends.
 * The chain is at most as long as the list, which bounds the recursion.
 */
const cycleFrom = (questions: readonly PremiseEntry[], id: string, seen: readonly string[]): readonly string[] => {
  const at = seen.indexOf(id);
  if (at >= 0) return seen.slice(at);
  const q = questions.find((e) => e.id === id);
  const next = q === undefined ? null : premiseOf(questions, q);
  return next === null ? [] : cycleFrom(questions, next, [...seen, id]);
};

/** A cycle in the order of the list: the same set of ids is reported once, starting with its earliest question. */
const inListOrder = (questions: readonly PremiseEntry[], cycle: readonly string[]): readonly string[] => questions.map((q) => q.id).filter((id) => cycle.includes(id));

/** Every cycle of the list's conditions, once each, in the order of their first question in the list. */
const cyclesOf = (questions: readonly PremiseEntry[]): readonly (readonly string[])[] =>
  questions
    .map((q) => inListOrder(questions, cycleFrom(questions, q.id, [])))
    .filter((c) => c.length > 0)
    .filter((c, i, all) => all.findIndex((d) => d.join(" ") === c.join(" ")) === i);

/** The problem of one entry's own condition, or null. */
const conditionProblem = (questions: readonly PremiseEntry[], q: PremiseEntry): SkipProblem | null => {
  if (q.skip_if === null) return null;
  const condition = q.skip_if;
  if (condition.question === q.id) return { kind: "selfReference", id: q.id };
  const named = questions.find((p) => p.id === condition.question);
  if (named === undefined) return { kind: "unknownQuestion", id: q.id, names: condition.question };
  return named.proposed_answers.some((a) => piecesText(a.label) === condition.answer) ? null : { kind: "unknownAnswer", id: q.id, question: condition.question, answer: condition.answer };
};

/** Every problem of the skip conditions of a list, in the order of the list, the cycles last; empty when they are sound. */
export const skipConditionProblems = (questions: readonly PremiseEntry[]): readonly SkipProblem[] => [
  ...questions.map((q) => conditionProblem(questions, q)).filter((p): p is SkipProblem => p !== null),
  ...cyclesOf(questions).map((ids): SkipProblem => ({ kind: "cycle", ids })),
];

/**
 * The list in a stable order in which every question comes after the question its condition names; a cycle fails.
 * Questions whose order no condition constrains keep their relative order.
 */
export const orderBySkipCondition = <Q extends PremiseEntry>(questions: readonly Q[]): Result.Result<readonly Q[], SkipProblem> => {
  const self = questions.find((q) => q.skip_if !== null && q.skip_if.question === q.id);
  if (self !== undefined) return Result.fail({ kind: "selfReference", id: self.id });
  const cycle = cyclesOf(questions)[0];
  if (cycle !== undefined) return Result.fail({ kind: "cycle", ids: cycle });
  // Kahn's order, stable: each time the first question still waiting whose premise is placed. Without a cycle one is
  // always found, and the recursion is as deep as the list is long.
  const place = (waiting: readonly Q[], placed: readonly Q[]): readonly Q[] => {
    const next = waiting.find((q) => {
      const premise = premiseOf(questions, q);
      return premise === null || placed.some((p) => p.id === premise);
    });
    return next === undefined ? placed : place(waiting.filter((q) => q !== next), [...placed, next]);
  };
  return Result.succeed(place(questions, []));
};

/** The program's own record of the user's reply to an agreed question: the option chosen, or text that chose none. */
export type AgreedAnswer = Readonly<{ kind: "option"; label: string }> | Readonly<{ kind: "text" }>;
/** The replies so far, by the id of the agreed question. */
export type AgreedAnswers = ReadonlyMap<string, AgreedAnswer>;

/**
 * A question the user's answers removed: its id, the question its condition names and the answer it names, and why:
 * the user chose that answer, or that question was itself skipped and never asked.
 */
export type Skipped = Readonly<{ id: string; question: string; answer: string; cause: "answered" | "premiseSkipped" }>;

/**
 * Every question whose condition's answer the user chose, and, transitively, every question whose condition names a
 * skipped question (its premise question is never asked, so it has no answer). A text reply skips nothing.
 */
export const skippedQuestions = (questions: readonly PremiseEntry[], answers: AgreedAnswers): readonly Skipped[] => {
  // The chain of premises is at most as long as the list; `seen` keeps a cycle, which validation excludes, finite.
  const causeOf = (q: PremiseEntry, seen: readonly string[]): Skipped["cause"] | null => {
    const premise = premiseOf(questions, q);
    if (premise === null || q.skip_if === null || seen.includes(q.id)) return null;
    const answer = answers.get(premise);
    if (answer?.kind === "option" && answer.label === q.skip_if.answer) return "answered";
    const above = questions.find((p) => p.id === premise);
    return above !== undefined && causeOf(above, [...seen, q.id]) !== null ? "premiseSkipped" : null;
  };
  return questions.flatMap((q) => {
    const cause = causeOf(q, []);
    return cause === null || q.skip_if === null ? [] : [{ id: q.id, question: q.skip_if.question, answer: q.skip_if.answer, cause }];
  });
};

/** The id of the premise question not yet answered that the question `id` waits on, or null. */
export const waitingFor = (questions: readonly PremiseEntry[], answers: AgreedAnswers, id: string): string | null => {
  const q = questions.find((e) => e.id === id);
  const premise = q === undefined ? null : premiseOf(questions, q);
  return premise !== null && !answers.has(premise) ? premise : null;
};

/** What an interview turn did against the skipped questions and the order of the premises (issue #99), as data. */
export const TurnSkipProblemSchema = Schema.Union([
  /** The turn asks a question the user's answers removed. */
  Schema.Struct({ kind: Schema.Literal("skippedAsked"), id: Schema.String, question: Schema.String, answer: Schema.String }),
  /** The turn asks a question before the question its condition names has been answered. */
  Schema.Struct({ kind: Schema.Literal("askedBeforePremise"), id: Schema.String, premise: Schema.String }),
  /** The proposed summary does not name these skipped questions. */
  Schema.Struct({ kind: Schema.Literal("summaryOmits"), ids: Schema.Array(Schema.String) }),
]);
export type TurnSkipProblem = typeof TurnSkipProblemSchema.Type;
