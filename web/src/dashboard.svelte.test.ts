import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import Dashboard from "./components/Dashboard.svelte";
import * as prompts from "../../src/prompts.ts";
import { plainBlocks, plainPieces } from "../../src/pieces.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import { shownOf } from "./test-setup.ts";
import { type AnsweredEntry, type Dashboard as DashboardView, emptyDashboard, emptyRun, type RunView } from "./state.ts";

// Issue #22: the "You and Interloq" panel as a dashboard, mounted in jsdom.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const question: PresentedQuestion = {
  number: 3,
  origin: { kind: "relayed" },
  context: { blocks: plainBlocks("The context."), by: "agent" },
  history: [],
  explanations: [shownOf({ id: "z", term: "zod", senses: ["A library."] })],
  question: [{ text: "Which ", ref: "", code: false }, { text: "zod", ref: "z", code: false }, { text: "?", ref: "", code: false }],
  options: [{ label: plainPieces("A"), description: plainPieces("a"), answer: { token: "1" } }],
  attached: { kind: "request", blocks: [{ kind: "code", text: "npm i zod" }] },
  decision: null,
};
const entry = (i: number, asked: AnsweredEntry["asked"] = { _tag: "NotShown" }): AnsweredEntry => ({ key: `1-${i}`, asked, answer: `answer **${i}**` });

const runWith = (dashboard: Partial<DashboardView>, more: Partial<RunView> = {}): RunView => ({
  ...emptyRun(1),
  item: { id: "22", title: "The dashboard" },
  dashboard: { ...emptyDashboard, ...dashboard },
  ...more,
});

const mountDashboard = (run: RunView, extra: { compact?: boolean; answersOpen?: boolean } = {}) => {
  const toggles: boolean[] = [];
  const props = $state({ run, answersOpen: extra.answersOpen ?? false, compact: extra.compact ?? false, onAnswers: (open: boolean) => void toggles.push(open) });
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(Dashboard, { target, props }));
  flushSync();
  return { target, props, toggles };
};

describe("the dashboard", () => {
  test("its header is the item's headline, and the panel's name before Started", () => {
    const { target } = mountDashboard(runWith({}));
    expect(target.querySelector("h2")?.textContent).toBe(prompts.itemHeadline("22", "The dashboard"));
    expect(target.querySelector("section")?.getAttribute("aria-label")).toBe("You and Interloq");
    const before = mountDashboard({ ...emptyRun(2) });
    expect(before.target.querySelector("h2")?.textContent).toBe("You and Interloq");
  });

  test("the model lines are shown once named", () => {
    expect(mountDashboard(runWith({})).target.querySelector("[data-models]")).toBe(null);
    const { target } = mountDashboard(runWith({ models: { claude: "Claude Code model: x", codex: "Codex model: y" } }));
    expect(target.querySelector("[data-models]")?.textContent).toMatch(/Claude Code model: x.*Codex model: y/s);
  });

  test("the status's text, Idle's text, and the countdown of each wait", () => {
    expect(mountDashboard(runWith({ status: { _tag: "Interloq", text: "Planning began." } })).target.querySelector("[data-status]")?.textContent).toBe("Planning began.");
    expect(mountDashboard(runWith({})).target.querySelector("[data-status]")?.textContent).toBe(prompts.NO_AGENT_WORKING);
    const now = Date.now();
    const retry = mountDashboard(runWith({ status: { _tag: "Activity", text: "Codex — retry" } }, { retry: { agent: "codex", purpose: "review", text: "retry", wait: { fromMs: now - 1000, untilMs: now + 60_000 } } }));
    expect(retry.target.querySelector("[data-retry-wait]")).not.toBe(null);
    const limit = mountDashboard(runWith({}, { limitWait: { agent: "claude", purpose: "planning", limitType: null, basis: { kind: "reset" }, fromMs: now - 1000, untilMs: now + 60_000 } }));
    expect(limit.target.querySelector("[data-limit-wait]")).not.toBe(null);
  });

  test("Claude Code's latest message is rendered Markdown with its heading", () => {
    const { target } = mountDashboard(runWith({ claude: { heading: "Interview", body: "**bold**" } }));
    const region = target.querySelector("[data-claude]");
    expect(region?.querySelector("strong")?.textContent).toBe("bold");
    expect(region?.textContent).toMatch(/Claude/);
    expect(region?.textContent).toMatch(/Interview/);
    expect(mountDashboard(runWith({})).target.querySelector("[data-claude]")).toBe(null);
  });

  test("the last answer shows its question as presented, its attached material and its explanations, and the answer as Markdown", () => {
    const { target } = mountDashboard(runWith({ answers: [entry(1), entry(2, { _tag: "Question", question })] }));
    const last = target.querySelector("[data-last-answer]");
    expect(last?.textContent).toMatch(/Which zod\?/);
    expect(last?.textContent).toMatch(/npm i zod/);
    expect(last?.querySelector("[data-ref=z]")?.textContent).toBe("zod");
    expect(last?.querySelector("[data-your-answer] strong")?.textContent).toBe("2");
    expect(last?.textContent).toMatch(new RegExp(prompts.LAST_ANSWER_LABEL));
    const hinted = mountDashboard(runWith({ answers: [entry(1, { _tag: "Hint", hint: "Continue?" })] }));
    expect(hinted.target.querySelector("[data-last-answer]")?.textContent).toMatch(/Continue\?/);
  });

  test("every answer is under a heading closed at first, which reports a click and lists them in order when open", () => {
    const answers = [entry(1), entry(2), entry(3)];
    const closed = mountDashboard(runWith({ answers }));
    const button = closed.target.querySelector<HTMLButtonElement>("[data-answers-heading] button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.textContent).toMatch(new RegExp(prompts.allAnswersHeading(3).replace(/[()]/g, "\\$&")));
    expect(closed.target.querySelector("[data-answers]")).toBe(null);
    button?.click();
    expect(closed.toggles).toEqual([true]);
    const open = mountDashboard(runWith({ answers }), { answersOpen: true });
    expect([...open.target.querySelectorAll("[data-answers] [data-answer]")].map((e) => e.querySelector("[data-your-answer]")?.textContent?.trim())).toEqual(["answer 1", "answer 2", "answer 3"]);
    expect(mountDashboard(runWith({})).target.querySelector("[data-answers-heading] button")).toBe(null);
  });

  test("the interview's help is shown while set", () => {
    expect(mountDashboard(runWith({ interviewHelp: "Type /done" })).target.querySelector("[data-interview-help]")?.textContent).toBe("Type /done");
    expect(mountDashboard(runWith({})).target.querySelector("[data-interview-help]")).toBe(null);
  });

  test("compact: the status, ellipsized with its whole text as its title, and the heading of every answer, nothing else", () => {
    const run = runWith({ status: { _tag: "Interloq", text: "A long line" }, models: { claude: "m", codex: null }, claude: { heading: null, body: "c" }, interviewHelp: "h", answers: [entry(1), entry(2)] });
    const { target } = mountDashboard(run, { compact: true });
    const status = target.querySelector("[data-status]");
    expect(status?.textContent).toBe("A long line");
    expect(status?.getAttribute("title")).toBe("A long line");
    expect(status?.classList.contains("compact")).toBe(true);
    for (const attr of ["data-models", "data-claude", "data-last-answer", "data-interview-help"]) expect(target.querySelector(`[${attr}]`), attr).toBe(null);
    expect(target.querySelector("h2")).toBe(null);
    expect(target.querySelector("[data-answers-heading] button")).not.toBe(null);
    const open = mountDashboard(run, { compact: true, answersOpen: true });
    expect(open.target.querySelectorAll("[data-answers] [data-answer]").length).toBe(2);
  });
});
