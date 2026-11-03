import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ownName } from "../../src/hostDir.ts";
import { endMarkOf, LIMIT_PAUSED_MARK, RUNNING_MARK, TITLE_ENDED_MARK, TITLE_UNFINISHED_MARK, TITLE_WAITING_MARK } from "../../src/prompts.ts";
import { type Mark, markGlyph } from "./notify.ts";
import { tabTitle } from "./title.ts";

// Issue #29: the tab's title is the directory's own name, an em dash and Interloq; Interloq alone without a location.
describe("tabTitle", () => {
  it("names the directory's own name before Interloq, never the full path", () => {
    expect(tabTitle("/home/mackler/work/interloq-dev")).toBe("interloq-dev — Interloq");
    expect(tabTitle("/workspace")).toBe("workspace — Interloq");
    expect(tabTitle("/")).toBe("/ — Interloq");
    expect(tabTitle(null)).toBe("Interloq");
  });
  it("property: begins with the location's own name, the top bar's headline, and ends with Interloq", () => {
    fc.assert(
      fc.property(fc.string(), (location) => {
        const title = tabTitle(location);
        expect(title.startsWith(ownName(location))).toBe(true);
        expect(title.endsWith(" — Interloq")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// Issue #16: a pause or an unseen end puts its marker in front of the title, which keeps the project.
const WAITING: Mark = { _tag: "Waiting" };
const glyphOf = markGlyph;
const mark = fc.oneof(
  fc.constant<Mark>({ _tag: "Clear" }),
  fc.constant<Mark>(WAITING),
  fc.constant<Mark>({ _tag: "Running" }),
  fc.constant<Mark>({ _tag: "LimitPaused", pause: { fromMs: 0, untilMs: 60_000, known: true } }),
  fc.constantFrom(0, 1, 130).map((code): Mark => ({ _tag: "Ended", code })),
);
describe("tabTitle's marker", () => {
  it("puts the marker before the title it would have without one", () => {
    const path = "/home/mackler/work/interloq-dev";
    expect(tabTitle(path, WAITING)).toBe(`${TITLE_WAITING_MARK} ${tabTitle(path)}`);
    expect(tabTitle(path, { _tag: "Ended", code: 0 })).toBe(`${TITLE_ENDED_MARK} ${tabTitle(path)}`);
    expect(tabTitle(null, WAITING)).toBe(`${TITLE_WAITING_MARK} ${tabTitle(null)}`);
    expect(TITLE_WAITING_MARK).not.toBe(TITLE_ENDED_MARK);
  });
  // Issue #139: a working run and a run paused for a usage limit are marked too, by the tab's glyphs.
  it("marks a working run ◌ and a paused one ‖", () => {
    expect(tabTitle("/p", { _tag: "Running" })).toBe(`${RUNNING_MARK} ${tabTitle("/p")}`);
    expect(tabTitle("/p", { _tag: "LimitPaused", pause: { fromMs: 0, untilMs: 1, known: false } })).toBe(`${LIMIT_PAUSED_MARK} ${tabTitle("/p")}`);
  });
  // Issue #209: ✓ for a finished run, ✕ for any other end.
  it("marks a finished end ✓ and a halted, abandoned or stopped one ✕", () => {
    const path = "/p";
    expect(tabTitle(path, { _tag: "Ended", code: 0 }).startsWith(`${TITLE_ENDED_MARK} `)).toBe(true);
    for (const code of [1, 2, 130]) expect(tabTitle(path, { _tag: "Ended", code })).toBe(`${TITLE_UNFINISHED_MARK} ${tabTitle(path)}`);
    fc.assert(fc.property(fc.integer(), (code) => tabTitle(path, { _tag: "Ended", code }) === `${endMarkOf(code)} ${tabTitle(path)}`), { numRuns: 100 });
  });
  it("property: keeps the project's title, begins with the mark's glyph, and is unchanged without a mark", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), mark, (location, m) => {
        const title = tabTitle(location, m);
        expect(title.endsWith(tabTitle(location))).toBe(true);
        const glyph = glyphOf(m);
        if (glyph === null) expect(title).toBe(tabTitle(location));
        else expect(title.startsWith(`${glyph} `)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
