// Pure decoding of the events of a streamed Codex turn (plan step 1.8): the tool uses for the activity line.

import type { ThreadEvent } from "@openai/codex-sdk";
import { Result } from "effect";
import type { UiEvent } from "./uiEvents.ts";
import { NEW_SANITIZER, type OutputEvent, type ProcessKey, processKeyOf, processNameOf, type ProcessStatus, sanitizeChunk, sanitizeEnd, type Sanitizer } from "./liveOutput.ts";
import { CODEX_REASONING_NAME } from "./prompts.ts";

export type ToolUse = Readonly<{ id: string; event: Extract<UiEvent, { _tag: "ToolUsed" }> }>;

/**
 * The tool use an event reports, or null. A command and a web search are reported on item.started, a file
 * change on item.completed (the SDK emits it only then); an item id in `seen` is not reported again. The event carries
 * the id of the turn it belongs to (W3-R2-1 of issue #184).
 */
export const toolEventOf = (seen: ReadonlySet<string>, event: ThreadEvent, callId: string): ToolUse | null => {
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = event.item;
  if (seen.has(item.id)) return null;
  const used = (tool: string, target: string): ToolUse => ({ id: item.id, event: { _tag: "ToolUsed", agent: "codex", tool, target, callId } });
  switch (item.type) {
    case "command_execution":
      return event.type === "item.started" ? used("command", item.command) : null;
    case "web_search":
      return event.type === "item.started" ? used("search", item.query) : null;
    case "file_change":
      return event.type === "item.completed" ? used("edit", item.changes.map((c) => c.path).join(", ")) : null;
    default:
      return null;
  }
};

/**
 * What a streamed turn produced: the text of its last agent message and its usage, or the reason it failed; and in both
 * cases the notices of its error events, in order (issue #26).
 */
export type TurnOutcome =
  | Readonly<{ kind: "ok"; finalResponse: string; usage: Readonly<{ input_tokens: number; output_tokens: number }> | null; notices: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string; notices: readonly string[] }>;

/**
 * The reduction of a turn's events. An error event is a notice (the CLI reporting its reconnection, which the SDK's own
 * run() ignores), not a failure (issue #26). The turn fails on turn.failed, when the stream ends without turn.completed
 * (with the last notice as its message), and when it has no agent message.
 */
export const reduceTurn = (events: readonly ThreadEvent[]): TurnOutcome => {
  const notices = events.flatMap((e) => (e.type === "error" ? [e.message] : []));
  const failed = events.find((e) => e.type === "turn.failed");
  if (failed !== undefined && failed.type === "turn.failed") return { kind: "failed", message: failed.error.message, notices };
  const completed = events.find((e) => e.type === "turn.completed");
  if (completed === undefined || completed.type !== "turn.completed") {
    return { kind: "failed", message: notices[notices.length - 1] ?? "no reply: the stream ended without turn.completed", notices };
  }
  const messages = events.flatMap((e) => (e.type === "item.completed" && e.item.type === "agent_message" ? [e.item.text] : []));
  const last = messages[messages.length - 1];
  if (last === undefined) return { kind: "failed", message: "no reply: the turn ended without an agent message", notices };
  const usage = { input_tokens: completed.usage.input_tokens ?? 0, output_tokens: completed.usage.output_tokens ?? 0 };
  return { kind: "ok", finalResponse: last, usage, notices };
};

/**
 * Issue #49: one Codex item whose text the live panel shows: a command (its `aggregated_output`) or a reasoning summary
 * (its `text`). `raw` is the item's text already passed on, unsanitized, `sanitizer` the state after it.
 */
export type CodexItemOutput = Readonly<{ kind: "command" | "reasoning"; key: ProcessKey; name: string; raw: string; sanitizer: Sanitizer; finished: boolean }>;
/** The live output's state of one Codex turn: its items by id, and the items already named as touched. */
export type CodexOutputState = Readonly<{ items: ReadonlyMap<string, CodexItemOutput>; touched: ReadonlySet<string> }>;
export const EMPTY_CODEX_OUTPUT: CodexOutputState = { items: new Map(), touched: new Set() };

type ItemEvent = Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>;

/**
 * The live output of one event of a turn (issue #49), pure. The SDK sends a running command's item again as its
 * `aggregated_output` grows, and a reasoning item as its `text` grows: the new suffix is passed on through the item's
 * sanitizer, and a text that no longer begins with what was passed on is passed on whole, the sanitizer reset. A search
 * and a file change are one Touched each. Every key carries `callId`, since each turn is a CLI invocation of its own.
 */
export const codexOutputOf = (state: CodexOutputState, event: ThreadEvent, callId: string): readonly [CodexOutputState, readonly OutputEvent[]] => {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return [state, []];
  const item = event.item;
  switch (item.type) {
    case "command_execution":
      return textItem(state, event, callId, "command", item.command, item.aggregated_output, () =>
        item.exit_code !== undefined ? { _tag: "Exited", code: item.exit_code } : item.status === "failed" ? { _tag: "Failed" } : { _tag: "Unknown" },
      );
    case "reasoning":
      return textItem(state, event, callId, "reasoning", CODEX_REASONING_NAME, item.text, () => ({ _tag: "Succeeded" }));
    case "web_search":
      return touched(state, item.id, `search ${item.query}`);
    case "file_change":
      return event.type === "item.completed" ? touched(state, item.id, `edit ${item.changes.map((c) => c.path).join(", ")}`) : [state, []];
    default:
      return [state, []];
  }
};

const touched = (state: CodexOutputState, id: string, name: string): readonly [CodexOutputState, readonly OutputEvent[]] =>
  state.touched.has(id) ? [state, []] : [{ ...state, touched: new Set([...state.touched, id]) }, [{ _tag: "Touched", name: processNameOf(name) }]];

const textItem = (
  state: CodexOutputState,
  event: ItemEvent,
  callId: string,
  kind: "command" | "reasoning",
  label: string,
  text: string,
  status: () => ProcessStatus,
): readonly [CodexOutputState, readonly OutputEvent[]] => {
  const id = event.item.id;
  const known = state.items.get(id);
  if (known?.finished === true) return [state, []];
  const built = known === undefined ? processKeyOf({ kind: kind === "command" ? "codex" : "reasoning", callId, item: id }) : Result.succeed(known.key);
  if (Result.isFailure(built)) return [state, []];
  const key = built.success;
  const name = known?.name ?? (kind === "command" ? processNameOf(label) : label);
  const start: readonly OutputEvent[] = known === undefined ? [{ _tag: "Started", key, name }] : [];
  const before = known ?? { kind, key, name, raw: "", sanitizer: NEW_SANITIZER, finished: false };
  const continues = text.startsWith(before.raw);
  const [sanitizer, printed] = sanitizeChunk(continues ? before.sanitizer : NEW_SANITIZER, continues ? text.slice(before.raw.length) : text);
  const print: readonly OutputEvent[] = printed === "" ? [] : [{ _tag: "Printed", key, name, text: printed }];
  const finished = event.type === "item.completed";
  const end: readonly OutputEvent[] = finished ? [{ _tag: "Finished", key, name, status: status() }] : [];
  const after: CodexItemOutput = { ...before, raw: text, sanitizer: finished ? sanitizeEnd(sanitizer) : sanitizer, finished };
  return [{ ...state, items: new Map([...state.items, [id, after]]) }, [...start, ...print, ...end]];
};

/** The end of every item of the turn not yet finished (issue #49), for the turn's end: how it ended is not known. */
export const codexOpenItems = (state: CodexOutputState): readonly OutputEvent[] =>
  [...state.items.values()].flatMap((i) => (i.finished ? [] : [{ _tag: "Finished", key: i.key, name: i.name, status: { _tag: "Unknown" } } satisfies OutputEvent]));
