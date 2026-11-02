// The page's remembered preferences (finding 3 of docs/gui-review.md): an edge over the browser's storage. Acquiring
// the storage, reading and writing may each throw (a SecurityError, a full quota, storage disabled); every such failure
// is a typed result. Issue #120 removed the remembered project directory: the project is the server's directory.

import { defaultPreferences, type Preferences, type Toggle } from "./notify.ts";
import { DEFAULT_PANEL_LINES, type PanelLines, panelLinesOf } from "./panelHeight.ts";
import { Result } from "effect";
import { type ColumnWidths, DEFAULT_COLUMN_WIDTHS, leftPercentOf, railRemOf } from "./columnWidths.ts";

/** The part of the browser's Storage this module uses. */
export type StorageLike = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
/** How the storage is acquired: the getter of `localStorage` itself may throw, so it runs inside the guard. */
export type AcquireStorage = () => StorageLike | undefined;
export type Stored<A> = { ok: true; value: A } | { ok: false };

/** Issue #16: the alert preferences. */
const ALERTS_KEY = "interloq.alerts";
export const browserStorage: AcquireStorage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The alert preferences (issue #16); defaults where nothing or something unreadable is stored. */
export const readPreferences = (acquire: AcquireStorage = browserStorage): Stored<Preferences> => guarded(acquire, (s) => decodePreferences(s.getItem(ALERTS_KEY)));
/** Remembers the alert preferences; `{ ok: false }` when they could not be remembered. */
export const writePreferences = (preferences: Preferences, acquire: AcquireStorage = browserStorage): Stored<void> =>
  guarded(acquire, (s) => s.setItem(ALERTS_KEY, JSON.stringify(preferences)));

const isToggle = (v: unknown): v is Toggle => v === "on" || v === "off";
/** The stored text as preferences: total, the defaults for nothing stored and for anything not of their shape. */
const decodePreferences = (text: string | null): Preferences => {
  if (text === null) return defaultPreferences;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultPreferences;
    const { desktop, sound } = value as Record<string, unknown>;
    return isToggle(desktop) && isToggle(sound) ? { desktop, sound } : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
};

/** The one place where the storage's exceptions are caught and become a typed failure. */
const guarded = <A>(acquire: AcquireStorage, use: (storage: StorageLike) => A): Stored<A> => {
  try {
    const storage = acquire();
    return storage === undefined ? { ok: false } : { ok: true, value: use(storage) };
  } catch {
    return { ok: false };
  }
};

/** Issue #221: the live panel's dragged height, per browser. */
const PANEL_KEY = "interloq.livePanel";
/** The full live panel's remembered height; the default where nothing or something unreadable is stored. */
export const readPanelLines = (acquire: AcquireStorage = browserStorage): Stored<PanelLines> => guarded(acquire, (s) => decodePanelLines(s.getItem(PANEL_KEY)));
/** Remembers the full live panel's height; `{ ok: false }` when it could not be remembered. */
export const writePanelLines = (lines: PanelLines, acquire: AcquireStorage = browserStorage): Stored<void> =>
  guarded(acquire, (s) => s.setItem(PANEL_KEY, JSON.stringify({ lines })));

const decodePanelLines = (text: string | null): PanelLines => {
  if (text === null) return DEFAULT_PANEL_LINES;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_PANEL_LINES;
    const { lines } = value as Record<string, unknown>;
    return typeof lines === "number" ? Result.getOrElse(panelLinesOf(lines), () => DEFAULT_PANEL_LINES) : DEFAULT_PANEL_LINES;
  } catch {
    return DEFAULT_PANEL_LINES;
  }
};

// Issue #204: the run's column widths, remembered per browser as the live panel's height is.
const COLUMNS_KEY = "interloq.columns";
/** The run's remembered column widths; each field its default where it is missing or unreadable. */
export const readColumnWidths = (acquire: AcquireStorage = browserStorage): Stored<ColumnWidths> => guarded(acquire, (s) => decodeColumnWidths(s.getItem(COLUMNS_KEY)));
/** Remembers the run's column widths; `{ ok: false }` when they could not be remembered. */
export const writeColumnWidths = (widths: ColumnWidths, acquire: AcquireStorage = browserStorage): Stored<void> =>
  guarded(acquire, (s) => s.setItem(COLUMNS_KEY, JSON.stringify({ rail: widths.rail, left: widths.left })));

/** Total: nothing stored, unparsable text and a non-object give the defaults; each field decodes on its own. */
const decodeColumnWidths = (text: string | null): ColumnWidths => {
  if (text === null) return DEFAULT_COLUMN_WIDTHS;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_COLUMN_WIDTHS;
    const { rail, left } = value as Record<string, unknown>;
    return {
      rail: typeof rail === "number" ? Result.getOrElse(railRemOf(rail), () => DEFAULT_COLUMN_WIDTHS.rail) : DEFAULT_COLUMN_WIDTHS.rail,
      left: typeof left === "number" ? Result.getOrElse(leftPercentOf(left), () => DEFAULT_COLUMN_WIDTHS.left) : DEFAULT_COLUMN_WIDTHS.left,
    };
  } catch {
    return DEFAULT_COLUMN_WIDTHS;
  }
};
