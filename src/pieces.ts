// A question's text as pieces and blocks (issue #36, rewritten 30 Sep 2026; decisions Q1, Q2, F1): the pure functions
// over them. Nothing here reads Markdown to find anything: the agent chooses the pieces, and the block structure is data.
// Pure; also imported by the browser. prompts.ts never imports this module (it builds its pieces as literals), so that
// the display of a literal value (exactCodeSpan, codeFence) can be shared from there without an import cycle.

import { codeFence, exactCodeSpan } from "./prompts.ts";
import type { Block, Explanation, Piece, PieceOption } from "./schema.ts";

export type { Block, Explanation, Piece, PieceOption };

/**
 * A block as the program shows it: an agent's block, or the program's own `document`, Markdown shown whole and never
 * divided (a message of Claude Code that is a question's context, the summary to confirm; S7). Never part of an agent
 * schema.
 */
export type ShownBlock = Block | Readonly<{ kind: "document"; markdown: string }>;

/** A plain piece of the program's own words; none for the empty text. */
export const plainPieces = (text: string): readonly Piece[] => (text === "" ? [] : [{ text, ref: "", code: false }]);
/** A literal value as one code piece: shown exactly, never formatted, referring to nothing. */
export const codePiece = (text: string): Piece => ({ text, ref: "", code: true });
/** The program's own paragraphs as blocks, one paragraph per non-empty text, in order. */
export const plainBlocks = (...paragraphs: readonly string[]): readonly Block[] =>
  paragraphs.filter((p) => p.trim() !== "").map((p) => ({ kind: "paragraph", pieces: plainPieces(p) }));
/** An option of the program's own words. */
export const plainOption = (label: string, description: string): PieceOption => ({ label: plainPieces(label), description: plainPieces(description) });

/** The words of a sequence of pieces, joined. */
export const piecesText = (pieces: readonly Piece[]): string => pieces.map((p) => p.text).join("");
/**
 * The words of each block, in order: a paragraph's words, each list item's words (with its level), a code block's text;
 * a document's Markdown.
 */
export const blocksText = (blocks: readonly ShownBlock[]): readonly string[] =>
  blocks.flatMap((b) => (b.kind === "paragraph" ? [piecesText(b.pieces)] : b.kind === "list" ? b.items.map((i) => piecesText(i.pieces)) : b.kind === "code" ? [b.text] : [b.markdown]));

/** The shape and the words of blocks, compared: kinds, list levels and joined words (decision Q1). */
const blockShape = (b: ShownBlock): string =>
  JSON.stringify(b.kind === "paragraph" ? ["p", piecesText(b.pieces)] : b.kind === "list" ? ["l", b.items.map((i) => [i.level, piecesText(i.pieces)])] : b.kind === "code" ? ["c", b.text] : ["d", b.markdown]);
/** Whether two sequences of blocks have the same kinds, list levels and words, however their pieces are divided. */
export const sameBlocks = (a: readonly ShownBlock[], b: readonly ShownBlock[]): boolean => a.length === b.length && a.every((x, i) => blockShape(x) === blockShape(b[i]));
/** Whether two sequences of pieces have the same words, however they are divided. */
export const samePieces = (a: readonly Piece[], b: readonly Piece[]): boolean => piecesText(a) === piecesText(b);

/** The pieces of a sequence of blocks, in order (a code block and a document have none). */
export const blockPieces = (blocks: readonly ShownBlock[]): readonly Piece[] =>
  blocks.flatMap((b) => (b.kind === "paragraph" ? b.pieces : b.kind === "list" ? b.items.flatMap((i) => i.pieces) : []));
/**
 * The literal values of blocks, in order (decision F1): every code block's text and every code piece's text, whether or
 * not it refers to an explanation (the name of a setting the program explains keeps its ref, which is checked apart).
 */
export const literalsOf = (blocks: readonly ShownBlock[]): readonly string[] =>
  blocks.flatMap((b) => (b.kind === "code" ? [b.text] : b.kind === "document" ? [] : blockPieces([b]).filter((p) => p.code).map((p) => p.text)));
/**
 * A list's items with levels Markdown can express (W1-R1-3): the first at 0, each at least 0 and at most one more than
 * the previous item's. The schema's level is an unbounded integer; this keeps every rendering total.
 */
export const normalizedLevels = <T extends Readonly<{ level: number }>>(items: readonly T[]): readonly T[] =>
  items.reduce<T[]>((acc, item, i) => {
    const max = i === 0 ? 0 : acc[i - 1].level + 1;
    const level = Number.isFinite(item.level) ? Math.min(max, Math.max(0, Math.trunc(item.level))) : 0;
    return [...acc, { ...item, level }];
  }, []);
/** Every ref of the pieces, in order, with repetitions. */
export const refsOf = (pieces: readonly Piece[]): readonly string[] => pieces.filter((p) => p.ref !== "").map((p) => p.ref);

// ---- Markdown for the records and the terminal -------------------------------------------------------------------

/**
 * Pieces as inline Markdown: a plain piece as written, a code piece as a code span of exactly its text (S45; the program
 * escapes a value before it becomes a piece, S48), a piece that refers to an explanation as its words.
 */
export const piecesMarkdown = (pieces: readonly Piece[]): string => pieces.map((p) => (p.code ? exactCodeSpan(p.text) : p.text)).join("");
/** A code block as a fenced block of exactly its text (S45). */
const codeBlockMarkdown = (text: string): string => {
  const fence = codeFence(text);
  return `${fence}\n${text}\n${fence}`;
};
/** Blocks as Markdown, separated by blank lines: paragraphs, lists (two spaces per level), fenced code, documents whole. */
export const blocksMarkdown = (blocks: readonly ShownBlock[]): string =>
  blocks
    .map((b) =>
      b.kind === "paragraph"
        ? piecesMarkdown(b.pieces)
        : b.kind === "list"
          ? normalizedLevels(b.items).map((i) => `${"  ".repeat(i.level)}- ${piecesMarkdown(i.pieces)}`).join("\n")
          : b.kind === "code"
            ? codeBlockMarkdown(b.text)
            : b.markdown.trim(),
    )
    .filter((t) => t.trim() !== "")
    .join("\n\n");
