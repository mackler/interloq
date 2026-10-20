import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { toolEventOf } from "../src/codexEvents.ts";
import { command, fileChange, webSearch } from "./fakeSdk.ts";

/** The tool events of a stream, as the adapter folds it: an id already reported is not reported again. */
const fold = (events: readonly ThreadEvent[]) =>
  events.reduce<{ seen: ReadonlySet<string>; out: unknown[] }>(
    (acc, event) => {
      const tool = toolEventOf(acc.seen, event, "codex-1");
      return tool === null ? acc : { seen: new Set([...acc.seen, tool.id]), out: [...acc.out, tool.event] };
    },
    { seen: new Set(), out: [] },
  ).out;

test("a command is reported once, on item.started, though the SDK reports it started and completed", () => {
  assert.deepEqual(fold(command("c1", "npm test")), [{ _tag: "ToolUsed", agent: "codex", tool: "command", target: "npm test", callId: "codex-1" }]);
});

test("a file change, reported only on completion, is reported with its paths", () => {
  assert.deepEqual(fold(fileChange("f1", "src/a.ts", "src/b.ts")), [{ _tag: "ToolUsed", agent: "codex", tool: "edit", target: "src/a.ts, src/b.ts", callId: "codex-1" }]);
});

test("a web search is reported once with its query; messages, reasoning and turn events are not tool uses", () => {
  const other = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "m", type: "agent_message", text: "x" } },
    { type: "item.completed", item: { id: "r", type: "reasoning", text: "y" } },
  ] as ThreadEvent[];
  assert.deepEqual(fold([...other, ...webSearch("w", "q")]), [{ _tag: "ToolUsed", agent: "codex", tool: "search", target: "q", callId: "codex-1" }]);
});

// Issue #26: an error event is a notice of the CLI's reconnection, not a failure; the SDK's own run() ignores it.
import { reduceTurn } from "../src/codexEvents.ts";
import { turn, turnFailed } from "./fakeSdk.ts";

const notice = (message: string): ThreadEvent => ({ type: "error", message }) as ThreadEvent;
const reconnecting = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";

test("an error notice followed by turn.completed with an agent message is ok, and the notice is kept", () => {
  const outcome = reduceTurn([notice(reconnecting), ...turn("reply")]);
  assert.equal(outcome.kind, "ok");
  assert.deepEqual(outcome.notices, [reconnecting]);
  assert.equal(outcome.kind === "ok" ? outcome.finalResponse : "", "reply");
});

test("an error notice followed by turn.failed fails with the turn's message", () => {
  const outcome = reduceTurn([notice(reconnecting), ...turnFailed("stream disconnected before completion")]);
  assert.deepEqual(outcome, { kind: "failed", message: "stream disconnected before completion", notices: [reconnecting] });
});

test("a stream that ends without turn.completed fails with its last notice", () => {
  const outcome = reduceTurn([notice("first"), notice(reconnecting)]);
  assert.deepEqual(outcome, { kind: "failed", message: reconnecting, notices: ["first", reconnecting] });
});

test("an agent message without turn.completed is not a completed turn", () => {
  const outcome = reduceTurn([{ type: "item.completed", item: { id: "m", type: "agent_message", text: "x" } } as ThreadEvent]);
  assert.equal(outcome.kind, "failed");
});
