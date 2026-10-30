import { describe, expect, test } from "vitest";
import fc from "fast-check";
import type { OutputEvent, ProcessKey } from "../../src/liveOutput.ts";
import { LIVE_OUTPUT_EMPTY, OUTPUT_FINISHED_HEADER, outputEndedLine } from "../../src/prompts.ts";
import { applyOutput, EMPTY_OUTPUTS, EMPTY_PANEL, hasRunning, LINE_LIMIT, type LivePanel, lineText, outputsAfter, PANEL_LINES, panelView } from "./livePanel.ts";

// Issue #49: the live panel's buffer.
const K = (k: string): ProcessKey => k as ProcessKey;
const started = (key: string, name = key): OutputEvent => ({ _tag: "Started", key: K(key), name });
const print = (key: string, text: string, name = key): OutputEvent => ({ _tag: "Printed", key: K(key), name, text });
const done = (key: string, code = 0, name = key): OutputEvent => ({ _tag: "Finished", key: K(key), name, status: { _tag: "Exited", code } });
const fold = (events: readonly OutputEvent[], from: LivePanel = EMPTY_PANEL): LivePanel => events.reduce(applyOutput, from);
const shown = (panel: LivePanel): string[] => panel.lines.map(lineText);

describe("the live panel", () => {
  test("two processes interleave, each line after its name", () => {
    const p = fold([started("a"), started("b"), print("a", "one\n"), print("b", "two\n"), print("a", "three\n")]);
    expect(shown(p)).toEqual(["a | one", "b | two", "a | three"]);
  });

  test("a partial line is shown at once and completed in place, keeping its position", () => {
    const first = fold([started("a"), started("b"), print("a", "Runn")]);
    expect(first.lines).toEqual([{ _tag: "Output", key: "a", name: "a", text: "Runn", partial: true }]);
    const later = fold([print("b", "other\n"), print("a", "ing\nnext")], first);
    expect(shown(later)).toEqual(["a | Running", "b | other", "a | next"]);
    expect(later.lines.map((l) => (l._tag === "Output" ? l.partial : null))).toEqual([false, false, true]);
  });

  test("a process printing without a newline is visible while it runs", () => {
    expect(shown(fold([print("r", "Reading the plan"), print("r", " and the diff")]))).toEqual(["r | Reading the plan and the diff"]);
  });

  test("a progress bar with carriage returns adds lines, and the same text in one chunk or two gives the same lines", () => {
    expect(shown(fold([print("p", "10%\r20%\r30%\r")]))).toEqual(["p | 10%", "p | 20%", "p | 30%"]);
    expect(shown(fold([print("p", "first\r"), print("p", "\nsecond")]))).toEqual(shown(fold([print("p", "first\r\nsecond")])));
    expect(shown(fold([print("p", "first\r"), print("q", "x\n"), print("p", "\nsecond")]))).toEqual(["p | first", "q | x", "p | second"]);
    expect(shown(fold([print("p", "a\r"), print("p", "b")]))).toEqual(["p | a", "p | b"]);
  });

  test("a silent running process keeps the running header; an end keeps the lines under the finished header", () => {
    const running = fold([started("suite:1", "suite"), print("suite:1", "ok 1\n")]);
    expect(panelView(running, PANEL_LINES).header).toMatch(/suite/u);
    expect(panelView(running, PANEL_LINES).header).not.toBe(OUTPUT_FINISHED_HEADER);
    const ended = fold([done("suite:1", 0, "suite")], running);
    expect(panelView(ended, PANEL_LINES)).toEqual({ header: OUTPUT_FINISHED_HEADER, lines: [ended.lines[0], { _tag: "Ended", text: outputEndedLine("suite", { _tag: "Exited", code: 0 }) }] });
    expect(panelView(EMPTY_PANEL, PANEL_LINES).header).toBe(LIVE_OUTPUT_EMPTY);
  });

  test("a panel that never saw a Started shows the name from later events and no running process after the end", () => {
    const p = fold([print("t:9", "half", "npm test"), done("t:9", 1, "npm test")]);
    expect(shown(p)).toEqual(["npm test | half", outputEndedLine("npm test", { _tag: "Exited", code: 1 })]);
    expect(p.running.size).toBe(0);
  });

  test("outputsAfter keeps each run's panel apart", () => {
    const o = outputsAfter(outputsAfter(EMPTY_OUTPUTS, { run: 1, event: print("a", "x\n") }), { run: 2, event: print("a", "y\n") });
    expect(shown(o.get(1)!)).toEqual(["a | x"]);
    expect(shown(o.get(2)!)).toEqual(["a | y"]);
  });
});

const KEYS = ["a", "b", "c"];
const arbText = fc.array(fc.constantFrom("x", "y", " ", "\n", "\r", "\r\n"), { maxLength: 12 }).map((cs) => cs.join(""));
const arbEvent: fc.Arbitrary<OutputEvent> = fc.oneof(
  fc.constantFrom(...KEYS).map((k) => started(k)),
  fc.tuple(fc.constantFrom(...KEYS), fc.oneof(arbText, fc.string({ minLength: LINE_LIMIT, maxLength: LINE_LIMIT + 40 }))).map(([k, t]) => print(k, t)),
  fc.tuple(fc.constantFrom(...KEYS), fc.nat(99)).map(([k, s]): OutputEvent => ({ _tag: "Progress", key: K(k), name: k, seconds: s })),
  fc.constantFrom(...KEYS).map((k) => done(k)),
  fc.constant<OutputEvent>({ _tag: "Touched", name: "Read a.txt" }),
);

describe("the live panel's invariants", () => {
  test("bounded lines, clipped lines, one ended line per Finished, and the finished header exactly when nothing runs", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 60 }), (events) => {
        let p = EMPTY_PANEL;
        for (const e of events) {
          const before = p;
          p = applyOutput(p, e);
          expect(p.lines.length).toBeLessThanOrEqual(PANEL_LINES);
          for (const l of p.lines) expect(l.text.length).toBeLessThanOrEqual(LINE_LIMIT);
          if (e._tag === "Finished") {
            expect(p.running.has(e.key)).toBe(false);
            expect(p.lines.at(-1)?._tag).toBe("Ended");
            const endedBefore = before.lines.filter((l) => l._tag === "Ended").length;
            const endedAfter = p.lines.filter((l) => l._tag === "Ended").length;
            expect(endedAfter === endedBefore + 1 || (before.lines.length === PANEL_LINES && endedAfter <= endedBefore + 1)).toBe(true);
          }
          const header = panelView(p, PANEL_LINES).header;
          expect(header === OUTPUT_FINISHED_HEADER).toBe(p.running.size === 0 && p.lines.length > 0);
        }
      }),
      { numRuns: 300, seed: 49 },
    );
  });

  test("any split of one process's text gives the lines of the unsplit text", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "\n", "\r", "\r\n", " "), { maxLength: 30 }), fc.array(fc.nat(), { maxLength: 5 }), (chars, cuts) => {
        const text = chars.join("");
        const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((x, y) => x - y);
        const chunks = [0, ...points].map((at, i, all) => text.slice(at, all[i + 1] ?? text.length));
        expect(fold(chunks.map((c) => print("p", c))).lines).toEqual(fold([print("p", text)]).lines);
      }),
      { numRuns: 300, seed: 4949 },
    );
  });
});

// Issue #200, requirements Q2: whether a process runs, the one source of the compact panel's presence and limit.
describe("hasRunning", () => {
  const touched: OutputEvent = { _tag: "Touched", name: "Read a.txt" };
  test("an empty panel has nothing running", () => expect(hasRunning(EMPTY_PANEL)).toBe(false));
  test("a process started and silent is running", () => expect(hasRunning(fold([started("a")]))).toBe(true));
  test("a process started then finished is not running", () => expect(hasRunning(fold([started("a"), done("a")]))).toBe(false));
  test("a tool touched alone runs nothing", () => expect(hasRunning(fold([touched]))).toBe(false));
  test("two started and one finished leaves one running", () =>
    expect(hasRunning(fold([started("a"), started("b"), done("a")]))).toBe(true));
  test("it equals a model of the processes named and not yet finished", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 60 }), (events) => {
        const model = events.reduce<ReadonlySet<string>>(
          (keys, e) =>
            e._tag === "Touched" ? keys : e._tag === "Finished" ? new Set([...keys].filter((k) => k !== e.key)) : new Set([...keys, e.key]),
          new Set(),
        );
        expect(hasRunning(fold(events))).toBe(model.size > 0);
      }),
      { numRuns: 300, seed: 200 },
    );
  });
});
