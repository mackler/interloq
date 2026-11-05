// Issue #38: log entries for the tests of src/resolution.ts and the investigation, every field given.
import type * as S from "../src/schema.ts";

type LogEntry = S.LogEntry;
const id = (s: string) => s as S.IssueId;

export const reviewEntry = (i: string, action: S.Action, extra: Partial<typeof S.ReviewEntry.Type> = {}): LogEntry => ({
  id: id(i),
  phase: 1,
  round: 1,
  source: "review",
  severity: "major",
  location: "l",
  problem: "p",
  evidence: "e",
  action,
  rationale: "r",
  duplicate_of: null,
  reverses: null,
  superseded: false,
  file_change: null,
  task_dispute: false,
  work_effects: null,
  kept_passages: [],
  reviewer_position: null,
  planner_position: null,
  resolution: null,
  investigations: [],
  ...extra,
});
export const selfEntry = (i: string, action: "accepted" | "plan_error" | "correction_disputed", extra: Partial<typeof S.SelfCorrectionEntry.Type> = {}): LogEntry => ({
  id: id(i),
  phase: 1,
  round: 1,
  source: "self_correction",
  problem: "p",
  action,
  rationale: "r",
  superseded: false,
  file_change: null,
  kept_passages: [],
  planner_position: null,
  resolution: null,
  investigations: [],
  ...extra,
});
