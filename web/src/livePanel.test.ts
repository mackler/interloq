import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { type OutputEvent, type ProcessKey, SCROLLBACK_LINES, sanitizedOutput } from "../../src/liveOutput.ts";
import { outputEndedDetail, outputEndedLine, outputRunningName } from "../../src/prompts.ts";
import {
  applyOutput, EMPTY_OUTPUTS, EMPTY_PANEL, endedMarkOf, followsEnd, hasRunning, type LivePanel, lineText, outputsAfter, PROCESS_MARK, panelView,
} from "./livePanel.ts";
import { applySgr, DEFAULT_STYLE } from "./terminalColor.ts";

// Issue #49: the live panel's buffer; issue #221: its scrollback of 1,000 lines, its tags and whole names, its colors and icons.
const ESC = "\u001b";
const K = (k: string): ProcessKey => k as ProcessKey;
const started = (key: string, name = key): OutputEvent => ({ _tag: "Started", key: K(key), name });
const print = (key: string, text: string, name = key): OutputEvent => ({ _tag: "Printed", key: K(key), name, text });
const done = (key: string, code = 0, name = key): OutputEvent => ({ _tag: "Finished", key: K(key), name, status: { _tag: "Exited", code } });
const fold = (events: readonly OutputEvent[], from: LivePanel = EMPTY_PANEL): LivePanel => events.reduce(applyOutput, from);
const shown = (panel: LivePanel): string[] => panelView(panel).lines.map(lineText);
const outputTexts = (panel: LivePanel): string[] =>
  panelView(panel).lines.flatMap((l) => (l._tag === "Output" ? [l.runs.map((r) => r.text).join("")] : []));

describe("the live panel", () => {
  test("a process begins with a line of its tag, its mark and its whole name; its later lines carry the tag alone", () => {
    const p = fold([started("a"), started("b"), print("a", "one\n"), print("b", "two\n"), print("a", "three\n")]);
    expect(shown(p)).toEqual([`#1 ${PROCESS_MARK.running} a`, `#2 ${PROCESS_MARK.running} b`, "#1 one", "#2 two", "#1 three"]);
  });

  test("a name of 300 characters is shown whole on its begun line and in the running list", () => {
    const name = "x".repeat(150) + " " + "y".repeat(149);
    const v = panelView(fold([started("a", name)]));
    expect(v.lines[0]).toMatchObject({ _tag: "Begun", tag: "#1", name, mark: "running", label: outputRunningName(name, null) });
    expect(v.running).toEqual([{ key: "a", tag: "#1", name, mark: "running", label: outputRunningName(name, null), elapsed: null }]);
  });

  test("a partial line is shown at once and completed in place, keeping its position and its id", () => {
    const first = fold([started("a"), started("b"), print("a", "Runn")]);
    const id = first.lines.at(-1)?.id;
    const later = fold([print("b", "other\n"), print("a", "ing\nnext")], first);
    expect(outputTexts(later)).toEqual(["Running", "other", "next"]);
    expect(later.lines.find((l) => l._tag === "Output" && l.key === "a")?.id).toBe(id);
    expect(later.lines.map((l) => (l._tag === "Output" ? l.partial : null))).toEqual([null, null, false, false, true]);
  });

  test("a progress bar with carriage returns adds lines, and the same text in one chunk or two gives the same lines", () => {
    expect(outputTexts(fold([print("p", "10%\r20%\r30%\r")]))).toEqual(["10%", "20%", "30%"]);
    expect(fold([print("p", "first\r"), print("p", "\nsecond")]).lines).toEqual(fold([print("p", "first\r\nsecond")]).lines);
    expect(outputTexts(fold([print("p", "first\r"), print("q", "x\n"), print("p", "\nsecond")]))).toEqual(["first", "x", "second"]);
  });

  test("a color carries across chunks onto the next line, and a line of 2,000 characters is kept whole", () => {
    const p = fold([print("a", `${ESC}[31mred `), print("a", `still\nnext${ESC}[0m plain\n`), print("a", "z".repeat(2000) + "\n")]);
    const red = applySgr(DEFAULT_STYLE, "31");
    const lines = panelView(p).lines.filter((l) => l._tag === "Output");
    expect(lines.map((l) => (l._tag === "Output" ? l.runs : null))).toEqual([
      [{ text: "red still", style: red }],
      [{ text: "next", style: red }, { text: " plain", style: DEFAULT_STYLE }],
      [{ text: "z".repeat(2000), style: DEFAULT_STYLE }],
    ]);
  });

  test("a silent running process is running; its end is a line with its mark, accessible name and detail", () => {
    const running = fold([started("suite:1", "suite")]);
    expect(hasRunning(running)).toBe(true);
    expect(panelView(running).running.map((r) => r.name)).toEqual(["suite"]);
    const status = { _tag: "Exited", code: 1 } as const;
    const ended = fold([{ _tag: "Finished", key: K("suite:1"), name: "suite", status }], running);
    const v = panelView(ended);
    expect(v.running).toEqual([]);
    expect(v.lines[0]).toMatchObject({ _tag: "Begun", mark: "failed", label: outputEndedLine("suite", status) });
    expect(v.lines[1]).toEqual({ _tag: "Ended", id: ended.lines[1]?.id, tag: "#1", mark: "failed", label: outputEndedLine("suite", status), detail: outputEndedDetail(status) });
    expect(panelView(EMPTY_PANEL).empty).toBe(true);
    expect(v.empty).toBe(false);
  });

  test("each ending has its mark", () => {
    expect(endedMarkOf({ _tag: "Exited", code: 0 })).toBe("succeeded");
    expect(endedMarkOf({ _tag: "Succeeded" })).toBe("succeeded");
    for (const s of [{ _tag: "Exited", code: 2 }, { _tag: "Signaled", signal: "SIGKILL" }, { _tag: "TimedOut" }, { _tag: "NotStarted" }, { _tag: "Failed" }] as const)
      expect(endedMarkOf(s)).toBe("failed");
    expect(endedMarkOf({ _tag: "Stopped" })).toBe("stopped");
    expect(endedMarkOf({ _tag: "Unknown" })).toBe("unknown");
  });

  test("a panel that never saw a Started registers the process from later events", () => {
    const p = fold([print("t:9", "half", "npm test"), done("t:9", 1, "npm test")]);
    expect(shown(p)).toEqual([`#1 ${PROCESS_MARK.failed} npm test`, "#1 half", `#1 ${PROCESS_MARK.failed} exit 1`]);
    expect(hasRunning(p)).toBe(false);
  });

  test("outputsAfter keeps each run's panel apart", () => {
    const o = outputsAfter(outputsAfter(EMPTY_OUTPUTS, { run: 1, event: print("a", "x\n") }), { run: 2, event: print("a", "y\n") });
    expect(outputTexts(o.get(1)!)).toEqual(["x"]);
    expect(outputTexts(o.get(2)!)).toEqual(["y"]);
  });

  test("followsEnd is true within 4 px of the end", () => {
    expect(followsEnd(96, 100, 200)).toBe(true);
    expect(followsEnd(95, 100, 200)).toBe(false);
    expect(followsEnd(0, 100, 50)).toBe(true);
  });
});

const KEYS = ["a", "b", "c"];
const arbText = fc.array(fc.constantFrom("x", "y", " ", "\n", "\r", "\r\n", `${ESC}[31m`, `${ESC}[0m`), { maxLength: 12 }).map((cs) => cs.join(""));
const arbEvent: fc.Arbitrary<OutputEvent> = fc.oneof(
  fc.constantFrom(...KEYS).map((k) => started(k)),
  fc.tuple(fc.constantFrom(...KEYS), fc.oneof(fc.constant(""), arbText)).map(([k, t]) => print(k, t)),
  fc.tuple(fc.constantFrom(...KEYS), fc.nat(99)).map(([k, s]): OutputEvent => ({ _tag: "Progress", key: K(k), name: k, seconds: s })),
  fc.constantFrom(...KEYS).map((k) => done(k)),
  fc.constant<OutputEvent>({ _tag: "Touched", name: "Read a.txt" }),
);

describe("the live panel's invariants", () => {
  test("at most 1,000 lines, ids ascending, the oldest dropped first, and no ended process without a line", () => {
    const many = fold(Array.from({ length: SCROLLBACK_LINES + 200 }, (_, i) => print("a", `line ${i}\n`)));
    expect(many.lines.length).toBe(SCROLLBACK_LINES);
    expect(outputTexts(many).at(0)).toBe("line 200");
    expect(outputTexts(many).at(-1)).toBe(`line ${SCROLLBACK_LINES + 199}`);
    // W1-R1-2: an empty text of a process never seen still trims the panel to the bound.
    const full = fold(Array.from({ length: SCROLLBACK_LINES }, (_, i) => ({ _tag: "Touched", name: `t${i}` }) as OutputEvent));
    const after = applyOutput(full, print("new", ""));
    expect(after.lines.length).toBe(SCROLLBACK_LINES);
    expect(after.lines[0]).toMatchObject({ _tag: "Touched", text: "t1" });
    expect(after.lines.at(-1)).toMatchObject({ _tag: "Begun", key: "new" });
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 60 }), fc.integer({ min: 0, max: SCROLLBACK_LINES }), (events, filler) => {
        let p = fold(Array.from({ length: filler }, () => ({ _tag: "Touched", name: "f" }) as OutputEvent));
        for (const e of events) {
          const before = p;
          p = applyOutput(p, e);
          expect(p.lines.length).toBeLessThanOrEqual(SCROLLBACK_LINES);
          const ids = p.lines.map((l) => l.id);
          expect(ids).toEqual([...ids].sort((x, y) => x - y));
          expect(new Set(ids).size).toBe(ids.length);
          // What survives of the earlier lines is a suffix of them, apart from a partial line extended in place.
          const kept = before.lines.filter((l) => ids.includes(l.id)).map((l) => l.id);
          expect(kept).toEqual(before.lines.slice(before.lines.length - kept.length).map((l) => l.id));
          for (const [key, info] of p.processes)
            if (info.state._tag === "Ended") expect(p.lines.some((l) => "key" in l && l.key === key)).toBe(true);
        }
      }),
      { numRuns: 200, seed: 221 },
    );
  });

  test("a CR-free text split anywhere outside an SGR sequence gives the sanitized text's lines, colors removed", () => {
    const tokens = fc.array(fc.constantFrom("a", "b", " ", "\n", `${ESC}[31m`, `${ESC}[0m`), { maxLength: 30 });
    fc.assert(
      fc.property(tokens, fc.array(fc.boolean(), { maxLength: 30 }), (parts, cuts) => {
        const chunks: string[] = [];
        let current = "";
        parts.forEach((t, i) => {
          current += t;
          if (cuts[i] === true) (chunks.push(current), (current = ""));
        });
        chunks.push(current);
        const text = parts.join("");
        const split = fold(chunks.map((c) => print("p", c)));
        expect(split.lines).toEqual(fold([print("p", text)]).lines);
        expect(outputTexts(split).join("\n")).toBe(sanitizedOutput(text).replace(/\u001b\[[0-9;:]*m/gu, "").replace(/\n$/u, ""));
      }),
      { numRuns: 300, seed: 4949 },
    );
  });

  test("a name is never shortened", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 400 }), (name) => {
        const v = panelView(fold([started("a", name), print("a", "x\n")]));
        expect(v.lines[0]).toMatchObject({ _tag: "Begun", name });
        expect(v.running[0]?.name).toBe(name);
      }),
      { numRuns: 100, seed: 2211 },
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
