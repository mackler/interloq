// Issue #133, decisions Q2 and G-R1-1: the height an opened heading's text takes from the decision page's columns, as a
// pure function. The open point's default: at most half the shared height beside the columns, all of it alone.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { allotOpened, type OpenedInput } from "./layout.ts";

const RUNS = { numRuns: 300, seed: 20261012 };
const height = fc.oneof(fc.double({ min: -50, max: 2000, noNaN: true }), fc.integer({ min: -50, max: 2000 }));
const input: fc.Arbitrary<OpenedInput> = fc.record({ _tag: fc.constantFrom("BesideColumns" as const, "Alone" as const), shared: height, content: height });
const normalized = (i: OpenedInput) => ({ s: Math.max(0, Math.floor(i.shared)), c: Math.max(0, Math.ceil(i.content)) });

describe("allotOpened", () => {
  test("every output is a whole, non-negative number of pixels, and together they are the shared height", () => {
    fc.assert(
      fc.property(input, (i) => {
        const { text, columns } = allotOpened(i);
        const { s } = normalized(i);
        expect(Number.isInteger(text) && Number.isInteger(columns)).toBe(true);
        expect(text >= 0 && columns >= 0).toBe(true);
        expect(text + columns).toBe(s);
      }),
      RUNS,
    );
  });

  test("the text never takes more than its content", () => {
    fc.assert(fc.property(input, (i) => {
      expect(allotOpened(i).text <= normalized(i).c).toBe(true);
    }), RUNS);
  });

  test("beside the columns the text takes at most half, and its whole content when that fits in half", () => {
    fc.assert(
      fc.property(input, (raw) => {
        const i = { ...raw, _tag: "BesideColumns" as const };
        const { s, c } = normalized(i);
        const { text, columns } = allotOpened(i);
        expect(text <= Math.floor(s / 2)).toBe(true);
        expect(columns >= Math.ceil(s / 2)).toBe(true);
        if (c <= Math.floor(s / 2)) expect(text).toBe(c);
      }),
      RUNS,
    );
  });

  test("alone the text takes its content, up to the shared height", () => {
    fc.assert(
      fc.property(input, (raw) => {
        const i = { ...raw, _tag: "Alone" as const };
        const { s, c } = normalized(i);
        expect(allotOpened(i).text).toBe(Math.min(c, s));
      }),
      RUNS,
    );
  });
});
