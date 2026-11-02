// Issue #196 (S9): the queue editor of the Implementation tab's list view: rows in order, keyboard buttons, a drag.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { type ChainQueue, EMPTY_QUEUE, moveDownChange, moveToChange, moveUpChange, type QueueChange } from "../../src/chainQueue.ts";
import type { ItemId } from "../../src/tracker.ts";
import QueueEditor from "./components/QueueEditor.svelte";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const entries = ["5", "3", "8"].map((i) => ({ item: i as ItemId, title: `title ${i}` }));
const queue: ChainQueue = { ...EMPTY_QUEUE, source: "queue", entries };
const editor = (props: Record<string, unknown> = {}) => {
  const changes: QueueChange[] = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(mount(QueueEditor, { target: root, props: { queue, listed: null, offline: false, onEdit: (c: QueueChange) => void changes.push(c), ...props } }));
  flushSync();
  return { root, changes };
};
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("li[data-queued]")];
const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const label = (i: number) => `#${entries[i]!.item} ${entries[i]!.title}`;
/** Rows laid out 40 px apart, as jsdom lays out nothing. */
const layOut = (root: HTMLElement) =>
  rows(root).forEach((row, i) => {
    row.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 40, height: 40, left: 0, right: 300, width: 300, x: 0, y: i * 40, toJSON: () => ({}) });
  });
const pointer = (target: Element, type: string, clientY: number) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientY, pointerId: 1 }));

describe("QueueEditor", () => {
  test("its region is named by the heading, and its rows show their number and item in order", () => {
    const { root } = editor();
    expect(root.querySelector(`section[aria-label="${prompts.QUEUE_HEADING}"]`)).not.toBeNull();
    expect(rows(root).map((r) => r.getAttribute("data-queued"))).toEqual(["5", "3", "8"]);
    expect(rows(root)[1]!.textContent).toContain("2");
    expect(rows(root)[1]!.textContent).toContain("#3 title 3");
    expect(root.textContent).toContain(prompts.QUEUE_SUPPORT);
  });

  test("Move up, Move down and Remove send the changes the queue's helpers give; the ends are disabled", () => {
    const { root, changes } = editor();
    named(root, prompts.queueMoveUpName(label(1))).click();
    named(root, prompts.queueMoveDownName(label(1))).click();
    named(root, prompts.queueRemoveName(label(2))).click();
    expect(changes).toEqual([moveUpChange(entries, "3" as ItemId), moveDownChange(entries, "3" as ItemId), { _tag: "Remove", item: "8" }]);
    expect(named(root, prompts.queueMoveUpName(label(0))).disabled).toBe(true);
    expect(named(root, prompts.queueMoveDownName(label(2))).disabled).toBe(true);
  });

  test("a drag from the first row to the third sends one Move equal to moveToChange; Escape sends nothing", () => {
    const { root, changes } = editor();
    layOut(root);
    const handle = rows(root)[0]!.querySelector<HTMLElement>("[data-handle]")!;
    expect(handle.getAttribute("aria-label")).toBe(prompts.queueHandleName(label(0)));
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 100);
    pointer(handle, "pointerup", 100);
    flushSync();
    expect(changes).toEqual([moveToChange(entries, "5" as ItemId, 2)]);
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 100);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    pointer(handle, "pointerup", 100);
    flushSync();
    expect(changes.length).toBe(1);
  });

  test("a drag the browser cancels sends nothing and leaves no row dragged or marked as the drop", () => {
    const { root, changes } = editor();
    layOut(root);
    const handle = rows(root)[0]!.querySelector<HTMLElement>("[data-handle]")!;
    pointer(handle, "pointerdown", 20);
    pointer(handle, "pointermove", 100);
    flushSync();
    expect(root.querySelector("ol.drop-end")).not.toBeNull();
    pointer(handle, "pointercancel", 100);
    flushSync();
    expect(changes.length).toBe(0);
    expect(root.querySelector("li.dragging, li.drop-before, ol.drop-end")).toBeNull();
  });

  test("the stale note shows only for an item absent from a loaded listing", () => {
    expect(editor().root.textContent).not.toContain(prompts.QUEUE_STALE);
    const { root } = editor({ listed: ["5", "8"] });
    expect(rows(root).map((r) => r.textContent?.includes(prompts.QUEUE_STALE))).toEqual([false, true, false]);
  });

  test("an empty queue says so", () => {
    expect(editor({ queue: { ...queue, entries: [] } }).root.textContent).toContain(prompts.QUEUE_EMPTY);
  });
});
