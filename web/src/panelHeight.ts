// The live panel's height in lines (issue #221), dragged by its handle or moved by the keyboard. Pure: the component
// measures the room and the root font size and hands them in; web/src/storage.ts remembers the height per browser.
import { type Brand, Result } from "effect";
import { PANEL_LINES } from "./livePanel.ts";

export const MIN_PANEL_LINES = 3;
export const MAX_PANEL_LINES = 60;
/** The fewest lines the screen shows where the room allows fewer than MIN_PANEL_LINES. */
export const FLOOR_PANEL_LINES = 1;
/** The height of one line of the panel's screen, in rem. */
export const LINE_REM = 1.125;
/** The room the content above the panel keeps at the least, in rem. */
export const ABOVE_MIN_REM = 2;
/** Below this room, in rem, the panel's running list is bounded at one line. */
export const SHORT_COLUMN_REM = 20;

/** A height in lines, a whole number within the bounds. */
export type PanelLines = Brand.Branded<number, "PanelLines">;
export const panelLinesOf = (n: number): Result.Result<PanelLines, number> =>
  Number.isInteger(n) && n >= MIN_PANEL_LINES && n <= MAX_PANEL_LINES ? Result.succeed(n as PanelLines) : Result.fail(n);
/** The full panel's height before the developer drags it. */
export const DEFAULT_PANEL_LINES: PanelLines = Result.getOrElse(panelLinesOf(PANEL_LINES), () => MIN_PANEL_LINES as PanelLines);

/** The separator's minimum: MIN_PANEL_LINES, or the room's maximum where that is smaller. */
export const minPanelLines = (max: number): number => Math.min(MIN_PANEL_LINES, max);

/** A height within [minPanelLines(max), max], max itself within [FLOOR_PANEL_LINES, MAX_PANEL_LINES]. */
const clamp = (n: number, max: number): number => {
  const top = Math.max(FLOOR_PANEL_LINES, Math.min(max, MAX_PANEL_LINES));
  return Math.min(Math.max(n, minPanelLines(top)), top);
};

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
  available === null || available === 0
    ? MAX_PANEL_LINES
    : Math.min(Math.max(Math.floor((available - chromePx - ABOVE_MIN_REM * rootPx) / (LINE_REM * rootPx)), FLOOR_PANEL_LINES), MAX_PANEL_LINES);

/** How many lines the running list may take: one in a short column, three otherwise or where the room is unmeasured. */
export const runningListLines = (available: number | null, rootPx: number): 1 | 3 => (available === null || available >= SHORT_COLUMN_REM * rootPx ? 3 : 1);

/** The most height the full panel may take, the content above keeping its minimum; null where the room is unmeasured. */
export const panelBudgetPx = (available: number | null, rootPx: number): number | null => (available === null ? null : Math.max(0, available - ABOVE_MIN_REM * rootPx));

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
      return clamp(minPanelLines(max), max);
    case "End":
      return clamp(max, max);
    default:
      return null;
  }
};

/** The height during a drag that began at `startY` with `startLines`, the pointer now at `y`: up makes it taller. */
export const afterDrag = (startLines: number, startY: number, y: number, line: number, max: number): number => clamp(startLines + Math.round((startY - y) / line), max);
