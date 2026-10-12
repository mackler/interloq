// Issue #133, W1-R1-1 (the developer's decision of 12 Oct 2026, "Every control stays, windows scroll"): the columns keep a
// floor, an opened text takes at most half where the room suffices, and the run scrolls where it does not.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { allotWithFloor, COLUMNS_FLOOR_REM, type FloorInput, floorPx } from "./layout.ts";

const RUNS = { numRuns: 300, seed: 20261012 };
const height = fc.oneof(fc.double({ min: -500, max: 3000, noNaN: true }), fc.integer({ min: -500, max: 3000 }));
const floorArb = fc.oneof(fc.double({ min: -10, max: 600, noNaN: true }), fc.integer({ min: 0, max: 600 }));
const input: fc.Arbitrary<FloorInput> = fc.record({ _tag: fc.constantFrom("BesideColumns" as const, "Alone" as const), available: height, floor: floorArb, content: height });
const beside = input.map((i) => ({ ...i, _tag: "BesideColumns" as const }));
const normalized = (i: FloorInput) => {
  const f = Math.max(1, Math.ceil(i.floor));
  return { a: Math.max(0, Math.floor(i.available)), c: Math.max(0, Math.ceil(i.content)), f, textFloor: Math.ceil(f / 2) };
};

describe("allotWithFloor", () => {
  test("every output is a whole, non-negative number of pixels", () => {
    fc.assert(fc.property(input, (i) => {
      const { text, columns } = allotWithFloor(i);
      expect(Number.isInteger(text) && Number.isInteger(columns)).toBe(true);
      expect(text >= 0 && columns >= 0).toBe(true);
    }), RUNS);
  });

  test("the text never takes more than its content", () => {
    fc.assert(fc.property(input, (i) => { expect(allotWithFloor(i).text <= normalized(i).c).toBe(true); }), RUNS);
  });

  test("beside the columns, the columns keep the floor", () => {
    fc.assert(fc.property(beside, (i) => { expect(allotWithFloor(i).columns >= normalized(i).f).toBe(true); }), RUNS);
  });

  test("beside the columns, where the room suffices, the two fill it exactly, so nothing scrolls", () => {
    fc.assert(fc.property(beside, (i) => {
      const { a, c, f, textFloor } = normalized(i);
      fc.pre(a - f >= Math.min(c, textFloor));
      const { text, columns } = allotWithFloor(i);
      expect(text + columns).toBe(a);
    }), RUNS);
  });

  test("beside the columns, the text takes at most half where the room allows, and at least its floor", () => {
    fc.assert(fc.property(beside, (i) => {
      const { a, c, textFloor } = normalized(i);
      const { text } = allotWithFloor(i);
      expect(text <= Math.max(Math.min(c, textFloor), Math.floor(a / 2))).toBe(true);
      expect(text >= Math.min(c, textFloor)).toBe(true);
    }), RUNS);
  });

  test("alone, there are no columns and the text takes up to the larger of the room and the floor", () => {
    fc.assert(fc.property(input.map((i) => ({ ...i, _tag: "Alone" as const })), (i) => {
      const { a, c, f } = normalized(i);
      expect(allotWithFloor(i)).toEqual({ text: Math.min(c, Math.max(a, f)), columns: 0 });
    }), RUNS);
  });

  test("1280 × 800: an opened long text takes 142 px and the columns their floor of 240", () => {
    expect(allotWithFloor({ _tag: "BesideColumns", available: 382, floor: 240, content: 2000 })).toEqual({ text: 142, columns: 240 });
  });
});

describe("floorPx", () => {
  test("is a positive integer for every input, NaN, 0 and negative numbers included", () => {
    fc.assert(fc.property(fc.oneof(fc.double({ min: -1e6, max: 1e6 }), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0), fc.integer({ min: -100, max: 0 })), (f) => {
      const v = floorPx(f);
      expect(Number.isInteger(v) && v > 0).toBe(true);
    }), RUNS);
  });

  test("is the ceiling of the floor in rem times a finite positive font size, and 16 px's otherwise", () => {
    fc.assert(fc.property(fc.double({ min: 0.01, max: 200, noNaN: true }), (f) => { expect(floorPx(f)).toBe(Math.ceil(COLUMNS_FLOOR_REM * f)); }), RUNS);
    expect(floorPx(Number.NaN)).toBe(Math.ceil(COLUMNS_FLOOR_REM * 16));
  });
});
