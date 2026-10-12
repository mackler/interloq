// The page's layout state at compact widths (finding 7 of docs/gui-review.md, decision Q3), pure. Below M3's expanded
// breakpoint only one of the two panels is shown; the other's new messages are counted for its badge, and a new
// prompt selects "You and Interloq", where the prompt is answered.

import { type DraftKey, sameKey } from "./draft.ts";

export type Pane = "left" | "right";
export type Counts = Readonly<Record<Pane, number>>;
export type Layout = Readonly<{ selected: Pane; unseen: Counts; counts: Counts; prompt: DraftKey | null }>;
/**
 * What the layout observes of the view: each panel's message count and the pending prompt, by its full key
 * (incarnation, run, prompt), since prompt numbers restart with each run and each start of the server (W2-R1-1).
 */
export type Observed = Readonly<{ counts: Counts; prompt: DraftKey | null }>;

/** M3's expanded window class begins at 840 dp. */
export const EXPANDED_MIN_WIDTH = 840;

export const initialLayout: Layout = { selected: "left", unseen: { left: 0, right: 0 }, counts: { left: 0, right: 0 }, prompt: null };

/** The layout after the view changed; `compact` when the window is narrower than the expanded class. */
export const observe = (layout: Layout, observed: Observed, compact: boolean): Layout => {
  const newPrompt = observed.prompt !== null && (layout.prompt === null || !sameKey(observed.prompt, layout.prompt));
  const selected: Pane = newPrompt ? "left" : layout.selected;
  // A panel with fewer messages than before belongs to a new run: its count starts again.
  const added = (pane: Pane): number => Math.max(0, observed.counts[pane] - layout.counts[pane]);
  const count = (pane: Pane): number => (!compact || pane === selected ? 0 : observed.counts[pane] < layout.counts[pane] ? 0 : layout.unseen[pane] + added(pane));
  return { selected, unseen: { left: count("left"), right: count("right") }, counts: observed.counts, prompt: observed.prompt };
};

/** The user selects a panel; its unseen count is cleared. */
export const select = (layout: Layout, pane: Pane): Layout => ({ ...layout, selected: pane, unseen: { ...layout.unseen, [pane]: 0 } });

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

// ---- the decision page's opened heading (issue #133, decisions Q2 and G-R1-1) -------------------------------------------

/**
 * What the allotment of an opened heading's text is computed from: `shared`, the height left for the columns' region and
 * the opened text together, measured independently of the split; `content`, the text's full height with its padding.
 * Beside the columns (`BesideColumns`) the text takes at most half; below 390 px there are no columns (`Alone`).
 */
export type OpenedInput = Readonly<{ _tag: "BesideColumns" | "Alone"; shared: number; content: number }>;
/** The heights the opened text and the columns' region take, in whole pixels, together the shared height. */
export type OpenedHeights = Readonly<{ text: number; columns: number }>;
/**
 * The height an opened heading's text takes from the columns (the open point's default: at most half the shared height,
 * the text scrolling inside itself beyond that; the columns keep the rest). The inputs are normalized first, the shared
 * height floored and the content ceiled, none below zero.
 */
export const allotOpened = (input: OpenedInput): OpenedHeights => {
  const shared = Math.max(0, Math.floor(input.shared));
  const content = Math.max(0, Math.ceil(input.content));
  const text = Math.min(content, input._tag === "BesideColumns" ? Math.floor(shared / 2) : shared);
  return { text, columns: shared - text };
};
