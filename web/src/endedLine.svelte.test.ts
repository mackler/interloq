// Issue #44 (S8): the ended line states the run's ending and the confirmed disposition of its work and item, from the
// one vocabulary of src/prompts.ts; its glyph is hidden from assistive technology, and color is never the only signal.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import EndedLine from "./components/EndedLine.svelte";
import type { Ending } from "../../src/ending.ts";
import { endingAlerts } from "../../src/ending.ts";
import { endingDetails, endingLine, endingMarkOf, runTimeText } from "../../src/prompts.ts";
import { ABANDONED_PARK_FAILED, ENDINGS, HALTED_UNCHECKED, SENT_BACK_NOTHING, UNESTABLISHED_ENDING } from "../../test/endingFixtures.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const show = (ending: Ending, runTimeMs: number | null = null): HTMLElement => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(mount(EndedLine, { target: root, props: { ending, runTimeMs } }));
  flushSync();
  return root.querySelector<HTMLElement>("[role=status]")!;
};
const visibleText = (el: HTMLElement): string => [...el.querySelectorAll("p")].map((p) => p.textContent).join("\n");

describe("EndedLine", () => {
  test("every ending: its line and details, its glyph hidden, the alert exactly for a halt and an abandonment", () => {
    for (const ending of ENDINGS) {
      const status = show(ending);
      expect(status.dataset["ending"]).toBe(ending._tag);
      const paragraphs = [...status.querySelectorAll("p")].map((p) => p.textContent);
      expect(paragraphs).toEqual([endingLine(ending), ...endingDetails(ending)]);
      const glyph = status.querySelector("[aria-hidden=true]");
      expect(glyph?.textContent).toBe(endingMarkOf(ending));
      expect(status.querySelectorAll(".alert").length > 0).toBe(endingAlerts(ending));
      document.body.innerHTML = "";
    }
  });
  // Issue #18: the run's time, after the ending's line and before its details, a measurement and never an alert.
  test("every ending with a run time shows it after its line, in the details' style", () => {
    for (const ending of ENDINGS) {
      const status = show(ending, 3_725_000);
      const paragraphs = [...status.querySelectorAll("p")].map((p) => p.textContent);
      expect(paragraphs).toEqual([endingLine(ending), runTimeText(3_725_000), ...endingDetails(ending)]);
      const runTime = status.querySelector("[data-run-time]");
      expect(runTime?.textContent).toBe(runTimeText(3_725_000));
      expect(runTime?.classList.contains("alert")).toBe(false);
      document.body.innerHTML = "";
    }
  });
  test("a run with no run time shows none", () => {
    expect(show(ENDINGS[0]!, null).querySelector("[data-run-time]")).toBeNull();
  });
  test("a send-back that parked nothing says there was no work to keep and names no branch", () => {
    const text = visibleText(show(SENT_BACK_NOTHING));
    expect(text).toContain("There was no work to keep, so no branch was made.");
    expect(text).not.toContain("interloq/");
    expect(text).not.toContain("moved to branch");
  });
  test("an abandonment whose parking failed never says the work was moved", () => {
    expect(visibleText(show(ABANDONED_PARK_FAILED))).not.toContain("moved to branch");
  });
  test("an unconfirmed return names no label the item carried", () => {
    const text = visibleText(show(HALTED_UNCHECKED));
    expect(text).toContain("could not be checked");
    expect(text).not.toContain("carried the label");
  });
  test("an older run's end claims no completion", () => {
    const status = show(UNESTABLISHED_ENDING);
    expect(status.textContent).not.toContain("✓");
    expect(status.textContent).not.toContain("Completed");
  });
});
