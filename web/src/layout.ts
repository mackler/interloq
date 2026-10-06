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
// That floor (the strip and both minimums) is bounded by `room`, the height the window has for the three regions beside
// the question and its first answer (the developer's decision at the stop of execution phase 1 of the task of L21:
// the window wins, at every width). Beyond `room` the regions yield in this order: the columns, from the strip down
// to 0; then the recommendation, below its minimum, down to 0; then the context. The question and the answers are
// outside the allotment and are never given up. All heights in pixels.

declare const RoomBrand: unique symbol;
/** The height the decision area may take without the run scrolling past the first answer; never negative. */
export type Room = number & { readonly [RoomBrand]: true };
/** A room not yet measured: no bound. */
export const UNBOUNDED_ROOM = Number.POSITIVE_INFINITY as Room;
/** The spare room below the first answer: three times the 8 px by which CI's font and the container's differ (issue #73). */
export const ROOM_MARGIN = 24;
/**
 * What the room is measured from, by layout. `height` is the run's client height, its padding included; `padding` its
 * top plus bottom padding. Compact (`Stacked`, a flex column): `above` the children before the decision area, one gap
 * after each and one between the decision area and `.left`. Wide (`Grid`): the analysis's row, a row gap, then the row
 * of `.left`. `firstAnswer` is the distance from the top of `.left` to the bottom of the first answer; nothing below
 * it is counted, so the rest of the prompt and the activity line are reached by scrolling.
 */
export type RoomInput =
  | Readonly<{ _tag: "Stacked"; height: number; padding: number; gap: number; above: readonly number[]; firstAnswer: number }>
  | Readonly<{ _tag: "Grid"; height: number; padding: number; rowGap: number; firstAnswer: number }>;
/** The room of the decision area. */
export const roomOf = (input: RoomInput): Room => {
  const taken =
    input._tag === "Stacked"
      ? input.padding + input.above.reduce((n, h) => n + h, 0) + input.gap * (input.above.length + 1)
      : input.padding + input.rowGap;
  return Math.max(0, input.height - taken - input.firstAnswer - ROOM_MARGIN) as Room;
};
/** The part of the area's room left to the three regions `allot` divides, once `fixed` (heading, question, gaps, padding) is taken. */
export const regionsRoom = (room: Room, fixed: number): Room => Math.max(0, room - fixed) as Room;

declare const MinimumBrand: unique symbol;
/** The least height the analysis needs, never more than the room. */
export type AnalysisMinimum = number & { readonly [MinimumBrand]: true };
/** The analysis's minimum total, bounded by the room. */
export const boundedMinimum = (minimum: number, room: Room): AnalysisMinimum => Math.max(0, Math.min(minimum, room)) as AnalysisMinimum;

/** What the allotment is computed from: the room, the two texts' content heights, the columns' strip and each text's minimum. */
export type AllotInput = Readonly<{ available: number; context: number; recommendation: number; strip: number; minContext: number; minRecommendation: number; room: Room }>;
/** The floor of the three regions: the strip and each text's minimum, capped by its content. */
export const floorTotal = (i: AllotInput): number => i.strip + Math.min(i.minContext, i.context) + Math.min(i.minRecommendation, i.recommendation);
/** The heights given to the context region, the recommendation's region and the columns' region. */
export type Allotment = Readonly<{ context: number; recommendation: number; columns: number }>;

/** The heights of the three regions (decision Q1). */
export const allot = (input: AllotInput): Allotment => {
  const budget = Math.max(input.available, input.room);
  return floorTotal(input) <= budget ? allotFloor(input) : allotYielding(input, budget);
};

/**
 * Where the floor exceeds the room (the task of L21): the columns yield first, then the recommendation, then the
 * context; every region is at or below its floor, so nothing is left to share.
 */
const allotYielding = (i: AllotInput, budget: number): Allotment => {
  const [minContext, minRecommendation] = [Math.min(i.minContext, i.context), Math.min(i.minRecommendation, i.recommendation)];
  const columns = Math.max(0, budget - minContext - minRecommendation);
  const texts = budget - columns;
  const recommendation = Math.max(0, texts - minContext);
  return { context: texts - recommendation, recommendation, columns };
};

/** Where the floor fits: the allotment of decisions Q1 and G-R1-2, which never cuts the strip or a minimum. */
const allotFloor = ({ available, context, recommendation, strip, ...minimums }: AllotInput): Allotment => {
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
