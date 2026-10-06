import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { allot, type AllotInput, analysisShown, closedHeightOf, initialLayout, observe, select, stripOf } from "./layout.ts";

// Finding 7 of docs/gui-review.md, decision Q3: selectable panels at compact widths.
type Key = { incarnation: string; run: number; prompt: number };
const key = (prompt: number, run = 1, incarnation = "a"): Key => ({ incarnation, run, prompt });
const seen = (left: number, right: number, prompt: Key | null = null) => ({ counts: { left, right }, prompt });

describe("layout", () => {
  test("the left panel is selected at first", () => {
    expect(initialLayout.selected).toBe("left");
  });

  test("messages that arrive in the hidden panel are counted for its badge; the shown panel's are not", () => {
    const l = observe(observe(initialLayout, seen(2, 1), true), seen(3, 4), true);
    expect(l.unseen).toEqual({ left: 0, right: 4 });
  });

  test("selecting a panel shows it and clears its count", () => {
    const l = select(observe(initialLayout, seen(0, 5), true), "right");
    expect(l.selected).toBe("right");
    expect(l.unseen.right).toBe(0);
    const back = observe(l, seen(2, 5), true);
    expect(back.unseen).toEqual({ left: 2, right: 0 });
  });

  test("a new prompt selects the left panel, where it is answered", () => {
    const l = observe(select(initialLayout, "right"), seen(1, 0, key(4)), true);
    expect(l.selected).toBe("left");
    expect(observe(select(l, "right"), seen(1, 0, key(4)), true).selected).toBe("right");
  });

  test("at expanded width both panels show, so nothing is counted", () => {
    const l = observe(select(initialLayout, "right"), seen(3, 3, key(1)), false);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });

  test("a new run (fewer messages than before) starts the counts again", () => {
    const l = observe(observe(initialLayout, seen(10, 10), true), seen(1, 0), true);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });
});

// W2-R1-1: prompt numbers restart with each run and each start of the server, so a prompt is its full key.
describe("the prompt's identity", () => {
  test("prompt 1 of run 2, and prompt 1 of another incarnation, are new prompts that select the left panel", () => {
    const waiting = select(observe(initialLayout, seen(1, 1, key(1)), true), "right");
    expect(observe(waiting, seen(1, 1, key(1, 2)), true).selected).toBe("left");
    expect(observe(waiting, seen(1, 1, key(1, 1, "b")), true).selected).toBe("left");
    expect(observe(waiting, seen(1, 1, key(1)), true).selected).toBe("right");
  });
});

// W2-R1-3: the conversation shown instead of an analysis belongs to one decision of one run of one server start.
test("analysisShown: hidden only for the decision it was hidden for, not for the same number in another run or incarnation", () => {
  const k = (decision: number, run = 1, incarnation = "a") => ({ incarnation, run, decision });
  expect(analysisShown(null, k(1))).toBe(true);
  expect(analysisShown(k(1), k(1))).toBe(false);
  expect(analysisShown(k(1), k(2))).toBe(true);
  expect(analysisShown(k(1), k(1, 2))).toBe(true);
  expect(analysisShown(k(1), k(1, 1, "b"))).toBe(true);
});

// Issues #79 and #81, decisions Q1 and G-R1-2: the heights of a decision's analysis.
describe("the allotment of a decision's heights", () => {
  const RUNS = { numRuns: 300, seed: 20261006 };
  const px = fc.integer({ min: 0, max: 2000 });
  const input = fc.record({ available: px, context: px, recommendation: px, strip: fc.integer({ min: 0, max: 400 }), minContext: fc.integer({ min: 0, max: 60 }), minRecommendation: fc.integer({ min: 0, max: 60 }) });
  // W4-R1-1 of work review 4: each text's minimum clamped by its own content.
  const mins = (i: AllotInput) => ({ c: Math.min(i.minContext, i.context), r: Math.min(i.minRecommendation, i.recommendation) });
  /** The room the texts share when they do not fit beside the strip, never less than their clamped minimums. */
  const textRoom = (i: AllotInput) => Math.max(i.available - i.strip, mins(i).c + mins(i).r);
  test("the columns never get less than the strip", () => {
    fc.assert(fc.property(input, (i) => void expect(allot(i).columns).toBeGreaterThanOrEqual(i.strip)), RUNS);
  });
  test("each text gets at most its content and at least its minimum", () => {
    fc.assert(
      fc.property(input, (i) => {
        const a = allot(i);
        const m = mins(i);
        expect(a.context).toBeLessThanOrEqual(i.context);
        expect(a.recommendation).toBeLessThanOrEqual(i.recommendation);
        expect(a.context).toBeGreaterThanOrEqual(m.c - 1e-9);
        expect(a.recommendation).toBeGreaterThanOrEqual(m.r - 1e-9);
      }),
      RUNS,
    );
  });
  test("when everything fits beside the strip, both texts are whole and the columns take the rest", () => {
    fc.assert(
      fc.property(input, (i) => {
        fc.pre(i.context + i.recommendation + i.strip <= i.available);
        expect(allot(i)).toEqual({ context: i.context, recommendation: i.recommendation, columns: i.available - i.context - i.recommendation });
      }),
      RUNS,
    );
  });
  test("when both texts are cut, they get heights within 1 px of each other", () => {
    fc.assert(
      fc.property(input, (i) => {
        const a = allot(i);
        const m = mins(i);
        // P1-R1-1: a minimum above half the room binds, and the split is then unequal on a correct allotment.
        fc.pre(a.context < i.context && a.recommendation < i.recommendation && Math.max(m.c, m.r) <= textRoom(i) / 2);
        expect(Math.abs(a.context - a.recommendation)).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });
  test("the three regions fill the room, or the minimum total where the room is smaller (decision G-R1-2)", () => {
    fc.assert(
      fc.property(input, (i) => {
        const a = allot(i);
        const m = mins(i);
        expect(a.context + a.recommendation + a.columns).toBeCloseTo(Math.max(i.available, m.c + m.r + i.strip), 6);
      }),
      RUNS,
    );
  });
  // W4-R1-1: the recommendation's minimum is its own, never the context's.
  const unequal = input.filter((i) => i.minContext !== i.minRecommendation);
  test("with minimums that differ, the recommendation is never held to the context's minimum", () => {
    fc.assert(
      fc.property(unequal, (i) => {
        const a = allot(i);
        const m = mins(i);
        expect(a.recommendation).toBeGreaterThanOrEqual(m.r - 1e-9);
        expect(a.context).toBeGreaterThanOrEqual(m.c - 1e-9);
        if (a.context < i.context && a.recommendation < i.recommendation && Math.max(m.c, m.r) > textRoom(i) / 2) {
          const [bound, other] = m.r > m.c ? [a.recommendation, a.context] : [a.context, a.recommendation];
          const otherContent = m.r > m.c ? i.context : i.recommendation;
          expect(bound).toBeCloseTo(Math.max(m.c, m.r), 6);
          expect(other).toBeCloseTo(Math.min(otherContent, textRoom(i) - Math.max(m.c, m.r)), 6);
        }
      }),
      RUNS,
    );
  });
  test("a recommendation cut to its minimum gets its own minimum, not the context's", () => {
    // The sizes of W4-R1-1 at 1280 × 400: two lines of 15 px, the context's padding 16 px, the recommendation's 24 px.
    const a = allot({ available: 100, context: 500, recommendation: 500, strip: 80, minContext: 46, minRecommendation: 54 });
    expect(a).toEqual({ context: 46, recommendation: 54, columns: 80 });
  });
  test("more room never shrinks any region", () => {
    fc.assert(
      fc.property(input, fc.integer({ min: 0, max: 500 }), (i, more) => {
        const [a, b] = [allot(i), allot({ ...i, available: i.available + more })];
        expect(b.context).toBeGreaterThanOrEqual(a.context - 1e-9);
        expect(b.recommendation).toBeGreaterThanOrEqual(a.recommendation - 1e-9);
        expect(b.columns).toBeGreaterThanOrEqual(a.columns - 1e-9);
      }),
      RUNS,
    );
  });
  test("the strip is ten lines, or the closed columns' height if that is less", () => {
    fc.assert(fc.property(px, px, (closed, ten) => void expect(stripOf(closed, ten)).toBe(Math.min(closed, ten))), RUNS);
  });

  // A column: its height with every entry closed, and its entries' bodies, each open or not.
  const column = fc.record({ closed: fc.integer({ min: 0, max: 1000 }), bodies: fc.array(fc.record({ height: fc.integer({ min: 1, max: 900 }), open: fc.boolean() }), { maxLength: 5 }) });
  const measured = (c: { closed: number; bodies: readonly { height: number; open: boolean }[] }) => {
    const open = c.bodies.filter((b) => b.open).map((b) => b.height);
    return { content: c.closed + open.reduce((n, h) => n + h, 0), openBodies: open };
  };
  test("closedHeightOf is the tallest column's closed height, whichever entries are open", () => {
    fc.assert(
      fc.property(fc.array(column, { minLength: 1, maxLength: 4 }), fc.array(fc.boolean(), { maxLength: 20 }), (columns, flips) => {
        const expected = Math.max(...columns.map((c) => c.closed));
        expect(closedHeightOf(columns.map(measured))).toBe(expected);
        let k = 0;
        const flipped = columns.map((c) => ({ ...c, bodies: c.bodies.map((b) => ({ ...b, open: flips[k++] ?? b.open })) }));
        expect(closedHeightOf(flipped.map(measured))).toBe(expected);
      }),
      RUNS,
    );
  });
  test("closedHeightOf is never negative", () => {
    fc.assert(fc.property(fc.array(fc.record({ content: px, openBodies: fc.array(px, { maxLength: 3 }) }), { maxLength: 4 }), (cs) => void expect(closedHeightOf(cs)).toBeGreaterThanOrEqual(0)), RUNS);
  });
  test("a short closed column beside a long open one: the open column's own bodies are taken from it first", () => {
    expect(closedHeightOf([{ content: 1000, openBodies: [900] }, { content: 200, openBodies: [] }])).toBe(200);
  });
});
