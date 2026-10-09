// The catalog of the program's records under <project>/plan-review/ (finding 28 of
// docs/functional-design-review.md): typed identities and one `pathOf`, so that no workflow builds a path. Pure.
import type { Brand } from "effect";
import type { RunMode } from "./runMode.ts";

/**
 * A reviewed subject: the question list, the requirements, the plan of one planning phase, the work of one execution
 * phase (the work review), or the analysis of decision k (decision support, numbered across the run).
 */
export type SubjectId = "questions" | "terms" | "requirements" | Readonly<{ plan: number }> | Readonly<{ work: number }> | Readonly<{ decision: number }>;
/** A subject whose phase follows from its identity; a decision's phase is where it took place, which its identity does not say. */
export type PhasedSubject = Exclude<SubjectId, Readonly<{ decision: number }>>;

export type Artifact =
  | Readonly<{ kind: "conversation" | "decisions" | "feedback" | "usage" | "questions" | "terms" | "requirements" | "plan" | "planFile" | "checkpoint" | "config" }>
  | Readonly<{ kind: "log"; subject: SubjectId }>
  | Readonly<{ kind: "review" | "response" | "round"; subject: SubjectId; round: number }>
  /** The raw reply of corrective turn `attempt` of a round (issue #30), beside the round's response. */
  | Readonly<{ kind: "correction"; subject: SubjectId; round: number; attempt: number }>
  | Readonly<{ kind: "planWrite" | "execution"; phase: number }>
  /** The tree of the project at the start of the run (Q7), and the change record a work review reads. */
  | Readonly<{ kind: "baseline" }>
  | Readonly<{ kind: "changes"; phase: number }>
  | Readonly<{ kind: "invalidReply"; agent: "claude" | "codex"; n: number }>
  /** Decision k: the question and its options, the reviewed analysis, the analysis call's raw output, the user's choice. */
  | Readonly<{ kind: "decisionQuestion" | "analysis" | "analysisWrite" | "chosen"; decision: number }>;

/** The directory of the records, relative to the project. */
export const RECORDS_DIR = "plan-review";

/**
 * The records directory of one run, relative to plan-review/ (issue #120): `runs/<start time>-<mode>-<item>`, built
 * by runRootOf alone, or that name with the suffix the store adds on a clash (`-2`, `-3`, …). The mode separates the
 * two runs that can be in progress at once, one per mode; the start time separates successive runs of one mode and
 * orders a listing; the item says which item the records belong to; `runs/` keeps every run apart from
 * plan-review/config.json and from the archives and loose files of runs before this change.
 */
export type RunRoot = Brand.Branded<string, "RunRoot">;
/** The directory that holds every run's records directory, relative to plan-review/. */
export const RUNS_DIR = "runs";
/** The longest item id a root carries; a Trello id is opaque and may be long. */
const ITEM_IN_ROOT = 40;
/** A run's root: the time with `:` and `.` replaced by `-`, as the archive names had; an item id's characters outside [A-Za-z0-9] become `_`. Total. */
export const runRootOf = (mode: RunMode, item: string, startedAtIso: string): RunRoot =>
  `${RUNS_DIR}/${startedAtIso.replace(/[:.]/g, "-")}-${mode}-${item.replace(/[^A-Za-z0-9]/g, "_").slice(0, ITEM_IN_ROOT)}` as RunRoot;
/** A root with the suffix that the store adds when the name exists: `-2` for k = 2. */
export const suffixedRoot = (root: RunRoot, k: number): RunRoot => (k <= 1 ? root : (`${root}-${k}` as RunRoot));
/** The path of an artifact of a run as messages and prompts name it, relative to the project: `plan-review/<root>/<path>`. */
export const runRecordPath = (root: RunRoot, artifact: Artifact): string => `${RECORDS_DIR}/${root}/${pathOf(artifact)}`;

/** The phase recorded in a subject's log entries: 0 for the question list and the requirements. */
export const phaseOf = (subject: PhasedSubject): number => (typeof subject !== "object" ? 0 : "plan" in subject ? subject.plan : subject.work);
/** The subdirectory of plan-review/ that holds a subject's round files. */
export const subjectDir = (subject: SubjectId): string =>
  subject === "questions"
    ? "question-review"
    : subject === "terms"
      ? "terms-review"
      : subject === "requirements"
      ? "requirements-review"
      : "plan" in subject
        ? `planning-${subject.plan}`
        : "work" in subject
          ? `work-review-${subject.work}`
          : `decision-${subject.decision}`;
const PLANNING_DIR = /^planning-([1-9][0-9]*)$/;
const WORK_DIR = /^work-review-([1-9][0-9]*)$/;
const DECISION_DIR = /^decision-([1-9][0-9]*)$/;
/** The subject of a subdirectory name, or null for a name that is not one. */
export const subjectOf = (dirName: string): SubjectId | null => {
  if (dirName === "question-review") return "questions";
  if (dirName === "terms-review") return "terms";
  if (dirName === "requirements-review") return "requirements";
  const planning = PLANNING_DIR.exec(dirName);
  if (planning !== null) return { plan: Number(planning[1]) };
  const work = WORK_DIR.exec(dirName);
  if (work !== null) return { work: Number(work[1]) };
  const decision = DECISION_DIR.exec(dirName);
  return decision === null ? null : { decision: Number(decision[1]) };
};
/** The file a subject's review reads. */
export const reviewedFile = (subject: SubjectId): Artifact =>
  subject === "questions" || subject === "terms" || subject === "requirements"
    ? { kind: subject }
    : "plan" in subject
      ? { kind: "planFile" }
      : "work" in subject
        ? { kind: "changes", phase: subject.work }
        : { kind: "analysis", decision: subject.decision };
const FIXED: Record<Extract<Artifact, { kind: string }>["kind"] & ("conversation" | "decisions" | "feedback" | "usage" | "questions" | "terms" | "requirements" | "plan" | "planFile" | "checkpoint" | "config"), string> = {
  conversation: "conversation.md",
  decisions: "user-decisions.md",
  feedback: "reviewer-feedback.md",
  usage: "usage.jsonl",
  questions: "questions.json",
  /** The explanations of the agreed questions' terms, the terms subject's reviewed file (S17, issue #36). */
  terms: "terms.json",
  requirements: "requirements.md",
  /** Rendered from plan.json for the developer to read (issue #6, F2). */
  plan: "plan.md",
  /** The plan with the status of each step, the plan subject's reviewed file (issue #6, F1). */
  planFile: "plan.json",
  checkpoint: "checkpoint.json",
  config: "config.json",
};
const ROUND_FILE = { review: "review", response: "cc", round: "round" } as const;
/** The path of an artifact relative to plan-review/, with "/" separators. */
export const pathOf = (artifact: Artifact): string => {
  switch (artifact.kind) {
    case "log":
      return artifact.subject === "questions"
        ? "questions-log.json"
        : artifact.subject === "terms"
          ? "terms-log.json"
          : artifact.subject === "requirements"
          ? "requirements-log.json"
          : "plan" in artifact.subject
            ? "issue-log.json"
            : "work" in artifact.subject
              ? "work-review-log.json"
              : "decision-log.json";
    case "review":
    case "response":
    case "round":
      return `${subjectDir(artifact.subject)}/${ROUND_FILE[artifact.kind]}-${artifact.round}.json`;
    case "correction":
      return `${subjectDir(artifact.subject)}/${ROUND_FILE.response}-${artifact.round}-corrective-${artifact.attempt}.json`;
    case "planWrite":
      return `planning-${artifact.phase}/cc-0.json`;
    case "execution":
      return `execution-${artifact.phase}/result.json`;
    case "baseline":
      return "baseline.json";
    case "changes":
      return `work-review-${artifact.phase}/changes.diff`;
    case "invalidReply":
      return `invalid-replies/${artifact.agent}-${artifact.n}.json`;
    case "decisionQuestion":
      return `decision-${artifact.decision}/question.json`;
    case "analysis":
      return `decision-${artifact.decision}/analysis.json`;
    case "analysisWrite":
      return `decision-${artifact.decision}/cc-0.json`;
    case "chosen":
      return `decision-${artifact.decision}/chosen.json`;
    default:
      return FIXED[artifact.kind];
  }
};
/** The path as messages and prompts name it: `plan-review/<path>`. */
export const recordPath = (artifact: Artifact): string => `${RECORDS_DIR}/${pathOf(artifact)}`;
/** The six issue logs (one subject of each). */
export const LOG_SUBJECTS: readonly SubjectId[] = [{ plan: 1 }, "questions", "terms", "requirements", { work: 1 }, { decision: 1 }];

/**
 * Whether a path under plan-review/ is a record that a read-only call must leave unchanged (finding 1 of
 * docs/gui-review.md). Exempt: what the program itself writes during a call (usage.jsonl; invalid-replies/, written
 * before a repair turn) and the archives of earlier runs. Every other path is guarded, a kind added later included.
 */
export const guardedRecord = (relPath: string): boolean =>
  relPath !== pathOf({ kind: "usage" }) && relPath !== "invalid-replies" && !relPath.startsWith("invalid-replies/") && !/^archive-[^/]+(\/|$)/.test(relPath);
