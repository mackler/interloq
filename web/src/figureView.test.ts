// Issue #247: the enlarged view of an option's picture, its size and its state, by examples and properties.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  afterViewEvent,
  aspectOf,
  CLOSED,
  enlargedSize,
  FIGURE_VIEW_HEADER,
  FIGURE_VIEW_MARGIN,
  FIGURE_VIEW_PADDING,
  isOpen,
  positiveLength,
  roomOf,
  viewBoxOf,
  type ViewEvent,
  type ViewState,
} from "./figureView.ts";
import { CLOSE_PICTURE, enlargePictureName } from "../../src/prompts.ts";

describe("the size an SVG states", () => {
  test("positiveLength takes a unitless or px length and refuses the rest", () => {
    expect(positiveLength("120")).toBe(120);
    expect(positiveLength(" 12px ")).toBe(12);
    expect(positiveLength("100%")).toBeNull();
    expect(positiveLength("2em")).toBeNull();
    expect(positiveLength("0")).toBeNull();
    expect(positiveLength("-3")).toBeNull();
    expect(positiveLength(null)).toBeNull();
  });
  test("aspectOf: a viewBox wins over width and height", () => {
    expect(aspectOf("0 0 400 300", "10", "100")).toBeCloseTo(4 / 3);
    expect(aspectOf("0,0,200,100", null, null)).toBe(2);
    expect(aspectOf("0, 0, 200 , 100", null, null)).toBe(2);
  });
  test("aspectOf: an invalid viewBox falls back to width and height", () => {
    expect(aspectOf("0 0 0 100", "120", "80px")).toBe(1.5);
    expect(aspectOf("0 0 -5 100", "12px", "12px")).toBe(1);
    expect(aspectOf(null, "100%", "80")).toBeNull();
    expect(aspectOf(null, null, null)).toBeNull();
  });
  test("viewBoxOf derives a viewBox only where none is valid", () => {
    expect(viewBoxOf("0 0 4 3", "120", "80")).toBeNull();
    expect(viewBoxOf(null, "120", "80px")).toBe("0 0 120 80");
    expect(viewBoxOf("bad", "120", "80")).toBe("0 0 120 80");
    expect(viewBoxOf(null, "50%", "80")).toBeNull();
  });
});

describe("the room and the enlarged size", () => {
  const inset = 2 * FIGURE_VIEW_MARGIN + 2 * FIGURE_VIEW_PADDING;
  test("roomOf at the three tested sizes", () => {
    expect(roomOf({ width: 1280, height: 800 })).toEqual({ width: 1280 - inset, height: 800 - inset - FIGURE_VIEW_HEADER });
    expect(roomOf({ width: 640, height: 400 })).toEqual({ width: 640 - inset, height: 400 - inset - FIGURE_VIEW_HEADER });
    expect(roomOf({ width: 390, height: 844 })).toEqual({ width: 390 - inset, height: 844 - inset - FIGURE_VIEW_HEADER });
    expect(roomOf({ width: 0, height: 0 })).toEqual({ width: 1, height: 1 });
  });
  test("examples of enlargedSize", () => {
    expect(enlargedSize(2, { width: 1000, height: 300 })).toEqual({ width: 600, height: 300 });
    expect(enlargedSize(0.5, { width: 100, height: 1000 })).toEqual({ width: 100, height: 200 });
    expect(enlargedSize(null, { width: 500, height: 400 })).toEqual({ width: 500, height: 400 });
    expect(enlargedSize(4 / 3, { width: 358, height: 772 })).toEqual({ width: 358, height: 268 });
  });
  const aspect = fc.double({ min: 0.05, max: 20, noNaN: true });
  const room = fc.record({ width: fc.integer({ min: 1, max: 4000 }), height: fc.integer({ min: 1, max: 4000 }) });
  test("it lies within the room", () => {
    fc.assert(fc.property(aspect, room, (a, r) => {
      const s = enlargedSize(a, r);
      expect(s.width).toBeLessThanOrEqual(r.width);
      expect(s.height).toBeLessThanOrEqual(r.height);
      expect(s.width).toBeGreaterThanOrEqual(1);
      expect(s.height).toBeGreaterThanOrEqual(1);
    }));
  });
  test("it keeps the aspect within one pixel and touches the room on an axis", () => {
    fc.assert(fc.property(aspect, room, (a, r) => {
      const s = enlargedSize(a, r);
      if (s.width > 1 && s.height > 1) expect(Math.abs(s.width - s.height * a)).toBeLessThanOrEqual(Math.max(1, a) + 1e-9);
      expect(r.width - s.width <= 1 || r.height - s.height <= 1).toBe(true);
    }));
  });
  test("a room larger than a card's picture of the same aspect gives a larger picture", () => {
    fc.assert(fc.property(aspect, fc.integer({ min: 10, max: 400 }), fc.integer({ min: 2, max: 10 }), (a, cardWidth, factor) => {
      const card = { width: cardWidth, height: cardWidth / a };
      const s = enlargedSize(a, { width: Math.ceil(card.width * factor), height: Math.ceil(card.height * factor) });
      expect(s.width).toBeGreaterThan(card.width);
      expect(s.height).toBeGreaterThan(card.height - 1);
    }));
  });
});

describe("the view's state", () => {
  const step = (s: ViewState, e: ViewEvent) => afterViewEvent(s, e);
  test("hover opens after the delay and closes after leaving both", () => {
    const a = step(CLOSED, { _tag: "Enter", on: "picture" });
    expect(a).toEqual({ state: { _tag: "Pending" }, commands: ["StartOpenTimer"] });
    const b = step(a.state, { _tag: "OpenDue" });
    expect(b.state).toEqual({ _tag: "Hovered", over: "picture" });
    expect(isOpen(b.state)).toBe(true);
    const c = step(b.state, { _tag: "Leave", on: "picture" });
    expect(c).toEqual({ state: { _tag: "Hovered", over: "neither" }, commands: ["StartCloseTimer"] });
    const d = step(c.state, { _tag: "Enter", on: "view" });
    expect(d).toEqual({ state: { _tag: "Hovered", over: "view" }, commands: ["CancelTimers"] });
    expect(step(d.state, { _tag: "Leave", on: "picture" })).toEqual({ state: d.state, commands: [] });
    const e = step(d.state, { _tag: "Leave", on: "view" });
    expect(step(e.state, { _tag: "CloseDue" }).state).toEqual(CLOSED);
  });
  test("a pass shorter than the delay opens nothing", () => {
    const a = step(CLOSED, { _tag: "Enter", on: "picture" });
    expect(step(a.state, { _tag: "Leave", on: "picture" })).toEqual({ state: CLOSED, commands: ["CancelTimers"] });
    expect(step(CLOSED, { _tag: "OpenDue" })).toEqual({ state: CLOSED, commands: [] });
  });
  test("activation pins; a pinned view ignores the pointer and leaves by dismissal, returning focus", () => {
    const p = step(CLOSED, { _tag: "Activate" });
    expect(p).toEqual({ state: { _tag: "Pinned" }, commands: ["CancelTimers", "FocusView"] });
    expect(isOpen(p.state)).toBe(true);
    expect(step(p.state, { _tag: "Leave", on: "picture" }).state).toEqual(p.state);
    expect(step(p.state, { _tag: "Activate" })).toEqual({ state: p.state, commands: [] });
    expect(step(p.state, { _tag: "Dismiss", how: "outside" })).toEqual({ state: CLOSED, commands: ["ReturnFocus"] });
  });
  test("dismissing a hovered view returns no focus", () => {
    expect(step({ _tag: "Hovered", over: "view" }, { _tag: "Dismiss", how: "close" })).toEqual({ state: CLOSED, commands: ["CancelTimers"] });
    expect(step(CLOSED, { _tag: "Dismiss", how: "escape" })).toEqual({ state: CLOSED, commands: [] });
  });

  const event: fc.Arbitrary<ViewEvent> = fc.oneof(
    fc.constantFrom<"picture" | "view">("picture", "view").map((on) => ({ _tag: "Enter" as const, on })),
    fc.constantFrom<"picture" | "view">("picture", "view").map((on) => ({ _tag: "Leave" as const, on })),
    fc.constant({ _tag: "OpenDue" as const }),
    fc.constant({ _tag: "CloseDue" as const }),
    fc.constant({ _tag: "Activate" as const }),
    fc.constantFrom<"escape" | "close" | "outside">("escape", "close", "outside").map((how) => ({ _tag: "Dismiss" as const, how })),
  );
  test("over any sequence: Pinned is left only by Dismiss, focus moves only with Pinned, Dismiss always closes", () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (events) => {
      let state: ViewState = CLOSED;
      for (const e of events) {
        const next = afterViewEvent(state, e);
        if (state._tag === "Pinned" && next.state._tag !== "Pinned") expect(e._tag).toBe("Dismiss");
        if (next.commands.includes("ReturnFocus")) expect(state._tag === "Pinned" && next.state._tag !== "Pinned").toBe(true);
        if (next.commands.includes("FocusView")) expect(state._tag !== "Pinned" && next.state._tag === "Pinned").toBe(true);
        if (e._tag === "Dismiss") expect(next.state).toEqual(CLOSED);
        state = next.state;
      }
    }));
  });
});

describe("the view's texts", () => {
  test("the picture's control is named by the action and the whole alt text; the close label is not blank", () => {
    const alt = "A sketch of the page, its heading the whole question.";
    const name = enlargePictureName(alt);
    expect(name.startsWith("Enlarge picture")).toBe(true);
    expect(name).toContain(alt);
    expect(CLOSE_PICTURE.trim()).not.toBe("");
  });
});
