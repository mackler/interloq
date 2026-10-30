// Issue #202: the second row of tabs scrolls sideways inside itself, and shows the selected tab's indicator for any tab.
// jsdom does no layout, so the CSS that decides the widths is asserted, not the widths.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ScrollableTabs from "./components/ScrollableTabs.svelte";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const runName = (n: number): string => `#12${n} ${"A long title of a refinement run".slice(0, 26)}…`;
const items = [{ name: "Items", value: "list" }, ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ name: runName(n), value: `run-${n}` }))];

const show = (tab: string): { root: HTMLElement; props: { tab: string; items: typeof items } } => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const props = $state({ tab, items });
  mounted.push(mount(ScrollableTabs, { target: root, props }));
  flushSync();
  return { root, props };
};

describe("ScrollableTabs", () => {
  test("the indicator is inside the selected tab, the eighth of eight", () => {
    const { root } = show("run-7");
    const indicators = root.querySelectorAll(".indicator");
    expect(indicators.length).toBe(1);
    expect(indicators[0]!.closest("label")).toBe(root.querySelectorAll("label")[7]);
  });

  test("the row scrolls inside itself and no tab shrinks or wraps", () => {
    const { root } = show("run-7");
    const row = root.querySelector<HTMLElement>(".row")!;
    expect(getComputedStyle(row).overflowX).toBe("auto");
    expect(getComputedStyle(row).flexWrap).toBe("nowrap");
    for (const label of root.querySelectorAll("label")) {
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(label).flexShrink).toBe("0");
    }
  });

  test("choosing another tab updates the bound tab and moves the indicator", () => {
    const { root, props } = show("run-7");
    root.querySelectorAll<HTMLInputElement>("input")[2]!.click();
    flushSync();
    expect(props.tab).toBe("run-2");
    expect(root.querySelector(".indicator")!.closest("label")).toBe(root.querySelectorAll("label")[2]);
  });

  test("every tab shows its whole name", () => {
    const { root } = show("list");
    expect([...root.querySelectorAll("label")].map((label) => label.textContent?.trim())).toEqual(items.map((item) => item.name));
  });
});
