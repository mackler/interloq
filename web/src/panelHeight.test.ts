// Issue #221: the live panel's height in lines, dragged or moved by the keyboard, and remembered.
import fc from "fast-check";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { PANEL_LINES } from "./livePanel.ts";
import { afterDrag, afterKey, linePx, MAX_PANEL_LINES, maxPanelLines, MIN_PANEL_LINES, panelLinesOf, shownLines } from "./panelHeight.ts";

describe("panel height", () => {
  test("panelLinesOf admits whole numbers within the bounds alone", () => {
    expect(Result.isSuccess(panelLinesOf(MIN_PANEL_LINES))).toBe(true);
    expect(Result.isSuccess(panelLinesOf(MAX_PANEL_LINES))).toBe(true);
    for (const n of [2, 61, 3.5, Number.NaN, Infinity]) expect(Result.isFailure(panelLinesOf(n))).toBe(true);
  });

  test("a line is 1.125 times the root font size, 16 px where that is not a positive number", () => {
    expect(linePx("16px")).toBe(18);
    expect(linePx("20px")).toBe(22.5);
    expect(linePx("abc")).toBe(18);
    expect(linePx("0px")).toBe(18);
  });

  test("the most lines the room allows, the content above keeping its minimum", () => {
    expect(maxPanelLines(null, 100, 16)).toBe(MAX_PANEL_LINES);
    expect(maxPanelLines(0, 100, 16)).toBe(MAX_PANEL_LINES);
    expect(maxPanelLines(800, 100, 16)).toBe(35);
    expect(maxPanelLines(800, 2000, 16)).toBe(MIN_PANEL_LINES);
    expect(maxPanelLines(5000, 0, 16)).toBe(MAX_PANEL_LINES);
    expect(shownLines(40, 35)).toBe(35);
    expect(shownLines(12, 35)).toBe(12);
  });

  test("the keys and a drag", () => {
    expect(afterKey(12, "ArrowUp", 35)).toBe(13);
    expect(afterKey(12, "ArrowDown", 35)).toBe(11);
    expect(afterKey(12, "Home", 35)).toBe(MIN_PANEL_LINES);
    expect(afterKey(12, "End", 35)).toBe(35);
    expect(afterKey(35, "ArrowUp", 35)).toBe(35);
    expect(afterKey(MIN_PANEL_LINES, "ArrowDown", 35)).toBe(MIN_PANEL_LINES);
    expect(afterKey(12, "a", 35)).toBeNull();
    expect(afterDrag(12, 500, 464, 18, 35)).toBe(14);
    expect(afterDrag(12, 500, 900, 18, 35)).toBe(MIN_PANEL_LINES);
  });

  const max = fc.integer({ min: MIN_PANEL_LINES, max: MAX_PANEL_LINES });
  test("every result lies within the minimum and the maximum", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 200 }), max, fc.constantFrom("ArrowUp", "ArrowDown", "Home", "End"), fc.integer({ min: -2000, max: 2000 }), (n, m, key, dy) => {
        for (const r of [afterKey(n, key, m) ?? MIN_PANEL_LINES, afterDrag(n, 0, dy, 18, m), maxPanelLines(dy + 1000, 50, 16)]) {
          expect(r).toBeGreaterThanOrEqual(MIN_PANEL_LINES);
          expect(r).toBeLessThanOrEqual(MAX_PANEL_LINES);
        }
        expect(afterDrag(n, 0, dy, 18, m)).toBeLessThanOrEqual(m);
        expect(afterKey(n, key, m)).toBeLessThanOrEqual(m);
      }),
      { numRuns: 200, seed: 221 },
    );
  });

  test("Up then Down returns the start away from the bounds, and a drag with no movement returns it", () => {
    fc.assert(
      fc.property(max, fc.integer({ min: 0, max: 1000 }), (m, y) => {
        fc.pre(m > MIN_PANEL_LINES + 1);
        const start = MIN_PANEL_LINES + 1 + ((y % (m - MIN_PANEL_LINES - 1)) || 0);
        fc.pre(start < m);
        expect(afterKey(afterKey(start, "ArrowUp", m) ?? 0, "ArrowDown", m)).toBe(start);
        expect(afterDrag(start, y, y, 18, m)).toBe(start);
      }),
      { numRuns: 200, seed: 2212 },
    );
    expect(PANEL_LINES).toBeGreaterThanOrEqual(MIN_PANEL_LINES);
  });
});
