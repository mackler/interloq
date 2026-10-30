// Issue #131 (S19): the preparation's switch above the Refinement list, its status, and each item's mark.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { PreparationStatus, PreparationView } from "../../src/preparationSwitch.ts";
import type { ListedItem } from "../../src/protocol.ts";
import ItemList from "./components/ItemList.svelte";
import PreparationControl from "./components/PreparationControl.svelte";
import { initialState, shownMark, type ViewState } from "./state.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const show = (component: typeof ItemList | typeof PreparationControl, props: Record<string, unknown>): HTMLElement => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(mount(component as typeof ItemList, { target: root, props: props as never }));
  flushSync();
  return root;
};
const view = (status: PreparationStatus, enabled = true): PreparationView => ({ settings: { enabled, generation: 1 }, status });
const item = (id: string, preparation: ListedItem["preparation"] = null): ListedItem => ({ id, title: `title ${id}`, excerpt: "", url: null, sentBack: 0, preparation });

describe("PreparationControl", () => {
  test("the switch shows the view's setting and its click sends the other", () => {
    const sent: boolean[] = [];
    const root = show(PreparationControl, { view: view({ _tag: "Off" }, false), onChange: (enabled: boolean) => void sent.push(enabled) });
    const input = root.querySelector<HTMLInputElement>("input[name=preparation]")!;
    expect(input.checked).toBe(false);
    expect(root.textContent).toContain(prompts.PREPARATION_SWITCH_LABEL);
    input.click();
    flushSync();
    expect(sent).toEqual([true]);
  });

  test("each status shows its text", () => {
    for (const status of [{ _tag: "Off" }, { _tag: "Idle" }, { _tag: "Preparing", item: "7", title: "Seven" }, { _tag: "Unavailable", notice: "the tracker is down" }] as PreparationStatus[]) {
      const root = show(PreparationControl, { view: view(status, status._tag !== "Off"), onChange: () => undefined });
      expect(root.querySelector("[role=status]")!.textContent).toBe(prompts.preparationStatusText(status));
    }
  });
});

describe("ItemList's preparation marks", () => {
  const list = (items: readonly ListedItem[], state: ViewState) =>
    show(ItemList, { mode: "refinement", items: { _tag: "Listed", items }, startable: { _tag: "Except", items: [] }, markOf: (i: ListedItem) => shownMark(state, i), onStart: () => undefined, onRefresh: () => undefined });
  const row = (root: HTMLElement, id: string) => root.querySelector(`[data-item="${id}"]`)!.closest("li")!;

  test("each mark's text on its row, the terms note on a prepared one, and every start enabled", () => {
    const items = [item("1", { _tag: "Prepared", questions: 3 }), item("2", { _tag: "Prepared", questions: 0 }), item("3", { _tag: "SetAside", reason: "its review stopped" }), item("4", { _tag: "Preparing" }), item("5")];
    const root = list(items, { ...initialState, preparation: view({ _tag: "Preparing", item: "4", title: "title 4" }) });
    expect(row(root, "1").textContent).toContain(prompts.preparedMarkText(3));
    expect(row(root, "1").textContent).toContain(prompts.PREPARED_TERMS_NOTE);
    expect(row(root, "2").textContent).toContain(prompts.preparedMarkText(0));
    expect(row(root, "3").textContent).toContain(prompts.setAsideMarkText("its review stopped"));
    expect(row(root, "3").querySelector("[data-preparation]")!.classList.contains("error")).toBe(true);
    expect(row(root, "4").textContent).toContain(prompts.PREPARING_MARK);
    expect(row(root, "5").querySelector("[data-preparation]")).toBe(null);
    for (const id of ["1", "2", "3", "4", "5"]) expect(root.querySelector<HTMLButtonElement>(`[data-item="${id}"]`)!.disabled).toBe(false);
  });

  // W2-R1-1: the view decides Preparing; a listed Preparing the switch's status does not name is outdated.
  test("a listed Preparing that the switch's status does not name shows no mark on its row", () => {
    const state: ViewState = { ...initialState, preparation: view({ _tag: "Idle" }) };
    const root = list([item("4", { _tag: "Preparing" })], state);
    expect(row(root, "4").querySelector("[data-preparation]")).toBe(null);
    expect(row(root, "4").textContent).not.toContain(prompts.PREPARING_MARK);
  });

  test("with a listing of no marks, the view's item being prepared shows Preparing on its row alone", () => {
    const state: ViewState = { ...initialState, preparation: view({ _tag: "Preparing", item: "2", title: "title 2" }) };
    const root = list([item("1"), item("2"), item("3")], state);
    expect(row(root, "2").textContent).toContain(prompts.PREPARING_MARK);
    expect(row(root, "1").textContent).not.toContain(prompts.PREPARING_MARK);
    expect(row(root, "3").textContent).not.toContain(prompts.PREPARING_MARK);
  });
});
