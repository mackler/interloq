// The first interview's state (issue #184; pure, no I/O, no Effect services): which agreed question Interloq presents
// next, the follow-up questions Claude Code asked and their place, and the count "x of N answered". Interloq picks the
// next agreed question itself, so that no Claude Code call stands between one answer and the next question.

import { type AgreedAnswer, type AgreedAnswers, type PremiseEntry, skippedQuestions, waitingFor } from "./premises.ts";
import { clarificationCount } from "./schemaNormalize.ts";
import type { InterviewReply } from "./schema.ts";

/** A follow-up question Claude Code asked in a reply. */
export type FollowUp = InterviewReply["follow_ups"][number];

/** What the first interview has done so far. */
export type ClarificationState = Readonly<{
  /** The developer's answer to each agreed question answered. */
  answers: AgreedAnswers;
  /** The agreed questions presented, in order. */
  shown: readonly string[];
  /** The follow-ups received and not yet presented, in arrival order. */
  followUps: readonly FollowUp[];
  /** The ids of every follow-up received, presented or not. */
  askedFollowUps: readonly string[];
  /** The ids of the follow-ups answered. */
  answeredFollowUps: readonly string[];
  /** Whether the developer ended the interview with /done: no agreed question is presented after it. */
  ended: boolean;
}>;

export const INITIAL_CLARIFICATION: ClarificationState = { answers: new Map(), shown: [], followUps: [], askedFollowUps: [], answeredFollowUps: [], ended: false };

/** The question presented next: the oldest pending follow-up, else the next agreed question, else none. */
export type NextQuestion<Q> = Readonly<{ kind: "followUp"; followUp: FollowUp }> | Readonly<{ kind: "agreed"; question: Q }> | Readonly<{ kind: "none" }>;

/**
 * The agreed question presented next: the first, in the list's order (questions.json is recorded ordered by
 * orderBySkipCondition), that is neither shown nor answered, that the developer's answers have not removed, and whose
 * premise is answered or absent; none once the developer ended the interview.
 */
export const nextAgreed = <Q extends PremiseEntry>(questions: readonly Q[], state: ClarificationState): Q | null => {
  if (state.ended) return null;
  const skipped = skippedQuestions(questions, state.answers).map((k) => k.id);
  return questions.find((q) => !state.shown.includes(q.id) && !state.answers.has(q.id) && !skipped.includes(q.id) && waitingFor(questions, state.answers, q.id) === null) ?? null;
};

/** A follow-up received while a question is on the page comes right after it is answered, before the next agreed question. */
export const nextQuestion = <Q extends PremiseEntry>(questions: readonly Q[], state: ClarificationState): NextQuestion<Q> => {
  const followUp = state.followUps[0];
  if (followUp !== undefined) return { kind: "followUp", followUp };
  const question = nextAgreed(questions, state);
  return question === null ? { kind: "none" } : { kind: "agreed", question };
};

/** The developer's answer to an agreed question (its option or text), or to a follow-up (null). */
export const withAnswer = (state: ClarificationState, id: string, answer: AgreedAnswer | null): ClarificationState =>
  answer === null ? { ...state, answeredFollowUps: [...state.answeredFollowUps, id] } : { ...state, answers: new Map([...state.answers, [id, answer]]) };

export const withShown = (state: ClarificationState, id: string): ClarificationState => ({ ...state, shown: [...state.shown, id] });

export const withEnded = (state: ClarificationState): ClarificationState => ({ ...state, ended: true });

/**
 * The follow-ups of a reply, appended in order; one whose id is an agreed question's is dropped, since an agreed
 * question is never asked a second time, and so is one whose id was received before.
 */
export const withFollowUps = (state: ClarificationState, followUps: readonly FollowUp[], agreedIds: readonly string[]): ClarificationState =>
  followUps.reduce<ClarificationState>(
    (s, f) => (agreedIds.includes(f.id) || s.askedFollowUps.includes(f.id) ? s : { ...s, followUps: [...s.followUps, f], askedFollowUps: [...s.askedFollowUps, f.id] }),
    state,
  );

/** The oldest pending follow-up taken off the queue, as it is presented. */
export const takeFollowUp = (state: ClarificationState): ClarificationState => ({ ...state, followUps: state.followUps.slice(1) });

/** "x of N answered", counted by Interloq from the list, the answers, the skipped questions and the follow-ups asked. */
export const progressOf = (agreedIds: readonly string[], questions: readonly PremiseEntry[], state: ClarificationState): Readonly<{ answered: number; total: number }> =>
  clarificationCount(agreedIds, state.askedFollowUps, [...state.answers.keys(), ...state.answeredFollowUps], skippedQuestions(questions, state.answers).map((k) => k.id));
