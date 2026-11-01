import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import Dashboard from "./components/Dashboard.svelte";
import * as prompts from "../../src/prompts.ts";
import type { DecisionAnalysis, Entry } from "../../src/schema.ts";
import type { ShownDocument } from "../../src/reviewedDocument.ts";
import { type Dashboard as DashboardView, emptyDashboard, emptyRun, type RunView } from "./state.ts";

// Issue #86 (requirements Q1, Q2 and G-R1-1): the dashboard's closed heading of the document under review, and the
// draft analysis under the question while a decision is prepared.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const el = (text: string, counterarguments: Entry["threshold"]["counterarguments"] = []) => ({ text, counterarguments });
const entry = (id: string, title: string, counterarguments: Entry["threshold"]["counterarguments"] = []): Entry => ({
  id,
  title,
  comparative_condition: el(`condition of ${id}`, counterarguments),
  starting_cause: el("cause"),
  intermediate_steps: el("steps"),
  threshold: el("threshold"),
  effect_on_persons: el("effect"),
  reason_the_effect_matters: el("matters"),
  extent: { per_person: el("per"), persons_affected: el("persons"), likelihood: el("likely"), timing: el("timing") },
});
const analysis: DecisionAnalysis = {
  decision: "Which database?",
  columns: [
    { kind: "argued", option: "SQLite", advantages: [entry("E1", "a file", [{ id: "C1", text: "It is not true that a file suffices.", equivalent_to: "E2", replies: [{ id: "R1", text: "It is true.", equivalent_to: "", replies: [] }] }])], disadvantages: [] },
    { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [entry("E2", "a server")] },
  ],
  recommendation: { option: "SQLite", reason: "Smaller." },
};
const runWith = (dashboard: Partial<DashboardView>, more: Partial<RunView> = {}): RunView => ({ ...emptyRun(1), item: { id: "86", title: "Documents" }, dashboard: { ...emptyDashboard, ...dashboard }, ...more });
const deciding = (question: number): Partial<RunView> => ({ deciding: [{ question, widget: null as never, prompt: null }] });

const mountDashboard = (run: RunView, extra: { compact?: boolean; documentOpen?: boolean } = {}) => {
  const toggles: boolean[] = [];
  const props = $state({ run, answersOpen: false, onAnswers: () => {}, documentOpen: extra.documentOpen ?? false, compact: extra.compact ?? false, onDocument: (open: boolean) => void toggles.push(open) });
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(Dashboard, { target, props }));
  flushSync();
  return { target, props, toggles };
};
const heading = (target: HTMLElement) => target.querySelector("[data-document-heading] button");
const body = (target: HTMLElement) => target.querySelector("[data-document]");
const withDocument = (document: ShownDocument, subject: Parameters<typeof prompts.documentLabel>[0] = { plan: 1 }) => runWith({ document: { subject, document } });

describe("the document under review on the dashboard", () => {
  test("absent with no document; present, closed and named by its document; a click asks to open it", () => {
    expect(heading(mountDashboard(runWith({})).target)).toBe(null);
    const { target, toggles } = mountDashboard(withDocument({ _tag: "Markdown", text: "# The plan" }));
    expect(heading(target)?.textContent).toContain(prompts.documentLabel({ plan: 1 }));
    expect(heading(target)?.getAttribute("aria-expanded")).toBe("false");
    expect(body(target)).toBe(null);
    (heading(target) as HTMLButtonElement).click();
    expect(toggles).toEqual([true]);
  });

  test("open, a Markdown document is rendered, and a newer document replaces it", () => {
    const { target, props } = mountDashboard(withDocument({ _tag: "Markdown", text: "# The plan\n\n1. step one" }), { documentOpen: true });
    expect(body(target)?.querySelector("h1")?.textContent).toBe("The plan");
    props.run = withDocument({ _tag: "Markdown", text: "# The amended plan" });
    flushSync();
    expect(body(target)?.querySelector("h1")?.textContent).toBe("The amended plan");
    expect(body(target)?.textContent).not.toContain("step one");
  });

  test("a diff is text in a pre: a tag and a backtick stay characters", () => {
    const { target } = mountDashboard(withDocument({ _tag: "Diff", text: "+<b>x</b>\n-`y`" }, { work: 1 }), { documentOpen: true });
    expect(heading(target)?.textContent).toContain(prompts.documentLabel({ work: 1 }));
    const pre = body(target)?.querySelector("pre");
    expect(pre?.textContent).toBe("+<b>x</b>\n-`y`");
    expect(pre?.querySelector("b")).toBe(null);
  });

  test("an analysis shows its headings and labels, the opposing texts marked, a counterargument and its reply nested, and the equivalence symbol on both sides", () => {
    const { target } = mountDashboard(withDocument({ _tag: "Analysis", analysis }, { decision: 1 }), { documentOpen: true });
    const text = body(target)?.textContent ?? "";
    expect(text).toContain(prompts.ADVANTAGES_HEADING);
    expect(text).toContain(prompts.advantageLabel(1));
    expect(text).toContain(prompts.DISADVANTAGES_HEADING);
    const counter = body(target)?.querySelector("[data-argument-level='1']");
    expect(counter?.textContent).toContain("It is not true that a file suffices.");
    expect(counter?.classList.contains("opposes")).toBe(true);
    expect(body(target)?.querySelector("[data-argument-level='2']")?.textContent).toContain("It is true.");
    const marks = [...(body(target)?.querySelectorAll("[data-symbol]") ?? [])].map((e) => e.textContent);
    expect(marks.filter((m) => m === "*").length).toBe(2);
    expect(text).toContain("Smaller.");
  });
});

describe("the draft analysis in the compact strip", () => {
  const draftRun = (more: Partial<RunView>) => runWith({ document: { subject: { plan: 1 }, document: { _tag: "Markdown", text: "# The plan" } }, draft: { decision: 2, question: 3, analysis } }, more);

  test("shown only while its question is being decided, named for the draft, never the full document", () => {
    const { target } = mountDashboard(draftRun(deciding(3)), { compact: true, documentOpen: true });
    expect(heading(target)?.textContent).toContain(prompts.documentLabel({ decision: 2 }));
    expect(body(target)?.textContent).toContain(prompts.ADVANTAGES_HEADING);
    expect(body(target)?.textContent).not.toContain("The plan");
    expect(heading(mountDashboard(draftRun({ deciding: [] }), { compact: true }).target)).toBe(null);
    expect(heading(mountDashboard(runWith({ document: { subject: { plan: 1 }, document: { _tag: "Markdown", text: "# The plan" } } }), { compact: true }).target)).toBe(null);
  });
});
