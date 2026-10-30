// What a running process prints, as the page's live panel shows it (issue #49). Pure, and imported by the browser as
// well as the server, so it imports nothing that needs Node or an Effect service. None of it is ever recorded: the
// events below reach a tab live, are kept nowhere, and are never part of a run's events or its replay.
import { type Brand, Result } from "effect";

/**
 * One process within its run, never shown: `suite:<n>` (Interloq's suite run n), `claude:<tool_use_id>` (a Claude Code
 * foreground command), `task:<task_id>` (a Claude Code background task or watch), `codex:<callId>:<item id>` (a Codex
 * command) and `reasoning:<callId>:<item id>` (a Codex reasoning summary). The Codex kinds carry the turn's call id
 * because each Codex turn is a separate CLI invocation, whose item ids are not promised unique across turns.
 */
export type ProcessKey = Brand.Branded<string, "ProcessKey">;

/** What a process key is built from. */
export type ProcessSource =
  | Readonly<{ kind: "suite"; run: number }>
  | Readonly<{ kind: "claude"; id: string }>
  | Readonly<{ kind: "task"; id: string }>
  | Readonly<{ kind: "codex"; callId: string; item: string }>
  | Readonly<{ kind: "reasoning"; callId: string; item: string }>;

/** Why no key was built: a blank part, or a suite run that is not a positive whole number. */
export type InvalidProcessKey = Readonly<{ _tag: "InvalidProcessKey"; source: ProcessSource }>;

export const processKeyOf = (source: ProcessSource): Result.Result<ProcessKey, InvalidProcessKey> => {
  const parts = partsOf(source);
  // A part the SDK left out (an id absent from a message) is refused like a blank one, never a defect.
  const valid = parts !== null && parts.every((p) => typeof p === "string" && p.trim() !== "");
  return valid ? Result.succeed([source.kind, ...parts].join(":") as ProcessKey) : Result.fail({ _tag: "InvalidProcessKey", source });
};

const partsOf = (source: ProcessSource): readonly string[] | null => {
  switch (source.kind) {
    case "suite":
      return Number.isSafeInteger(source.run) && source.run > 0 ? [String(source.run)] : null;
    case "claude":
    case "task":
      return [source.id];
    case "codex":
    case "reasoning":
      return [source.callId, source.item];
  }
};

/** How a process ended, as far as its source says. */
export type ProcessStatus =
  | Readonly<{ _tag: "Exited"; code: number }>
  | Readonly<{ _tag: "Signaled"; signal: string }>
  | Readonly<{ _tag: "TimedOut" }>
  | Readonly<{ _tag: "NotStarted" }>
  | Readonly<{ _tag: "Failed" }>
  | Readonly<{ _tag: "Succeeded" }>
  | Readonly<{ _tag: "Stopped" }>
  | Readonly<{ _tag: "Unknown" }>;

/**
 * One event of the live output. Every event about a process carries its key and its name, so a tab that connected
 * after the process started registers it from whichever event reaches it first. `Printed`'s text is as it arrived,
 * possibly a partial line; `Progress` is the elapsed time Claude Code reports for a command; `Touched` names a tool
 * whose output is not carried (a file read, a search, a file change).
 */
export type OutputEvent =
  | Readonly<{ _tag: "Started"; key: ProcessKey; name: string }>
  | Readonly<{ _tag: "Printed"; key: ProcessKey; name: string; text: string }>
  | Readonly<{ _tag: "Progress"; key: ProcessKey; name: string; seconds: number }>
  | Readonly<{ _tag: "Finished"; key: ProcessKey; name: string; status: ProcessStatus }>
  | Readonly<{ _tag: "Touched"; name: string }>;

/** The longest short name of a process, before its ellipsis. */
export const PROCESS_NAME_LENGTH = 40;

/** A process's short name: the first non-blank line of its command, whitespace collapsed, at most 40 characters and an ellipsis. */
export const processNameOf = (text: string): string => {
  const line = (text.split(/\r\n|\r|\n/u).find((l) => l.trim() !== "") ?? "").replace(/\s+/gu, " ").trim();
  const chars = Array.from(line);
  return chars.length <= PROCESS_NAME_LENGTH ? line : `${chars.slice(0, PROCESS_NAME_LENGTH).join("")}…`;
};

/**
 * The state of the sanitizer between chunks: in plain text, after ESC, inside a control sequence (`ESC [` until a final
 * character `@`–`~`), inside an operating-system command (`ESC ]` until BEL or `ESC \`), or after an ESC inside one.
 * It buffers nothing, so its state is bounded whatever the length of a sequence.
 */
export type Sanitizer = "Text" | "Escape" | "Csi" | "Osc" | "OscEscape";
export const NEW_SANITIZER: Sanitizer = "Text";

const ESC = "\u001b";
const BEL = "\u0007";
const kept = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return c === "\t" || c === "\r" || c === "\n" || (code >= 0x20 && code !== 0x7f);
};

/** One character through the sanitizer: the next state and what it emits. */
const step = (s: Sanitizer, c: string): readonly [Sanitizer, string] => {
  switch (s) {
    case "Text":
      return c === ESC ? ["Escape", ""] : ["Text", kept(c) ? c : ""];
    case "Escape":
      return c === "[" ? ["Csi", ""] : c === "]" ? ["Osc", ""] : c === ESC ? ["Escape", ""] : ["Text", ""];
    case "Csi": {
      const code = c.charCodeAt(0);
      return code >= 0x40 && code <= 0x7e ? ["Text", ""] : c === ESC ? ["Escape", ""] : ["Csi", ""];
    }
    case "Osc":
      return c === BEL ? ["Text", ""] : c === ESC ? ["OscEscape", ""] : ["Osc", ""];
    case "OscEscape":
      return c === "\\" ? ["Text", ""] : c === ESC ? ["OscEscape", ""] : ["Osc", ""];
  }
};

/** A chunk of output through the sanitizer: escape sequences and control characters other than tab, CR and LF removed. */
export const sanitizeChunk = (sanitizer: Sanitizer, chunk: string): readonly [Sanitizer, string] => {
  let state = sanitizer;
  let out = "";
  for (const c of chunk) {
    const [next, emitted] = step(state, c);
    state = next;
    out += emitted;
  }
  return [state, out];
};

/** The sanitizer after its process ended: an unterminated sequence emits nothing. */
export const sanitizeEnd = (_sanitizer: Sanitizer): Sanitizer => NEW_SANITIZER;

/** A whole text through the sanitizer, the same machine as a chunk, so splitting a text never changes what is shown. */
export const plainOutput = (text: string): string => sanitizeChunk(NEW_SANITIZER, text)[1];

/** One live output event as the server forwards it to a tab: the run it belongs to and the event. */
export type OutputEnvelope = Readonly<{ run: number; event: OutputEvent }>;
/** The envelopes a tab has not yet been sent, in arrival order. */
export type OutputBacklog = readonly OutputEnvelope[];
export const EMPTY_BACKLOG: OutputBacklog = [];

/** What is handed to the tab now, and the backlog left: empty. */
export const backlogTake = (backlog: OutputBacklog): readonly [readonly OutputEnvelope[], OutputBacklog] => [backlog, EMPTY_BACKLOG];

const processOf = (e: OutputEnvelope): string | null => (e.event._tag === "Touched" ? null : `${e.run}\u0000${e.event.key}`);
const without = (backlog: OutputBacklog, drop: (e: OutputEnvelope, i: number) => boolean): OutputBacklog => backlog.filter((e, i) => !drop(e, i));

/**
 * The envelope appended to the backlog. A `Progress` replaces the pending `Progress` of its own process, since only the
 * latest elapsed time means anything. Then, while more than `bound` envelopes are pending, the backlog is compacted, one
 * removal at a time: the oldest `Printed`; else the oldest `Touched`; else the oldest finished process with something
 * to remove: all of it where its `Started` is pending too (the tab was never told of it), else its `Progress`, its
 * `Finished` kept, so a process the tab shows as running always receives its end. What may remain past the bound is a
 * `Started` and a `Progress` per process running and a `Finished` per process whose `Started` was already taken.
 */
export const backlogAdmit = (backlog: OutputBacklog, envelope: OutputEnvelope, bound: number): OutputBacklog => {
  const id = processOf(envelope);
  const superseded = envelope.event._tag === "Progress" ? without(backlog, (e) => e.event._tag === "Progress" && processOf(e) === id) : backlog;
  let pending: OutputBacklog = [...superseded, envelope];
  while (pending.length > bound) {
    const next = compactOnce(pending);
    if (next === null) return pending;
    pending = next;
  }
  return pending;
};

const compactOnce = (pending: OutputBacklog): OutputBacklog | null => {
  const printed = pending.findIndex((e) => e.event._tag === "Printed");
  if (printed >= 0) return without(pending, (_, i) => i === printed);
  const touched = pending.findIndex((e) => e.event._tag === "Touched");
  if (touched >= 0) return without(pending, (_, i) => i === touched);
  for (const f of pending) {
    if (f.event._tag !== "Finished") continue;
    const id = processOf(f);
    const startedPending = pending.some((e) => e.event._tag === "Started" && processOf(e) === id);
    if (startedPending) return without(pending, (e) => processOf(e) === id);
    if (pending.some((e) => e.event._tag === "Progress" && processOf(e) === id)) return without(pending, (e) => e.event._tag === "Progress" && processOf(e) === id);
  }
  return null;
};
