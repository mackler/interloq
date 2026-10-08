import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { promptOf } from "../../src/userPrompts.ts";
import QuestionPane from "./components/QuestionPane.svelte";
import TopBar from "./components/TopBar.svelte";
import { emptyRun, type RunView, type Widget } from "./state.ts";
import type { DraftKey } from "./draft.ts";

// S38 (W2-R1-1, P3-R1-1): a confirmation acts only on the incarnation, run or prompt it was opened for, and closes
// without acting when that changes.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const target = () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
};
const openDialog = (root: ParentNode) => root.querySelector<HTMLDialogElement>("dialog[open]");
const confirmButton = (root: ParentNode) => root.querySelector<HTMLButtonElement>("dialog button[name=confirm-end]")!;
const runOf = (id: number): RunView => ({ ...emptyRun(id), project: "/p", task: "t" });

describe("TopBar's confirmation of Stop task", () => {
  const bar = () => {
    const stopped: [string, number][] = [];
    const props: { run: RunView | null; location: string | null; incarnation: string | null; connection: "open"; onStop: (incarnation: string, run: number) => void } = $state({
      run: runOf(3),
      location: null,
      incarnation: "A",
      connection: "open",
      onStop: (incarnation, run) => void stopped.push([incarnation, run]),
    });
    const root = target();
    mounted.push(mount(TopBar, { target: root, props }));
    flushSync();
    root.querySelector<HTMLButtonElement>("button[name=stop]")!.click();
    flushSync();
    expect(openDialog(root)).not.toBe(null);
    return { root, props, stopped };
  };

  test("confirmed while its run is current, it stops that incarnation's run", () => {
    const { root, stopped } = bar();
    confirmButton(root).click();
    flushSync();
    expect(stopped).toEqual([["A", 3]]);
  });

  for (const [name, change] of [
    ["another run of the same incarnation", (p: { run: RunView | null; incarnation: string | null }) => { p.run = runOf(4); }],
    ["no run", (p: { run: RunView | null; incarnation: string | null }) => { p.run = null; }],
    ["the same run id in another incarnation", (p: { run: RunView | null; incarnation: string | null }) => { p.incarnation = "B"; p.run = runOf(3); }],
  ] as const) {
    test(`it closes and stops nothing when the view changes to ${name}`, () => {
      const { root, props, stopped } = bar();
      change(props);
      flushSync();
      expect(openDialog(root)).toBe(null);
      confirmButton(root).click();
      flushSync();
      expect(stopped).toEqual([]);
    });
  }
});

describe("QuestionPane's confirmation of End the run", () => {
  const widgetOf = (prompt: number): Widget => {
    const asked = { _tag: "Asked" as const, prompt, ...promptOf(prompts.decisionPrompt) };
    return { asked, options: [], choices: asked.choices, question: null, presentedAt: null, hint: prompts.pagePromptText(asked.kind, prompts.decisionPrompt) };
  };
  const pane = (how: "click" | "typed") => {
    const sent: [number, string][] = [];
    const props: { widget: Widget | null; identity: DraftKey | null; text: string; onAnswer: (prompt: number, text: string) => void } = $state({
      widget: widgetOf(1),
      identity: { incarnation: "A", run: 3, prompt: 1 },
      text: "",
      onAnswer: (prompt, text) => void sent.push([prompt, text]),
    });
    const root = target();
    mounted.push(mount(QuestionPane, { target: root, props }));
    flushSync();
    if (how === "click") {
      [...root.querySelectorAll<HTMLButtonElement>(".choices button")].find((b) => b.textContent?.trim() === prompts.END_RUN_LABEL)!.click();
    } else {
      const input = root.querySelector<HTMLInputElement>("input[name=answer]")!;
      input.value = "q";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    flushSync();
    expect(openDialog(root)).not.toBe(null);
    return { root, props, sent };
  };

  for (const how of ["click", "typed"] as const) {
    test(`${how}: confirmed while its prompt is pending, it delivers q to that prompt`, () => {
      const { root, sent } = pane(how);
      confirmButton(root).click();
      flushSync();
      expect(sent).toEqual([[1, "q"]]);
    });

    for (const [name, change] of [
      ["prompt 2 of the same run", (p: { widget: Widget | null; identity: DraftKey | null }) => { p.widget = widgetOf(2); p.identity = { incarnation: "A", run: 3, prompt: 2 }; }],
      ["a prompt of another run", (p: { widget: Widget | null; identity: DraftKey | null }) => { p.identity = { incarnation: "A", run: 4, prompt: 1 }; }],
      ["a prompt of another incarnation", (p: { widget: Widget | null; identity: DraftKey | null }) => { p.identity = { incarnation: "B", run: 3, prompt: 1 }; }],
      ["no prompt", (p: { widget: Widget | null; identity: DraftKey | null }) => { p.widget = null; p.identity = null; }],
    ] as const) {
      test(`${how}: it closes and delivers nothing when the pending prompt becomes ${name}`, () => {
        const { root, props, sent } = pane(how);
        change(props);
        flushSync();
        expect(openDialog(root)).toBe(null);
        confirmButton(root)?.click();
        flushSync();
        expect(sent).toEqual([]);
      });
    }
  }

  test("the typed text stays in the field while the same prompt is pending and the dialog is canceled", () => {
    const { root, props } = pane("typed");
    root.querySelector<HTMLButtonElement>("dialog button[name=cancel-end]")!.click();
    flushSync();
    expect(props.text).toBe("q");
  });
});
