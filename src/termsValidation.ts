// The validations of the explanations of the agreed questions' terms (S17; issue #142), pure. Apart from
// src/subjects.ts so that src/conversation.ts, which src/subjects.ts imports, can use them without an import cycle.

import { Result } from "effect";
import { QuestionInvalid } from "./errors.ts";
import * as prompts from "./prompts.ts";
import type { QuestionProblem, QuestionProblems } from "./prompts.ts";
import { sameBlocks, samePieces } from "./pieces.ts";
import { questionProblems } from "./question.ts";
import type { Validation } from "./review.ts";
import type { QuestionsFile, TermsEntry } from "./schema.ts";

/** The kinds of problem of the question list itself, which its own review settled: not the explanations' to repair. */
const LIST_PROBLEMS: readonly QuestionProblem["kind"][] = ["blankContext", "notLast", "bareNumber"];
/** The fields of an agreed entry whose wording the division into pieces keeps (decision Q1), each compared by its words and blocks. */
const wordingChanges = (agreed: QuestionsFile["questions"][number], entry: TermsEntry): readonly QuestionProblem[] => [
  ...(sameBlocks(entry.context, agreed.context) ? [] : ["context"]),
  ...(sameBlocks(entry.history, agreed.history) ? [] : ["history"]),
  ...(samePieces(entry.question, agreed.question) ? [] : ["question"]),
  ...(sameBlocks(entry.reason, agreed.reason) ? [] : ["reason"]),
  ...(entry.proposed_answers.length === agreed.proposed_answers.length && entry.proposed_answers.every((a, i) => samePieces(a.label, agreed.proposed_answers[i].label) && samePieces(a.description, agreed.proposed_answers[i].description)) ? [] : ["proposed_answers"]),
].map((subject) => ({ kind: "wordingChanged" as const, subject }));
/**
 * The validation of the explanations (S17; S6 of the task of issue #36, decision Q1): every entry names a question of the
 * agreed list, keeps its wording (its fields' words and blocks), and holds its explanations under the data clauses of
 * the format: every ref names an explanation, every explanation is referred to, none blank. Inside behaviour 10's
 * validation budget, like the list's own validation.
 */
export const termsValidation =
  <T extends Readonly<{ entries: readonly TermsEntry[] }>>(questions: QuestionsFile["questions"]): Validation<T> =>
  (output) => questionsChecked(output, termsProblems(questions, output.entries));

/** The problems of the terms entries against the agreed questions they name: an unknown id, a changed wording, a rule. */
const termsProblems = (questions: QuestionsFile["questions"], entries: readonly TermsEntry[]): QuestionProblems =>
  entries.flatMap((entry): QuestionProblems => {
    const q = questions.find((x) => x.id === entry.id);
    if (q === undefined) return [{ where: entry.id, problems: [{ kind: "unknownQuestion", subject: entry.id }] }];
    const problems = [
      ...wordingChanges(q, entry),
      ...questionProblems({ context: entry.context, history: entry.history, question: entry.question, explanations: entry.explanations, options: entry.proposed_answers, details: entry.reason }).filter((p) => !LIST_PROBLEMS.includes(p.kind)),
    ];
    return problems.length === 0 ? [] : [{ where: entry.id, problems }];
  });

/** A reply accepted where no question has a problem, otherwise QuestionInvalid with its repair prompt. */
const questionsChecked = <T>(output: T, failing: QuestionProblems) =>
  failing.length === 0 ? Result.succeed({ value: output, notes: [] }) : Result.fail({ error: new QuestionInvalid({ questions: failing }), repair: prompts.questionRepairPrompt(failing) });

/**
 * Issue #142: the reply to a request for one agreed question's terms (termsOnRequestPrompt): termsValidation over that
 * question alone, and exactly one entry for it (`entryCount`).
 */
export const requestedTermsValidation =
  <T extends Readonly<{ entries: readonly TermsEntry[] }>>(agreed: QuestionsFile["questions"][number]): Validation<T> =>
  (output) => {
    const count = output.entries.filter((e) => e.id === agreed.id).length;
    const counted: QuestionProblems = count === 1 ? [] : [{ where: agreed.id, problems: [{ kind: "entryCount", subject: String(count) }] }];
    return questionsChecked(output, [...termsProblems([agreed], output.entries), ...counted]);
  };

/** Issue #142: the terms entries with `entry` in place of the one of its id, or added, in the agreed list's order. */
export const withTermsEntry = (entries: readonly TermsEntry[], entry: TermsEntry, questions: QuestionsFile["questions"]): readonly TermsEntry[] => {
  const byId = new Map([...entries.map((e): [string, TermsEntry] => [e.id, e]), [entry.id, entry]]);
  return questions.flatMap((q) => {
    const found = byId.get(q.id);
    return found === undefined ? [] : [found];
  });
};
