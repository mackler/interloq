// The live panel's height in lines (issue #221), dragged by its handle or moved by the keyboard. Pure: the component
// measures the room and the root font size and hands them in; web/src/storage.ts remembers the height per browser.
import { type Brand, Result } from "effect";
import { PANEL_LINES } from "./livePanel.ts";

export const MIN_PANEL_LINES = 3;
export const MAX_PANEL_LINES = 60;
/** The height of one line of the panel's screen, in rem. */
export const LINE_REM = 1.125;
/** The room the content above the panel keeps at the least, in rem. */
export const ABOVE_MIN_REM = 4;

/** A height in lines, a whole number within the bounds. */
export type PanelLines = Brand.Branded<number, "PanelLines">;
export const panelLinesOf = (n: number): Result.Result<PanelLines, number> =>
  Number.isInteger(n) && n >= MIN_PANEL_LINES && n <= MAX_PANEL_LINES ? Result.succeed(n as PanelLines) : Result.fail(n);
/** The full panel's height before the developer drags it. */
export const DEFAULT_PANEL_LINES: PanelLines = Result.getOrElse(panelLinesOf(PANEL_LINES), () => MIN_PANEL_LINES as PanelLines);

const clamp = (n: number, max: number): number => Math.min(Math.max(n, MIN_PANEL_LINES), Math.max(MIN_PANEL_LINES, Math.min(max, MAX_PANEL_LINES)));

/** The root font size in pixels from its computed text, 16 where that is no finite positive number. */
const rootPxOf = (text: string): number => {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : 16;
};
/** One line's height in pixels. */
export const linePx = (rootFontSizeText: string): number => LINE_REM * rootPxOf(rootFontSizeText);

/**
 * The most lines the panel may take: what the dashboard section's content height leaves after the panel's own chrome
 * (its handle, header, gaps and the screen's padding) and the content above's minimum, within the bounds; the maximum
 * where the room is not yet measured.
 */
export const maxPanelLines = (available: number | null, chromePx: number, rootPx: number): number =>
  available === null || available === 0 ? MAX_PANEL_LINES : clamp(Math.floor((available - chromePx - ABOVE_MIN_REM * rootPx) / (LINE_REM * rootPx)), MAX_PANEL_LINES);

/** The lines shown: the stored height, never past the room; the stored value is not rewritten. */
export const shownLines = (stored: number, max: number): number => Math.min(stored, max);

/** The height after a key on the handle, or null for a key the handle does not take. */
export const afterKey = (lines: number, key: string, max: number): number | null => {
  switch (key) {
    case "ArrowUp":
      return clamp(lines + 1, max);
    case "ArrowDown":
      return clamp(lines - 1, max);
    case "Home":
      return MIN_PANEL_LINES;
    case "End":
      return clamp(max, max);
    default:
      return null;
  }
};

/** The height during a drag that began at `startY` with `startLines`, the pointer now at `y`: up makes it taller. */
export const afterDrag = (startLines: number, startY: number, y: number, line: number, max: number): number => clamp(startLines + Math.round((startY - y) / line), max);
