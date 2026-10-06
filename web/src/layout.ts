// The page's layout state at compact widths (finding 7 of docs/gui-review.md, decision Q3), pure. Below M3's expanded
// breakpoint only one of the two panels is shown; the other's new messages are counted for its badge, and a new
// prompt selects "You and Interloq", where the prompt is answered.

import type { DraftKey } from "./draft.ts";

export type Pane = "left" | "right";
export type Counts = Readonly<Record<Pane, number>>;
export type Layout = Readonly<{ selected: Pane; unseen: Counts; counts: Counts; prompt: DraftKey | null }>;
/**
 * What the layout observes of the view: each panel's message count and the pending prompt, by its full key
 * (incarnation, run, prompt), since prompt numbers restart with each run and each start of the server (W2-R1-1).
 */
export type Observed = Readonly<{ counts: Counts; prompt: DraftKey | null }>;

const sameKey = (a: DraftKey | null, b: DraftKey | null): boolean =>
  a === null || b === null ? a === b : a.incarnation === b.incarnation && a.run === b.run && a.prompt === b.prompt;

/** M3's expanded window class begins at 840 dp. */
export const EXPANDED_MIN_WIDTH = 840;

export const initialLayout: Layout = { selected: "left", unseen: { left: 0, right: 0 }, counts: { left: 0, right: 0 }, prompt: null };

/** The layout after the view changed; `compact` when the window is narrower than the expanded class. */
export const observe = (layout: Layout, observed: Observed, compact: boolean): Layout => {
  const newPrompt = observed.prompt !== null && !sameKey(observed.prompt, layout.prompt);
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

// Issues #79 and #81, decisions Q1 and G-R1-2 of their task: the heights of a decision's analysis. The context paragraph
// and the recommendation take their whole height when the columns keep their strip; otherwise they share the room the
// strip leaves, equally, an unused share going to the other, each keeping at least its own minimum, `minContext` or
// `minRecommendation` (or its content, if less): two lines plus that region's own padding and borders (W4-R1-1).
// The columns never get less than the strip; where even the minimums do not fit, the total exceeds `available`, and the
// compact layout lets the page grow to it (G-R1-2). All heights in pixels.

/** What the allotment is computed from: the room, the two texts' content heights, the columns' strip and each text's minimum. */
export type AllotInput = Readonly<{ available: number; context: number; recommendation: number; strip: number; minContext: number; minRecommendation: number }>;
/** The heights given to the context region, the recommendation's region and the columns' region. */
export type Allotment = Readonly<{ context: number; recommendation: number; columns: number }>;

/** The heights of the three regions (decision Q1). */
export const allot = ({ available, context, recommendation, strip, ...minimums }: AllotInput): Allotment => {
  if (context + recommendation + strip <= available) return { context, recommendation, columns: available - context - recommendation };
  const [minContext, minRecommendation] = [Math.min(minimums.minContext, context), Math.min(minimums.minRecommendation, recommendation)];
  // The room the strip leaves, never less than the two minimums (G-R1-2: the page grows instead).
  const room = Math.max(available - strip, minContext + minRecommendation);
  if (context + recommendation <= room) return { context, recommendation, columns: Math.max(strip, available - context - recommendation) };
  const half = room / 2;
  const split = context <= half ? context : recommendation <= half ? room - recommendation : half;
  const shown = Math.min(context, Math.max(minContext, Math.min(split, room - minRecommendation)));
  const rest = Math.min(recommendation, room - shown);
  return { context: shown, recommendation: rest, columns: Math.max(strip, available - shown - rest) };
};
/** The columns' strip: about ten lines, or the closed columns' height if that is less (decision Q1). */
export const stripOf = (closedColumnsHeight: number, tenLines: number): number => Math.min(tenLines, closedColumnsHeight);
/**
 * The height of the tallest column with every entry closed. `content` is a column's content height alone (an
 * unconstrained inner wrapper's, never the scroller's `scrollHeight`, which is at least the scroller's own height);
 * `openBodies` are the heights of that column's own open entry bodies. Each column's open bodies are taken from that
 * column, then the maximum is taken, so an entry open in another tab changes nothing.
 */
export const closedHeightOf = (columns: readonly Readonly<{ content: number; openBodies: readonly number[] }>[]): number =>
  columns.reduce((tallest, c) => Math.max(tallest, c.content - c.openBodies.reduce((n, h) => n + h, 0)), 0);
