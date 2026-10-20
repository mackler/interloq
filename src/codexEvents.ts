// Pure decoding of the events of a streamed Codex turn (plan step 1.8): the tool uses for the activity line.

import type { ThreadEvent } from "@openai/codex-sdk";
import type { UiEvent } from "./uiEvents.ts";

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
