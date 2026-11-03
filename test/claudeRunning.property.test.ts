// Issue #40 (requirements 2 and 3): the processes a message of Claude Code's was written beside are the processes of
// the call open on the live panel when it arrived, derived from the program's own fold of the SDK's messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeOpenProcesses, claudeOutputOf, claudeRunningNames, EMPTY_CLAUDE_OUTPUT, type ClaudeOutputState } from "../src/claudeEvents.ts";
import { processNameOf } from "../src/liveOutput.ts";
import { bashResult, bashUse, notification, started, watchChanged, watchNotification, watchStarted } from "./backgroundMessages.ts";

type Op =
  | Readonly<{ kind: "use"; id: string; command: string; background: boolean }>
  | Readonly<{ kind: "result"; id: string }>
  | Readonly<{ kind: "started" | "notification" | "watchChanged" | "watchStarted" | "watchNotification"; id: string }>;

const ids = fc.constantFrom("a", "b", "c");
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("use" as const), id: ids, command: fc.constantFrom("npm test", "git status", "sleep 5"), background: fc.boolean() }),
  fc.record({ kind: fc.constant("result" as const), id: ids }),
  fc.record({ kind: fc.constantFrom("started" as const, "notification" as const, "watchChanged" as const, "watchStarted" as const, "watchNotification" as const), id: ids }),
);
const messageOf = (o: Op): SDKMessage => {
  switch (o.kind) {
    case "use":
      return bashUse(o.id, o.command, o.background);
    case "result":
      return bashResult(o.id, "out\n");
    case "started":
      return started(o.id);
    case "notification":
      return notification(o.id, "completed", `/tmp/${o.id}.out`);
    case "watchChanged":
      return watchChanged(o.id, `task ${o.id}`);
    case "watchStarted":
      return watchStarted(o.id, `tu-${o.id}`, `task ${o.id}`);
    case "watchNotification":
      return watchNotification(o.id, `tu-${o.id}`, `/tmp/${o.id}.out`, `task ${o.id}`);
  }
};
const statesOf = (ops: readonly Op[]): readonly ClaudeOutputState[] =>
  ops.reduce<ClaudeOutputState[]>((acc, o) => [...acc, claudeOutputOf(acc[acc.length - 1] ?? EMPTY_CLAUDE_OUTPUT, messageOf(o))[0]], [EMPTY_CLAUDE_OUTPUT]);

/** The reference model: a foreground command open from its use until its result; a task from its first sighting until its notification, never again after it. */
const modelNames = (ops: readonly Op[]): readonly string[] => {
  const commands = new Map<string, string>();
  const tasks = new Map<string, string>();
  const ended = new Set<string>();
  for (const o of ops) {
    if (o.kind === "use" && !o.background) commands.set(o.id, processNameOf(o.command));
    else if (o.kind === "result") commands.delete(o.id);
    else if (o.kind === "notification" || o.kind === "watchNotification") (tasks.delete(o.id), ended.add(o.id));
    else if (o.kind === "started" || o.kind === "watchChanged" || o.kind === "watchStarted") {
      if (!ended.has(o.id) && !tasks.has(o.id)) tasks.set(o.id, `task ${o.id}`);
    }
  }
  return [...commands.values(), ...tasks.values()];
};

test("property: in every state reached, the running names are the names claudeOpenProcesses ends, in its order", () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 12 }), (ops) => {
      for (const state of statesOf(ops)) assert.deepEqual(claudeRunningNames(state), claudeOpenProcesses(state).map((e) => (e._tag === "Finished" ? e.name : "")));
    }),
    { numRuns: 200 },
  );
});

test("property: the running names are the reference model's open processes", () => {
  fc.assert(
    fc.property(fc.array(op, { maxLength: 12 }), (ops) => {
      const states = statesOf(ops);
      assert.deepEqual(claudeRunningNames(states[states.length - 1] ?? EMPTY_CLAUDE_OUTPUT), modelNames(ops));
    }),
    { numRuns: 200 },
  );
});

test("examples: nothing runs at first; a foreground command runs until its result; a background task until its notification", () => {
  assert.deepEqual(claudeRunningNames(EMPTY_CLAUDE_OUTPUT), []);
  const fg = statesOf([{ kind: "use", id: "t1", command: "npm test", background: false }, { kind: "result", id: "t1" }]);
  assert.deepEqual(fg.map(claudeRunningNames), [[], [processNameOf("npm test")], []]);
  const bg = statesOf([{ kind: "started", id: "b1" }, { kind: "notification", id: "b1" }]);
  assert.deepEqual(bg.map(claudeRunningNames), [[], ["task b1"], []]);
});
