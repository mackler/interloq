// A question put to the user (S2 and following): its parts, and the mechanical part of the rules of QUESTION_RULES in
// src/prompts.ts. Issue #36 (30 Sep 2026): a question's text is a sequence of pieces, and the explanations a list the
// pieces refer to; the checks are on data alone, and nothing reads Markdown. Pure; also imported by the browser.
import { Result, Schema } from "effect";
import { QuestionInvalid } from "./errors.ts";
import { blockPieces, blocksText, piecesText, type ShownBlock } from "./pieces.ts";
import type { QuestionProblem } from "./prompts.ts";
import { Block, type Disposition, Explanation, type Issue, type LogEntry, Piece, PieceOption, type QuestionOption } from "./schema.ts";

export type { QuestionOption };
export type { Explanation, Piece, PieceOption } from "./schema.ts";

/**
 * The parts of a question that an agent writes: the context paragraph (blocks), the question (pieces), the explanations
 * its pieces refer to and its options; `details`, what the question is about as the program records it (S11), may hold
 * pieces that refer to explanations too.
 */
export type Question = Readonly<{
  context: readonly ShownBlock[];
  question: readonly Piece[];
  explanations: readonly Explanation[];
  options: readonly PieceOption[];
  details?: readonly ShownBlock[];
}>;

/** Words that stand before a number without saying what it numbers ("see #53", "the #6"). */
const NOT_A_KIND = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "by", "for", "from", "with", "as", "see", "per", "via"]);
/** A reference like "#53" without the kind of thing it numbers before it; "Issues #6, #33 and #28" names its kind once. */
const bareNumbers = (text: string): readonly string[] =>
  [...text.matchAll(/#\d+/gu)].flatMap((m) => {
    const before = text.slice(0, m.index).replace(/(?:#\d+\s*(?:,\s*(?:and\s+|or\s+)?|and\s+|or\s+))+$/u, "");
    const kind = /(\p{L}+)\s+$/u.exec(before);
    return kind !== null && !NOT_A_KIND.has(kind[1].toLowerCase()) ? [] : [m[0]];
  });

/** Every piece of a question that the reader is shown: the context's, the question's, the details' and every option's. */
export const questionPieces = (q: Question): readonly Piece[] => [
  ...blockPieces(q.context),
  ...q.question,
  ...blockPieces(q.details ?? []),
  ...q.options.flatMap((o) => [...o.label, ...o.description]),
];
/** A code piece that refers to an explanation, as a key: its words and its ref. */
const codeRefKey = (p: Piece): string => JSON.stringify([p.text, p.ref]);

/**
 * The problems of one question; none when it keeps every mechanically checkable rule (S3 of the task of issue #36): every
 * ref names an explanation, every explanation is referred to, ids unique, terms, explanations and referring pieces not
 * blank, no ref added to a literal value, the question ending with its question mark, a context, and no bare number.
 * `supplied`: the code pieces with a ref that the program itself supplied (the names of a tool's settings it explains, S9),
 * the one exception to "no ref on a code piece"; none for a question an agent wrote.
 */
export const questionProblems = (q: Question, supplied: readonly Piece[] = []): readonly QuestionProblem[] => {
  const pieces = questionPieces(q);
  const ids = q.explanations.map((e) => e.id);
  const refs = new Set(pieces.filter((p) => p.ref !== "").map((p) => p.ref));
  const allowed = new Set(supplied.filter((p) => p.code && p.ref !== "").map(codeRefKey));
  const plainWords = [...blocksText(q.context.filter((b) => b.kind !== "code")), piecesText(q.question), ...q.options.flatMap((o) => [piecesText(o.label), piecesText(o.description)])];
  return [
    ...(blocksText(q.context).join("").trim() === "" ? [{ kind: "blankContext" as const, subject: "" }] : []),
    ...(/\?["'”’)\]]*$/u.test(piecesText(q.question).trim()) ? [] : [{ kind: "notLast" as const, subject: "" }]),
    ...[...new Set(pieces.filter((p) => p.ref !== "" && !ids.includes(p.ref)).map((p) => p.ref))].map((subject) => ({ kind: "unknownRef" as const, subject })),
    ...pieces.filter((p) => p.ref !== "" && p.text.trim() === "").map((p) => ({ kind: "blankTermPiece" as const, subject: p.ref })),
    ...pieces.filter((p) => p.code && p.ref !== "" && !allowed.has(codeRefKey(p))).map((p) => ({ kind: "refOnCode" as const, subject: p.text })),
    ...q.explanations.flatMap((e, i): QuestionProblem[] => [
      ...(ids.indexOf(e.id) < i ? [{ kind: "duplicateExplanation" as const, subject: e.id }] : []),
      ...(e.term.trim() === "" ? [{ kind: "blankTerm" as const, subject: e.id }] : []),
      ...(e.explanation.trim() === "" ? [{ kind: "blankExplanation" as const, subject: e.term.trim() === "" ? e.id : e.term }] : []),
      ...(refs.has(e.id) || ids.indexOf(e.id) < i ? [] : [{ kind: "unusedExplanation" as const, subject: e.term.trim() === "" ? e.id : e.term }]),
    ]),
    ...plainWords.flatMap(bareNumbers).map((subject) => ({ kind: "bareNumber" as const, subject })),
  ];
};

/** Validates one question; `where` names it in the error ("questions_for_user 1", "Q3"). */
export const validateQuestion = (q: Question, where = "the question"): Result.Result<Question, QuestionInvalid> => {
  const problems = questionProblems(q);
  return problems.length === 0 ? Result.succeed(q) : Result.fail(new QuestionInvalid({ questions: [{ where, problems }] }));
};

/** Validates the questions of one reply together: every failing question is named in the one error. */
export const validateQuestions = (questions: readonly Readonly<{ where: string; question: Question }>[]): Result.Result<void, QuestionInvalid> => {
  const failing = questions.map(({ where, question }) => ({ where, problems: questionProblems(question) })).filter((q) => q.problems.length > 0);
  return failing.length === 0 ? Result.succeed(undefined) : Result.fail(new QuestionInvalid({ questions: failing }));
};

// ---- the one presentation of a question (S5, issues #46 and #57) ------------------------------------------------------

/** The pause of behaviour 7 that asks the question, with the ids and names it concerns (S5, S11). */
export type PauseOrigin =
  | Readonly<{ pause: "reraised"; id: string }>
  | Readonly<{ pause: "secondClarification"; id: string }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number }>
  | Readonly<{ pause: "identical"; fileLabel: string }>
  | Readonly<{ pause: "idle"; idle: number }>;

/** A log entry of a pause's facts; its prose never shows the program's measurement (issue #31). */
export type ShownEntry = LogEntry;
/**
 * What a pause of behaviour 7 is about, as data (S11, issue #19): the ids of its origin, and the review issue, the
 * disposition and the earlier log entries that the user reads as prose (`pauseProse` in src/render.ts), never as JSON.
 */
export type PauseFacts =
  | Readonly<{ pause: "reraised"; id: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "secondClarification"; id: string; history: readonly ShownEntry[]; disposition: Disposition | null }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string; explanation: string; history: readonly ShownEntry[] }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string; history: readonly ShownEntry[]; issue: Issue | null; disposition: Disposition | null }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number; resultText: string }>
  | Readonly<{ pause: "identical"; fileLabel: string; round: number; seen: string }>
  | Readonly<{ pause: "idle"; idle: number; round: number; issues: readonly ShownEntry[] }>;
/** The ids a pause's origin keeps of its facts. */
export const pauseOriginOf = (facts: PauseFacts): PauseOrigin => {
  switch (facts.pause) {
    case "reraised":
    case "secondClarification":
    case "disputedSelfCorrection":
      return { pause: facts.pause, id: facts.id };
    case "reversal":
      return { pause: "reversal", id: facts.id, reverses: facts.reverses };
    case "repeatedUnderNewId":
      return { pause: "repeatedUnderNewId", id: facts.id, repeats: facts.repeats };
    case "unexplained":
      return { pause: "unexplained", fileLabel: facts.fileLabel, heading: facts.heading, round: facts.round };
    case "identical":
      return { pause: "identical", fileLabel: facts.fileLabel };
    case "idle":
      return { pause: "idle", idle: facts.idle };
  }
};

/**
 * What produced a question (S5): where it arose in the run, with what the record and the origin line need to name it.
 * A question inside decision k carries k in `PresentedQuestion.decision`, whatever its origin (issue #57).
 */
export type QuestionOrigin =
  /** An agreed question of the clarification, or a question asked there that is not in the list (a follow-up, an accepted requirements issue). */
  | Readonly<{ kind: "clarification"; id: string }>
  | Readonly<{ kind: "followUp"; id: string }>
  /** A turn of the clarification that asks no particular question: the user replies to Claude Code's message. */
  | Readonly<{ kind: "reply" }>
  /** The choice after an empty agreed list: start planning, or talk first. */
  | Readonly<{ kind: "startOrTalk" }>
  /** The confirmation of the summary of a clarification. */
  | Readonly<{ kind: "confirmSummary" }>
  /** A question Claude Code returns with a plan it writes or revises, or with a response to a review (`heading` names where). */
  | Readonly<{ kind: "planner"; heading: string }>
  /** A question Claude Code asks while implementing the plan. */
  | Readonly<{ kind: "relayed" }>
  /** An implementation that stopped without a question the user was asked. */
  | Readonly<{ kind: "execStop"; phase: number; status: string }>
  /** A permission request of Claude Code while implementing the plan. */
  | Readonly<{ kind: "permission"; tool: string; input: string }>
  | (Readonly<{ kind: "pause"; heading: string }> & PauseOrigin)
  | Readonly<{ kind: "limit"; heading: string; limit: number }>
  | Readonly<{ kind: "unchanged"; heading: string; fileLabel: string; accepted: readonly string[] }>
  | Readonly<{ kind: "transport"; agent: "claude" | "codex"; what: string; attempts: number; fault: string }>;

/** The exact text that chooses an option, or any whole number the user types (the more cycles at the cycle limit, S8). */
export type OptionAnswer = Readonly<{ token: string }> | Readonly<{ numeric: true }>;
/** An option as the user is shown it: its label and description as pieces, and the answer that chooses it. */
export type PresentedOption = Readonly<{ label: readonly Piece[]; description: readonly Piece[]; answer: OptionAnswer }>;
/** Who wrote the context paragraph (as blocks): an agent, or the program (a fixed paragraph, S7 and S10). */
export type QuestionContextText = Readonly<{ blocks: readonly ShownBlock[]; by: "agent" | "program" }>;
/**
 * What the context call gives a question (S9, decisions G-R1-1 and F1): its context paragraph, by whom, the explanations,
 * and, when an agent wrote it, the question, the options and the details as it rephrased them; absent, the program's own
 * stand.
 */
export type ContextWritten = Readonly<{
  context: QuestionContextText;
  explanations: readonly Explanation[];
  question?: readonly Piece[];
  options?: readonly PieceOption[];
  details?: readonly ShownBlock[];
}>;

/**
 * A question as the user is shown it (S5), the same shape whatever produced it: its number in the run, where it came
 * from, the context paragraph, the explanations its pieces refer to, the question and the options that answer it, and
 * the decision it belongs to (issue #57), or null.
 */
export type PresentedQuestion = Readonly<{
  number: number;
  origin: QuestionOrigin;
  context: QuestionContextText;
  explanations: readonly Explanation[];
  question: readonly Piece[];
  options: readonly PresentedOption[];
  /** What the question is about, shown with the context (S11): a pause's facts, the summary to confirm; empty when none. */
  details: readonly ShownBlock[];
  decision: number | null;
}>;

// ---- a question relayed from AskUserQuestion (S8 of the task of issue #36; behavior 4) ---------------------------------

/**
 * A question Claude Code relays with AskUserQuestion, as the text of the tool's question (RELAYED_SHAPE of src/prompts.ts):
 * a JSON object with its context, its question, its explanations and its options as pieces, in the tool's option order.
 */
export const RelayedQuestion = Schema.Struct({
  context: Schema.Array(Block),
  question: Schema.Array(Piece),
  explanations: Schema.Array(Explanation),
  options: Schema.Array(PieceOption),
});
export type RelayedQuestion = typeof RelayedQuestion.Type;
const decodeRelayed = Schema.decodeUnknownResult(Schema.fromJsonString(RelayedQuestion));

/**
 * The parts of a relayed question's text (S8): null unless the text decodes as a RelayedQuestion, keeps every mechanically
 * checkable rule, and has the tool's options, the same count with each option's words equal to the tool's label and
 * description at that position. A text that is not so is not denied; a context call writes its context (S14).
 */
export const parseRelayedQuestion = (text: string, options: readonly QuestionOption[]): Question | null => {
  const decoded = decodeRelayed(text.trim());
  if (Result.isFailure(decoded)) return null;
  const q: Question = decoded.success;
  const sameOptions = q.options.length === options.length && q.options.every((o, i) => piecesText(o.label) === options[i].label && piecesText(o.description) === options[i].description);
  return sameOptions && questionProblems(q).length === 0 ? q : null;
};
