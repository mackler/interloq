// The page's layout state at compact widths (finding 7 of docs/gui-review.md, decision Q3), pure. Below M3's expanded
// breakpoint only one of the two panels is shown: the dashboard (issue #22), "You and Interloq", or the right panel,
// "Claude and Codex". The dashboard has no message list, so only the right panel's new messages are counted for its
// badge, and a new prompt selects the dashboard's column, where the prompt is answered.

import { type DraftKey, sameKey } from "./draft.ts";

export type Pane = "dashboard" | "right";
/** `unseen` and `count` are the right panel's: its messages not seen while hidden, and its count last observed. */
export type Layout = Readonly<{ selected: Pane; unseen: number; count: number; prompt: DraftKey | null }>;
/**
 * What the layout observes of the view: the right panel's message count and the pending prompt, by its full key
 * (incarnation, run, prompt), since prompt numbers restart with each run and each start of the server (W2-R1-1).
 */
export type Observed = Readonly<{ right: number; prompt: DraftKey | null }>;

/** M3's expanded window class begins at 840 dp. */
export const EXPANDED_MIN_WIDTH = 840;

export const initialLayout: Layout = { selected: "dashboard", unseen: 0, count: 0, prompt: null };

/** The layout after the view changed; `compact` when the window is narrower than the expanded class. */
export const observe = (layout: Layout, observed: Observed, compact: boolean): Layout => {
  const newPrompt = observed.prompt !== null && (layout.prompt === null || !sameKey(observed.prompt, layout.prompt));
  const selected: Pane = newPrompt ? "dashboard" : layout.selected;
  // Fewer messages than before belong to a new run: the count starts again.
  const unseen = !compact || selected === "right" || observed.right < layout.count ? 0 : layout.unseen + (observed.right - layout.count);
  return { selected, unseen, count: observed.right, prompt: observed.prompt };
};

/** The user selects a panel; selecting the right panel clears its unseen count. */
export const select = (layout: Layout, pane: Pane): Layout => ({ ...layout, selected: pane, unseen: pane === "right" ? 0 : layout.unseen });

/**
 * A decision's analysis as the page names it (W2-R1-3): decision numbers restart with each run and each start of the
 * server, so the conversation shown instead of an analysis is kept for this key alone.
 */
export type AnalysisKey = Readonly<{ incarnation: string; run: number; decision: number }>;
/** Whether the analysis of `key` is shown: always, unless the user chose the conversation for exactly that decision. */
export const analysisShown = (hidden: AnalysisKey | null, key: AnalysisKey): boolean =>
  hidden === null || hidden.incarnation !== key.incarnation || hidden.run !== key.run || hidden.decision !== key.decision;

/**
 * The lowest window, in CSS pixels, in which the question and its first answer stay in view without the run scrolling:
 * the developer's decision of 9 Oct 2026 at the stop of execution phase 1 of issue #120, when the tabs took 48 px of
 * the window. The one source of the number, which the layout tests import. Issue #133 removed the decision page's
 * yielding (Room, roomOf, allot and the rest), which the order of that page, the question and its choices at its top,
 * makes unnecessary; the limit stays while the layout tests of the question page use it.
 */
export const IN_VIEW_MIN_HEIGHT = 450;

// ---- the decision page's opened heading and the columns' floor (issue #133, decision G-R1-1, W1-R1-1; the developer's
// decision of 12 Oct 2026, "Every control stays, windows scroll") ---------------------------------------------------------

/** The heights the opened text and the columns' region take, in whole pixels. */
export type OpenedHeights = Readonly<{ text: number; columns: number }>;

/** The columns' region is never lower than 15rem, ten lines of 1.5rem. */
export const COLUMNS_FLOOR_REM = 15;
/** The floor in whole pixels, from the root element's font size; 16 px, the browser's default, where that is no finite positive number. */
export const floorPx = (rootFontSizePx: number): number =>
  Math.ceil(COLUMNS_FLOOR_REM * (Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? rootFontSizePx : 16));
/**
 * What the allotment beside a floor is computed from: `available`, the height the visible run area leaves for the columns'
 * region and an opened text together (0 or negative in a low window); `floor`, `floorPx` of the root font size; `content`,
 * the opened text's full height, 0 when nothing is open. Below 390 px there are no columns (`Alone`).
 */
export type FloorInput = Readonly<{ _tag: "BesideColumns" | "Alone"; available: number; floor: number; content: number }>;
/**
 * The heights of an opened text and the columns' region, in whole pixels. Beside the columns, where the room suffices
 * (`available - floor` at least the text's floor), the two fill it exactly and nothing scrolls, the text taking at most
 * half; where it does not, the columns keep the floor and the text at least five lines (half the floor), and the run
 * scrolls. Alone, the text takes up to the larger of the room and the floor.
 */
export const allotWithFloor = (input: FloorInput): OpenedHeights => {
  const a = Math.max(0, Math.floor(input.available));
  const c = Math.max(0, Math.ceil(input.content));
  const f = Math.max(1, Math.ceil(input.floor));
  if (input._tag === "Alone") return { text: Math.min(c, Math.max(a, f)), columns: 0 };
  const text = Math.min(c, Math.max(Math.ceil(f / 2), Math.min(Math.floor(a / 2), a - f)));
  return { text, columns: Math.max(f, a - text) };
};
