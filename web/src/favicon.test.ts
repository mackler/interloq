import { arbEnding } from "../../test/endingArbitraries.ts";
import { ABANDONED, COMPLETED, ENDINGS, HALTED, SENT_BACK_PARKED, UNESTABLISHED_ENDING, endedMark } from "../../test/endingFixtures.ts";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { faviconHref } from "./favicon.ts";
import type { Mark } from "./notify.ts";
import { endingMarkOf, LIMIT_PAUSED_MARK, RUNNING_MARK } from "../../src/prompts.ts";

// Issue #16: the page's icon carries a badge while a prompt waits, or after a watched run ended unseen.
const COLORS = { base: "rgb(1, 2, 3)", badge: "rgb(200, 0, 0)", ended: "rgb(0, 100, 0)", working: "rgb(50, 50, 80)" };
const PREFIX = "data:image/svg+xml,";
const svgOf = (href: string): string => decodeURIComponent(href.slice(PREFIX.length));
const mark = fc.oneof(fc.constant<Mark>({ _tag: "Clear" }), fc.constant<Mark>({ _tag: "Waiting" }), fc.constant<Mark>({ _tag: "Running" }), fc.constant<Mark>({ _tag: "LimitPaused", pause: { fromMs: 0, untilMs: 1, known: true } }), arbEnding.map((ending): Mark => ({ _tag: "Ended", ending })));

describe("faviconHref", () => {
  it("is an SVG data URL with a badge only for a mark, in the mark's color", () => {
    const clear = faviconHref({ _tag: "Clear" }, COLORS);
    const waiting = faviconHref({ _tag: "Waiting" }, COLORS);
    const ended = faviconHref(endedMark(COMPLETED), COLORS);
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
  // Issue #209: an end's badge carries ✓ or ✕; the waiting badge stays a plain dot.
  it("puts the end's mark in its badge, and none in a waiting or clear icon", () => {
    for (const ending of ENDINGS) expect(svgOf(faviconHref(endedMark(ending), COLORS))).toMatch(new RegExp(`<text class="badge-mark"[^>]*>${endingMarkOf(ending)}</text>`));
    expect(svgOf(faviconHref({ _tag: "Waiting" }, COLORS))).not.toContain("badge-mark");
    expect(svgOf(faviconHref({ _tag: "Clear" }, COLORS))).not.toContain("badge");
  });
  // Issue #139: halted is the alert, in the error color with ✕; finished in tertiary with ✓; working and paused in their own color with their glyph.
  it("draws each of the five marks in its color with its glyph", () => {
    const halted = svgOf(faviconHref(endedMark(HALTED), COLORS));
    expect(halted).toContain(`fill="${COLORS.badge}"`);
    expect(halted).toContain(`>${endingMarkOf(HALTED)}</text>`);
    const finished = svgOf(faviconHref(endedMark(COMPLETED), COLORS));
    expect(finished).toContain(`fill="${COLORS.ended}"`);
    expect(finished).not.toContain(`fill="${COLORS.badge}"`);
    const running = svgOf(faviconHref({ _tag: "Running" }, COLORS));
    expect(running).toContain(`fill="${COLORS.working}"`);
    expect(running).toContain(`>${RUNNING_MARK}</text>`);
    const paused = svgOf(faviconHref({ _tag: "LimitPaused", pause: { fromMs: 0, untilMs: 1, known: true } }, COLORS));
    expect(paused).toContain(`fill="${COLORS.working}"`);
    expect(paused).toContain(`>${LIMIT_PAUSED_MARK}</text>`);
  });
});

// Issue #44: each ending's own glyph, the error color for a halt and an abandonment alone (decision Q2).
describe("the badge of each ending", () => {
  it("a send-back in the ended color with ↩, an abandonment in the badge color with ⧗, an unestablished end with – and never ✓", () => {
    const sentBack = svgOf(faviconHref(endedMark(SENT_BACK_PARKED), COLORS));
    expect(sentBack).toContain(`fill="${COLORS.ended}"`);
    expect(sentBack).toContain(">↩</text>");
    const abandoned = svgOf(faviconHref(endedMark(ABANDONED), COLORS));
    expect(abandoned).toContain(`fill="${COLORS.badge}"`);
    expect(abandoned).toContain(">⧗</text>");
    const unestablished = svgOf(faviconHref(endedMark(UNESTABLISHED_ENDING), COLORS));
    expect(unestablished).toContain(">–</text>");
    expect(unestablished).not.toContain("✓");
  });
});
