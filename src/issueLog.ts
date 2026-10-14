// Pure functions on the issue log. No file access, no agent calls, no Effect. The log transitions take a
// validated round (src/round.ts), so a missing disposition is unrepresentable here (finding 4).

import type { IssueId, ValidatedRound } from "./round.ts";
import type { FileChange, LogEntry, Review } from "./schema.ts";

const NOT_ACCEPTED_IN_FULL = new Set(["rejected", "partially_accepted", "no_change_needed"]);

function current(log: readonly LogEntry[]): LogEntry[] {
  return log.filter((e) => e.superseded !== true);
}

/** Ids in the review that Claude Code did not accept in full earlier and that Codex has raised again. */
export function reraisedIds(log: readonly LogEntry[], review: Review): string[] {
  const open = new Set<string>(current(log).filter((e) => NOT_ACCEPTED_IN_FULL.has(e.action)).map((e) => e.id));
  return review.issues.map((i) => i.id).filter((id) => open.has(id));
}

/** Pairs [new id, earlier id]: issues that Claude Code identifies as repetitions of an issue not accepted in full. */
export function repeatedUnderNewId(log: readonly LogEntry[], round: ValidatedRound): [string, string][] {
  const open = new Set(current(log).filter((e) => NOT_ACCEPTED_IN_FULL.has(e.action)).map((e) => e.id));
  return round.dispositions.flatMap((d) => (d.duplicateOf !== null && open.has(d.duplicateOf) ? [[d.id, d.duplicateOf] as [string, string]] : []));
}

/** Pairs [new id, earlier id]: issues whose correction would undo an earlier accepted correction. */
export function reversals(round: ValidatedRound): [string, string][] {
  return round.dispositions.flatMap((d) => (d.reverses !== null ? [[d.id, d.reverses] as [string, string]] : []));
}

/** Ids for which Claude Code requests clarification and has requested it before. */
export function secondClarifications(log: readonly LogEntry[], round: ValidatedRound): string[] {
  const asked = new Set(log.filter((e) => e.action === "clarification_requested").map((e) => e.id));
  return round.dispositions.filter((d) => d.action === "clarification_requested" && asked.has(d.id)).map((d) => d.id);
}

export function acceptedCount(round: ValidatedRound): number {
  return round.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").length;
}

function supersede(log: readonly LogEntry[], ids: ReadonlySet<string>): LogEntry[] {
  return log.map((e) => (ids.has(e.id) ? { ...e, superseded: true } : e));
}

/**
 * The log with the entries of one round appended; earlier entries with the same id are marked superseded.
 * Decision Q2: a self-correction that shares an id with a review issue of the round is appended before the
 * review entries and superseded by the disposition, which is the last word; other self-corrections follow.
 */
export function appendRound(log: readonly LogEntry[], round: ValidatedRound, change: FileChange | null): readonly LogEntry[] {
  const { phase, round: n } = round;
  const fromReview: LogEntry[] = round.review.issues.map((issue) => {
    const d = round.dispositions.find((x) => x.id === issue.id)!;
    return {
      id: issue.id,
      phase,
      round: n,
      source: "review",
      severity: issue.severity,
      location: issue.location,
      problem: issue.problem,
      evidence: issue.evidence,
      action: d.action,
      rationale: d.rationale,
      duplicate_of: d.duplicateOf,
      reverses: d.reverses,
      superseded: false,
      file_change: change,
      task_dispute: d.taskDispute,
    };
  });
  const fromSelf: LogEntry[] = round.selfCorrections.map((sc) => {
    const earlier = log.filter((e) => e.id === sc.id).at(-1);
    return {
      id: sc.id,
      phase,
      round: n,
      source: "self_correction",
      problem: earlier?.problem ?? "error found by the planner",
      action: sc.newAction === "rejected" ? "correction_disputed" : sc.newAction,
      rationale: sc.explanation,
      superseded: false,
      file_change: change,
    };
  });
  const reviewIds = new Set(fromReview.map((e) => e.id));
  const overlapping = fromSelf.filter((e) => reviewIds.has(e.id)).map((e) => ({ ...e, superseded: true }));
  const others = fromSelf.filter((e) => !reviewIds.has(e.id));
  const added = [...overlapping, ...fromReview, ...others];
  return [...supersede(log, new Set(added.map((e) => e.id))), ...added];
}

/** An entry as the user is shown it (Q6 of issue #31): without the measurement, which is for the records and Codex. */
export function displayEntry(entry: LogEntry): Omit<LogEntry, "file_change"> {
  if (!("file_change" in entry)) return entry;
  const { file_change: _measured, ...shown } = entry;
  return shown;
}

/** The log with a decision of the user on one issue appended; earlier entries of that id are superseded. */
export function appendUserDecision(log: readonly LogEntry[], id: IssueId, decision: string, phase: number, round: number): readonly LogEntry[] {
  const earlier = log.filter((e) => e.id === id).at(-1);
  const entry: LogEntry = { id, phase, round, source: "user", problem: earlier?.problem ?? "", action: "decided_by_user", rationale: decision, superseded: false };
  return [...supersede(log, new Set([id])), entry];
}

export function countedIssues(review: Review, countMinor: boolean): number {
  return countMinor ? review.issues.length : review.issues.filter((i) => i.severity !== "minor").length;
}

/**
 * Whether the round acknowledges a defect that needs a planning phase (plan 2.4): a disposition accepted or
 * partially accepted, or an effective self-correction accepted or plan_error. A self-correction whose id is
 * an issue of the round's review is superseded by that issue's disposition (the overlap rule of appendRound).
 */
export function correctionsDue(round: ValidatedRound): boolean {
  if (acceptedCount(round) > 0) return true;
  const reviewed = new Set<string>(round.review.issues.map((i) => i.id));
  return round.selfCorrections.some((sc) => !reviewed.has(sc.id) && (sc.newAction === "accepted" || sc.newAction === "plan_error"));
}

/**
 * The corrections of one response as the page counts them (issue #14, Q2): the dispositions accepted or partially
 * accepted, and the self-corrections accepted or plan_error whose id is not an issue of the same review (such a
 * self-correction is superseded by the issue's disposition, as in correctionsDue).
 */
export function correctionCount(reviewIds: readonly string[], response: Readonly<{ dispositions: readonly Readonly<{ action: string }>[]; self_corrections: readonly Readonly<{ id: string; new_action: string }>[] }>): number {
  const reviewed = new Set(reviewIds);
  const accepted = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").length;
  const effective = response.self_corrections.filter((sc) => !reviewed.has(sc.id) && (sc.new_action === "accepted" || sc.new_action === "plan_error")).length;
  return accepted + effective;
}
