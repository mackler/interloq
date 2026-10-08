// A question put to the user (S2 and following): its parts, and the mechanical part of the rules of QUESTION_RULES in
// src/prompts.ts. Issue #36 (30 Sep 2026): a question's text is a sequence of pieces, and the explanations a list the
// pieces refer to; the checks are on data alone, and nothing reads Markdown. Pure; also imported by the browser.
import { type Brand, Result, Schema } from "effect";
import { QuestionInvalid } from "./errors.ts";
import { blockPieces, blocksText, piecesText, plainRuns, type ShownBlock } from "./pieces.ts";
import { type QuestionProblem, sensesNumbered } from "./prompts.ts";
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

// ---- the senses of an explanation (issue #112) -------------------------------------------------------------------------

/** One sense of an explanation: a definition with a character other than whitespace, built by sensesOf alone. */
export type Sense = Brand.Branded<string, "Sense">;
/** The senses of an explanation: one or more, in the order the writer gave them, as a dictionary numbers them. */
export type Senses = readonly [Sense, ...Sense[]];
/** Why a list of texts is not the senses of an explanation: it is empty, or the entry at `position` (from 1) is blank. */
export type SenseProblem = Readonly<{ kind: "noSense" }> | Readonly<{ kind: "blankSense"; position: number }>;
/**
 * The senses of an explanation from the texts an agent wrote (issue #112): the one place that decides that a list of
 * senses is not empty and that no sense is blank. At the agent boundary the list is a plain array of strings, so that
 * the schema needs no keyword Codex's strict mode might reject; a reply that breaks it gets the validation repair turn.
 */
export const sensesOf = (texts: readonly string[]): Result.Result<Senses, readonly SenseProblem[]> => {
  if (texts.length === 0) return Result.fail([{ kind: "noSense" }]);
  const blank = texts.flatMap((t, i): SenseProblem[] => (t.trim() === "" ? [{ kind: "blankSense", position: i + 1 }] : []));
  return blank.length === 0 ? Result.succeed(texts as unknown as Senses) : Result.fail(blank);
};
/** An explanation's problems of its senses, each named by its term (or its id, where the term is blank). */
const senseProblems = (e: Explanation): readonly QuestionProblem[] => {
  const built = sensesOf(e.senses);
  if (Result.isSuccess(built)) return [];
  const name = e.term.trim() === "" ? e.id : e.term;
  return built.failure.map((p): QuestionProblem => (p.kind === "noSense" ? { kind: "noSense", subject: name } : { kind: "blankSense", subject: `sense ${p.position} of the term ${JSON.stringify(name)}` }));
};

/** An explanation as a presented question holds it (issue #112): its senses built by sensesOf. */
export type ShownExplanation = Readonly<{ id: string; term: string; senses: Senses }>;
/**
 * The explanations of a question as it is presented: each one's senses through sensesOf. Every explanation that reaches
 * a draft has passed questionProblems or is the program's own, so a failure here is the program's error, typed.
 */
export const shownExplanations = (explanations: readonly Explanation[], where = "the question shown"): Result.Result<readonly ShownExplanation[], QuestionInvalid> => {
  const built = explanations.map((e) => ({ e, senses: sensesOf(e.senses) }));
  const problems = explanations.flatMap(senseProblems);
  if (problems.length > 0) return Result.fail(new QuestionInvalid({ questions: [{ where, problems }] }));
  return Result.succeed(built.flatMap(({ e, senses }) => (Result.isSuccess(senses) ? [{ id: e.id, term: e.term, senses: senses.success }] : [])));
};
/** The senses as a dictionary numbers them: none for one sense, 1…n in order for several (issue #112). */
export const numberedSenses = (senses: Senses): readonly Readonly<{ number: number | null; text: Sense }>[] =>
  sensesNumbered(senses).map((s, i) => ({ number: s.number, text: senses[i] }));

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
/**
 * The plain runs of blocks (plainRuns of src/pieces.ts; W1-R1-2): a code piece is a literal value, never a bare number,
 * and it separates the words on either side of it. Each paragraph's and list item's runs, a document's Markdown whole; a
 * code block has none.
 */
const blockRuns = (blocks: readonly ShownBlock[]): readonly string[] =>
  blocks.flatMap((b) => (b.kind === "paragraph" ? plainRuns(b.pieces) : b.kind === "list" ? b.items.flatMap((i) => plainRuns(i.pieces)) : b.kind === "document" ? [b.markdown] : []));
/**
 * Every sequence of pieces of a question, each read on its own (S33): the question, each paragraph and list item of the
 * context and the details, each option's label and description. A document block has none.
 */
const sequencesOf = (q: Question): readonly (readonly Piece[])[] => {
  const ofBlocks = (blocks: readonly ShownBlock[]) => blocks.flatMap((b) => (b.kind === "paragraph" ? [b.pieces] : b.kind === "list" ? b.items.map((i) => i.pieces) : []));
  return [...ofBlocks(q.context), q.question, ...ofBlocks(q.details ?? []), ...q.options.flatMap((o) => [o.label, o.description])];
};
/**
 * The code pieces that stand right after another in one sequence (W5-R1-1, P6-R1-1): an empty plain piece writes nothing
 * between them and is skipped; an empty code piece is written as a phrase, not a span, and separates them.
 */
const adjacentCodes = (pieces: readonly Piece[]): readonly Piece[] =>
  pieces
    .filter((p) => p.code || p.text !== "")
    .filter((p, i, kept) => i > 0 && p.code && p.text !== "" && kept[i - 1].code && kept[i - 1].text !== "");
/** A code piece that refers to an explanation, as a key: its words and its ref. */
const codeRefKey = (p: Piece): string => JSON.stringify([p.text, p.ref]);
/**
 * A code piece with a ref that the program supplied, with the part of the question it stands in (`partsOf`): the
 * exception to "no ref on a code piece" holds in that part alone, and as many times as it was supplied (P5-R1-1).
 */
export type SuppliedRef = Readonly<{ part: string; piece: Piece }>;
/** The parts of a question, each with its pieces, in the order of questionPieces. */
export const partsOf = (q: Question): readonly Readonly<{ part: string; pieces: readonly Piece[] }>[] => [
  { part: "context", pieces: blockPieces(q.context) },
  { part: "question", pieces: q.question },
  { part: "details", pieces: blockPieces(q.details ?? []) },
  ...q.options.flatMap((o, i) => [
    { part: `option ${i + 1} label`, pieces: o.label },
    { part: `option ${i + 1} description`, pieces: o.description },
  ]),
];
/** Every supplied code piece of a question (its code pieces with a ref), with its part. */
export const suppliedOf = (q: Question): readonly SuppliedRef[] => partsOf(q).flatMap(({ part, pieces }) => pieces.filter((p) => p.code && p.ref !== "").map((piece) => ({ part, piece })));
/**
 * The code pieces with a ref beyond what was supplied in their part: in each part, each text and ref as many times as
 * the program supplied it there, the rest in excess (W4-R1-1, P5-R1-1).
 */
const refsBeyondSupplied = (q: Question, supplied: readonly SuppliedRef[]): readonly Piece[] =>
  partsOf(q).flatMap(({ part, pieces }) =>
    pieces
      .filter((p) => p.code && p.ref !== "")
      .filter((p, i, refd) => {
        const allowed = supplied.filter((s) => s.part === part && codeRefKey(s.piece) === codeRefKey(p)).length;
        return refd.slice(0, i + 1).filter((r) => codeRefKey(r) === codeRefKey(p)).length > allowed;
      }),
  );

/**
 * The problems of one question; none when it keeps every mechanically checkable rule (S3 of the task of issue #36): every
 * ref names an explanation, every explanation is referred to, ids unique, terms and referring pieces not blank, every
 * explanation with one or more senses and none blank (issue #112), no ref added to a literal value, the question ending with its question mark, a context, and no bare number.
 * `supplied`: the code pieces with a ref that the program itself supplied (the names of a tool's settings it explains, S9),
 * each with its part, the one exception to "no ref on a code piece", in that part and as often as supplied (P5-R1-1);
 * none for a question an agent wrote.
 */
export const questionProblems = (q: Question, supplied: readonly SuppliedRef[] = []): readonly QuestionProblem[] => {
  const pieces = questionPieces(q);
  const ids = q.explanations.map((e) => e.id);
  const refs = new Set(pieces.filter((p) => p.ref !== "").map((p) => p.ref));
  const plainWords = [...blockRuns(q.context), ...plainRuns(q.question), ...blockRuns(q.details ?? []), ...q.options.flatMap((o) => [...plainRuns(o.label), ...plainRuns(o.description)])];
  return [
    ...(blocksText(q.context).join("").trim() === "" ? [{ kind: "blankContext" as const, subject: "" }] : []),
    ...(/\?["'”’)\]]*$/u.test(piecesText(q.question).trim()) ? [] : [{ kind: "notLast" as const, subject: "" }]),
    ...[...new Set(pieces.filter((p) => p.ref !== "" && !ids.includes(p.ref)).map((p) => p.ref))].map((subject) => ({ kind: "unknownRef" as const, subject })),
    ...pieces.filter((p) => p.ref !== "" && p.text.trim() === "").map((p) => ({ kind: "blankTermPiece" as const, subject: p.ref })),
    ...refsBeyondSupplied(q, supplied).map((p) => ({ kind: "refOnCode" as const, subject: p.text })),
    // W3-R1-1: a code span shows a line break as a space; a value of several lines is a code block.
    ...pieces.filter((p) => p.code && /[\r\n]/u.test(p.text)).map((p) => ({ kind: "multiLineCode" as const, subject: p.text })),
    // W5-R1-1: two code spans side by side are read as one span holding their backticks.
    ...sequencesOf(q).flatMap(adjacentCodes).map((p) => ({ kind: "adjacentCode" as const, subject: p.text })),
    ...q.explanations.flatMap((e, i): QuestionProblem[] => [
      ...(ids.indexOf(e.id) < i ? [{ kind: "duplicateExplanation" as const, subject: e.id }] : []),
      ...(e.term.trim() === "" ? [{ kind: "blankTerm" as const, subject: e.id }] : []),
      ...senseProblems(e),
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
  explanations: readonly ShownExplanation[];
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
