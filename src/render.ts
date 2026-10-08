// Markdown rendering of the records (pure): the round in conversation.md, the decision lines, the question lists,
// and the headings of the subjects (finding 27: the Store writes; it does not compose text).

import type { SubjectId } from "./artifacts.ts";
import { CONTEXT_BY_PROGRAM, originLine, questionTitle, TERMS_HEADING } from "./prompts.ts";
import { type Block, blocksMarkdown, type Piece, type PieceOption, piecesMarkdown, piecesText, plainMarkdown } from "./pieces.ts";
import { numberedSenses, type PauseFacts, pauseOriginOf, type PresentedOption, type PresentedQuestion, type QuestionOrigin, type ShownEntry, type ShownExplanation, shownExplanations } from "./question.ts";
import { Result } from "effect";
import type { QuestionInvalid } from "./errors.ts";
import * as words from "./prompts.ts";
import type { Disposition, Issue, TermsEntry } from "./schema.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import type { DecisionEvent } from "./reviewState.ts";
import type { TurnText } from "./schemaNormalize.ts";
import type { InterviewStage } from "./uiEvents.ts";

/** A question list as the agents exchange it or as the program records it (a recorded default may be null). */
export type RenderableQuestions = Readonly<{
  questions: readonly Readonly<{ id: string; question: readonly Piece[]; reason: readonly Block[]; proposed_answers: readonly PieceOption[]; default_answer: string | null; skip_if: Readonly<{ question: string; answer: string }> | null }>[];
}>;

/** "Question review", "Requirements review", "Planning phase k": the heading of a subject's rounds. */
export const subjectHeading = (subject: SubjectId): string =>
  subject === "questions"
    ? "Question review"
    : subject === "terms"
      ? "Terms review"
      : subject === "requirements"
      ? "Requirements review"
      : "plan" in subject
        ? `Planning phase ${subject.plan}`
        : "work" in subject
          ? `Work review ${subject.work}`
          : `Decision ${subject.decision}`;

export function renderRound(heading: string, round: number, review: Review, response: PlannerResponse): string {
  return `## ${heading}, round ${round}\n\n${renderReview(review)}${renderResponse(response)}`;
}

/** The lines of one decision: for user-decisions.md and for conversation.md. */
export const renderDecision = (event: DecisionEvent): Readonly<{ record: string; conversation: string }> => ({
  record: `Subject: ${event.subject}\nDecision: ${event.decision}\n\n`,
  conversation: `**User decision** on ${event.subject}: ${event.decision}\n\n`,
});

export const renderFeedback = (heading: string, round: number, text: string): string => `## ${heading}, round ${round}\n${text}\n\n`;

export function renderQuestions(list: RenderableQuestions): string {
  if (list.questions.length === 0) return "The list is empty.\n";
  return (
    list.questions
      .map((q) => {
        const answers = q.proposed_answers.map((a) => `  - ${piecesMarkdown(a.label)}: ${piecesMarkdown(a.description)}${piecesText(a.label) === q.default_answer ? " (default)" : ""}`).join("\n");
        const condition = q.skip_if === null ? "" : `\n  ${words.skipIfLine(q.skip_if)}`;
        return `- **[${q.id}]** ${piecesMarkdown(q.question)}\n  Reason: ${blocksMarkdown(q.reason).replace(/\n/g, "\n  ")}\n${answers}${condition}`;
      })
      .join("\n") + "\n"
  );
}

/**
 * The explanations of the agreed questions' terms in conversation.md (S17): each entry's id, then its terms as items
 * nested under it (termItem; issue #112, W1-R1-2 of work review 1). It is written after termsValidation has passed, so a
 * failure of the senses is the program's own error, typed.
 */
export const renderTerms = (entries: readonly TermsEntry[]): Result.Result<string, QuestionInvalid> =>
  Result.map(
    Result.all(entries.map((e) => shownExplanations(e.explanations, e.id))),
    (shown) => shown.map((terms, i) => (terms.length === 0 ? `- **[${entries[i].id}]** no term` : [`- **[${entries[i].id}]**`, ...terms.map((t) => termItem(t, "  "))].join("\n"))).join("\n") + "\n",
  );

/** The lines said for an interview turn, in order; the page shows the turn once and absorbs these lines (plan 4.2). */
export const interviewSays = (turn: TurnText): readonly string[] =>
  turn.kind === "summary_proposed" ? [`\n${turn.message}\n`, `Summary proposed by Claude Code:\n\n${turn.summary}\n`] : [`\n${turn.message}\n`];


/** Codex's half of a round (the page shows it as Codex's message). */
export const renderReview = (review: Review): string =>
  `### Codex\n\n${review.issues.map((i) => `- **[${i.id}]** (${i.severity}, ${i.location}) ${i.problem}\n  Evidence: ${i.evidence}`).join("\n")}\n\n`;
/** Claude Code's half of a round. */
export const renderResponse = (response: PlannerResponse): string => {
  const answers = response.dispositions.map((d) => {
    const dup = d.duplicate_of !== "" ? ` (duplicate of ${d.duplicate_of})` : "";
    const rev = d.reverses !== "" ? ` (reverses ${d.reverses})` : "";
    return `- **[${d.id}]** ${d.action}${dup}${rev}: ${d.rationale}`;
  });
  const self = response.self_corrections.map((s) => `- **Self-correction** (${s.new_action}, issue "${s.id}"): ${s.explanation}`);
  const feedback = response.reviewer_feedback !== "" ? [`- **Feedback to the reviewer:** ${response.reviewer_feedback}`] : [];
  return `### Claude Code\n\n${[...answers, ...self, ...feedback].join("\n")}\n\n`;
};

/** The heading of an interview in conversation.md, a record: unchanged when the user-facing name changes (issue #21). */
export const recordHeading = (stage: InterviewStage): string => {
  switch (stage) {
    case "clarification":
      return "Interview";
    case "followUp":
      return "Second interview";
  }
};

/** A decision's opening in conversation.md: its heading, the question and the options (decision support). */
export const renderDecisionOpened = (k: number, question: string, options: readonly Readonly<{ label: string; description: string }>[]): string =>
  `## Decision ${k}\n\n${question}\n\n${options.map((o, i) => `${i + 1}. ${o.label}${o.description === "" ? "" : ` — ${o.description}`}`).join("\n")}\n\n`;
/** A reference of a decision analysis that named no entry and was dropped (D9). */
export const renderReferenceDropped = (argument: string, named: string): string =>
  `**Reference dropped:** argument ${argument} names ${named}, which is no entry of the analysis; treated as no reference.\n\n`;
/** An option label of an analysis that matched only after normalization, rewritten to the exact label (issue #37, decision Q4). */
export const renderLabelCorrected = (given: string, exact: string): string =>
  `**Option label corrected:** the analysis named ${JSON.stringify(given)}, which the program read as the option ${JSON.stringify(exact)}.\n\n`;
/** A plan whose stage or step numbers were not 1…n in order, renumbered by position (issue #6: the numbers are display only). */
export const renderPlanRenumbered = (): string => "**Plan renumbered:** the stage or step numbers of the plan were not 1, 2, 3 … in order; the program numbered them by position.\n\n";
/** The user's answer after decision k (decision Q4), in conversation.md. */
export const renderChoice = (k: number, answer: string, option: string | null): string =>
  `**User choice** after decision ${k}: ${answer === "" ? "(none)" : answer}${option === null ? "" : ` (${option})`}\n\n`;
// ---- a question in conversation.md (S6, S8) --------------------------------------------------------------------------

/**
 * A sense as Markdown after a list marker whose content starts `column` spaces past the item's indent: the whole sense
 * escaped by plainMarkdown at once, so that its lookahead across lines decides a link label that spans two (P2-R1-1),
 * then every line after the first indented to that column, so that the sense stays inside its item (W1-R1-1). A blank
 * line stays empty and is a paragraph break within the item.
 */
const senseMarkdown = (text: string, indent: string, column: number): string =>
  plainMarkdown([text], { lineStart: true, lineEnd: true, after: "" })
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : `${indent}${" ".repeat(column)}${line}`))
    .join("\n");
/**
 * A term and its senses as one Markdown list item at `indent` (issue #112; W1-R1-1 and W1-R1-2 of work review 1), the one
 * rendering of a term in conversation.md and in the decision analysis's prompt: its label once, one sense on the label's
 * line, several numbered under it in the order given, as a dictionary gives them (numberedSenses).
 */
export const termItem = (explanation: ShownExplanation, indent: string): string => {
  const [first, ...rest] = numberedSenses(explanation.senses);
  if (rest.length === 0) return `${indent}- ${explanation.term}: ${senseMarkdown(first.text, indent, 2)}`;
  return [
    `${indent}- ${explanation.term}:`,
    ...[first, ...rest].map((s) => {
      const marker = `${s.number}. `;
      return `${indent}  ${marker}${senseMarkdown(s.text, indent, 2 + marker.length)}`;
    }),
  ].join("\n");
};
/** The id by which a record names the question (S6): an agreed question's, a follow-up's, an issue's; null for the others. */
export const recordIdOf = (origin: QuestionOrigin): string | null =>
  origin.kind === "clarification" || origin.kind === "followUp" ? origin.id : origin.kind === "pause" && "id" in origin ? origin.id : null;
/** A question in conversation.md (S6): under its displayed number, with the record's id beside it, so that the two can be matched. */
export const renderQuestionRecord = (q: PresentedQuestion): string => {
  const id = recordIdOf(q.origin);
  const terms = q.explanations.length === 0 ? "" : `**${TERMS_HEADING}**\n\n${q.explanations.map((e) => termItem(e, "")).join("\n")}\n\n`;
  // S11 (issue #59): each option's label in bold on its own line, its description below it.
  const option = (o: PresentedOption): string => {
    const description = piecesMarkdown(o.description);
    return `- ${"token" in o.answer ? `${o.answer.token}. ` : ""}**${piecesMarkdown(o.label)}**${description.trim() === "" ? "" : `  \n  ${description.replace(/\n/g, "\n  ")}`}`;
  };
  const options = q.options.length === 0 ? "" : `${q.options.map(option).join("\n")}\n\n`;
  const contextText = blocksMarkdown(q.context.blocks);
  const context = contextText.trim() === "" ? "" : `${contextText.split("\n").map((l) => `> ${l}`).join("\n")}${q.context.by === "program" ? ` (${CONTEXT_BY_PROGRAM})` : ""}\n\n`;
  const detailsText = blocksMarkdown(q.details);
  const details = detailsText.trim() === "" ? "" : `${detailsText}\n\n`;
  return `### ${questionTitle(q.number)}${id === null ? "" : ` (${id})`}\n\n_${originLine(q.origin, q.decision)}_\n\n${context}${details}${terms}**${piecesMarkdown(q.question)}**\n\n${options}`;
};
// ---- a pause's facts as prose (S11, issue #19) -------------------------------------------------------------------------

/** One entry of an issue's history in words, without the record's field names or its empty fields. */
const entryProse = (e: ShownEntry): string => {
  switch (e.source) {
    case "review":
      return words.reviewEntryLine(e.round, e.problem, words.dispositionWords(e.action), e.rationale);
    case "self_correction":
      return words.selfCorrectionLine(e.round, words.selfCorrectionWords(e.action), e.rationale);
    case "user":
      return words.userDecisionLine(e.round, e.rationale);
  }
};
const paragraph = (text: string): Block => ({ kind: "paragraph", pieces: [{ text, ref: "", code: false }] });
const list = (lines: readonly string[]): Block => ({ kind: "list", items: lines.map((text) => ({ level: 0, pieces: [{ text, ref: "", code: false }] })) });
const historyProse = (history: readonly ShownEntry[]): readonly Block[] => (history.length === 0 ? [] : [paragraph(words.HISTORY_HEADING), list(history.map(entryProse))]);
const issueProse = (issue: Issue | null): readonly Block[] => (issue === null ? [] : [paragraph(`${words.CODEX_SAYS} ${issue.problem.trim()}`), ...(issue.evidence.trim() === "" ? [] : [paragraph(issue.evidence.trim())])]);
const answerProse = (d: Disposition | null): readonly Block[] => (d === null ? [] : [paragraph(words.claudeAnswers(words.dispositionWords(d.action), d.rationale))]);
/**
 * A pause of behaviour 7 as the user reads it (S11, issue #19): what happened, what Codex says and what Claude Code
 * answers, and the point's history, as blocks of the details (S9 of the task of issue #36); the null and empty fields of
 * the records are left out.
 */
export const pauseProse = (facts: PauseFacts): readonly Block[] => {
  const lead = words.pauseLead(pauseOriginOf(facts));
  const parts = ((): readonly Block[] => {
    switch (facts.pause) {
      case "reraised":
        return [...issueProse(facts.issue), ...historyProse(facts.history)];
      case "secondClarification":
        return [...answerProse(facts.disposition), ...historyProse(facts.history)];
      case "disputedSelfCorrection":
        return [paragraph(facts.explanation.trim()), ...historyProse(facts.history)];
      case "reversal":
        return [...issueProse(facts.issue), ...answerProse(facts.disposition), ...historyProse(facts.history)];
      case "repeatedUnderNewId":
        return [...issueProse(facts.issue), ...historyProse(facts.history)];
      case "unexplained":
        return [paragraph(words.claudeResponseText(facts.resultText))];
      case "identical":
        return [paragraph(words.identicalFacts(facts.fileLabel, facts.round, facts.seen))];
      case "idle":
        return facts.issues.length === 0 ? [] : [paragraph(words.IDLE_ISSUES_HEADING), list(facts.issues.map(entryProse))];
    }
  })();
  return [paragraph(lead), ...parts.filter((p) => p.kind !== "paragraph" || piecesText(p.pieces).trim() !== "")];
};
