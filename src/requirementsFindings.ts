/**
 * The classification of the requirements review's accepted findings (pure; issue #47): which problems a response's
 * `findings` and `requirements` have against its dispositions and the requirements.md they amend, and which findings
 * the second interview asks and which the response writes into the document.
 */
import type { Disposition, RequirementFinding } from "./schema.ts";

/** The kinds of a problem of the classification, in the order they are listed. */
export const FINDING_PROBLEM_KINDS = ["missing", "notAccepted", "duplicate", "blankSource", "blankChange", "documentUnchanged"] as const;
/** The kinds of a problem that concerns one finding's id. */
export type IdProblemKind = Exclude<(typeof FINDING_PROBLEM_KINDS)[number], "documentUnchanged">;
/**
 * A problem of the classification: an accepted id with no finding (`missing`), a finding for an id that is no accepted
 * or partially accepted disposition of this response (`notAccepted`), two findings for one id (`duplicate`), a blank
 * `source` or `changed`, and answered or corrected findings whose document is null or unchanged (`documentUnchanged`).
 */
export type FindingProblem = { readonly kind: IdProblemKind; readonly id: string } | { readonly kind: "documentUnchanged"; readonly ids: readonly string[] };

/** A finding the second interview asks. */
export type InterviewedFinding = Extract<RequirementFinding, { kind: "unresolved" | "reopened" }>;
/** A finding the response writes into requirements.md. */
export type WrittenFinding = Extract<RequirementFinding, { kind: "answered" | "corrected" }>;

const isAccepted = (d: Disposition): boolean => d.action === "accepted" || d.action === "partially_accepted";
const blank = (text: string): boolean => text.trim() === "";
const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();
const isInterviewed = (f: RequirementFinding): f is InterviewedFinding => f.kind === "unresolved" || f.kind === "reopened";
const isWritten = (f: RequirementFinding): f is WrittenFinding => f.kind === "answered" || f.kind === "corrected";

/**
 * Every problem of a response's classification, by kind in FINDING_PROBLEM_KINDS's order and then by id, so the repair
 * prompt is the same for the same reply. `current` is requirements.md as it stands; a document counts as changed only
 * where it differs from it beyond trailing whitespace.
 */
export function findingsProblems(dispositions: readonly Disposition[], findings: readonly RequirementFinding[], requirements: string | null, current: string): readonly FindingProblem[] {
  const accepted = new Set(dispositions.filter(isAccepted).map((d) => d.id));
  const ids = findings.map((f) => f.id);
  const byKind = (kind: IdProblemKind, of: readonly string[]): FindingProblem[] => unique(of).map((id) => ({ kind, id }));
  const written = unique(findings.filter(isWritten).map((f) => f.id));
  const unchanged = requirements === null || requirements.trimEnd() === current.trimEnd();
  return [
    ...byKind("missing", [...accepted].filter((id) => !ids.includes(id))),
    ...byKind("notAccepted", ids.filter((id) => !accepted.has(id))),
    ...byKind("duplicate", ids.filter((id, i) => ids.indexOf(id) !== i)),
    ...byKind("blankSource", findings.flatMap((f) => (f.kind === "answered" && blank(f.source) ? [f.id] : []))),
    ...byKind("blankChange", findings.flatMap((f) => (f.kind === "reopened" && blank(f.changed) ? [f.id] : []))),
    ...(written.length > 0 && unchanged ? [{ kind: "documentUnchanged" as const, ids: written }] : []),
  ];
}

/** The findings the second interview asks, in the response's order. */
export const interviewedOf = (findings: readonly RequirementFinding[]): readonly InterviewedFinding[] => findings.filter(isInterviewed);

/** The findings the response writes into requirements.md, in the response's order. */
export const writtenOf = (findings: readonly RequirementFinding[]): readonly WrittenFinding[] => findings.filter(isWritten);
