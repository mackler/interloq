// Issue #154 (S5): properties of foldBackground over arbitrary interleavings of the SDK's background-task messages.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { foldBackground, NO_BACKGROUND, type BackgroundState } from "../src/claudeEvents.ts";
import { changed, notification, started } from "./backgroundMessages.ts";

const ids = ["a", "b", "c"] as const;
type Event =
  | { kind: "start"; id: string; backgrounded: boolean; ambient: boolean | undefined }
  | { kind: "level"; tasks: (readonly [string, boolean])[] }
  | { kind: "notify"; id: string; ambient: boolean | undefined }
  | { kind: "other" };
const ambientFlag = fc.option(fc.boolean(), { nil: undefined });
const event: fc.Arbitrary<Event> = fc.oneof(
  fc.record({ kind: fc.constant("start" as const), id: fc.constantFrom(...ids), backgrounded: fc.boolean(), ambient: ambientFlag }),
  fc.record({ kind: fc.constant("level" as const), tasks: fc.uniqueArray(fc.tuple(fc.constantFrom(...ids), fc.boolean()), { selector: ([id]) => id, maxLength: 3 }).map((ts) => ts.map(([id, a]) => [id, a] as const)) }),
  fc.record({ kind: fc.constant("notify" as const), id: fc.constantFrom(...ids), ambient: ambientFlag }),
  fc.constant({ kind: "other" as const }),
);
const messageOf = (e: Event): SDKMessage => {
  switch (e.kind) {
    case "start":
      return started(e.id, { backgrounded: e.backgrounded, ...(e.ambient === undefined ? {} : { ambient: e.ambient }) });
    case "level":
      return changed(e.tasks);
    case "notify":
      return notification(e.id, "completed", `/tmp/${e.id}`, e.ambient);
    case "other":
      return { type: "assistant", message: { content: [] } } as unknown as SDKMessage;
  }
};

// The reference: a task is unseen, then pending from its first non-ambient sighting, and gone for good after its
// non-ambient notification or its first ambient marking, whichever comes first.
type Phase = "unseen" | "pending" | "gone";
const step = (phase: Phase, id: string, e: Event): Phase => {
  if (phase === "gone") return "gone";
  switch (e.kind) {
    case "start":
      if (e.id !== id) return phase;
      if (e.ambient === true) return "gone";
      return e.backgrounded ? "pending" : phase;
    case "level": {
      const entry = e.tasks.find(([t]) => t === id);
      if (entry === undefined) return phase;
      return entry[1] ? "gone" : "pending";
    }
    case "notify":
      return e.id === id ? "gone" : phase;
    case "other":
      return phase;
  }
};

test("a task is pending exactly from its first non-ambient sighting until its non-ambient notification or first ambient marking", () => {
  fc.assert(
    fc.property(fc.array(event, { maxLength: 30 }), (events) => {
      let state: BackgroundState = NO_BACKGROUND;
      const phases = new Map<string, Phase>(ids.map((id) => [id, "unseen"]));
      for (const e of events) {
        state = foldBackground(state, messageOf(e));
        for (const id of ids) phases.set(id, step(phases.get(id) ?? "unseen", id, e));
        for (const id of ids) assert.equal(state.pending.has(id), phases.get(id) === "pending", `${id} after ${JSON.stringify(e)}`);
      }
    }),
    { numRuns: 500 },
  );
});

test("there is at most one end per task, and an ambient task has none", () => {
  fc.assert(
    fc.property(fc.array(event, { maxLength: 30 }), (events) => {
      const state = events.map(messageOf).reduce(foldBackground, NO_BACKGROUND);
      const endIds = state.ended.map((e) => e.taskId);
      assert.equal(new Set(endIds).size, endIds.length);
      for (const id of endIds) assert.ok(!state.pending.has(id));
    }),
    { numRuns: 500 },
  );
});

test("messages of other kinds never change the state", () => {
  fc.assert(
    fc.property(fc.array(event, { maxLength: 20 }), (events) => {
      const state = events.map(messageOf).reduce(foldBackground, NO_BACKGROUND);
      assert.equal(foldBackground(state, messageOf({ kind: "other" })), state);
    }),
    { numRuns: 200 },
  );
});
