import { ABANDONED, COMPLETED, HALTED, INTERRUPTED, SENT_BACK_PARKED, endedMark } from "../../test/endingFixtures.ts";
// Issue #139: the primary tabs, each with its run's mark. jsdom does no layout, so the CSS that keeps a label on one
// row is asserted, not the row.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ModeTabs from "./components/ModeTabs.svelte";
import { type Mark, markedTabName, markStateText } from "./notify.ts";
import { limitPauseText } from "../../src/prompts.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const PAUSE = { fromMs: Date.parse("2026-11-03T10:00:00Z"), untilMs: Date.parse("2026-11-03T23:11:00Z"), known: true };
const MARKS: readonly Mark[] = [
  { _tag: "Clear" },
  { _tag: "Running" },
  { _tag: "LimitPaused", pause: PAUSE },
  { _tag: "Waiting" },
  endedMark(COMPLETED),
  endedMark(HALTED),
];

const show = (mark: Mark, tab = "a") => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const props = $state({ tab, items: [{ value: "a", name: "Refinement", mark }, { value: "b", name: "Implementation", mark: { _tag: "Clear" } as Mark }] });
  mounted.push(mount(ModeTabs, { target: root, props }));
  flushSync();
  const label = root.querySelector<HTMLElement>('label[data-value="a"]')!;
  const radio = root.querySelector<HTMLInputElement>('input[value="a"]')!;
  return { root, props, label, radio };
};

describe("ModeTabs", () => {
  test("each mark's label reads markedTabName, and its radio is named with the state's words", () => {
    for (const mark of MARKS) {
      const { label, radio } = show(mark);
      expect(label.textContent?.trim()).toBe(markedTabName("Refinement", mark));
      expect(label.dataset["mark"]).toBe(mark._tag);
      const words = markStateText(mark);
      expect(radio.getAttribute("aria-label")).toBe(words === null ? "Refinement" : `Refinement: ${words}`);
      document.body.innerHTML = "";
    }
  });
  test("a running run holds one progress indicator, and no other mark does", () => {
    for (const mark of MARKS) {
      const { label } = show(mark);
      expect(label.querySelectorAll("[role=progressbar]").length).toBe(mark._tag === "Running" ? 1 : 0);
      document.body.innerHTML = "";
    }
  });
  test("halted is the alert; finished is not", () => {
    expect(show(endedMark(HALTED)).label.querySelector(".alert")).not.toBe(null);
    document.body.innerHTML = "";
    expect(show(endedMark(COMPLETED)).label.querySelector(".alert")).toBe(null);
  });
  // Issue #44 (decision Q2): a halt and an abandonment are drawn in the error color; any other ending is not.
  test("an abandonment is the alert too; a send-back and an interruption are not", () => {
    expect(show(endedMark(ABANDONED)).label.querySelector(".alert")).not.toBe(null);
    document.body.innerHTML = "";
    for (const ending of [SENT_BACK_PARKED, INTERRUPTED]) {
      const { label } = show(endedMark(ending));
      expect(label.querySelector(".alert")).toBe(null);
      expect(label.dataset["ending"]).toBe(ending._tag);
      document.body.innerHTML = "";
    }
  });
  test("a paused run shows when the pause ends", () => {
    const { label } = show({ _tag: "LimitPaused", pause: PAUSE });
    expect(label.querySelector(".when")?.textContent).toBe(limitPauseText(PAUSE.fromMs, PAUSE.untilMs, PAUSE.known));
  });
  test("the label is one row, and only the pause's time shrinks", () => {
    const { label } = show({ _tag: "LimitPaused", pause: PAUSE });
    expect(getComputedStyle(label).flexDirection).toBe("row");
    expect(getComputedStyle(label).flexWrap).toBe("nowrap");
    expect(getComputedStyle(label.querySelector(".when")!).minWidth).toBe("0px");
  });
  test("choosing a tab updates the bound value, and the indicator is under the selected tab", () => {
    const { root, props } = show({ _tag: "Clear" });
    expect(root.querySelector('label[data-value="a"] .indicator')).not.toBe(null);
    root.querySelector<HTMLInputElement>('input[value="b"]')!.click();
    flushSync();
    expect(props.tab).toBe("b");
    expect(root.querySelector('label[data-value="b"] .indicator')).not.toBe(null);
    expect(root.querySelectorAll(".indicator").length).toBe(1);
  });
});
