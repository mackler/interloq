// Issue #221: the live panel's height in lines, dragged or moved by the keyboard, and remembered.
import fc from "fast-check";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { PANEL_LINES } from "./livePanel.ts";
import { ABOVE_MIN_REM, afterDrag, afterKey, FLOOR_PANEL_LINES, LINE_REM, linePx, MAX_PANEL_LINES, maxPanelLines, MIN_PANEL_LINES, minPanelLines, panelBudgetPx, panelLinesOf, runningListLines, SHORT_COLUMN_REM, shownLines } from "./panelHeight.ts";

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
    expect(ABOVE_MIN_REM).toBe(2);
    const fits = (n: number): number => 100 + ABOVE_MIN_REM * 16 + n * LINE_REM * 16;
    expect(maxPanelLines(800, 100, 16)).toBe(Math.floor((800 - 100 - ABOVE_MIN_REM * 16) / 18));
    expect(maxPanelLines(800, 2000, 16)).toBe(FLOOR_PANEL_LINES);
    expect(maxPanelLines(fits(1), 100, 16)).toBe(1);
    expect(maxPanelLines(fits(2) + 5, 100, 16)).toBe(2);
    expect(maxPanelLines(fits(1) - 1, 100, 16)).toBe(1);
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

  test("the running list's lines: one below 20rem of room, three otherwise or unmeasured", () => {
    expect(SHORT_COLUMN_REM).toBe(20);
    expect(runningListLines(null, 16)).toBe(3);
    expect(runningListLines(156, 16)).toBe(1);
    expect(runningListLines(319, 16)).toBe(1);
    expect(runningListLines(320, 16)).toBe(3);
    expect(runningListLines(700, 16)).toBe(3);
    fc.assert(
      fc.property(fc.option(fc.double({ min: 0, max: 5000, noNaN: true }), { nil: null }), fc.double({ min: 8, max: 40, noNaN: true }), (a, root) => {
        expect(runningListLines(a, root) === 3).toBe(a === null || a >= 20 * root);
      }),
      { numRuns: 200, seed: 2213 },
    );
  });

  test("the panel's budget: the room less the content above's minimum, never negative", () => {
    expect(panelBudgetPx(null, 16)).toBeNull();
    expect(panelBudgetPx(144, 16)).toBe(112);
    expect(panelBudgetPx(78, 16)).toBe(46);
    expect(panelBudgetPx(20, 16)).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), fc.double({ min: 8, max: 40, noNaN: true }), (a, root) => {
        const b = panelBudgetPx(a, root) ?? -1;
        expect(b).toBeGreaterThanOrEqual(0);
        if (a - 2 * root >= 0) expect(b).toBeCloseTo(a - 2 * root, 9);
      }),
      { numRuns: 200, seed: 2214 },
    );
  });

  test("below three lines of room the separator's minimum is the room's maximum", () => {
    expect(minPanelLines(35)).toBe(MIN_PANEL_LINES);
    expect(minPanelLines(2)).toBe(2);
    expect(minPanelLines(1)).toBe(1);
    expect(afterKey(12, "Home", 2)).toBe(2);
    expect(afterKey(12, "Home", 1)).toBe(1);
    expect(afterKey(1, "ArrowUp", 2)).toBe(2);
    expect(afterKey(2, "ArrowDown", 2)).toBe(2);
    expect(afterDrag(12, 500, 900, 18, 1)).toBe(1);
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 200 }), fc.integer({ min: FLOOR_PANEL_LINES, max: MIN_PANEL_LINES - 1 }), fc.constantFrom("ArrowUp", "ArrowDown", "Home", "End"), fc.integer({ min: -2000, max: 2000 }), (n, m, key, dy) => {
        for (const r of [afterKey(n, key, m) ?? m, afterDrag(n, 0, dy, 18, m)]) {
          expect(r).toBeGreaterThanOrEqual(minPanelLines(m));
          expect(r).toBeLessThanOrEqual(m);
        }
        expect(afterKey(n, "Home", m)).toBe(m);
      }),
      { numRuns: 200, seed: 2215 },
    );
  });

  const max = fc.integer({ min: MIN_PANEL_LINES, max: MAX_PANEL_LINES });
  test("every result lies within the minimum and the maximum", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 200 }), max, fc.constantFrom("ArrowUp", "ArrowDown", "Home", "End"), fc.integer({ min: -2000, max: 2000 }), (n, m, key, dy) => {
        for (const r of [afterKey(n, key, m) ?? MIN_PANEL_LINES, afterDrag(n, 0, dy, 18, m)]) {
          expect(r).toBeGreaterThanOrEqual(MIN_PANEL_LINES);
          expect(r).toBeLessThanOrEqual(MAX_PANEL_LINES);
        }
        const room = maxPanelLines(dy + 1000, 50, 16);
        expect(room).toBeGreaterThanOrEqual(FLOOR_PANEL_LINES);
        expect(room).toBeLessThanOrEqual(MAX_PANEL_LINES);
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
