// The `Refined using Interloq` section of an item's body (issue #120, part 1), as a value: written and read by pure
// functions, so that what is written is what is read. The text the developer wrote is never changed: not one
// character of it, trailing spaces, blank lines and line endings included.
//
// The section is the opening line, the refinement, and the closing line. The closing line is there because the
// developer may add text below the section later, which must survive a rewrite, and the refinement may hold headings
// of its own. Visible Markdown lines rather than HTML comments, since Trello's descriptions do not hide comments.
// Appended to a non-empty body, the section is preceded by SEPARATOR, which belongs to it: removing the section
// removes the separator and gives the body back exactly.
import { type Brand, Option, Result } from "effect";
import { LINE_BREAK } from "./pieces.ts";

export const OPENING_LINE = "## Refined using Interloq";
export const CLOSING_LINE = "_End of the section Refined using Interloq._";
/** What stands between a non-empty body and the section's opening line, so that the opening line begins a line. */
export const SEPARATOR = "\n\n";

/**
 * A refinement: a text that is not blank, holds neither marker line as a line, and does not end with a carriage
 * return (which would join the line break written before the closing line into one `\r\n`); built by refinementOf alone.
 */
export type Refinement = Brand.Branded<string, "Refinement">;
/** Why a text is not a refinement. */
export type InvalidRefinement = Readonly<{ _tag: "InvalidRefinement"; reason: "blank" | "markerLine" | "trailingCarriageReturn" }>;
/** Why a body's section cannot be read: an opening line without a closing line, the reverse, two sections, or an empty one. */
export type SectionMalformed = Readonly<{ _tag: "SectionMalformed"; reason: string }>;

const isMarker = (line: string): boolean => line === OPENING_LINE || line === CLOSING_LINE;

export const refinementOf = (text: string): Result.Result<Refinement, InvalidRefinement> => {
  if (text.trim() === "") return Result.fail({ _tag: "InvalidRefinement", reason: "blank" });
  if (text.split(LINE_BREAK).some((part, i) => i % 2 === 0 && isMarker(part))) return Result.fail({ _tag: "InvalidRefinement", reason: "markerLine" });
  if (text.endsWith("\r")) return Result.fail({ _tag: "InvalidRefinement", reason: "trailingCarriageReturn" });
  return Result.succeed(text as Refinement);
};

/** One line of a body: where its text starts and ends, and where its line ending ends. */
type Line = Readonly<{ text: string; start: number; end: number; next: number }>;
const linesOf = (body: string): readonly Line[] => {
  const parts = body.split(LINE_BREAK);
  const starts = parts.reduce<readonly number[]>((acc, p) => [...acc, acc[acc.length - 1] + p.length], [0]);
  return parts.flatMap((text, i): Line[] => (i % 2 === 0 ? [{ text, start: starts[i], end: starts[i + 1], next: i + 1 < parts.length ? starts[i + 2] : starts[i + 1] }] : []));
};

/** Where a body's section lies: `from` (with the separator before it, if present) and `to`, the closing line's end; `content` its refinement. */
type Span = Readonly<{ from: number; open: number; to: number; content: Refinement }>;
const malformed = (reason: string): Result.Result<never, SectionMalformed> => Result.fail({ _tag: "SectionMalformed", reason });

const sectionOf = (body: string): Result.Result<Option.Option<Span>, SectionMalformed> => {
  const lines = linesOf(body);
  const opens = lines.filter((l) => l.text === OPENING_LINE);
  const closes = lines.filter((l) => l.text === CLOSING_LINE);
  if (opens.length === 0 && closes.length === 0) return Result.succeed(Option.none());
  if (opens.length !== 1 || closes.length !== 1) return malformed(`${opens.length} opening and ${closes.length} closing lines of the section "${OPENING_LINE}"`);
  const [open, close] = [opens[0], closes[0]];
  if (close.start <= open.start) return malformed(`the closing line of the section "${OPENING_LINE}" comes before its opening line`);
  const before = lines[lines.indexOf(close) - 1];
  if (before === open) return malformed(`the section "${OPENING_LINE}" is empty`);
  const content = refinementOf(body.slice(open.next, before.end));
  if (Result.isFailure(content)) return malformed(`the section "${OPENING_LINE}" holds no refinement`);
  const from = body.slice(0, open.start).endsWith(SEPARATOR) ? open.start - SEPARATOR.length : open.start;
  return Result.succeed(Option.some({ from, open: open.start, to: close.end, content: content.success }));
};

const sectionText = (refinement: Refinement): string => `${OPENING_LINE}\n${refinement}\n${CLOSING_LINE}`;

/** The body with its section: appended after the body and SEPARATOR when it has none, else the section replaced, the separator kept as found. */
export const withRefinement = (body: string, refinement: Refinement): Result.Result<string, SectionMalformed> =>
  Result.map(sectionOf(body), (span) =>
    Option.match(span, {
      onNone: () => `${body}${body === "" ? "" : SEPARATOR}${sectionText(refinement)}`,
      onSome: (s) => `${body.slice(0, s.open)}${sectionText(refinement)}${body.slice(s.to)}`,
    }),
  );

/** The refinement the body's section holds; none when the body has no section. */
export const readRefinement = (body: string): Result.Result<Option.Option<Refinement>, SectionMalformed> => Result.map(sectionOf(body), Option.map((s) => s.content));

/** The body without its section and the separator before it: the developer's text alone. */
export const withoutRefinement = (body: string): Result.Result<string, SectionMalformed> =>
  Result.map(sectionOf(body), Option.match({ onNone: () => body, onSome: (s) => `${body.slice(0, s.from)}${body.slice(s.to)}` }));
