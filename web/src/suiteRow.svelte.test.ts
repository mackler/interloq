// Issue #39 (S10, decision Q2): the Full test suite row on the rail. Closed it shows passed or failed as before; opened,
// one line per command that counts tests, its text the one commandReportText gives; a click asks to open the row's
// shared scope.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import TimelineRail from "./components/TimelineRail.svelte";
import { commandReportText, suiteResultText } from "../../src/prompts.ts";
import type { CommandReport } from "../../src/testCounts.ts";
import { emptyUiState, type UiScope, withFlag } from "../../src/uiState.ts";
import { railView } from "./rail.ts";
import { emptyRun, type TimelineEntry } from "./state.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const unit: CommandReport = { _tag: "Counted", name: "npm run test:unit", outcome: "passed", scope: "whole", counts: { passed: 10, failed: 0, skipped: 1 } };
const web: CommandReport = { _tag: "Counted", name: "npm run test:web", outcome: "passed", scope: "whole", counts: { passed: 300, failed: 0, skipped: 3 } };
const build: CommandReport = { _tag: "Uncounted", name: "npm run build", outcome: "passed" };
const entry: TimelineEntry = {
  phase: { kind: "suite", n: 1 }, label: "Full test suite", groups: [], steps: [], state: "done", plan: null,
  began: "2026-11-03T00:00:00.000Z", ended: "2026-11-03T00:10:00.000Z", currentStep: null, lastStarted: null, acted: [], record: null,
  result: "passed", counts: [build, unit, web],
};
const scope: UiScope = { _tag: "RailPhase", phase: "suite-1" };

const show = (open: boolean, toggles: Array<[UiScope, boolean]> = []): HTMLElement => {
  const run = { ...emptyRun(1), timeline: [entry], ui: open ? withFlag(emptyUiState, { scope, open: true }) : emptyUiState };
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(mount(TimelineRail, { target: root, props: { timeline: [entry], busy: false, rail: railView(run, false, false), onToggle: (s: UiScope, o: boolean) => void toggles.push([s, o]) } }));
  flushSync();
  return root;
};

describe("the Full test suite row (issue #39)", () => {
  test("closed: its result and no count line; a click asks to open its scope", () => {
    const toggles: Array<[UiScope, boolean]> = [];
    const root = show(false, toggles);
    expect(root.querySelector("[data-phase-result]")?.textContent).toBe(suiteResultText("passed"));
    expect(root.querySelector("[data-suite-counts]")).toBeNull();
    root.querySelector<HTMLButtonElement>(".rail-toggle")!.click();
    expect(toggles).toEqual([[scope, true]]);
  });
  test("open: one line per counted command, each its commandReportText, the result still on the row", () => {
    const root = show(true);
    expect(root.querySelector("[data-phase-result]")?.textContent).toBe(suiteResultText("passed"));
    const lines = [...root.querySelectorAll("[data-suite-counts] li")].map((li) => li.textContent);
    expect(lines).toEqual([commandReportText(unit), commandReportText(web)]);
  });
});
