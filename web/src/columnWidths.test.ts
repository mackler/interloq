// Issue #204: the widths of the run's columns, their bounds, keys and drags.
import fc from "fast-check";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { afterDrag, afterKey, columnsPxOf, DEFAULT_COLUMN_WIDTHS, gridColumns, LEFT_PERCENT_MAX, LEFT_PERCENT_MIN, leftBounds, leftPercentOf, PANEL_MIN_REM, RAIL_MAX_REM, RAIL_MIN_REM, railBounds, railRemOf, shown } from "./columnWidths.ts";

describe("column widths", () => {
  test("the constructors admit whole numbers within their domains alone", () => {
    expect(Result.isSuccess(railRemOf(14))).toBe(true);
    expect(Result.isSuccess(railRemOf(28))).toBe(true);
    expect(Result.isSuccess(leftPercentOf(20))).toBe(true);
    expect(Result.isSuccess(leftPercentOf(80))).toBe(true);
    for (const n of [13, 29, 14.5, Number.NaN]) expect(Result.isFailure(railRemOf(n))).toBe(true);
    for (const n of [19, 81, 50.5]) expect(Result.isFailure(leftPercentOf(n))).toBe(true);
    expect(DEFAULT_COLUMN_WIDTHS).toEqual({ rail: 14, left: 50 });
  });

  test("at 840 px the layout is today's, at 1280 the rail may double", () => {
    expect(columnsPxOf(840, 16)).toBe(840 - 48);
    const c840 = columnsPxOf(840, 16);
    expect(railBounds(c840, 16)).toEqual({ min: 14, max: 14 });
    expect(leftBounds(c840 - 14 * 16, 16)).toEqual({ min: 50, max: 50 });
    expect(railBounds(columnsPxOf(1280, 16), 16)).toEqual({ min: 14, max: 28 });
    expect(railBounds(null, 16)).toEqual({ min: RAIL_MIN_REM, max: RAIL_MAX_REM });
    expect(leftBounds(null, 16)).toEqual({ min: LEFT_PERCENT_MIN, max: LEFT_PERCENT_MAX });
    const p = columnsPxOf(1280, 16) - 14 * 16;
    expect(leftBounds(p, 16)).toEqual({ min: Math.ceil((320 / p) * 100), max: 100 - Math.ceil((320 / p) * 100) });
  });

  test("the keys and a drag, clamped", () => {
    const b = { min: 14, max: 28 };
    expect(afterKey(20, "ArrowRight", b)).toBe(21);
    expect(afterKey(20, "ArrowLeft", b)).toBe(19);
    expect(afterKey(20, "Home", b)).toBe(14);
    expect(afterKey(20, "End", b)).toBe(28);
    expect(afterKey(28, "ArrowRight", b)).toBe(28);
    expect(afterKey(14, "ArrowLeft", b)).toBe(14);
    expect(afterKey(20, "ArrowUp", b)).toBeNull();
    expect(afterDrag(14, 100, 148, 16, b)).toBe(17);
    expect(afterDrag(14, 100, 0, 16, b)).toBe(14);
    expect(shown(40, b)).toBe(28);
  });

  test("the grid's five tracks", () => {
    expect(gridColumns(14, 50)).toBe("14rem 0.75rem minmax(0, 50fr) 0.75rem minmax(0, 50fr)");
    expect(gridColumns(20, 60)).toBe("20rem 0.75rem minmax(0, 60fr) 0.75rem minmax(0, 40fr)");
  });

  const width = fc.double({ min: 0, max: 6000, noNaN: true });
  const root = fc.double({ min: 8, max: 40, noNaN: true });

  test("the minimum is at most the maximum, and shown lies within", () => {
    fc.assert(
      fc.property(fc.option(width, { nil: null }), root, fc.integer({ min: -100, max: 200 }), (w, r, v) => {
        for (const b of [railBounds(w, r), leftBounds(w, r)]) {
          expect(b.min).toBeLessThanOrEqual(b.max);
          const s = shown(v, b);
          expect(s).toBeGreaterThanOrEqual(b.min);
          expect(s).toBeLessThanOrEqual(b.max);
        }
      }),
      { numRuns: 200, seed: 2041 },
    );
  });

  test("a widened rail leaves both panels their minimum at an even split", () => {
    fc.assert(
      fc.property(width, root, (w, r) => {
        const b = railBounds(w, r);
        if (b.max > RAIL_MIN_REM) expect(w - b.max * r).toBeGreaterThanOrEqual(2 * PANEL_MIN_REM * r - 1e-9);
      }),
      { numRuns: 200, seed: 2042 },
    );
  });

  test("an uncollapsed split leaves both panels their minimum", () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 6000, noNaN: true }), root, (p, r) => {
        const b = leftBounds(p, r);
        if (!(b.min === 50 && b.max === 50)) {
          expect((p * b.min) / 100).toBeGreaterThanOrEqual(PANEL_MIN_REM * r - 1);
          expect((p * (100 - b.max)) / 100).toBeGreaterThanOrEqual(PANEL_MIN_REM * r - 1);
        }
      }),
      { numRuns: 200, seed: 2043 },
    );
  });

  test("a stored width survives the unmeasured bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 14, max: 28 }), fc.integer({ min: 20, max: 80 }), fc.double({ min: 8, max: 40, noNaN: true }), (rail, left, r) => {
        expect(shown(rail, railBounds(null, r))).toBe(rail);
        expect(shown(left, leftBounds(null, r))).toBe(left);
      }),
      { numRuns: 200, seed: 2044 },
    );
  });
});
