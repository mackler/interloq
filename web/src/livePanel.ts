// The dashboard's live panel (issue #49): the last lines the running processes of a run printed, as they arrived over
// this tab's connection. Pure, and outside the replayed reducer of web/src/state.ts: nothing here is rebuilt from a
// replay, and the page empties it on every hello, since the panel holds only what arrived since this tab connected.
import type { OutputEvent } from "../../src/liveOutput.ts";
import { LIVE_OUTPUT_EMPTY, OUTPUT_FINISHED_HEADER, outputEndedLine, outputRunningHeader } from "../../src/prompts.ts";

/** The lines the full dashboard's panel shows: a glimpse, not a log (requirements: 10 to 20 lines). */
export const PANEL_LINES = 12;
/** The lines the compact dashboard's panel shows, under a question or beside a decision. */
export const COMPACT_PANEL_LINES = 4;
/** The characters a line keeps, a partial one included; the rest is clipped, which bounds the panel's memory. */
export const LINE_LIMIT = 500;

/** One line of the panel: a process's output (`partial` while its process may still extend it), an ended line, or a tool named. */
export type PanelLine =
  | Readonly<{ _tag: "Output"; key: string; name: string; text: string; partial: boolean }>
  | Readonly<{ _tag: "Ended"; text: string }>
  | Readonly<{ _tag: "Touched"; text: string }>;

/** A process running: its name, its elapsed seconds where known, and whether its last text ended in a carriage return. */
export type RunningProcess = Readonly<{ name: string; seconds: number | null; afterCr: boolean }>;

/** The panel of one run: its last lines in arrival order, and its running processes by key in first-seen order. */
export type LivePanel = Readonly<{ lines: readonly PanelLine[]; running: ReadonlyMap<string, RunningProcess> }>;
export const EMPTY_PANEL: LivePanel = { lines: [], running: new Map() };

const clip = (text: string): string => (text.length <= LINE_LIMIT ? text : text.slice(0, LINE_LIMIT));
const kept = (lines: readonly PanelLine[]): readonly PanelLine[] => (lines.length <= PANEL_LINES ? lines : lines.slice(lines.length - PANEL_LINES));
const isPartialOf = (line: PanelLine, key: string): boolean => line._tag === "Output" && line.key === key && line.partial;

/** The process registered from whichever event names it first: a tab that connected after its Started still knows it. */
const registered = (panel: LivePanel, key: string, name: string): LivePanel =>
  panel.running.has(key) ? panel : { ...panel, running: new Map([...panel.running, [key, { name, seconds: null, afterCr: false }]]) };
const withRunning = (panel: LivePanel, key: string, f: (p: RunningProcess) => RunningProcess): LivePanel => {
  const p = panel.running.get(key);
  return p === undefined ? panel : { ...panel, running: new Map([...panel.running].map(([k, v]) => [k, k === key ? f(v) : v])) };
};

/**
 * A process's text on the panel. A line feed that completes a carriage return split across chunks is dropped; a lone
 * carriage return ends a line, so a progress bar adds lines rather than growing one forever; the text before the first
 * break extends the process's partial line, which keeps the place it first appeared; the text after the last break is
 * the new partial line, shown at once and completed in place as more arrives.
 */
const printed = (panel: LivePanel, key: string, name: string, raw: string): LivePanel => {
  const before = registered(panel, key, name);
  const afterCr = before.running.get(key)?.afterCr === true;
  const text = afterCr && raw.startsWith("\n") ? raw.slice(1) : raw;
  if (text === "") return withRunning(before, key, (p) => ({ ...p, afterCr: raw === "" ? p.afterCr : false }));
  const parts = text.split(/\r\n|\r|\n/u);
  const [first, ...rest] = parts;
  const at = before.lines.findIndex((l) => isPartialOf(l, key));
  const complete = rest.length > 0;
  const head = first ?? "";
  const extended: readonly PanelLine[] =
    at >= 0
      ? before.lines.map((l, i) => (i === at && l._tag === "Output" ? { ...l, text: clip(l.text + head), partial: !complete } : l))
      : head === "" && !complete
        ? before.lines
        : [...before.lines, { _tag: "Output", key, name, text: clip(head), partial: !complete }];
  const middle = rest.slice(0, -1).map((t): PanelLine => ({ _tag: "Output", key, name, text: clip(t), partial: false }));
  const last = rest.at(-1);
  const tail: readonly PanelLine[] = last === undefined || last === "" ? [] : [{ _tag: "Output", key, name, text: clip(last), partial: true }];
  const lines = kept([...extended, ...middle, ...tail]);
  return withRunning({ ...before, lines }, key, (p) => ({ ...p, afterCr: text.endsWith("\r") }));
};

/** The panel after one live output event. */
export const applyOutput = (panel: LivePanel, event: OutputEvent): LivePanel => {
  switch (event._tag) {
    case "Started":
      return registered(panel, event.key, event.name);
    case "Progress":
      return withRunning(registered(panel, event.key, event.name), event.key, (p) => ({ ...p, seconds: event.seconds }));
    case "Printed":
      return printed(panel, event.key, event.name, event.text);
    case "Touched":
      return { ...panel, lines: kept([...panel.lines, { _tag: "Touched", text: clip(event.name) }]) };
    case "Finished": {
      const name = panel.running.get(event.key)?.name ?? event.name;
      const completed = panel.lines.map((l): PanelLine => (isPartialOf(l, event.key) && l._tag === "Output" ? { ...l, partial: false } : l));
      return {
        lines: kept([...completed, { _tag: "Ended", text: clip(outputEndedLine(name, event.status)) }]),
        running: new Map([...panel.running].filter(([k]) => k !== event.key)),
      };
    }
  }
};

/** Every run's panel, by run id, as this tab's connection received it. */
export type LiveOutputs = ReadonlyMap<number, LivePanel>;
export const EMPTY_OUTPUTS: LiveOutputs = new Map();
/** The panels after one output frame. */
export const outputsAfter = (outputs: LiveOutputs, frame: Readonly<{ run: number; event: OutputEvent }>): LiveOutputs =>
  new Map([...outputs, [frame.run, applyOutput(outputs.get(frame.run) ?? EMPTY_PANEL, frame.event)]]);

/** What the panel shows: its header and its last `lines` lines. A running process, a silent one included, is never shown ended. */
export type PanelView = Readonly<{ header: string; lines: readonly PanelLine[] }>;
export const panelView = (panel: LivePanel, lines: number): PanelView => ({
  header:
    panel.running.size > 0
      ? outputRunningHeader([...panel.running.values()].map((p) => ({ name: p.name, seconds: p.seconds })))
      : panel.lines.length > 0
        ? OUTPUT_FINISHED_HEADER
        : LIVE_OUTPUT_EMPTY,
  lines: panel.lines.slice(Math.max(0, panel.lines.length - lines)),
});

/** A line as the panel prints it: a process's output after its name, as a terminal shows several processes at once. */
export const lineText = (line: PanelLine): string => (line._tag === "Output" ? `${line.name} | ${line.text}` : line.text);
