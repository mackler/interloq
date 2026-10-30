// Issue #202: the scroll position that brings the selected tab of a sideways-scrolling row into view.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { tabScrollLeft, type Span } from "./tabRow.ts";

const px = fc.integer({ min: 0, max: 5000 });
/** A row's content width, a tab within it, and a view whose start is a scroll position the row can hold. */
const cases = fc
  .tuple(px, px, px, px, px)
  .map(([a, b, c, viewWidth, start]) => {
    const [tabLeft, tabEnd, scrollWidth] = [a, b, c].sort((x, y) => x - y) as [number, number, number];
    const max = Math.max(0, scrollWidth - viewWidth);
    const view: Span = { left: max === 0 ? 0 : start % (max + 1), width: viewWidth };
    const tab: Span = { left: tabLeft, width: tabEnd - tabLeft };
    return { view, tab, scrollWidth, max };
  });

describe("tabScrollLeft", () => {
  test("the result is a scroll position the row can hold", () => {
    fc.assert(fc.property(cases, ({ view, tab, scrollWidth, max }) => {
      const result = tabScrollLeft(view, tab, scrollWidth);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(max);
    }));
  });

  test("a tab no wider than the view lies wholly in view", () => {
    fc.assert(fc.property(cases.filter(({ view, tab }) => tab.width <= view.width), ({ view, tab, scrollWidth }) => {
      const result = tabScrollLeft(view, tab, scrollWidth);
      expect(tab.left).toBeGreaterThanOrEqual(result);
      expect(tab.left + tab.width).toBeLessThanOrEqual(result + view.width);
    }));
  });

  test("a tab already wholly in view moves nothing", () => {
    fc.assert(fc.property(cases.filter(({ view, tab }) => tab.left >= view.left && tab.left + tab.width <= view.left + view.width), ({ view, tab, scrollWidth }) => {
      expect(tabScrollLeft(view, tab, scrollWidth)).toBe(view.left);
    }));
  });

  test("applying it again changes nothing", () => {
    fc.assert(fc.property(cases, ({ view, tab, scrollWidth }) => {
      const once = tabScrollLeft(view, tab, scrollWidth);
      expect(tabScrollLeft({ left: once, width: view.width }, tab, scrollWidth)).toBe(once);
    }));
  });

  test("a seventh tab past the right edge of a 640 px row is brought to the edge", () => {
    expect(tabScrollLeft({ left: 0, width: 640 }, { left: 1500, width: 300 }, 1800)).toBe(1160);
  });

  test("a tab left of the view after the row was scrolled is brought to the start", () => {
    expect(tabScrollLeft({ left: 900, width: 640 }, { left: 100, width: 300 }, 1800)).toBe(100);
  });
});
