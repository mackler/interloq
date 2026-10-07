// Normalisation of agent replies after decoding (finding 8 of docs/functional-design-review.md; decision Q4):
// the wire shapes with coexisting fields become variants. Pure.

import { Result } from "effect";
import { QuestionListInvalid } from "./errors.ts";
import { piecesText } from "./pieces.ts";
import { orderBySkipCondition } from "./premises.ts";
import type { ExecReport, InterviewTurn, QuestionList, QuestionsFile } from "./schema.ts";

/** The questions asked and answered so far, as Claude Code reports them in each turn (issue #21), and the question asked now (S3: with its context, terms and options). */
type TurnIds = Readonly<{ asked: readonly string[]; answered: readonly string[]; current: InterviewTurn["current_question"] }>;
/** What an interview turn says: the conversation continues, or Claude Code proposes the summary. */
export type TurnText = Readonly<{ kind: "continuing"; message: string }> | Readonly<{ kind: "summary_proposed"; message: string; summary: string }>;
/** One interview turn: its text and the questions asked and answered so far. */
export type TurnVariant = TurnText & TurnIds;
/** `complete` with a blank summary, and a summary without `complete`, both continue the conversation (Q4: no coverage check). */
export const normalizeTurn = (turn: InterviewTurn): TurnVariant => {
  const ids = { asked: turn.asked_ids, answered: turn.answered_ids, current: turn.current_question };
  return turn.complete && turn.summary.trim() !== "" ? { kind: "summary_proposed", message: turn.message_to_user, summary: turn.summary, ...ids } : { kind: "continuing", message: turn.message_to_user, ...ids };
};

/** The status report of an execution call, by outcome: the `question` field is a question only when input is awaited, a description when blocked. */
export type ReportVariant =
  | Readonly<{ kind: "finished"; summary: string; remainingWork: string }>
  | Readonly<{ kind: "awaiting_input"; question: string; summary: string; remainingWork: string }>
  | Readonly<{ kind: "blocked"; description: string; summary: string; remainingWork: string }>;
export const normalizeReport = (report: ExecReport): ReportVariant => {
  const common = { summary: report.summary, remainingWork: report.remaining_work };
  switch (report.status) {
    case "finished":
      return { kind: "finished", ...common };
    case "needs_input":
      return { kind: "awaiting_input", question: report.question, ...common };
    case "blocked":
      return { kind: "blocked", description: report.question, ...common };
  }
};

/** A question list as the program records it: a default that names no proposed answer is null, with a note per question. */
export type NormalizedQuestionList = Readonly<{ questions: QuestionsFile["questions"]; notes: readonly string[] }>;
/** Duplicate or empty ids are structural (by analogy with Q3): the list is invalid, without a repair turn. */
export const normalizeQuestionList = (list: QuestionList): Result.Result<NormalizedQuestionList, QuestionListInvalid> => {
  const ids = list.questions.map((q) => q.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => id !== "" && ids.indexOf(id) !== i))];
  const emptyIds = ids.filter((id) => id === "").length;
  if (duplicateIds.length > 0 || emptyIds > 0) return Result.fail(new QuestionListInvalid({ duplicateIds, emptyIds, cycle: [] }));
  // Issue #99: a question follows the question its skip condition names. The validation has rejected a cycle with its
  // repair turn, so one here is structural.
  const ordered = orderBySkipCondition(list.questions);
  if (Result.isFailure(ordered)) return Result.fail(new QuestionListInvalid({ duplicateIds: [], emptyIds: 0, cycle: ordered.failure.kind === "cycle" ? ordered.failure.ids : [ordered.failure.id] }));
  const notes: string[] = [];
  const questions = ordered.success.map((q) => {
    if (q.proposed_answers.some((a) => piecesText(a.label) === q.default_answer)) return { ...q, id: q.id, default_answer: q.default_answer as string | null };
    notes.push(`The default answer of question ${q.id}, ${JSON.stringify(q.default_answer)}, names none of its proposed answers; the question has no default.`);
    return { ...q, id: q.id, default_answer: null };
  });
  return Result.succeed({ questions, notes });
};

/**
 * The count of a clarification (issue #21, Q6): the total is the agreed questions and every question asked so far
 * (follow-ups raise it, and it is never below the agreed count less the skipped ones); the count is the answered ones among them.
 */
export const clarificationCount = (agreed: readonly string[], asked: readonly string[], answered: readonly string[], skipped: readonly string[]): Readonly<{ answered: number; total: number }> => {
  // Issue #99: a question the user's answers removed is neither asked nor counted.
  const questions = new Set([...agreed, ...asked].filter((id) => !skipped.includes(id)));
  return { answered: new Set(answered.filter((id) => questions.has(id))).size, total: questions.size };
};
