// Issue #154 (S5): the background tasks of an execution call, folded from the SDK's messages. A task is pending from its
// first live sighting until its notification or its first ambient marking; a level signal without it never ends it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { foldBackground, nameTasks, NO_BACKGROUND, type BackgroundState, taskName, waitingOn } from "../src/claudeEvents.ts";
import { backgroundEndedText, REPORT_WHILE_RUNNING_DENIED } from "../src/prompts.ts";
import { changed, monitorResult, monitorUse, noTasksChanged, notification, started, watchChanged, watchNotification, watchStarted, watchSummary, watchUpdated } from "./backgroundMessages.ts";

const fold = (...messages: SDKMessage[]): BackgroundState => messages.reduce(foldBackground, NO_BACKGROUND);
const pending = (state: BackgroundState): string[] => [...state.pending].sort();

test("a backgrounded task_started makes its task pending; a foreground one does not", () => {
  assert.deepEqual(pending(fold(started("a"))), ["a"]);
  assert.deepEqual(pending(fold(started("b", { backgrounded: false }))), []);
  assert.ok(waitingOn(fold(started("a"))));
  assert.ok(!waitingOn(NO_BACKGROUND));
});

test("a level signal adds its non-ambient tasks and never removes a missing one", () => {
  assert.deepEqual(pending(fold(changed([["a", false], ["w", true]]))), ["a"]);
  assert.deepEqual(pending(fold(changed([["a", false]]), changed([]))), ["a"]);
});

test("the level signal emptied before the notification leaves the task pending, and the notification ends it", () => {
  const before = fold(started("a"), changed([["a", false]]), changed([]));
  assert.deepEqual(pending(before), ["a"]);
  const after = foldBackground(before, notification("a", "completed", "/tmp/a.out"));
  assert.deepEqual(pending(after), []);
  assert.deepEqual(after.ended, [{ taskId: "a", status: "completed", outputFile: "/tmp/a.out", summary: "summary of a" }]);
});

test("a notification before the level signal is not undone by it", () => {
  const state = fold(started("a"), notification("a", "failed", "/tmp/a.out"), changed([["a", false]]));
  assert.deepEqual(pending(state), []);
  assert.equal(state.ended.length, 1);
});

test("an ambient task is never pending, whichever message first marks it", () => {
  assert.deepEqual(pending(fold(started("w", { ambient: true }))), []);
  // An ambient start after a level snapshot that filtered it out.
  assert.deepEqual(pending(fold(changed([]), started("w", { ambient: true }))), []);
  // A live task that a later level signal marks ambient leaves pending at once; its ambient notification adds no end,
  // and a later non-ambient level signal does not add it back.
  const marked = fold(started("a"), changed([["a", true]]));
  assert.deepEqual(pending(marked), []);
  const notified = foldBackground(marked, notification("a", "completed", "/tmp/a.out", true));
  assert.deepEqual(notified.ended, []);
  assert.deepEqual(pending(foldBackground(notified, changed([["a", false]]))), []);
});

test("a second notification of one task appends no second end", () => {
  const state = fold(started("a"), notification("a", "completed", "/x"), notification("a", "completed", "/x"));
  assert.equal(state.ended.length, 1);
});

test("other messages change nothing", () => {
  const state = fold(started("a"));
  assert.equal(foldBackground(state, { type: "assistant" } as unknown as SDKMessage), state);
});

test("the text of an ended wait names each task's status, output file and summary; the denial says a command runs", () => {
  const text = backgroundEndedText([{ end: { taskId: "a", status: "completed", outputFile: "/tmp/a.out", summary: "suite passed" }, name: "the suite" }]);
  for (const part of ["the suite", "completed", "/tmp/a.out", "suite passed"]) assert.ok(text.includes(part), part);
  assert.match(REPORT_WHILE_RUNNING_DENIED, /background/);
});

// Issue #161 (S8): a Monitor watch, in the messages and the order the developer's run of the prototype showed.
const WATCH = "b9zskmcpx";
const WATCH_USE = "toolu_019cn3umzYKBUKhQQK1g9DS6";
const WATCH_NAME = "proto watch";
const WATCH_OUT = "/tmp/claude-1000/tasks/b9zskmcpx.output";
const use = monitorUse(WATCH_USE, { description: WATCH_NAME, timeout_ms: 300000, command: "node -e 1" });
const result = monitorResult(WATCH_USE, { taskId: WATCH, timeoutMs: 300000, persistent: false });
const names = (...messages: SDKMessage[]): ReadonlyMap<string, string> => messages.reduce(nameTasks, new Map<string, string>());

test("issue #161: a Monitor watch is pending from its announcement and named by its description", () => {
  assert.deepEqual(pending(fold(use, watchChanged(WATCH, WATCH_NAME))), [WATCH]);
  assert.deepEqual(pending(fold(use, watchChanged(WATCH, WATCH_NAME), watchStarted(WATCH, WATCH_USE, WATCH_NAME))), [WATCH]);
  assert.ok(waitingOn(fold(watchStarted(WATCH, WATCH_USE, WATCH_NAME))));
  assert.equal(names(watchChanged(WATCH, WATCH_NAME)).get(WATCH), WATCH_NAME);
  assert.equal(names(watchStarted(WATCH, WATCH_USE, WATCH_NAME)).get(WATCH), WATCH_NAME);
});

test("issue #161: the tool's messages, the emptied level signal and task_updated leave the watch pending; its notification ends it", () => {
  const announced = [use, watchChanged(WATCH, WATCH_NAME), watchStarted(WATCH, WATCH_USE, WATCH_NAME), result, noTasksChanged(), watchUpdated(WATCH)];
  const before = fold(...announced);
  assert.deepEqual(pending(before), [WATCH]);
  const after = foldBackground(before, watchNotification(WATCH, WATCH_USE, WATCH_OUT, WATCH_NAME));
  assert.deepEqual(pending(after), []);
  assert.deepEqual(after.ended, [{ taskId: WATCH, status: "completed", outputFile: WATCH_OUT, summary: watchSummary(WATCH_NAME) }]);
});

test("issue #161: the tool's result before the task messages gives the same end state", () => {
  const end = watchNotification(WATCH, WATCH_USE, WATCH_OUT, WATCH_NAME);
  const observed = fold(use, watchChanged(WATCH, WATCH_NAME), watchStarted(WATCH, WATCH_USE, WATCH_NAME), result, noTasksChanged(), watchUpdated(WATCH), end);
  const resultFirst = fold(use, result, watchChanged(WATCH, WATCH_NAME), watchStarted(WATCH, WATCH_USE, WATCH_NAME), noTasksChanged(), watchUpdated(WATCH), end);
  assert.deepEqual(resultFirst, observed);
});

test("issue #161: taskName gives the description nameTasks recorded, and the id where none was recorded", () => {
  assert.equal(taskName(names(watchStarted(WATCH, WATCH_USE, WATCH_NAME)), WATCH), WATCH_NAME);
  assert.equal(taskName(new Map(), WATCH), WATCH);
  assert.equal(taskName(names(started("a")), WATCH), WATCH);
});
