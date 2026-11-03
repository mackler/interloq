// Issue #202: the second row of tabs scrolls sideways inside itself, and shows the selected tab's indicator for any tab.
// jsdom does no layout, so the CSS that decides the widths is asserted, not the widths.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ScrollableTabs from "./components/ScrollableTabs.svelte";
import type { Ending } from "../../src/ending.ts";
import { ABANDONED, HALTED, INTERRUPTED, SENT_BACK_PARKED } from "../../test/endingFixtures.ts";
import { endedTabName, runEndedText } from "../../src/prompts.ts";

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

// Issue #44: an ended run's tab hides its glyph from assistive technology and says its ending in words; a halt and an
// abandonment are drawn in the error color (decision Q2), and the visible text is the composed name as before.
describe("an ended run's tab", () => {
  const endedItems = (ending: Ending) => [{ name: "Items", value: "list" }, { name: endedTabName("#11 item", ending), value: "run-1", plain: "#11 item", ending }];
  const showEnded = (ending: Ending): HTMLLabelElement => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    mounted.push(mount(ScrollableTabs, { target: root, props: { tab: "list", items: endedItems(ending) } }));
    flushSync();
    return root.querySelectorAll("label")[1]!;
  };
  test("a halt and an abandonment: the glyph hidden and in the alert's color, the ending in words", () => {
    for (const ending of [HALTED, ABANDONED]) {
      const label = showEnded(ending);
      const glyph = label.querySelector("[aria-hidden=true].alert");
      expect(glyph).not.toBe(null);
      expect(label.textContent).toContain(runEndedText(ending));
      expect(label.querySelector(".visually-hidden")?.textContent).toBe(`, ${runEndedText(ending)}`);
      document.body.innerHTML = "";
    }
  });
  test("a send-back and an interruption: the glyph hidden, not the alert, the ending in words", () => {
    for (const ending of [SENT_BACK_PARKED, INTERRUPTED]) {
      const label = showEnded(ending);
      expect(label.querySelector("[aria-hidden=true]:not(.indicator)")?.classList.contains("alert")).toBe(false);
      expect(label.textContent).toContain(runEndedText(ending));
      document.body.innerHTML = "";
    }
    expect(runEndedText(SENT_BACK_PARKED)).toBe("a run sent back");
    expect(runEndedText(INTERRUPTED)).toBe("a run interrupted");
  });
  test("the visible text is the composed name; a tab with no ending renders as before", () => {
    const label = showEnded(SENT_BACK_PARKED);
    const shown = [...label.querySelectorAll("span")].filter((s) => !s.classList.contains("visually-hidden") && s.closest(".visually-hidden") === null);
    expect(shown.map((s) => s.textContent).join("").startsWith("↩ #11 item")).toBe(true);
    const list = label.parentElement!.querySelectorAll("label")[0]!;
    expect(list.querySelector("span")?.textContent).toBe("Items");
    expect(list.querySelector(".visually-hidden")).toBe(null);
  });
});
