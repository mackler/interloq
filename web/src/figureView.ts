// The enlarged view of an option's picture (pure, no DOM, no timers; issue #247, requirements Q1): the size it takes in
// the window, and when it is open. FigureView.svelte and OptionFigure.svelte apply them at the component's edge.

/** A width and a height in CSS pixels. */
export type Room = Readonly<{ width: number; height: number }>;
export type Size = Room;

/** The space left at each edge of the window, as TermTooltip leaves. */
export const FIGURE_VIEW_MARGIN = 8;
/** The view's inner padding. */
export const FIGURE_VIEW_PADDING = 8;
/** The row holding the close control, M3's 40 px button height. */
export const FIGURE_VIEW_HEADER = 40;

/** A positive length, unitless or in px; anything else (a percentage, another unit) is null. */
export const positiveLength = (value: string | null): number | null => {
  const m = value === null ? null : /^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*(px)?\s*$/i.exec(value);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The extent of a valid viewBox: four finite numbers, separated by whitespace and/or commas, the last two positive. */
const viewBoxExtent = (viewBox: string | null): Room | null => {
  if (viewBox === null) return null;
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4 || parts.some((p) => p === "")) return null;
  const numbers = parts.map(Number);
  const [, , w, h] = numbers as [number, number, number, number];
  return numbers.every(Number.isFinite) && w > 0 && h > 0 ? { width: w, height: h } : null;
};

/** The width/height ratio an SVG root states: from a valid viewBox, else from width and height, else null. */
export const aspectOf = (viewBox: string | null, width: string | null, height: string | null): number | null => {
  const box = viewBoxExtent(viewBox);
  if (box !== null) return box.width / box.height;
  const w = positiveLength(width);
  const h = positiveLength(height);
  return w !== null && h !== null ? w / h : null;
};

/**
 * The viewBox the enlarged copy needs to scale its drawing: null where the viewBox is valid or none can be derived.
 * Without a viewBox an SVG keeps its own coordinate scale, so enlarging its viewport would not enlarge the drawing.
 */
export const viewBoxOf = (viewBox: string | null, width: string | null, height: string | null): string | null => {
  if (viewBoxExtent(viewBox) !== null) return null;
  const w = positiveLength(width);
  const h = positiveLength(height);
  return w !== null && h !== null ? `0 0 ${w} ${h}` : null;
};

/** The picture's room inside the view in a window of the given size. */
export const roomOf = (window: Room): Room => {
  const inset = 2 * FIGURE_VIEW_MARGIN + 2 * FIGURE_VIEW_PADDING;
  return { width: Math.max(1, window.width - inset), height: Math.max(1, window.height - inset - FIGURE_VIEW_HEADER) };
};

/**
 * The largest size of the aspect within the room, whole pixels, each at least 1; the room itself with no aspect.
 * The size the SVG states gives only its ratio: the picture takes the largest size that fits, smaller or larger than it.
 */
export const enlargedSize = (aspect: number | null, room: Room): Size => {
  const fit = (w: number, h: number): Size => ({ width: Math.max(1, Math.floor(w)), height: Math.max(1, Math.floor(h)) });
  if (aspect === null || !(aspect > 0)) return fit(room.width, room.height);
  return room.width / room.height <= aspect ? fit(room.width, room.width / aspect) : fit(room.height * aspect, room.height);
};

/** Where the pointer is while a hover keeps the view open. */
export type Over = "picture" | "view" | "neither";
export type ViewState =
  | Readonly<{ _tag: "Closed" }>
  | Readonly<{ _tag: "Pending" }>
  | Readonly<{ _tag: "Hovered"; over: Over }>
  | Readonly<{ _tag: "Pinned" }>;
export type Hoverable = "picture" | "view";
export type DismissHow = "escape" | "close" | "outside";
export type ViewEvent =
  | Readonly<{ _tag: "Enter"; on: Hoverable }>
  | Readonly<{ _tag: "Leave"; on: Hoverable }>
  | Readonly<{ _tag: "OpenDue" }>
  | Readonly<{ _tag: "CloseDue" }>
  | Readonly<{ _tag: "Activate" }>
  | Readonly<{ _tag: "Dismiss"; how: DismissHow }>;
/** What the component carries out. No command answers the question: nothing in the view chooses. */
export type ViewCommand = "StartOpenTimer" | "StartCloseTimer" | "CancelTimers" | "FocusView" | "ReturnFocus";
export type ViewStep = Readonly<{ state: ViewState; commands: readonly ViewCommand[] }>;

export const CLOSED: ViewState = { _tag: "Closed" };
export const HOVER_OPEN_MS = 120;
export const HOVER_CLOSE_MS = 200;

const stay = (state: ViewState): ViewStep => ({ state, commands: [] });

export const afterViewEvent = (state: ViewState, event: ViewEvent): ViewStep => {
  switch (event._tag) {
    case "Activate":
      return state._tag === "Pinned" ? stay(state) : { state: { _tag: "Pinned" }, commands: ["CancelTimers", "FocusView"] };
    case "Dismiss":
      switch (state._tag) {
        case "Closed":
          return stay(state);
        case "Pinned":
          return { state: CLOSED, commands: ["ReturnFocus"] };
        case "Pending":
        case "Hovered":
          return { state: CLOSED, commands: ["CancelTimers"] };
      }
    case "Enter":
      switch (state._tag) {
        case "Closed":
          return event.on === "picture" ? { state: { _tag: "Pending" }, commands: ["StartOpenTimer"] } : stay(state);
        case "Hovered":
          return { state: { _tag: "Hovered", over: event.on }, commands: ["CancelTimers"] };
        case "Pending":
        case "Pinned":
          return stay(state);
      }
    case "Leave":
      switch (state._tag) {
        case "Pending":
          return event.on === "picture" ? { state: CLOSED, commands: ["CancelTimers"] } : stay(state);
        case "Hovered":
          return state.over === event.on ? { state: { _tag: "Hovered", over: "neither" }, commands: ["StartCloseTimer"] } : stay(state);
        case "Closed":
        case "Pinned":
          return stay(state);
      }
    case "OpenDue":
      return state._tag === "Pending" ? { state: { _tag: "Hovered", over: "picture" }, commands: [] } : stay(state);
    case "CloseDue":
      return state._tag === "Hovered" && state.over === "neither" ? { state: CLOSED, commands: [] } : stay(state);
  }
};

export const isOpen = (state: ViewState): boolean => state._tag === "Hovered" || state._tag === "Pinned";
