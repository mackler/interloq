/**
 * The check of a revision against the corrections accepted earlier in its review loop (issue #232; pure: no I/O, no
 * Effect services). Claude Code names, per issue it accepts in full or in part, the passages of the file it returns that
 * carry the correction (correction_passages); the program records them on the issue's log entry (kept_passages), and
 * every later response of the loop must still contain each recorded passage, unless one of its validated dispositions
 * reverses that issue (behavior 7's reversal) or an entry of the response restates it with its passages as they now read.
 */
import { Result } from "effect";
import { CorrectionDropped } from "./errors.ts";
import { blocksText, piecesText } from "./pieces.ts";
import { elementsOf, entriesOf, flatten } from "./analysisView.ts";
import { KEPT_CORRECTION_PROBLEM_KINDS, type KeptCorrectionProblem, keptCorrectionsRepairPrompt } from "./prompts.ts";
import type { ValidatedDisposition, ValidatedRound } from "./round.ts";
import type { CorrectionPassages, DecisionAnalysis, LogEntry, Piece, Plan, QuestionEntry, TermsEntry } from "./schema.ts";
import type { Validation } from "./review.ts";

/** Every run of whitespace one space, the text trimmed: a passage is compared whitespace aside. */
export const normalizedSpace = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** Whether a passage stands, whitespace aside, within one of the texts (a passage never spans two fields). */
export const occursInTexts = (passage: string, texts: readonly string[]): boolean => {
  const wanted = normalizedSpace(passage);
  return texts.some((t) => normalizedSpace(t).includes(wanted));
};

/** One accepted correction of the loop and the passages that carry it. */
export type KeptCorrection = Readonly<{ id: string; passages: readonly string[] }>;

const current = (log: readonly LogEntry[], phase: number): readonly LogEntry[] => log.filter((e) => !e.superseded && e.phase === phase);
const passagesOf = (e: LogEntry): readonly string[] => (e.source === "user" ? [] : e.kept_passages);

/**
 * The corrections a response of the loop of `phase` must keep: the current entries of source review or self_correction
 * that carry passages. A self-correction's entry is read since appendRound supersedes an accepted review entry with it and
 * carries its passages forward; the phase, since the plan's issue-log.json holds every planning phase's entries.
 * KEPT_CORRECTIONS_SCOPE_SENTENCE of src/prompts.ts states this scope to Claude Code: a change of one needs the other.
 */
export const keptBaselineOf = (log: readonly LogEntry[], phase: number): readonly KeptCorrection[] =>
  current(log, phase).flatMap((e) => (passagesOf(e).length > 0 ? [{ id: e.id, passages: passagesOf(e) }] : []));

/** The ids an entry of correction_passages may restate: corrections that carry passages, and issues accepted earlier. */
export const restatable = (log: readonly LogEntry[], phase: number): ReadonlySet<string> =>
  new Set(current(log, phase).flatMap((e) => (passagesOf(e).length > 0 || (e.source === "review" && (e.action === "accepted" || e.action === "partially_accepted")) ? [e.id] : [])));

/**
 * The passages each entry keeps after a round (issue #232), the rule appendRound applies: this round's entry of the id
 * (its correction_passages) wins; otherwise the earlier passages stand, except that an accepted issue of this round
 * without an entry keeps none, and a validated reversal of this round clears them. `earlier` is the log as the round began.
 */
export const keptPassagesAfter = (earlier: readonly LogEntry[], round: ValidatedRound) => {
  const entry = (id: string): readonly string[] | undefined => round.correctionPassages.find((e) => e.id === id)?.passages;
  const before = (id: string): readonly string[] => {
    const found = earlier.filter((e) => !e.superseded && e.id === id).at(-1);
    return found === undefined ? [] : passagesOf(found);
  };
  const reversed = new Set(round.dispositions.flatMap((d) => (d.reverses === null ? [] : [d.reverses as string])));
  const cleared = (id: string, passages: readonly string[]): readonly string[] => (reversed.has(id) ? [] : passages);
  return {
    /** A review entry of this round. */
    review: (id: string, accepted: boolean): readonly string[] => cleared(id, entry(id) ?? (accepted ? [] : before(id))),
    /** A self-correction entry of this round. */
    selfCorrection: (id: string): readonly string[] => cleared(id, entry(id) ?? before(id)),
    /** An earlier entry no entry of this round replaces: restated or reversed in place, else unchanged. */
    earlierEntry: (e: LogEntry): LogEntry => {
      if (e.source === "user" || e.superseded) return e;
      const passages = cleared(e.id, entry(e.id) ?? e.kept_passages);
      return passages === e.kept_passages ? e : { ...e, kept_passages: passages };
    },
  };
};

export type KeptCorrectionsInput = Readonly<{
  baseline: readonly KeptCorrection[];
  restatable: ReadonlySet<string>;
  /** The validated dispositions of src/round.ts, whose `reverses` validateRound normalized. */
  dispositions: readonly Pick<ValidatedDisposition, "id" | "action" | "reverses">[];
  entries: readonly CorrectionPassages[];
  texts: readonly string[];
}>;

/** The problems of a response against its loop's accepted corrections, by kind (KEPT_CORRECTION_PROBLEM_KINDS) then id. */
export const keptCorrectionProblems = (input: KeptCorrectionsInput): readonly KeptCorrectionProblem[] => {
  const accepted = new Set(input.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id as string));
  const reversed = new Set(input.dispositions.flatMap((d) => (d.reverses === null ? [] : [d.reverses as string])));
  const named = new Set(input.entries.map((e) => e.id));
  const problem = (kind: KeptCorrectionProblem["kind"], id: string, passage = ""): KeptCorrectionProblem => ({ kind, id, passage });
  const problems: readonly KeptCorrectionProblem[] = [
    ...[...accepted].filter((i) => !named.has(i)).map((i) => problem("entryMissing", i)),
    ...[...named].filter((i) => input.entries.filter((e) => e.id === i).length > 1).map((i) => problem("entryDuplicate", i)),
    ...[...named].filter((i) => !accepted.has(i) && !input.restatable.has(i)).map((i) => problem("entryNotAccepted", i)),
    ...input.entries.flatMap((e) =>
      e.passages.map((passage) => (passage.trim() === "" ? problem("passageBlank", e.id) : occursInTexts(passage, input.texts) ? null : problem("passageNotInReply", e.id, passage))).filter((p) => p !== null),
    ),
    ...input.baseline
      .filter((c) => !reversed.has(c.id) && !named.has(c.id))
      .flatMap((c) => c.passages.filter((passage) => !occursInTexts(passage, input.texts)).map((passage) => problem("correctionMissing", c.id, passage))),
  ];
  const rank = (k: KeptCorrectionProblem["kind"]) => KEPT_CORRECTION_PROBLEM_KINDS.indexOf(k);
  return [...problems].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

const optionTexts = (o: Readonly<{ label: readonly Piece[]; description: readonly Piece[] }>): readonly string[] => [piecesText(o.label), piecesText(o.description)];

/** The plan's texts: each stage's title, each step's label and text. */
export const planTexts = (plan: Plan): readonly string[] => plan.stages.flatMap((stage) => [stage.title, ...stage.steps.flatMap((step) => [step.label, step.text])]);
/** The question list's texts: per entry its question, context, history, reason, proposed answers and default. */
export const questionListTexts = (questions: readonly QuestionEntry[]): readonly string[] =>
  questions.flatMap((q) => [piecesText(q.question), ...blocksText(q.context), ...blocksText(q.history), ...blocksText(q.reason), ...q.proposed_answers.flatMap(optionTexts), q.default_answer]);
/** The terms' texts: the same fields of each entry, and each explanation's term and senses. */
export const termsTexts = (entries: readonly TermsEntry[]): readonly string[] =>
  entries.flatMap((t) => [piecesText(t.question), ...blocksText(t.context), ...blocksText(t.history), ...blocksText(t.reason), ...t.proposed_answers.flatMap(optionTexts), ...t.explanations.flatMap((x) => [x.term, ...x.senses])]);
/** A decision analysis's texts: the decision, each column's option, what is unclear, each entry's title and every element and argument at every depth, and the recommendation. */
export const analysisTexts = (analysis: DecisionAnalysis): readonly string[] => [
  analysis.decision,
  ...analysis.columns.flatMap((c) => (c.kind === "unclear" ? [c.option, c.unclear] : [c.option])),
  ...entriesOf(analysis).flatMap((e) => [e.title, ...elementsOf(e).flatMap((el) => [el.text, ...flatten(el.counterarguments).map((a) => a.text)])]),
  analysis.recommendation.option,
  analysis.recommendation.reason,
];

export type KeptCorrectionsSetup<R> = Readonly<{
  baseline: readonly KeptCorrection[];
  restatable: ReadonlySet<string>;
  dispositionsOf: (reply: R) => readonly Pick<ValidatedDisposition, "id" | "action" | "reverses">[];
}>;

/** The check as a Validation: CorrectionDropped with its repair prompt where any problem is found. */
export const keptCorrectionsValidation =
  <R>(setup: KeptCorrectionsSetup<R>, textsOf: (reply: R) => readonly string[], entriesOf: (reply: R) => readonly CorrectionPassages[]): Validation<R> =>
  (reply) => {
    const problems = keptCorrectionProblems({ baseline: setup.baseline, restatable: setup.restatable, dispositions: setup.dispositionsOf(reply), entries: entriesOf(reply), texts: textsOf(reply) });
    return problems.length === 0 ? Result.succeed({ value: reply, notes: [] }) : Result.fail({ error: new CorrectionDropped({ problems }), repair: keptCorrectionsRepairPrompt(problems) });
  };
