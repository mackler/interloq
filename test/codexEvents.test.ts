import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import fc from "fast-check";
import { codexOpenItems, codexOutputOf, type CodexOutputState, EMPTY_CODEX_OUTPUT, toolEventOf } from "../src/codexEvents.ts";
import { type OutputEvent, plainOutput } from "../src/liveOutput.ts";
import { CODEX_REASONING_NAME } from "../src/prompts.ts";
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

// Issue #49: the live output of a Codex turn.
const out = (events: readonly ThreadEvent[], callId = "codex-1", from: CodexOutputState = EMPTY_CODEX_OUTPUT): { state: CodexOutputState; events: OutputEvent[] } =>
  events.reduce<{ state: CodexOutputState; events: OutputEvent[] }>(
    (acc, e) => {
      const [state, emitted] = codexOutputOf(acc.state, e, callId);
      return { state, events: [...acc.events, ...emitted] };
    },
    { state: from, events: [] },
  );
const cmd = (type: "item.started" | "item.updated" | "item.completed", id: string, output: string, extra: Record<string, unknown> = {}): ThreadEvent =>
  ({ type, item: { id, type: "command_execution", command: "npm test\n--all", aggregated_output: output, status: type === "item.completed" ? "completed" : "in_progress", ...extra } }) as ThreadEvent;
const K = "codex:codex-1:c1";

test("a command updated three times passes on each new suffix and ends with its exit code", () => {
  const { events } = out([cmd("item.started", "c1", ""), cmd("item.updated", "c1", "a\n"), cmd("item.updated", "c1", "a\nb"), cmd("item.updated", "c1", "a\nb\n\u001b[31mc\u001b[0m"), cmd("item.completed", "c1", "a\nb\n\u001b[31mc\u001b[0m", { exit_code: 2 })]);
  assert.deepEqual(events, [
    { _tag: "Started", key: K, name: "npm test" },
    { _tag: "Printed", key: K, name: "npm test", text: "a\n" },
    { _tag: "Printed", key: K, name: "npm test", text: "b" },
    { _tag: "Printed", key: K, name: "npm test", text: "\nc" },
    { _tag: "Finished", key: K, name: "npm test", status: { _tag: "Exited", code: 2 } },
  ]);
});

test("a replaced aggregated text is passed on whole; events after the end are ignored", () => {
  const { events } = out([cmd("item.updated", "c1", "abc"), cmd("item.updated", "c1", "xyz"), cmd("item.completed", "c1", "xyz", { status: "failed" }), cmd("item.updated", "c1", "xyz more")]);
  assert.deepEqual(events.map((e) => (e._tag === "Printed" ? e.text : e._tag === "Finished" ? e.status._tag : e._tag)), ["Started", "abc", "xyz", "Failed"]);
});

test("a reasoning item is Codex reasoning, ended as succeeded", () => {
  const r = (type: "item.updated" | "item.completed", text: string) => ({ type, item: { id: "r1", type: "reasoning", text } }) as ThreadEvent;
  const { events } = out([r("item.updated", "Reading the"), r("item.completed", "Reading the plan.")]);
  assert.deepEqual(events, [
    { _tag: "Started", key: "reasoning:codex-1:r1", name: CODEX_REASONING_NAME },
    { _tag: "Printed", key: "reasoning:codex-1:r1", name: CODEX_REASONING_NAME, text: "Reading the" },
    { _tag: "Printed", key: "reasoning:codex-1:r1", name: CODEX_REASONING_NAME, text: " plan." },
    { _tag: "Finished", key: "reasoning:codex-1:r1", name: CODEX_REASONING_NAME, status: { _tag: "Succeeded" } },
  ]);
});

test("a search and a file change are one Touched line each", () => {
  const { events } = out([...webSearch("w1", "effect queue"), ...fileChange("f1", "src/a.ts", "src/b.ts")]);
  assert.deepEqual(events, [{ _tag: "Touched", name: "search effect queue" }, { _tag: "Touched", name: "edit src/a.ts, src/b.ts" }]);
});

test("an item seen first at its completion starts, prints and ends at once", () => {
  const { events, state } = out([cmd("item.completed", "c1", "done\n", { exit_code: 0 })]);
  assert.deepEqual(events.map((e) => e._tag), ["Started", "Printed", "Finished"]);
  assert.deepEqual(codexOpenItems(state), []);
});

test("one item id in two turns gives two keys; an item left open is ended Unknown at the turn's end", () => {
  const first = out([cmd("item.started", "c1", "x")], "codex-1");
  const second = out([cmd("item.started", "c1", "y")], "codex-2");
  assert.notEqual((first.events[0] as { key: string }).key, (second.events[0] as { key: string }).key);
  assert.deepEqual(codexOpenItems(first.state), [{ _tag: "Finished", key: K, name: "npm test", status: { _tag: "Unknown" } }]);
});

test("for any growing aggregated text, the printed texts together are plainOutput of the last", () => {
  fc.assert(
    fc.property(fc.array(fc.array(fc.constantFrom("a", "\n", "\u001b", "[", "3", "m", "]", "\u0007", " "), { maxLength: 10 }).map((cs) => cs.join("")), { maxLength: 8 }), (parts) => {
      const texts = parts.map((_, i) => parts.slice(0, i + 1).join(""));
      const { events } = out(texts.map((t) => cmd("item.updated", "c1", t)));
      assert.equal(events.flatMap((e) => (e._tag === "Printed" ? [e.text] : [])).join(""), plainOutput(texts.at(-1) ?? ""));
    }),
    { numRuns: 200, seed: 49 },
  );
});
