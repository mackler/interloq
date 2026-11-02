// Issue #204: the run's vertical separator, moved by the keys and by a drag committed on release.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ColumnSeparator from "./components/ColumnSeparator.svelte";
import type { Bounds } from "./columnWidths.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const separator = (value: number, bounds: Bounds) => {
  const previews: (number | null)[] = [];
  const commits: number[] = [];
  const events: string[] = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(
    mount(ColumnSeparator, {
      target: root,
      props: {
        name: "rail",
        label: "Width",
        value,
        bounds,
        valueText: `${value} rem wide`,
        unitPx: 16,
        onPreview: (n: number | null) => {
          previews.push(n);
          events.push(`preview ${n}`);
        },
        onCommit: (n: number) => {
          commits.push(n);
          events.push(`commit ${n}`);
        },
      },
    }),
  );
  flushSync();
  return { el: root.querySelector<HTMLElement>("[data-column-resize]")!, previews, commits, events };
};
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const pointer = (el: HTMLElement, type: string, clientX: number) => el.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));

describe("ColumnSeparator", () => {
  test("its role, orientation and value", () => {
    const { el } = separator(20, { min: 14, max: 28 });
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-valuenow")).toBe("20");
    expect(el.getAttribute("aria-valuemin")).toBe("14");
    expect(el.getAttribute("aria-valuemax")).toBe("28");
    expect(el.getAttribute("aria-valuetext")).toBe("20 rem wide");
    expect(el.getAttribute("aria-label")).toBe("Width");
    expect(el.tabIndex).toBe(0);
  });

  test("the keys commit, clamped; another key commits nothing", () => {
    for (const [k, want] of [["ArrowRight", 21], ["ArrowLeft", 19], ["Home", 14], ["End", 28]] as const) {
      const { el, commits } = separator(20, { min: 14, max: 28 });
      key(el, k);
      expect(commits).toEqual([want]);
      unmount(mounted.pop()!);
    }
    const top = separator(28, { min: 14, max: 28 });
    key(top.el, "ArrowRight");
    expect(top.commits).toEqual([28]);
    const other = separator(20, { min: 14, max: 28 });
    key(other.el, "a");
    key(other.el, "ArrowUp");
    expect(other.commits).toEqual([]);
  });

  test("a drag previews live and commits once on release", () => {
    const { el, previews, commits, events } = separator(14, { min: 14, max: 28 });
    pointer(el, "pointerdown", 100);
    pointer(el, "pointermove", 124);
    pointer(el, "pointermove", 148);
    expect(previews.at(-1)).toBe(17);
    expect(commits).toEqual([]);
    pointer(el, "pointerup", 148);
    expect(commits).toEqual([17]);
    expect(events.slice(-2)).toEqual(["preview null", "commit 17"]);
    pointer(el, "pointermove", 300);
    expect(commits).toEqual([17]);
  });

  test("a collapsed bound changes nothing", () => {
    const { el, commits } = separator(14, { min: 14, max: 14 });
    for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) key(el, k);
    expect(commits.every((n) => n === 14)).toBe(true);
  });
});
