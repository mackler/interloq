// A question's text as pieces and blocks (issue #36, rewritten 30 Sep 2026; decisions Q1, Q2, F1): the pure functions
// over them. Nothing here reads Markdown to find anything: the agent chooses the pieces, and the block structure is data.
// Pure; also imported by the browser. prompts.ts never imports this module (it builds its pieces as literals), so that
// the display of a literal value (exactCodeSpan, codeFence) can be shared from there without an import cycle.

import { codeFence, exactCodeSpan, valuePhraseAt } from "./prompts.ts";
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
/** A block that may interrupt a list and then belongs to the item before it: a code block or a paragraph. */
export type Attached = Extract<Block, { kind: "code" | "paragraph" }>;
/** A list item of a run, with its normalized level and the blocks that interrupt the list after it. */
export type RunItem = Readonly<{ level: number; pieces: readonly Piece[]; attached: readonly Attached[] }>;
/** A block as it is laid out: a list is a whole run, its items carrying the blocks that interrupt it. */
export type LaidBlock = Exclude<ShownBlock, { kind: "list" }> | Readonly<{ kind: "list"; items: readonly RunItem[] }>;
const isAttached = (b: ShownBlock): b is Attached => b.kind === "code" || b.kind === "paragraph";
/**
 * Blocks laid out for display (W2-R1-1, P3-R1-1): every code block and paragraph that stands between two lists belongs to
 * the last item of the list before it, and the list after them continues that list, so that one run of lists is one list
 * whose levels are normalized as a whole (normalizedLevels): the continuing list's first item is at most one level deeper
 * than the item before the interruption, not forced to 0. A run ends at the first block after a list that no later list
 * follows; a document block always ends it.
 */
export const normalizedRuns = (blocks: readonly ShownBlock[]): readonly LaidBlock[] => {
  type State = Readonly<{ out: readonly LaidBlock[]; run: readonly RunItem[] | null; pending: readonly Attached[] }>;
  const flushed = (s: State): readonly LaidBlock[] => (s.run === null ? s.out : [...s.out, { kind: "list", items: normalizedLevels(s.run) }, ...s.pending]);
  const end = blocks.reduce<State>((s, b) => {
    if (b.kind === "list") {
      const items = b.items.map((it): RunItem => ({ level: it.level, pieces: it.pieces, attached: [] }));
      if (s.run === null || s.run.length === 0) return { out: flushed(s), run: items, pending: [] };
      const last = s.run[s.run.length - 1];
      return { out: s.out, run: [...s.run.slice(0, -1), { ...last, attached: [...last.attached, ...s.pending] }, ...items], pending: [] };
    }
    if (isAttached(b)) return s.run === null ? { ...s, out: [...s.out, b] } : { ...s, pending: [...s.pending, b] };
    return { out: [...flushed(s), b], run: null, pending: [] };
  }, { out: [], run: null, pending: [] });
  return flushed(end);
};
/**
 * A stretch of one sequence of pieces: a code piece on its own, with its ref, or the joined text of consecutive non-code
 * pieces (ref "").
 */
export type PieceRun = Readonly<{ code: boolean; text: string; ref: string }>;
/**
 * The runs of one sequence of pieces (a paragraph's, a list item's, a question's, a label's): each code piece is its own
 * run and separates the words on either side of it; consecutive non-code pieces, plain or referring to an explanation,
 * are joined into one run. A paragraph, list item or block boundary is the end of a sequence, so no run crosses it. The
 * one definition shared by the bare-number check (W1-R1-2) and the value phrases (W2-R1-2).
 */
export const pieceRuns = (pieces: readonly Piece[]): readonly PieceRun[] =>
  pieces.reduce<readonly PieceRun[]>((runs, p) => {
    const last = runs[runs.length - 1];
    if (p.code) return [...runs, { code: true, text: p.text, ref: p.ref }];
    return last !== undefined && !last.code ? [...runs.slice(0, -1), { code: false, text: `${last.text}${p.text}`, ref: "" }] : [...runs, { code: false, text: p.text, ref: "" }];
  }, []);
/** The joined texts of the non-code runs of one sequence of pieces, the empty ones left out (W1-R1-2). */
export const plainRuns = (pieces: readonly Piece[]): readonly string[] => pieceRuns(pieces).filter((r) => !r.code && r.text !== "").map((r) => r.text);
/**
 * A value of the details (W1-R1-1): a code block's text (`block`), a code piece's (`code`; W3-R1-1 keeps the two apart), or
 * a phrase in a plain piece that stands for one. `ref` is a code piece's ref, "" otherwise: compared by position, it keeps a
 * reference the program supplied on the occurrence it was supplied on (W4-R1-1).
 */
export type ValueToken = Readonly<{ kind: "block" | "code" | "phrase"; text: string; ref: string }>;
/** The value phrases of one plain text, left to right, the longest at each position (valuePhraseAt of src/prompts.ts). */
const phrasesIn = (text: string): readonly string[] => {
  const found: string[] = [];
  for (let i = 0; i < text.length; ) {
    const phrase = valuePhraseAt(text, i);
    if (phrase === null) i += 1;
    else {
      found.push(phrase);
      i += phrase.length;
    }
  }
  return found;
};
/**
 * Every value of blocks as one ordered sequence (W1-R1-1, decision F1): each code block as a block and each code piece as code (W3-R1-1), each value
 * phrase in a run of non-code pieces (pieceRuns; W2-R1-2) as a phrase, in document order. The kind keeps a code value and a phrase of the same words
 * apart; the one sequence keeps their order. Reads no Markdown: a phrase is one the program itself writes.
 */
export const valueTokensOf = (blocks: readonly ShownBlock[]): readonly ValueToken[] => {
  const ofPieces = (pieces: readonly Piece[]): readonly ValueToken[] =>
    pieceRuns(pieces).flatMap((r): readonly ValueToken[] => (r.code ? [{ kind: "code", text: r.text, ref: r.ref }] : phrasesIn(r.text).map((text) => ({ kind: "phrase", text, ref: "" }))));
  return blocks.flatMap((b): readonly ValueToken[] =>
    b.kind === "code" ? [{ kind: "block", text: b.text, ref: "" }] : b.kind === "document" ? [] : b.kind === "paragraph" ? ofPieces(b.pieces) : b.items.flatMap((i) => ofPieces(i.pieces)),
  );
};
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
/** Every line of a text indented by `n` spaces, blank lines left empty. */
const indented = (text: string, n: number): string => text.split("\n").map((l) => (l === "" ? l : `${" ".repeat(n)}${l}`)).join("\n");
/** A code block or a paragraph as Markdown. */
const attachedMarkdown = (b: Attached): string => (b.kind === "code" ? codeBlockMarkdown(b.text) : piecesMarkdown(b.pieces));
/**
 * Blocks as Markdown, separated by blank lines: paragraphs, lists (two spaces per level), fenced code, documents whole. A
 * block that interrupts a list (normalizedRuns) is indented to the content column of the item it belongs to, so that it
 * nests there, and the list continues at its levels (W2-R1-1, P3-R1-1).
 */
export const blocksMarkdown = (blocks: readonly ShownBlock[]): string =>
  normalizedRuns(blocks)
    .map((b) =>
      b.kind === "paragraph"
        ? piecesMarkdown(b.pieces)
        : b.kind === "list"
          ? b.items
              .map((i, n) => {
                const line = `${"  ".repeat(i.level)}- ${piecesMarkdown(i.pieces)}`;
                const inner = i.attached.map((a) => `\n\n${indented(attachedMarkdown(a), 2 * i.level + 2)}`).join("");
                const gap = n > 0 && b.items[n - 1].attached.length > 0 ? "\n\n" : n > 0 ? "\n" : "";
                return `${gap}${line}${inner}`;
              })
              .join("")
          : b.kind === "code"
            ? codeBlockMarkdown(b.text)
            : b.markdown.trim(),
    )
    .filter((t) => t.trim() !== "")
    .join("\n\n");
