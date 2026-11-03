// A picture of what an option of a question produces (pure, also imported by the browser; issue #98).
//
// The checks here are coarse, and they are not the sanitizing. They refuse a blank alternative text, markup over
// FIGURE_SVG_LIMIT_BYTES of UTF-8, and markup whose root element is not `svg`. They parse no XML, and they find
// neither a script nor a reference to anything outside the image: an agent's markup that passes them may still carry
// both. The page sanitizes every figure against the explicit allow-list of web/src/figure.ts before it is shown, and
// conversation.md reaches a figure only through an image link to its file, which a viewer draws as an image that runs
// no script.
import { Result, Schema } from "effect";
import type { FigureReply } from "./schema.ts";
import { FigureReply as FigureReplySchema } from "./schema.ts";
import { sha256Hex } from "./sha256.ts";

/** The most UTF-8 bytes of one figure's markup: 64 KiB (the requirements' default). */
export const FIGURE_SVG_LIMIT_BYTES = 65_536;

/** Why a reply is not a figure. */
export type FigureProblem =
  | Readonly<{ kind: "altBlank" }>
  | Readonly<{ kind: "tooLarge"; bytes: number }>
  | Readonly<{ kind: "notSvg" }>;

/** Markup that opens with an svg element, after whitespace and an optional XML declaration, and closes it last. */
export const SVG_ROOT_PATTERN = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>][\s\S]*<\/svg>\s*$/u;

/** The UTF-8 length of a text, which is what the limit means. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Everything wrong with a reply as a figure, in the order: alt text, size, root element. */
export const figureProblems = (reply: FigureReply): readonly FigureProblem[] => {
  const bytes = utf8Bytes(reply.svg);
  return [
    ...(reply.alt.trim() === "" ? [{ kind: "altBlank" } as const] : []),
    ...(bytes > FIGURE_SVG_LIMIT_BYTES ? [{ kind: "tooLarge", bytes } as const] : []),
    ...(SVG_ROOT_PATTERN.test(reply.svg) ? [] : [{ kind: "notSvg" } as const]),
  ];
};

/**
 * A figure as the protocol decodes it, and as a presented question holds it: a reply that figureProblems accepts,
 * branded so that no unchecked reply is taken for one.
 */
export const FigureSchema = FigureReplySchema.check(Schema.makeFilter((f) => figureProblems(f).length === 0)).pipe(Schema.brand("Figure"));
/** A figure whose alt text is not blank, whose markup is within the limit and has an svg root. */
export type Figure = typeof FigureSchema.Type;

/** The one constructor of a figure. */
export const figureOf = (reply: FigureReply): Result.Result<Figure, readonly FigureProblem[]> => {
  const problems = figureProblems(reply);
  return problems.length === 0 ? Result.succeed(reply as Figure) : Result.fail(problems);
};

/** Whether two options carry the same picture: both none, or the same markup and alt text. */
export const sameFigure = (a: FigureReply | null, b: FigureReply | null): boolean =>
  a === null || b === null ? a === b : a.svg === b.svg && a.alt === b.alt;

/** The figure's file in the run's records directory, named by the hash of its markup (decision G-R1-1). */
export const figureFileOf = (figure: Figure | FigureReply): string => `figures/${sha256Hex(figure.svg)}.svg`;
