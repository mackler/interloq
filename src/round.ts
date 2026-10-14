// A validated round: the review and Claude Code's response as one readonly value whose structure is
// guaranteed (findings 3, 4 and 7 of docs/functional-design-review.md; decisions Q2 and Q3). Pure. A failure was a halt
// under decision Q3; since issue #151 it gets one validation repair turn first (reviewValidation, roundValidation).

import { Result, Schema } from "effect";
import { CorrectionInvalid, RoundInvalid } from "./errors.ts";
import { correctionRepairPrompt, reviewRepairPrompt, roundRepairPrompt } from "./prompts.ts";
import type { Validation } from "./review.ts";
import type { Action, LogEntry, PlannerResponse, Review, UserQuestion } from "./schema.ts";

import * as S from "./schema.ts";
import type { IssueId } from "./schema.ts";
export type { IssueId };

export type ValidatedIssue = Readonly<{ id: IssueId; severity: Review["issues"][number]["severity"]; location: string; problem: string; evidence: string }>;
export type ValidatedReview = Readonly<{ issues: readonly ValidatedIssue[] }>;

/** A reference that decision Q3 dropped: what the response named, in which field, and why it was dropped. */
export type ReferenceNote = Readonly<{ id: IssueId; field: "duplicate_of" | "reverses"; named: string; reason: "unknown" | "not_accepted" }>;
const isMarked = Schema.is(S.MarkedDisposition);
/**
 * Claude Code's mark on a disposition (issue #156), the one place the rule is stated: a disposition of the question
 * list's or the terms' response that is marked and not `accepted`, since an accepted issue is no disagreement. Only
 * those two subjects' schemas keep the field when the reply is decoded, so every other disposition has none.
 */
export const taskDisputeOf = (d: S.Disposition): boolean => isMarked(d) && d[S.TASK_DISPUTE_FIELD] && d.action !== "accepted";
/** `taskDispute`: Claude Code's mark (issue #156), true only on a disposition other than `accepted`. */
export type ValidatedDisposition = Readonly<{
  id: IssueId;
  action: Action;
  rationale: string;
  duplicateOf: IssueId | null;
  reverses: IssueId | null;
  taskDispute: boolean;
}>;
export type ValidatedSelfCorrection = Readonly<{ id: IssueId; newAction: "accepted" | "rejected" | "plan_error"; explanation: string; generated: boolean }>;
export type ValidatedRound = Readonly<{
  phase: number;
  round: number;
  review: ValidatedReview;
  dispositions: readonly ValidatedDisposition[];
  selfCorrections: readonly ValidatedSelfCorrection[];
  notes: readonly ReferenceNote[];
  reviewerFeedback: string;
  questionsForUser: readonly UserQuestion[];
}>;

const ACCEPTED = new Set(["accepted", "partially_accepted"]);
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const duplicates = (ids: readonly string[]): string[] => unique(ids.filter((id, i) => ids.indexOf(id) !== i));
const roundInvalid = (fields: Partial<ConstructorParameters<typeof RoundInvalid>[0]>): RoundInvalid =>
  new RoundInvalid({ duplicateIssues: [], missing: [], duplicateDispositions: [], unknownDispositions: [], emptyIds: [], collidingIds: [], ...fields });

/** A review with unique, non-empty issue ids. Checked before anything is counted or asked. */
export const validateReview = (review: Review): Result.Result<ValidatedReview, RoundInvalid> => {
  const ids = review.issues.map((i) => i.id);
  const duplicateIssues = duplicates(ids);
  const empty = ids.filter((id) => id === "").length;
  if (duplicateIssues.length > 0 || empty > 0) return Result.fail(roundInvalid({ duplicateIssues, emptyIds: empty > 0 ? ["an issue of the review"] : [] }));
  return Result.succeed({ issues: review.issues.map((i) => ({ ...i, id: i.id as IssueId })) });
};

/**
 * The response against its validated review and the log: exactly one disposition per issue and none other,
 * non-empty ids, references normalised (Q3: a reference that names no current log entry, or a `reverses` whose
 * current entry is not an accepted correction, becomes null with a note), self-corrections with their generated
 * ids (`<prefix><phase>-S<round>-<k>`, the prefix of the subject: P, W, Q or G; a generated id that already exists in the log is invalid).
 */
export const validateRound = (review: ValidatedReview, response: PlannerResponse, log: readonly LogEntry[], phase: number, round: number, idPrefix: string, idNumber: number = phase): Result.Result<ValidatedRound, RoundInvalid> => {
  const issueIds = new Set<string>(review.issues.map((i) => i.id));
  const dispositionIds = response.dispositions.map((d) => d.id);
  const problems = {
    missing: review.issues.map((i) => i.id).filter((id) => !dispositionIds.includes(id)),
    duplicateDispositions: duplicates(dispositionIds),
    unknownDispositions: unique(dispositionIds.filter((id) => id !== "" && !issueIds.has(id))),
    emptyIds: dispositionIds.some((id) => id === "") ? ["a disposition of the response"] : [],
  };
  if (Object.values(problems).some((list) => list.length > 0)) return Result.fail(roundInvalid(problems));

  const current = new Map<string, LogEntry>();
  for (const entry of log) if (entry.superseded !== true) current.set(entry.id, entry);
  const notes: ReferenceNote[] = [];
  const reference = (id: IssueId, field: ReferenceNote["field"], named: string): IssueId | null => {
    if (named === "") return null;
    const entry = current.get(named);
    if (entry === undefined || named === id) {
      notes.push({ id, field, named, reason: "unknown" });
      return null;
    }
    if (field === "reverses" && !ACCEPTED.has(entry.action)) {
      notes.push({ id, field, named, reason: "not_accepted" });
      return null;
    }
    return named as IssueId;
  };
  const dispositions: ValidatedDisposition[] = response.dispositions.map((d) => {
    const id = d.id as IssueId;
    return {
      id,
      action: d.action,
      rationale: d.rationale,
      duplicateOf: reference(id, "duplicate_of", d.duplicate_of),
      reverses: reference(id, "reverses", d.reverses),
      taskDispute: taskDisputeOf(d),
    };
  });

  const known = new Set(log.map((e) => e.id));
  const selfCorrections: ValidatedSelfCorrection[] = response.self_corrections.map((sc, k) => ({
    id: (sc.id === "" ? `${idPrefix}${idNumber}-S${round}-${k + 1}` : sc.id) as IssueId,
    newAction: sc.new_action,
    explanation: sc.explanation,
    generated: sc.id === "",
  }));
  const collidingIds = selfCorrections.filter((sc) => sc.generated && known.has(sc.id)).map((sc) => sc.id);
  if (collidingIds.length > 0) return Result.fail(roundInvalid({ collidingIds }));

  return Result.succeed({ phase, round, review, dispositions, selfCorrections, notes, reviewerFeedback: response.reviewer_feedback, questionsForUser: response.questions_for_user });
};

/**
 * The validation of a corrective reply (issue #30), with the prompt of its repair turn: it may change only the action
 * and the rationale of the dispositions that were accepted in full or in part (correctivePrompt names them); every
 * other disposition, every reference and the rest of the response must be as in the previous response.
 */
export const correctiveValidation =
  <T extends PlannerResponse>(previous: PlannerResponse, acceptedIds: readonly string[]): Validation<T> =>
  (reply) => {
    const allowed = new Set(acceptedIds);
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const before = new Map(previous.dispositions.map((d) => [d.id, d] as const));
    const sameIds = reply.dispositions.length === previous.dispositions.length && reply.dispositions.every((d) => before.has(d.id));
    const changedIds = unique(
      reply.dispositions
        .filter((d) => {
          const was = before.get(d.id);
          if (was === undefined) return false;
          return allowed.has(d.id) ? d.duplicate_of !== was.duplicate_of || d.reverses !== was.reverses : !same(d, was);
        })
        .map((d) => d.id),
    );
    const other = [
      ...(sameIds ? [] : ["dispositions"]),
      ...(same(reply.self_corrections, previous.self_corrections) ? [] : ["self_corrections"]),
      ...(reply.reviewer_feedback === previous.reviewer_feedback ? [] : ["reviewer_feedback"]),
      ...(same(reply.questions_for_user, previous.questions_for_user) ? [] : ["questions_for_user"]),
    ];
    if (changedIds.length === 0 && other.length === 0) return Result.succeed({ value: reply, notes: [] });
    const error = new CorrectionInvalid({ changedIds, other });
    return Result.fail({ error, repair: correctionRepairPrompt(error, acceptedIds) });
  };

/** A review's validation with its repair turn (issue #151): unique, non-empty issue ids, or Codex's repair prompt. */
export const reviewValidation: Validation<Review> = (review) => repairable(review, validateReview(review), reviewRepairPrompt);

/** A check's result as a Validation's: the reply unchanged, or the failure with the prompt of its repair turn. */
const repairable = <T>(reply: T, checked: Result.Result<unknown, RoundInvalid>, repair: (error: RoundInvalid) => string): ReturnType<Validation<T>> =>
  Result.isFailure(checked) ? Result.fail({ error: checked.failure, repair: repair(checked.failure) }) : Result.succeed({ value: reply, notes: [] });

/**
 * A response's validation with its repair turn (issue #151): `check` is the round's validation against its review and the
 * log as the round began (roundCheckOf of src/reviewState.ts); a failure gets Claude Code's repair prompt, which names the
 * review's issue ids. The reply is returned unchanged.
 */
export const roundValidation =
  <R extends PlannerResponse>(check: (response: PlannerResponse) => Result.Result<ValidatedRound, RoundInvalid>, reviewIds: readonly string[]): Validation<R> =>
  (reply) =>
    repairable(reply, check(reply), (error) => roundRepairPrompt(error, reviewIds));
