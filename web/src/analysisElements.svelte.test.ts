import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import AnalysisElements from "./components/AnalysisElements.svelte";
import source from "./components/AnalysisElements.svelte?raw";
import { type ArgumentView, ELEMENT_ROLES, type EntryView, elementViewsOf, viewOf } from "../../src/analysisView.ts";
import * as prompts from "../../src/prompts.ts";
import type { Argument, Entry } from "../../src/schema.ts";

// Issue #41: an entry's parts as the page shows them: the chain of causes as one ordered list, the extent as one list,
// each part's name for screen readers alone, the marks hidden from them, and a counterargument outside its element's text.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const el = (text: string, counterarguments: Argument[] = []) => ({ text, counterarguments });
const arg = (id: string, text: string, replies: Argument[] = []): Argument => ({ id, text, equivalent_to: "", replies });
const source_: Entry = {
  id: "E1",
  title: "A server.",
  comparative_condition: el("condition", [arg("P1", "against the premise")]),
  starting_cause: el("cause"),
  intermediate_steps: el("steps"),
  threshold: el("threshold", [arg("T1", "against the threshold", [arg("T2", "defending the threshold")])]),
  effect_on_persons: el("effect"),
  reason_the_effect_matters: el("matters", [arg("M1", "against the reason")]),
  extent: { per_person: el("per"), persons_affected: el("persons"), likelihood: el("likely"), timing: el("timing", [arg("W1", "against the timing")]) },
};
const entryView = (): EntryView => {
  const view = viewOf({ decision: "d", columns: [{ kind: "argued", option: "A", advantages: [], disadvantages: [source_] }], recommendation: { option: "", reason: "" } });
  const column = view.columns[0];
  if (column.kind !== "argued") throw new Error("not argued");
  return column.disadvantages[0];
};
const symbol = createRawSnippet((argument: () => ArgumentView) => ({ render: () => `<span data-symbol>${argument().symbol?.mark ?? ""}</span>` }));
const render = (entry: EntryView): HTMLElement => {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(AnalysisElements, { target, props: { entry, symbol } }));
  flushSync();
  return target;
};
const wrapper = (root: HTMLElement, role: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`:is(div, li)[data-role="${role}"]`);
  if (found === null) throw new Error(`no wrapper of ${role}`);
  return found;
};
const argumentById = (root: HTMLElement, text: string): HTMLElement => {
  const found = [...root.querySelectorAll<HTMLElement>(".argument")].find((a) => a.textContent?.includes(text));
  if (found === undefined) throw new Error(`no argument ${text}`);
  return found;
};

describe("AnalysisElements (issue #41)", () => {
  test("the chain is one ordered list and the extent one list, each named, the roles in order", () => {
    const root = render(entryView());
    const chain = root.querySelector("ol.chain");
    expect(chain?.getAttribute("aria-label")).toBe(prompts.ELEMENT_GROUP_NAMES.chain);
    expect([...chain!.children].map((li) => li.getAttribute("data-role"))).toEqual(["startingCause", "intermediateSteps", "threshold", "effectOnPersons"]);
    const extent = root.querySelector("ul.extent");
    expect(extent?.getAttribute("aria-label")).toBe(prompts.ELEMENT_GROUP_NAMES.extent);
    expect([...extent!.children].map((li) => li.getAttribute("data-role"))).toEqual(["perPerson", "personsAffected", "likelihood", "timing"]);
    expect([...root.querySelectorAll(".element-text")].map((t) => t.getAttribute("data-role"))).toEqual([...ELEMENT_ROLES]);
  });

  test("each counterargument stays inside its own element's wrapper, the premise's and the reason's included", () => {
    const root = render(entryView());
    expect(wrapper(root, "comparativeCondition").contains(argumentById(root, "against the premise"))).toBe(true);
    expect(wrapper(root, "threshold").contains(argumentById(root, "against the threshold"))).toBe(true);
    expect(wrapper(root, "threshold").contains(argumentById(root, "defending the threshold"))).toBe(true);
    expect(wrapper(root, "reasonTheEffectMatters").contains(argumentById(root, "against the reason"))).toBe(true);
    expect(wrapper(root, "timing").contains(argumentById(root, "against the timing"))).toBe(true);
  });

  test("every element's text begins with its hidden name, and the marks are hidden from assistive technology", () => {
    const root = render(entryView());
    for (const text of root.querySelectorAll<HTMLElement>(".element-text")) {
      const role = text.getAttribute("data-role") as (typeof ELEMENT_ROLES)[number];
      const first = text.firstElementChild;
      expect(first?.classList.contains("visually-hidden")).toBe(true);
      expect(first?.textContent).toBe(`${prompts.ELEMENT_ROLE_NAMES[role]}: `);
    }
    const marks = [...root.querySelectorAll<HTMLElement>(".mark")];
    expect(marks.every((m) => m.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(marks.map((m) => [m.closest("[data-role]")?.getAttribute("data-role"), m.textContent])).toEqual([
      ["startingCause", prompts.CHAIN_START_MARK],
      ["intermediateSteps", prompts.CHAIN_LINK_MARK],
      ["effectOnPersons", prompts.CHAIN_LINK_MARK],
      ["reasonTheEffectMatters", prompts.REASON_MARK],
    ]);
  });

  test("counterarguments under the threshold and the extent are outside every element text, with their sides and levels", () => {
    const entry = entryView();
    const root = render(entry);
    const views = elementViewsOf(entry).flatMap((e) => e.arguments);
    for (const text of ["against the threshold", "defending the threshold", "against the timing"]) {
      const node = argumentById(root, text);
      expect(node.closest(".element-text")).toBe(null);
      const view = views.find((a) => a.text === text)!;
      expect(node.classList.contains("opposes")).toBe(view.opposes);
      expect(node.getAttribute("data-level")).toBe(String(view.level));
      expect(node.getAttribute("data-argument-level")).toBe(String(view.level));
    }
  });

  test("the names are visually hidden by the component's own rule", () => {
    expect(source).toMatch(/\.visually-hidden\s*\{[^}]*position:\s*absolute;[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*clip:\s*rect\(0 0 0 0\)/);
    expect(source).toMatch(/\.opposes\s*\{\s*color:\s*var\(--m3c-error\);/);
  });
});
