// The widths of the run's columns in the wide layout (issue #204): the progress rail's width and the split between the
// two panels, dragged by their separators or moved by the keyboard. Pure: App measures the run area and the root font
// size and hands them in; web/src/storage.ts remembers the widths per browser.
import { type Brand, Result } from "effect";

export const RAIL_MIN_REM = 14;
export const RAIL_MAX_REM = 28;
export const PANEL_MIN_REM = 20;
export const LEFT_PERCENT_MIN = 20;
export const LEFT_PERCENT_MAX = 80;
export const DEFAULT_LEFT_PERCENT = 50;
export const TRACK_REM = 0.75;
export const RUN_PADDING_REM = 0.75;

/** The rail's width in rem, a whole number within [RAIL_MIN_REM, RAIL_MAX_REM]. */
export type RailRem = Brand.Branded<number, "RailRem">;
export const railRemOf = (n: number): Result.Result<RailRem, number> =>
  Number.isInteger(n) && n >= RAIL_MIN_REM && n <= RAIL_MAX_REM ? Result.succeed(n as RailRem) : Result.fail(n);
/** The left panel's share of the two panels' width, a whole percent within [LEFT_PERCENT_MIN, LEFT_PERCENT_MAX]. */
export type LeftPercent = Brand.Branded<number, "LeftPercent">;
export const leftPercentOf = (n: number): Result.Result<LeftPercent, number> =>
  Number.isInteger(n) && n >= LEFT_PERCENT_MIN && n <= LEFT_PERCENT_MAX ? Result.succeed(n as LeftPercent) : Result.fail(n);

/** The widths the developer chose, as stored; what is shown is each clamped to the bounds the window allows. */
export type ColumnWidths = Readonly<{ rail: RailRem; left: LeftPercent }>;
export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { rail: RAIL_MIN_REM as RailRem, left: DEFAULT_LEFT_PERCENT as LeftPercent };
export type Bounds = Readonly<{ min: number; max: number }>;

/** The width the three columns share: the run area's client width less its padding and the two separators' tracks. */
export const columnsPxOf = (runClientWidth: number, rootPx: number): number => runClientWidth - 2 * RUN_PADDING_REM * rootPx - 2 * TRACK_REM * rootPx;

/** The rail's bounds: from today's width to the most that leaves both panels PANEL_MIN_REM; the domain unmeasured. */
export const railBounds = (columnsPx: number | null, rootPx: number): Bounds =>
  columnsPx === null
    ? { min: RAIL_MIN_REM, max: RAIL_MAX_REM }
    : { min: RAIL_MIN_REM, max: Math.min(RAIL_MAX_REM, Math.max(RAIL_MIN_REM, Math.floor((columnsPx - 2 * PANEL_MIN_REM * rootPx) / rootPx))) };

/** The split's bounds: neither panel below PANEL_MIN_REM; an even split where the panels have no room for that. */
export const leftBounds = (panelsPx: number | null, rootPx: number): Bounds => {
  if (panelsPx === null) return { min: LEFT_PERCENT_MIN, max: LEFT_PERCENT_MAX };
  if (!(panelsPx > 0)) return { min: DEFAULT_LEFT_PERCENT, max: DEFAULT_LEFT_PERCENT };
  const need = Math.ceil(((PANEL_MIN_REM * rootPx) / panelsPx) * 100);
  const min = Math.max(LEFT_PERCENT_MIN, need);
  const max = Math.min(LEFT_PERCENT_MAX, 100 - need);
  return min > max ? { min: DEFAULT_LEFT_PERCENT, max: DEFAULT_LEFT_PERCENT } : { min, max };
};

/** The value drawn: the stored one clamped to the bounds; the stored value is not rewritten. */
export const shown = (value: number, bounds: Bounds): number => Math.min(Math.max(value, bounds.min), bounds.max);

/** The value after a key on a vertical separator, or null for a key it does not take. */
export const afterKey = (value: number, key: string, bounds: Bounds): number | null => {
  switch (key) {
    case "ArrowRight":
      return shown(value + 1, bounds);
    case "ArrowLeft":
      return shown(value - 1, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
};

/** The value during a drag that began at `startX` with `start`, the pointer now at `x`: right makes it larger. */
export const afterDrag = (start: number, startX: number, x: number, unitPx: number, bounds: Bounds): number => shown(start + Math.round((x - startX) / unitPx), bounds);

/** The run's five tracks: the rail, a separator, the left panel, a separator, the right panel. */
export const gridColumns = (railRem: number, leftPercent: number): string =>
  `${railRem}rem ${TRACK_REM}rem minmax(0, ${leftPercent}fr) ${TRACK_REM}rem minmax(0, ${100 - leftPercent}fr)`;
