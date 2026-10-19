// The validation of a reply of the first interview (issue #184), apart from src/conversation.ts so that
// src/interviewWorker.ts uses it without an import cycle (finding 28); src/conversation.ts re-exports it.

import { Result } from "effect";
import { InterviewTurnInvalid } from "./errors.ts";
import { type AgreedAnswers, mentionsId, skippedQuestions, type TurnProblem } from "./premises.ts";
import * as prompts from "./prompts.ts";
import { bothValidations, questionsValidation, type Validation } from "./review.ts";
import type * as S from "./schema.ts";
import type { QuestionsFile } from "./schema.ts";
import { normalizeReply } from "./schemaNormalize.ts";

/** Issue #184: the validation of a reply of the first interview. */
export const replyValidation = (recorded: readonly string[], askedFollowUps: readonly string[], premises: Premises, closing: boolean): Validation<S.InterviewReply> =>
  bothValidations(followUpRules(recorded), replyIds(askedFollowUps, premises, closing));

/** Issue #184: each follow-up of a reply, not an agreed question's id, under the rules of every question (decision Q12: no Codex review). */
const followUpRules =
  (recorded: readonly string[]): Validation<S.InterviewReply> =>
  (reply) =>
    questionsValidation((r: S.InterviewReply) =>
      r.follow_ups
        .filter((f) => !recorded.includes(f.id))
        .map((f) => ({ where: f.id.trim() === "" ? "a follow-up question" : f.id, question: { context: f.context, history: f.history, question: f.text, explanations: f.explanations, options: f.options } })),
    )(reply);

/**
 * Issue #184: a follow-up's id is not blank and new to the interview and to the reply; and a summary proposed in reply
 * to a closing request names every skipped question. Failures get the validation repair turn of behavior 10.
 */
const replyIds =
  (askedFollowUps: readonly string[], premises: Premises, closing: boolean): Validation<S.InterviewReply> =>
  (reply) => {
    const ids = reply.follow_ups.map((f) => f.id);
    const reused = [...new Set(ids.filter((id, i) => id.trim() !== "" && (askedFollowUps.includes(id) || ids.indexOf(id) !== i)))];
    const summary = normalizeReply(reply, closing);
    const omitted = summary.kind === "summary_proposed" ? skippedQuestions(premises.questions, premises.answers).filter((k) => !mentionsId(summary.summary, k.id)).map((k) => k.id) : [];
    const problems: readonly TurnProblem[] = [
      ...(ids.some((id) => id.trim() === "") ? [{ kind: "followUpIdBlank" as const }] : []),
      ...reused.map((id) => ({ kind: "followUpIdReused" as const, id })),
      ...(omitted.length > 0 ? [{ kind: "summaryOmits" as const, ids: omitted }] : []),
    ];
    return problems.length === 0 ? Result.succeed({ value: reply, notes: [] }) : Result.fail({ error: new InterviewTurnInvalid({ problems }), repair: prompts.clarificationReplyRepairPrompt(problems) });
  };

/** What the first interview's reply validation knows of the premises (issue #99): the list and the user's choices so far. */
export type Premises = Readonly<{ questions: QuestionsFile["questions"]; answers: AgreedAnswers }>;
