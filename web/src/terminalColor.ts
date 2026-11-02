// Issue #221: the colors a process's output carries, as SGR sequences, turned into colored runs for the live panel.
// Pure, the browser's alone. Only color is kept: every other SGR code (bold, underline, inverse) is ignored, and the
// sanitizer of src/liveOutput.ts has already removed every other escape. A style holds integers only, so nothing a
// process prints can become markup or CSS.

/** A color, each component an integer 0–255; built only inside this module. */
export type Rgb = Readonly<{ r: number; g: number; b: number }>;
/** A run's colors; null is the panel's default. */
export type TermStyle = Readonly<{ fg: Rgb | null; bg: Rgb | null }>;
export const DEFAULT_STYLE: TermStyle = { fg: null, bg: null };
/** A piece of a line in one style. */
export type StyledRun = Readonly<{ text: string; style: TermStyle }>;

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });
const hex = (h: string): Rgb => rgb(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

/** The panel's text, background and the dim color of its tags. */
export const TERMINAL_FOREGROUND: Rgb = rgb(74, 246, 38);
export const TERMINAL_BACKGROUND: Rgb = rgb(0, 0, 0);
export const TERMINAL_DIM: Rgb = rgb(150, 150, 150);

/** The 16 standard and bright colors, chosen to read on black; black itself is a dark grey, so it stays visible. */
export const PALETTE_16: readonly Rgb[] = [
  "#4c4c4c", "#e05561", "#8cc265", "#d18f52", "#4aa5f0", "#c162de", "#42b3c2", "#d7dae0",
  "#808080", "#ff616e", "#a5e075", "#f0a45d", "#4dc4ff", "#de73ff", "#4cd1e0", "#ffffff",
].map(hex);

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const level = (n: number): number => CUBE_LEVELS[n] ?? 0;

/** A color of the 256-color table, as xterm has it: the 16 colors, the 6×6×6 cube, then 24 greys. */
const color256 = (n: number): Rgb => {
  if (n < 16) return PALETTE_16[n] ?? TERMINAL_FOREGROUND;
  if (n < 232) {
    const c = n - 16;
    return rgb(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
  }
  const grey = 8 + 10 * (n - 232);
  return rgb(grey, grey, grey);
};

const byte = (s: string | undefined): number | null => (s !== undefined && /^\d{1,3}$/u.test(s) && Number(s) <= 255 ? Number(s) : null);

/** An extended color's fields after 38 or 48: the color, or null where it is missing or out of range, and the fields read. */
const extended = (fields: readonly string[], colon: boolean): readonly [Rgb | null, number] => {
  if (fields[0] === "5") {
    const n = byte(fields[1]);
    return [n === null ? null : color256(n), 2];
  }
  if (fields[0] === "2") {
    // The colon form may carry a color-space field before the components: 38:2:<colorspace>:r:g:b.
    const at = colon && fields.length >= 5 ? 2 : 1;
    const [r, g, b] = [byte(fields[at]), byte(fields[at + 1]), byte(fields[at + 2])];
    return [r === null || g === null || b === null ? null : rgb(r, g, b), at + 3];
  }
  return [null, 1];
};

const codeOf = (s: string): number | null => (s === "" ? 0 : /^\d+$/u.test(s) ? Number(s) : null);

const withCode = (style: TermStyle, code: number): TermStyle => {
  if (code === 0) return DEFAULT_STYLE;
  if (code === 39) return { ...style, fg: null };
  if (code === 49) return { ...style, bg: null };
  if (code >= 30 && code <= 37) return { ...style, fg: color256(code - 30) };
  if (code >= 90 && code <= 97) return { ...style, fg: color256(code - 90 + 8) };
  if (code >= 40 && code <= 47) return { ...style, bg: color256(code - 40) };
  if (code >= 100 && code <= 107) return { ...style, bg: color256(code - 100 + 8) };
  return style;
};

const withExtended = (style: TermStyle, code: number, color: Rgb | null): TermStyle =>
  color === null ? style : code === 38 ? { ...style, fg: color } : { ...style, bg: color };

/** The style after one SGR sequence's parameters (`31`, `38;5;196`, `48:2::1:2:3`, `` for a reset). */
/**
 * A `;`-separated group as the codes it holds: a colon group headed by 38 or 48 kept whole, an extended color; any other
 * colon group split into its fields, each its own code, as if its colons were semicolons (W1-R1-1).
 */
const colonGroup = (group: string): readonly string[] => {
  if (!group.includes(":")) return [group];
  const fields = group.split(":");
  const code = codeOf(fields[0] ?? "");
  return code === 38 || code === 48 ? [group] : fields;
};

export const applySgr = (style: TermStyle, params: string): TermStyle => {
  const groups = params.split(";").flatMap(colonGroup);
  let s = style;
  let i = 0;
  while (i < groups.length) {
    const group = groups[i] ?? "";
    if (group.includes(":")) {
      const [head = "", ...rest] = group.split(":");
      const code = codeOf(head);
      if (code === 38 || code === 48) s = withExtended(s, code, extended(rest, true)[0]);
      i += 1;
      continue;
    }
    const code = codeOf(group);
    if (code === 38 || code === 48) {
      const [color, read] = extended(groups.slice(i + 1), false);
      s = withExtended(s, code, color);
      i += 1 + read;
    } else {
      if (code !== null) s = withCode(s, code);
      i += 1;
    }
  }
  return s;
};

const sameStyle = (a: TermStyle, b: TermStyle): boolean => sameRgb(a.fg, b.fg) && sameRgb(a.bg, b.bg);
const sameRgb = (a: Rgb | null, b: Rgb | null): boolean => (a === null || b === null ? a === b : a.r === b.r && a.g === b.g && a.b === b.b);

/**
 * A text in colored runs, from the style before it: split at every SGR sequence, equal runs merged, empty runs and any
 * stray ESC dropped; with the style after it. It keeps no partial-escape state, since the sanitizer emits every SGR
 * sequence whole and the panel splits a process's text only at line breaks, which no SGR sequence contains.
 */
export const styleText = (style: TermStyle, text: string): readonly [TermStyle, readonly StyledRun[]] => {
  const parts = text.split(/\u001b\[([0-9;:]*)m/u);
  const runs: StyledRun[] = [];
  let s = style;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      s = applySgr(s, part);
      return;
    }
    const plain = part.replaceAll("\u001b", "");
    if (plain === "") return;
    const last = runs.at(-1);
    if (last !== undefined && sameStyle(last.style, s)) runs[runs.length - 1] = { text: last.text + plain, style: last.style };
    else runs.push({ text: plain, style: s });
  });
  return [s, runs];
};

export const cssColor = (c: Rgb): string => `rgb(${c.r}, ${c.g}, ${c.b})`;
