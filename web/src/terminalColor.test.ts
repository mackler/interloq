// Issue #221: SGR parameters to colored runs, on the live panel's black background.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { applySgr, cssColor, DEFAULT_STYLE, type StyledRun, styleText, type TermStyle } from "./terminalColor.ts";

const ESC = "\u001b";
const rgb = (r: number, g: number, b: number) => ({ r, g, b });
const fg = (style: TermStyle) => style.fg;

describe("applySgr", () => {
  test("the 16 colors, foreground and background, and their resets", () => {
    expect(fg(applySgr(DEFAULT_STYLE, "31"))).toEqual(rgb(0xe0, 0x55, 0x61));
    expect(fg(applySgr(DEFAULT_STYLE, "91"))).toEqual(rgb(0xff, 0x61, 0x6e));
    expect(applySgr(DEFAULT_STYLE, "44").bg).toEqual(rgb(0x4a, 0xa5, 0xf0));
    expect(applySgr(DEFAULT_STYLE, "107").bg).toEqual(rgb(0xff, 0xff, 0xff));
    expect(fg(applySgr(DEFAULT_STYLE, "30"))).toEqual(rgb(0x4c, 0x4c, 0x4c));
    const both = applySgr(DEFAULT_STYLE, "31;42");
    expect(applySgr(both, "39")).toEqual({ fg: null, bg: both.bg });
    expect(applySgr(both, "49")).toEqual({ fg: both.fg, bg: null });
    expect(applySgr(both, "0")).toEqual(DEFAULT_STYLE);
    expect(applySgr(both, "")).toEqual(DEFAULT_STYLE);
  });

  test("256 colors and truecolor, in the semicolon and the colon forms", () => {
    expect(fg(applySgr(DEFAULT_STYLE, "38;5;196"))).toEqual(rgb(255, 0, 0));
    expect(fg(applySgr(DEFAULT_STYLE, "38;5;244"))).toEqual(rgb(128, 128, 128));
    expect(fg(applySgr(DEFAULT_STYLE, "38;5;9"))).toEqual(rgb(0xff, 0x61, 0x6e));
    expect(fg(applySgr(DEFAULT_STYLE, "38;2;1;2;3"))).toEqual(rgb(1, 2, 3));
    expect(applySgr(DEFAULT_STYLE, "48:2::10:20:30").bg).toEqual(rgb(10, 20, 30));
    expect(applySgr(DEFAULT_STYLE, "48:2:10:20:30").bg).toEqual(rgb(10, 20, 30));
    expect(fg(applySgr(DEFAULT_STYLE, "38:5:21"))).toEqual(rgb(0, 0, 255));
  });

  test("every other code, and a color out of range or incomplete, changes nothing", () => {
    expect(applySgr(DEFAULT_STYLE, "1")).toEqual(DEFAULT_STYLE);
    expect(applySgr(DEFAULT_STYLE, "4;7")).toEqual(DEFAULT_STYLE);
    expect(applySgr(DEFAULT_STYLE, "38;5;300")).toEqual(DEFAULT_STYLE);
    expect(applySgr(DEFAULT_STYLE, "38;2;1;2")).toEqual(DEFAULT_STYLE);
    expect(applySgr(DEFAULT_STYLE, "38;2;1;2;999")).toEqual(DEFAULT_STYLE);
    expect(fg(applySgr(DEFAULT_STYLE, "1;31"))).toEqual(rgb(0xe0, 0x55, 0x61));
  });
});

describe("styleText", () => {
  test("splits at SGR sequences, merges equal runs and drops empty ones", () => {
    const red = applySgr(DEFAULT_STYLE, "31");
    const [after, runs] = styleText(DEFAULT_STYLE, `${ESC}[31mred${ESC}[1m more${ESC}[0m plain${ESC}[32m`);
    expect(runs).toEqual([
      { text: "red more", style: red },
      { text: " plain", style: DEFAULT_STYLE },
    ]);
    expect(fg(after)).toEqual(rgb(0x8c, 0xc2, 0x65));
    expect(styleText(after, "next")[1]).toEqual([{ text: "next", style: after }]);
    expect(styleText(DEFAULT_STYLE, `a${ESC}b`)[1]).toEqual([{ text: "ab", style: DEFAULT_STYLE }]);
    expect(cssColor(rgb(224, 85, 97))).toBe("rgb(224, 85, 97)");
  });

  const arbSgr = fc.tuple(fc.array(fc.constantFrom("0", "1", "31", "38", "48", "5", "2", "196", "255", "300", "", "39", "49", "97"), { maxLength: 7 }), fc.constantFrom(";", ":")).map(([ps, sep]) => `${ESC}[${ps.join(sep)}m`);
  const arbPlain = fc.string({ maxLength: 10 }).filter((t) => !t.includes(ESC));
  const arbParts = fc.array(fc.oneof(arbPlain, arbSgr), { maxLength: 10 });
  const SGR = /\u001b\[[0-9;:]*m/gu;
  const joined = (runs: readonly StyledRun[]) => runs.map((r) => r.text).join("");
  const component = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;

  test("the runs' texts are the input without its SGR sequences, hold no ESC, and every component is a byte", () => {
    fc.assert(
      fc.property(arbParts, (parts) => {
        const text = parts.join("");
        const [style, runs] = styleText(DEFAULT_STYLE, text);
        expect(joined(runs)).toBe(text.replace(SGR, ""));
        for (const r of runs) {
          expect(r.text.includes(ESC)).toBe(false);
          expect(r.text).not.toBe("");
          for (const c of [r.style.fg, r.style.bg]) if (c !== null) expect([c.r, c.g, c.b].every(component)).toBe(true);
        }
        for (const c of [style.fg, style.bg]) if (c !== null) expect([c.r, c.g, c.b].every(component)).toBe(true);
      }),
      { numRuns: 200, seed: 20261102 },
    );
  });

  test("styling pieces split outside SGR sequences, the style threaded, equals styling the whole", () => {
    fc.assert(
      fc.property(arbParts, fc.array(fc.boolean(), { maxLength: 10 }), (parts, cuts) => {
        const pieces: string[] = [];
        let current = "";
        parts.forEach((p, i) => {
          current += p;
          if (cuts[i] === true) {
            pieces.push(current);
            current = "";
          }
        });
        pieces.push(current);
        let style = DEFAULT_STYLE;
        const runs: StyledRun[] = [];
        for (const piece of pieces) {
          const [next, rs] = styleText(style, piece);
          style = next;
          runs.push(...rs);
        }
        const [whole, wholeRuns] = styleText(DEFAULT_STYLE, parts.join(""));
        expect(style).toEqual(whole);
        const merged = runs.reduce<StyledRun[]>((acc, r) => {
          const last = acc.at(-1);
          if (last !== undefined && JSON.stringify(last.style) === JSON.stringify(r.style)) acc[acc.length - 1] = { text: last.text + r.text, style: r.style };
          else acc.push(r);
          return acc;
        }, []);
        expect(merged).toEqual(wholeRuns);
      }),
      { numRuns: 200, seed: 20261102 },
    );
  });
});
