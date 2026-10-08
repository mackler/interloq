import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { faviconHref } from "./favicon.ts";
import type { Mark } from "./notify.ts";

// Issue #16: the page's icon carries a badge while a prompt waits, or after a watched run ended unseen.
const COLORS = { base: "rgb(1, 2, 3)", badge: "rgb(200, 0, 0)", ended: "rgb(0, 100, 0)" };
const PREFIX = "data:image/svg+xml,";
const svgOf = (href: string): string => decodeURIComponent(href.slice(PREFIX.length));
const mark = fc.oneof(fc.constant<Mark>({ _tag: "Clear" }), fc.constant<Mark>({ _tag: "Waiting" }), fc.constantFrom(0, 1).map((code): Mark => ({ _tag: "Ended", code })));

describe("faviconHref", () => {
  it("is an SVG data URL with a badge only for a mark, in the mark's color", () => {
    const clear = faviconHref({ _tag: "Clear" }, COLORS);
    const waiting = faviconHref({ _tag: "Waiting" }, COLORS);
    const ended = faviconHref({ _tag: "Ended", code: 0 }, COLORS);
    for (const href of [clear, waiting, ended]) {
      expect(href.startsWith(PREFIX)).toBe(true);
      expect(svgOf(href)).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svgOf(href)).toContain(COLORS.base);
    }
    expect(svgOf(clear)).not.toContain("<circle");
    expect(svgOf(waiting)).toContain(`<circle class="badge" `);
    expect(svgOf(waiting)).toContain(COLORS.badge);
    expect(svgOf(ended)).toContain(`<circle class="badge" `);
    expect(svgOf(ended)).toContain(COLORS.ended);
  });
  it("property: the same for equal inputs, and a badge exactly when there is a mark", () => {
    fc.assert(
      fc.property(mark, (m) => {
        expect(faviconHref(m, COLORS)).toBe(faviconHref(m, COLORS));
        expect(svgOf(faviconHref(m, COLORS)).includes(`class="badge"`)).toBe(m._tag !== "Clear");
      }),
      { numRuns: 50 },
    );
  });
});
