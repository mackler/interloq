// The dashboard's live panel (issue #49): what the running processes of a run printed, as it arrived over this tab's
// connection. Pure, and outside the replayed reducer of web/src/state.ts: nothing here is rebuilt from a replay, and the
// page empties it on every hello, since the panel holds only what arrived since this tab connected. Issue #221: it keeps
// the last SCROLLBACK_LINES lines, cuts nothing, shows each process's whole name once, on the line that begins it, and
// tags the process's later lines with a short tag; its colors are runs from web/src/terminalColor.ts.
import { type OutputEvent, type ProcessStatus, SCROLLBACK_LINES } from "../../src/liveOutput.ts";
import { durationText, outputEndedDetail, outputEndedLine, outputRunningName } from "../../src/prompts.ts";
import { DEFAULT_STYLE, type StyledRun, styleText, type TermStyle } from "./terminalColor.ts";

/** The lines the full dashboard's panel shows by default, before the developer drags its handle. */
export const PANEL_LINES = 12;
/** The lines the compact dashboard's panel shows, under a question. */
export const COMPACT_PANEL_LINES = 4;

/** Whether a process is running, with its elapsed seconds where known, or how it ended. */
export type ProcessState = Readonly<{ _tag: "Running"; seconds: number | null }> | Readonly<{ _tag: "Ended"; status: ProcessStatus }>;

/** A process the panel knows: its tag, whole name, state, whether its last text ended in a CR, and its current colors. */
export type ProcessInfo = Readonly<{ tag: string; name: string; state: ProcessState; afterCr: boolean; style: TermStyle }>;

/**
 * One line of the panel, each with an id unique and ascending in arrival order: the line that begins a process, a line
 * of its output (`partial` while the process may still extend it, keeping its id), its end, or a tool named.
 */
export type PanelLine =
  | Readonly<{ _tag: "Begun"; id: number; key: string }>
  | Readonly<{ _tag: "Output"; id: number; key: string; runs: readonly StyledRun[]; partial: boolean }>
  | Readonly<{ _tag: "Ended"; id: number; key: string; status: ProcessStatus }>
  | Readonly<{ _tag: "Touched"; id: number; text: string }>;

/** The panel of one run: its lines in arrival order, its processes by key in first-seen order, and the next tag and id. */
export type LivePanel = Readonly<{ lines: readonly PanelLine[]; processes: ReadonlyMap<string, ProcessInfo>; nextTag: number; nextId: number }>;
export const EMPTY_PANEL: LivePanel = { lines: [], processes: new Map(), nextTag: 1, nextId: 1 };

/**
 * Whether any process of the run is running, a silent one included (issue #200, requirements Q2): the one statement of
 * "a command runs" from which the compact dashboard decides both whether it shows the panel and how much room it takes.
 */
export const hasRunning = (panel: LivePanel): boolean => [...panel.processes.values()].some((p) => p.state._tag === "Running");

const keyOfLine = (line: PanelLine): string | null => (line._tag === "Touched" ? null : line.key);

/** The lines past the scrollback dropped, oldest first, then every ended process left without a line. */
const kept = (panel: LivePanel): LivePanel => {
  const lines = panel.lines.length <= SCROLLBACK_LINES ? panel.lines : panel.lines.slice(panel.lines.length - SCROLLBACK_LINES);
  const withLine = new Set(lines.map(keyOfLine));
  const processes = new Map([...panel.processes].filter(([k, p]) => p.state._tag === "Running" || withLine.has(k)));
  return { ...panel, lines, processes };
};

const appended = (panel: LivePanel, line: (id: number) => PanelLine): LivePanel => ({ ...panel, lines: [...panel.lines, line(panel.nextId)], nextId: panel.nextId + 1 });

const RUNNING: ProcessState = { _tag: "Running", seconds: null };

/** The process registered, with its begun line, from whichever event names it first; an ended one that prints again runs again. */
const registered = (panel: LivePanel, key: string, name: string): LivePanel => {
  const known = panel.processes.get(key);
  if (known !== undefined) return known.state._tag === "Running" ? panel : withProcess(panel, key, (p) => ({ ...p, state: RUNNING }));
  const info: ProcessInfo = { tag: `#${panel.nextTag}`, name, state: RUNNING, afterCr: false, style: DEFAULT_STYLE };
  return appended({ ...panel, processes: new Map([...panel.processes, [key, info]]), nextTag: panel.nextTag + 1 }, (id) => ({ _tag: "Begun", id, key }));
};
const withProcess = (panel: LivePanel, key: string, f: (p: ProcessInfo) => ProcessInfo): LivePanel => {
  const p = panel.processes.get(key);
  return p === undefined ? panel : { ...panel, processes: new Map([...panel.processes].map(([k, v]) => [k, k === key ? f(v) : v])) };
};

const plainOf = (runs: readonly StyledRun[]): string => runs.map((r) => r.text).join("");
const joined = (a: readonly StyledRun[], b: readonly StyledRun[]): readonly StyledRun[] => {
  const last = a.at(-1);
  const first = b[0];
  if (last === undefined || first === undefined) return [...a, ...b];
  const same = JSON.stringify(last.style) === JSON.stringify(first.style);
  return same ? [...a.slice(0, -1), { text: last.text + first.text, style: last.style }, ...b.slice(1)] : [...a, ...b];
};
const isPartialOf = (line: PanelLine, key: string): boolean => line._tag === "Output" && line.key === key && line.partial;

/**
 * A process's text on the panel. A line feed that completes a carriage return split across chunks is dropped; a lone
 * carriage return ends a line, so a progress bar adds lines rather than growing one forever; the text before the first
 * break extends the process's partial line, which keeps its place and its id; the text after the last break is the new
 * partial line, shown at once and completed in place as more arrives. Each piece is styled from the process's colors,
 * which carry on to its next piece; a text is split at line breaks alone, which no SGR sequence holds.
 */
const printed = (panel: LivePanel, key: string, name: string, raw: string): LivePanel => {
  const before = registered(panel, key, name);
  const info = before.processes.get(key);
  if (info === undefined) return before;
  const text = info.afterCr && raw.startsWith("\n") ? raw.slice(1) : raw;
  if (text === "") return kept(withProcess(before, key, (p) => ({ ...p, afterCr: raw === "" ? p.afterCr : false })));
  const [head = "", ...rest] = text.split(/\r\n|\r|\n/u);
  let style = info.style;
  const styled = (t: string): readonly StyledRun[] => {
    const [next, runs] = styleText(style, t);
    style = next;
    return runs;
  };
  const complete = rest.length > 0;
  const headRuns = styled(head);
  const at = before.lines.findIndex((l) => isPartialOf(l, key));
  let p: LivePanel =
    at >= 0
      ? { ...before, lines: before.lines.map((l, i) => (i === at && l._tag === "Output" ? { ...l, runs: joined(l.runs, headRuns), partial: !complete } : l)) }
      : plainOf(headRuns) === "" && !complete
        ? before
        : appended(before, (id) => ({ _tag: "Output", id, key, runs: headRuns, partial: !complete }));
  rest.forEach((t, i) => {
    const runs = styled(t);
    const last = i === rest.length - 1;
    if (last && plainOf(runs) === "") return;
    p = appended(p, (id) => ({ _tag: "Output", id, key, runs, partial: last }));
  });
  return kept(withProcess(p, key, (q) => ({ ...q, afterCr: text.endsWith("\r"), style })));
};

/** The panel after one live output event. */
export const applyOutput = (panel: LivePanel, event: OutputEvent): LivePanel => {
  switch (event._tag) {
    case "Started":
      return kept(registered(panel, event.key, event.name));
    case "Progress":
      return kept(withProcess(registered(panel, event.key, event.name), event.key, (p) => ({ ...p, state: { _tag: "Running", seconds: event.seconds } })));
    case "Printed":
      return printed(panel, event.key, event.name, event.text);
    case "Touched":
      return kept(appended(panel, (id) => ({ _tag: "Touched", id, text: event.name })));
    case "Finished": {
      const before = registered(panel, event.key, event.name);
      const completed = before.lines.map((l): PanelLine => (isPartialOf(l, event.key) && l._tag === "Output" ? { ...l, partial: false } : l));
      const ended = withProcess({ ...before, lines: completed }, event.key, (p) => ({ ...p, state: { _tag: "Ended", status: event.status }, afterCr: false, style: DEFAULT_STYLE }));
      return kept(appended(ended, (id) => ({ _tag: "Ended", id, key: event.key, status: event.status })));
    }
  }
};

/** Every run's panel, by run id, as this tab's connection received it. */
export type LiveOutputs = ReadonlyMap<number, LivePanel>;
export const EMPTY_OUTPUTS: LiveOutputs = new Map();
/** The panels after one output frame. */
export const outputsAfter = (outputs: LiveOutputs, frame: Readonly<{ run: number; event: OutputEvent }>): LiveOutputs =>
  new Map([...outputs, [frame.run, applyOutput(outputs.get(frame.run) ?? EMPTY_PANEL, frame.event)]]);

/** The glyphs of a process's state, text glyphs like the rail's (docs/ui-review.md). */
export const PROCESS_MARK = { running: "●", succeeded: "✓", failed: "✕", stopped: "■", unknown: "?" } as const;
export type MarkKind = keyof typeof PROCESS_MARK;

/** The mark of how a process ended. */
export const endedMarkOf = (status: ProcessStatus): MarkKind => {
  switch (status._tag) {
    case "Exited":
      return status.code === 0 ? "succeeded" : "failed";
    case "Succeeded":
      return "succeeded";
    case "Signaled":
    case "TimedOut":
    case "NotStarted":
    case "Failed":
      return "failed";
    case "Stopped":
      return "stopped";
    case "Unknown":
      return "unknown";
  }
};

/** A running process in the panel's header. */
export type RunningView = Readonly<{ key: string; tag: string; name: string; mark: MarkKind; label: string; elapsed: string | null }>;
/** A line as the panel shows it; a mark's `label` is its accessible name in words. */
export type LineView =
  | Readonly<{ _tag: "Begun"; id: number; tag: string; name: string; mark: MarkKind; label: string }>
  | Readonly<{ _tag: "Output"; id: number; tag: string; runs: readonly StyledRun[] }>
  | Readonly<{ _tag: "Ended"; id: number; tag: string; mark: MarkKind; label: string; detail: string }>
  | Readonly<{ _tag: "Touched"; id: number; text: string }>;
/** What the panel shows: its processes running, its lines, and whether it has nothing at all. */
export type PanelView = Readonly<{ running: readonly RunningView[]; lines: readonly LineView[]; empty: boolean }>;

const markOf = (info: ProcessInfo): readonly [MarkKind, string] =>
  info.state._tag === "Running" ? ["running", outputRunningName(info.name, info.state.seconds)] : [endedMarkOf(info.state.status), outputEndedLine(info.name, info.state.status)];

const UNKNOWN_PROCESS: ProcessInfo = { tag: "", name: "", state: RUNNING, afterCr: false, style: DEFAULT_STYLE };

const lineView = (panel: LivePanel, line: PanelLine): LineView => {
  if (line._tag === "Touched") return line;
  const info = panel.processes.get(line.key) ?? UNKNOWN_PROCESS;
  switch (line._tag) {
    case "Begun": {
      const [mark, label] = markOf(info);
      return { _tag: "Begun", id: line.id, tag: info.tag, name: info.name, mark, label };
    }
    case "Output":
      return { _tag: "Output", id: line.id, tag: info.tag, runs: line.runs };
    case "Ended":
      return { _tag: "Ended", id: line.id, tag: info.tag, mark: endedMarkOf(line.status), label: outputEndedLine(info.name, line.status), detail: outputEndedDetail(line.status) };
  }
};

export const panelView = (panel: LivePanel): PanelView => {
  const running = [...panel.processes].flatMap(([key, info]): RunningView[] =>
    info.state._tag === "Running"
      ? [{ key, tag: info.tag, name: info.name, mark: "running", label: outputRunningName(info.name, info.state.seconds), elapsed: info.state.seconds === null ? null : durationText(info.state.seconds * 1000) }]
      : [],
  );
  return { running, lines: panel.lines.map((l) => lineView(panel, l)), empty: panel.lines.length === 0 && running.length === 0 };
};

/** A line's visible text, as a test reads it. */
export const lineText = (line: LineView): string => {
  switch (line._tag) {
    case "Begun":
      return `${line.tag} ${PROCESS_MARK[line.mark]} ${line.name}`;
    case "Output":
      return `${line.tag} ${line.runs.map((r) => r.text).join("")}`;
    case "Ended":
      return `${line.tag} ${PROCESS_MARK[line.mark]}${line.detail === "" ? "" : ` ${line.detail}`}`;
    case "Touched":
      return line.text;
  }
};

/** Whether a scrolled screen is at its end, within 4 px, so it follows new output. */
export const followsEnd = (scrollTop: number, clientHeight: number, scrollHeight: number): boolean => scrollHeight - scrollTop - clientHeight <= 4;
