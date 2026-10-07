/// <reference types="vite/client" />
import { type Component, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { viewOf } from "../../src/analysisView.ts";
import DirectoryDialog from "./components/DirectoryDialog.svelte";
import QuestionPane from "./components/QuestionPane.svelte";
import StartForm from "./components/StartForm.svelte";
import TimelineRail from "./components/TimelineRail.svelte";
import CircularIndeterminate from "./components/CircularIndeterminate.svelte";
import ActivityLine from "./components/ActivityLine.svelte";
import type { ServerMessage } from "../../src/protocol.ts";
import { countOfKind, foreseenPhases, phaseName, type UiEvent } from "../../src/uiEvents.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import type { Room } from "./layout.ts";
import TopBar from "./components/TopBar.svelte";
import MessageView from "./components/Message.svelte";
import ChatPanel from "./components/ChatPanel.svelte";
import { clockTime, fullTime, TOOLTIP_GRACE_MS } from "./time.ts";
import { callStartedAt, emptyRun, executing, initialState, type Message, reduce, type RoundGroup, type TimelineEntry, type TimelineStep, type Widget } from "./state.ts";
import { plainBlocks, plainPieces } from "../../src/pieces.ts";
const ref = (text: string, id: string) => ({ text, ref: id, code: false });

// Plan step 4.5: the components, mounted in jsdom.
let mounted: ReturnType<typeof mount>[] = [];
const show = <P extends Record<string, any>>(component: Component<P>, props: P) => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
};
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
  localStorage.clear();
});
const one = (root: ParentNode, selector: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no element matching ${selector}`);
  return el;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};
const widget = (text: string, options: Widget["options"] = []): Widget => {
  const asked = { _tag: "Asked" as const, prompt: 7, ...promptOf(text) };
  return { asked, options, choices: asked.choices, question: null, presentedAt: null, hint: prompts.pagePromptText(asked.kind, text) };
};

// Issue #1: a message's time, shown in its header or, when grouped, given to assistive technology only.
describe("Message", () => {
  const ISO = "2026-09-27T14:03:27.000Z";
  const m = (showTime: boolean): Message => ({ key: "1-1", author: "codex", heading: "Plan review, round 1", body: "No issue.", format: "text", time: ISO, showTime, band: null });

  test("a shown time is in the header as <time datetime title>, visible", () => {
    const root = show(MessageView, { message: m(true) });
    const time = one(root, "header time") as HTMLTimeElement;
    expect(time.getAttribute("datetime")).toBe(ISO);
    expect(time.getAttribute("title")).toBe(fullTime(ISO));
    expect(time.textContent?.trim()).toBe(clockTime(ISO));
    expect(time.closest(".visually-hidden")).toBe(null);
  });

  test("a grouped message keeps its time for assistive technology and the title, visually hidden", () => {
    const root = show(MessageView, { message: m(false) });
    const time = one(root, "time") as HTMLTimeElement;
    expect(time.getAttribute("datetime")).toBe(ISO);
    expect(time.getAttribute("title")).toBe(fullTime(ISO));
    expect(time.textContent?.trim()).toBe(clockTime(ISO));
    expect(time.closest(".visually-hidden")).not.toBe(null);
  });

  test("the message adds no live region of its own", () => {
    for (const shown of [true, false]) expect(show(MessageView, { message: m(shown) }).querySelector("[aria-live]")).toBe(null);
  });
});

// Issue #5: Claude's messages are headed "Claude" and carry no "[claude]" prefix.
describe("Claude's messages", () => {
  test("a message of Claude is headed Claude, not Claude Code", () => {
    const root = show(MessageView, { message: { key: "1-1", author: "claude", heading: null, body: "x", format: "text", time: "2026-09-27T14:00:00.000Z", showTime: true, band: null } });
    expect(one(root, "header").textContent).toMatch(/^Claude(?! Code)/);
  });

  test("the panel shows Claude's prose from the reducer as Claude's article, without the prefix", () => {
    const time = "2026-09-27T14:00:00.000Z";
    const state = [
      { type: "hello", cwd: "/p", current: 1, incarnation: "a" },
      { type: "event", run: 1, seq: 0, time, event: { _tag: "Started", project: "/p", task: "t" } },
      { type: "event", run: 1, seq: 1, time, event: { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "done" } } },
    ].reduce((s, m) => reduce(s, m as Parameters<typeof reduce>[1]), initialState);
    const root = show(ChatPanel, { title: "You and Interloq", messages: state.run?.left ?? [], empty: "none" });
    const article = one(root, "article[data-author=claude]");
    expect(article.classList.contains("claude")).toBe(true);
    expect(one(article, ".body").textContent?.trim()).toBe("done");
    expect(article.textContent).not.toContain("[claude]");
  });
});

// Issue #7: the user's answer in the left panel is rendered as Markdown.
test("a user message in Markdown renders its emphasis", () => {
  const root = show(MessageView, { message: { key: "1-1", author: "user", heading: null, body: "use **x**", format: "markdown", time: "2026-09-27T14:00:00.000Z", showTime: true, band: null } });
  expect(one(root, ".body strong").textContent).toBe("x");
});

// Issue #2: each author's article carries the class and data-author that its side rule in Message.svelte selects.
test("every author's message carries its author as class and data-author", () => {
  for (const author of ["claude", "codex", "user", "program"] as const) {
    const root = show(MessageView, { message: { key: `1-${author}`, author, heading: null, body: "x", format: "text", time: "2026-09-27T14:00:00.000Z", showTime: true, band: null } });
    const article = one(root, "article");
    expect(article.classList.contains(author)).toBe(true);
    expect(article.dataset.author).toBe(author);
  }
});

describe("StartForm", () => {
  test("the description is the page's help text from src/prompts.ts, and says Claude (issue #5)", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    const text = (one(root, ".help").textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("Claude writes a plan, Codex reviews it");
    expect(text).not.toContain("Claude Code");
    expect(text).toBe(prompts.START_FORM_DESCRIPTION.map((part) => part.text).join("").replace(/\s+/g, " ").trim());
  });

  test("Start is disabled while a field is empty or a run is active, and sends the project and the task", () => {
    const started: string[][] = [];
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: (p: string, t: string) => void started.push([p, t]), onBrowse: () => undefined });
    const start = one(root, "button[name=start]") as HTMLButtonElement;
    expect((one(root, "input[name=project]") as HTMLInputElement).value).toBe("/work");
    expect(start.disabled).toBe(true);
    type(one(root, "textarea[name=task]") as HTMLTextAreaElement, "Write the docs");
    expect(start.disabled).toBe(false);
    start.click();
    flushSync();
    expect(started).toEqual([["/work", "Write the docs"]]);
    const busy = show(StartForm, { cwd: "/work", running: true, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    type(one(busy, "textarea[name=task]") as HTMLTextAreaElement, "x");
    expect((one(busy, "button[name=start]") as HTMLButtonElement).disabled).toBe(true);
  });

  test("the form says what happens after Start (help and documentation)", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    expect(root.textContent).toMatch(/Claude writes a plan, Codex reviews it/);
    expect(root.textContent).toMatch(/Stop task/);
  });

  // Finding 3 of docs/gui-review.md: remembering the directory is never a prerequisite for starting a task.
  const startsDespite = (breakStorage: () => () => void) => {
    const restore = breakStorage();
    try {
      const started: string[][] = [];
      const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: (p: string, t: string) => void started.push([p, t]), onBrowse: () => undefined });
      expect((one(root, "input[name=project]") as HTMLInputElement).value).toBe("/work");
      type(one(root, "textarea[name=task]") as HTMLTextAreaElement, "Write the docs");
      (one(root, "button[name=start]") as HTMLButtonElement).click();
      flushSync();
      expect(started).toEqual([["/work", "Write the docs"]]);
    } finally {
      restore();
    }
  };
  const denied = () => new DOMException("access denied", "SecurityError");
  test("Start still starts when storing the directory throws, and a failing read falls back to the server's directory", () => {
    startsDespite(() => {
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw denied();
      });
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw denied();
      });
      return () => {
        set.mockRestore();
        get.mockRestore();
      };
    });
  });
  test("the form renders and Start starts when the localStorage getter itself throws", () => {
    startsDespite(() => {
      const original = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw denied();
        },
      });
      return () => {
        if (original !== undefined) Object.defineProperty(window, "localStorage", original);
      };
    });
  });

  test("a refusal is shown as the field's error text", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: "/work is not a git repository", chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    expect(root.textContent).toMatch(/is not a git repository/);
  });

  test("offline, Start and Browse… are disabled, and the fields stay editable and keep their text", () => {
    const started: string[] = [];
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, offline: true, onStart: () => void started.push("start"), onBrowse: () => void started.push("browse") });
    const task = one(root, "textarea[name=task]") as HTMLTextAreaElement;
    type(task, "Write the docs");
    expect(task.disabled).toBe(false);
    expect((one(root, "input[name=project]") as HTMLInputElement).disabled).toBe(false);
    expect((one(root, "button[name=start]") as HTMLButtonElement).disabled).toBe(true);
    expect((one(root, "button[name=browse]") as HTMLButtonElement).disabled).toBe(true);
    one(root, "form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
    expect(started).toEqual([]);
    expect(task.value).toBe("Write the docs");
  });
});

// Issue #12: the agent's options are cards in a group of their own, the fixed choices buttons below them.
const optionsGroup = (root: ParentNode) => root.querySelector<HTMLElement>(`[role=group][aria-label="${prompts.PROPOSED_ANSWERS_LABEL}"]`);
const cardsOf = (root: ParentNode): HTMLButtonElement[] => [...(optionsGroup(root)?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
/** An m3-svelte Card: its container and variant, without the size and icon classes only m3-svelte's Button sets. */
const isCard = (el: Element) =>
  el.classList.contains("m3-container") && el.classList.contains("outlined") && !el.classList.contains("s") && ![...el.classList].some((c) => c.startsWith("icon-"));
const paragraph = (n: number, topic: string) =>
  `${n}. ${topic}: ${"a sentence long enough to wrap over several lines of any window, with its reason and its consequences, ".repeat(3)}and its end ${n}.`;

describe("QuestionPane", () => {
  test("paragraph-length options are outlined cards with their full text, native buttons that send only the number (issue #12)", () => {
    const sent: string[] = [];
    const options = [1, 2, 3].map((n) => ({ label: paragraph(n, `Answer ${n}`), sends: String(n) }));
    expect(options.every((o) => o.label.length > 300)).toBe(true);
    const root = show(QuestionPane, { widget: widget(prompts.interviewMessagePrompt, options), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const cards = cardsOf(root);
    expect(cards.map((c) => c.textContent?.trim())).toEqual(options.map((o) => o.label));
    for (const card of cards) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.type).toBe("button");
      expect(isCard(card), `${card.className} is a card`).toBe(true);
      expect(card.classList.contains("filled") || card.classList.contains("tonal")).toBe(false);
    }
    cards[1].click();
    expect(sent).toEqual(["2"]);
    // The fixed choices stay buttons below: End clarification the filled primary action, Quit outlined; no option among them.
    const fixed = [...root.querySelectorAll<HTMLButtonElement>(".choices button")];
    expect(fixed.map((b) => b.textContent?.trim())).toEqual([prompts.END_CLARIFICATION, prompts.END_RUN_LABEL]);
    expect(fixed[0].classList.contains("filled")).toBe(true);
    expect(fixed[1].classList.contains("outlined")).toBe(true);
  });

  test("a relayed question's options are cards too, with Quit and the text field below (issue #12, Q4)", () => {
    const sent: string[] = [];
    const options = [{ label: "A", sends: "1" }, { label: "B", sends: "2" }, { label: paragraph(3, "C"), sends: "3" }];
    const root = show(QuestionPane, { widget: widget(prompts.optionOrTextPrompt, options), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const cards = cardsOf(root);
    expect(cards.map((c) => c.textContent?.trim())).toEqual(options.map((o) => o.label));
    expect(cards.map((c) => isCard(c))).toEqual([true, true, true]);
    cards[2].click();
    expect(sent).toEqual(["3"]);
    const fixed = [...root.querySelectorAll<HTMLButtonElement>(".choices button")];
    expect(fixed.map((b) => `${b.textContent?.trim()}:${b.classList.contains("outlined")}`)).toEqual([`${prompts.END_RUN_LABEL}:true`]);
    expect(root.querySelector("input[name=answer]")).not.toBe(null);
  });

  // Decision support, plan step 3.6: one "Help me decide" per question, a tonal button that sends /decide.
  test("Help me decide is a tonal button that sends /decide, never the filled primary action", () => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: widget(prompts.withOffer(prompts.optionOrTextPrompt), [{ label: "A", sends: "1" }, { label: "B", sends: "2" }]), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const fixed = [...root.querySelectorAll<HTMLButtonElement>(".choices button")];
    expect(fixed.map((b) => b.textContent?.trim())).toEqual([prompts.HELP_ME_DECIDE, prompts.END_RUN_LABEL]);
    expect(fixed[0].classList.contains("tonal")).toBe(true);
    expect(fixed[0].classList.contains("filled")).toBe(false);
    fixed[0].click();
    expect(sent).toEqual(["/decide"]);
    const decision = show(QuestionPane, { widget: widget(prompts.withOffer(prompts.decisionPrompt)), onAnswer: () => undefined });
    expect([...decision.querySelectorAll<HTMLButtonElement>(".choices button")].map((b) => `${b.textContent?.trim()}:${b.classList.contains("filled") ? "filled" : b.classList.contains("tonal") ? "tonal" : "outlined"}`)).toEqual([`${prompts.CONTINUE_WITHOUT_DECIDING}:filled`, `${prompts.HELP_ME_DECIDE}:tonal`, `${prompts.END_RUN_LABEL}:outlined`]);
  });

  test("a prompt without options has no group of cards", () => {
    const root = show(QuestionPane, { widget: widget(prompts.decisionPrompt), onAnswer: () => undefined });
    expect(optionsGroup(root)).toBe(null);
  });

  test("a choice sends its catalog text on one click; typed text is sent with Enter", () => {
    const sent: [number, string][] = [];
    const root = show(QuestionPane, { widget: widget(prompts.decisionPrompt), onAnswer: (p: number, t: string) => void sent.push([p, t]) });
    const buttons = [...root.querySelectorAll(".choices button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual([prompts.CONTINUE_WITHOUT_DECIDING, prompts.END_RUN_LABEL]);
    (root.querySelectorAll(".choices button")[0] as HTMLButtonElement).click();
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "keep the rejection");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(sent).toEqual([[7, ""], [7, "keep the rejection"]]);
  });

  test("an interview's numbered answer sends its number; a permission prompt has no text field", () => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: widget(prompts.interviewMessagePrompt, [{ label: "1. PostgreSQL", sends: "1" }, { label: "2. SQLite", sends: "2" }]), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const two = [...cardsOf(root)].find((b) => b.textContent?.trim() === "2. SQLite") as HTMLButtonElement;
    two.click();
    expect(sent).toEqual(["2"]);
    expect(root.querySelector("textarea[name=answer]")).not.toBe(null);
    const permission = show(QuestionPane, { widget: widget(prompts.permissionPrompt), onAnswer: () => undefined });
    expect(permission.querySelector("[name=answer]")).toBe(null);
  });

  // Finding 6 of docs/gui-review.md: an input method's Enter is not an answer; a visible Send and a persistent label.
  const key = (el: Element, init: KeyboardEventInit) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    flushSync();
  };
  test("Enter while an input method is composing sends nothing, on the line field and the message field", () => {
    const sent: string[] = [];
    const line = show(QuestionPane, { widget: widget(prompts.decisionPrompt), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const input = one(line, "input[name=answer]") as HTMLInputElement;
    type(input, "unfinished composition");
    key(input, { isComposing: true });
    const message = show(QuestionPane, { widget: widget(prompts.interviewMessagePrompt), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const area = one(message, "textarea[name=answer]") as HTMLTextAreaElement;
    type(area, "unfinished too");
    key(area, { isComposing: true });
    key(area, { shiftKey: true });
    expect(sent).toEqual([]);
    key(input, {});
    key(area, {});
    expect(sent).toEqual(["unfinished composition", "unfinished too"]);
  });

  test("a Send button sends the field's text and is disabled while the field is empty; the field keeps its label", () => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: widget(prompts.decisionPrompt), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const send = one(root, "button[name=send]") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(one(root, "input[name=answer]") as HTMLInputElement, "keep it");
    expect(send.disabled).toBe(false);
    send.click();
    flushSync();
    expect(sent).toEqual(["keep it"]);
    expect(root.querySelector("label")?.textContent).toBe("Your answer");
    expect(root.querySelector(".hint")?.textContent).toBe(prompts.answerHint("line"));
    const message = show(QuestionPane, { widget: widget(prompts.interviewMessagePrompt), onAnswer: () => undefined });
    expect(message.querySelector("label")?.textContent).toBe("Your message");
  });

  // G-R1-1 of the defects' requirements: once the page has failed, answering stays possible and is refused by the
  // socket, and nothing typed is cleared.
  test("offline, the choices and Send stay enabled, and sending keeps the field's text; online it clears it", () => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: widget(prompts.decisionPrompt), offline: true, onAnswer: (_p: number, t: string) => void sent.push(t) });
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "typed offline");
    const send = one(root, "button[name=send]") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(input.value).toBe("typed offline");
    send.click();
    flushSync();
    expect(input.value).toBe("typed offline");
    const choice = root.querySelectorAll(".choices button")[0] as HTMLButtonElement;
    expect(choice.disabled).toBe(false);
    choice.click();
    flushSync();
    expect(input.value).toBe("typed offline");
    expect(sent).toEqual(["typed offline", "typed offline", ""]);
    const online = show(QuestionPane, { widget: widget(prompts.decisionPrompt), offline: false, onAnswer: () => undefined });
    const field = one(online, "input[name=answer]") as HTMLInputElement;
    type(field, "sent online");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(field.value).toBe("");
  });

  test("without a pending prompt nothing can be sent", () => {
    const root = show(QuestionPane, { widget: null, onAnswer: () => undefined });
    expect(root.querySelector("button")).toBe(null);
  });
});

/** The fields of a timeline entry that its tests do not concern: the entry of a phase with no times yet. */
const fresh = { began: null, ended: null, currentStep: null, lastStarted: null, acted: [], record: null } as const;

describe("TimelineRail", () => {
  const cycle = (round: number, raised: number | null, counted: number | null = raised) => ({ round, raised, counted, reviewIds: [] });
  test("phases in order with their state, and the cycles grouped under each review with their issues, no limit", () => {
    const root = show(TimelineRail, {
      busy: true,
      timeline: [
        { ...fresh, phase: { kind: "questions" }, label: "Gather Requirements", state: "done", groups: [{ subject: "questions", heading: "Question review", rounds: [cycle(1, 0)], corrections: 0, result: "converged", done: true }], steps: [], plan: null },
        { ...fresh, phase: { kind: "planning", n: 1 }, label: "Planning 1", state: "active", groups: [{ subject: { plan: 1 }, heading: "Planning phase 1", rounds: [cycle(1, 2), cycle(2, 3, 1), cycle(3, null)], corrections: 2, result: null, done: false }], steps: [], plan: null },
      ],
    });
    const entries = [...root.querySelectorAll("[data-state]")].map((e) => `${e.getAttribute("data-state")}:${e.querySelector("[data-label]")?.textContent?.trim()}`);
    expect(entries).toEqual(["done:Gather Requirements", "active:Planning 1"]);
    const lines = [...root.querySelectorAll("[data-cycle]")].map((e) => e.textContent?.trim());
    expect(lines).toEqual(["cycle 1: 2 issues", "cycle 2: 3 issues (1 counted)", "cycle 3"]);
    expect(root.textContent).not.toMatch(/ of \d|round/);
    // A phase with one review loop does not repeat its name as a sub-heading.
    expect(root.textContent).not.toMatch(/Planning phase 1/);
    expect(root.textContent).not.toMatch(/Question review/);
    expect(root.querySelector("[data-busy]")).not.toBe(null);
  });

  test("a finished loop collapses to its one line, for each way it can end", () => {
    const finished = (result: "converged" | "proceed" | "revise", corrections: number) =>
      show(TimelineRail, { busy: false, timeline: [{ ...fresh, phase: { kind: "planning", n: 1 }, label: "Planning 1", state: "done", groups: [{ subject: { plan: 1 }, heading: "Planning phase 1", rounds: [cycle(1, 2), cycle(2, 0)], corrections, result, done: true }], steps: [], plan: null }] });
    const summary = (root: HTMLElement) => [...root.querySelectorAll("[data-summary]")].map((e) => e.textContent?.trim());
    const converged = finished("converged", 2);
    expect(summary(converged)).toEqual([prompts.loopSummary(2, 2, "converged")]);
    expect(converged.querySelectorAll("[data-cycle]").length).toBe(0);
    expect(summary(finished("proceed", 1))).toEqual([prompts.loopSummary(2, 1, "proceed")]);
    expect(summary(finished("revise", 0))).toEqual([prompts.loopSummary(2, 0, "revise")]);
  });

  // Issue #21: Gather Requirements shows its steps, the clarification's count, and #14's labels and cycle lines with them.
  const questionReview = { subject: "questions" as const, heading: "Question review", rounds: [cycle(1, 1), cycle(2, 0)], corrections: 1, result: "converged" as const, done: true };
  const gather = (state: TimelineEntry["state"], steps: TimelineStep[]): TimelineEntry => ({ ...fresh, phase: { kind: "questions" }, label: "Gather Requirements", state, groups: [], steps, plan: null });
  const step = (kind: TimelineStep["kind"], label: string, state: TimelineStep["state"], count: TimelineStep["count"], groups: RoundGroup[] = []): TimelineStep => ({ kind, label, state, count, base: { answered: 0, total: 0 }, groups });
  const stepRows = (root: HTMLElement) => [...root.querySelectorAll("[data-step]")].map((e) => `${e.getAttribute("data-step")}:${e.querySelector("[data-step-label]")?.textContent?.trim()}:${e.getAttribute("aria-current") ?? "-"}`);

  test("during a clarification: the first step done with its loop's line, Clarification active with its count", () => {
    const root = show(TimelineRail, { busy: true, timeline: [gather("active", [step("formulate", prompts.stepLabel("formulate"), "done", null, [questionReview]), step("clarification", "Clarification", "active", { answered: 3, total: 7 })])] });
    expect(root.querySelector("[data-label]")?.textContent?.trim()).toBe("Gather Requirements");
    expect(stepRows(root)).toEqual([`done:${prompts.stepLabel("formulate")}:-`, "active:Clarification:step"]);
    expect([...root.querySelectorAll("[data-summary]")].map((e) => e.textContent?.trim())).toEqual([prompts.loopSummary(2, 1, "converged")]);
    expect(root.querySelector("[data-step=active] [data-count]")?.textContent?.trim()).toBe("3 of 7 answered");
    expect(root.textContent).not.toMatch(/Question phase|Interview|round/);
  });

  // Issue #51 (Q4), the seam of the reducer and the rail: a clarification of 8 and a follow-up of 2 are one step, 10 of 10
  // answered, and the requirements review's two cycles are one line.
  test("a finished phase with a follow-up shows one Clarification step with the summed count and one loop summary", () => {
    const q = { kind: "questions" as const };
    const turn = (answered: number, total: number): UiEvent => ({ _tag: "InterviewTurn", heading: "Clarification", message: "Hi", summary: null, answered, total });
    const events: UiEvent[] = [
      { _tag: "PhaseBegan", phase: q },
      { _tag: "InterviewOpened", heading: "Clarification", stage: "clarification", total: 8 },
      turn(8, 8),
      { _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 },
      { _tag: "ReviewReceived", subject: "requirements", round: 1, review: { issues: [] }, counted: 2 },
      { _tag: "InterviewOpened", heading: "Clarification", stage: "followUp", total: 2 },
      turn(2, 2),
      { _tag: "RoundBegan", subject: "requirements", round: 2, limit: 5 },
      { _tag: "LoopFinished", subject: "requirements", result: "converged" },
      { _tag: "PhaseEnded", phase: q, result: "converged" },
    ];
    const time = "2026-09-29T00:00:00Z";
    const messages: ServerMessage[] = [
      { type: "hello", cwd: "/p", current: 1, incarnation: "a" },
      { type: "replay", ui: [], runs: [] },
      { type: "event", run: 1, seq: 0, time, event: { _tag: "Started", project: "/p", task: "t" } },
      ...events.map((event, i): ServerMessage => ({ type: "event", run: 1, seq: i + 1, time, event: { _tag: "Notified", event } })),
    ];
    const s = messages.reduce(reduce, initialState);
    const root = show(TimelineRail, { busy: false, timeline: s.run?.timeline ?? [] });
    expect(stepRows(root)).toEqual([`done:${prompts.stepLabel("formulate")}:-`, `done:${prompts.stepLabel("clarification")}:-`]);
    expect([...root.querySelectorAll("[data-count]")].map((e) => e.textContent?.trim())).toEqual([prompts.clarificationProgress(10, 10)]);
    expect([...root.querySelectorAll("[data-step] [data-summary]")].map((e) => e.textContent?.trim())).toEqual([prompts.loopSummary(2, 0, "converged")]);
    expect(root.textContent).not.toMatch(/Follow-up/);
  });

  // The re-check after #21: #14's labels and cycle lines render beside the steps of Gather Requirements.
  test("Gather Requirements with its steps, a planning loop's cycles and Implementation, together", () => {
    const planning: TimelineEntry = { ...fresh, phase: { kind: "planning", n: 1 }, label: "Planning 1", state: "done", groups: [{ subject: { plan: 1 }, heading: "Planning phase 1", rounds: [cycle(1, 2), cycle(2, 0)], corrections: 2, result: "converged", done: true }], steps: [], plan: null };
    const implementation: TimelineEntry = { ...fresh, phase: { kind: "execution", n: 1 }, label: "Implementation 1", state: "active", groups: [], steps: [], plan: null };
    const root = show(TimelineRail, { busy: false, timeline: [gather("done", [step("formulate", prompts.stepLabel("formulate"), "done", null, [questionReview]), step("clarification", "Clarification", "done", { answered: 2, total: 2 })]), planning, implementation] });
    expect([...root.querySelectorAll("[data-label]")].map((e) => e.textContent?.trim())).toEqual(["Gather Requirements", "Planning 1", "Implementation 1"]);
    expect([...root.querySelectorAll("[data-summary]")].map((e) => e.textContent?.trim())).toEqual([prompts.loopSummary(2, 1, "converged"), prompts.loopSummary(2, 2, "converged")]);
    expect(stepRows(root)).toEqual([`done:${prompts.stepLabel("formulate")}:-`, "done:Clarification:-"]);
    expect(root.textContent).not.toMatch(/Question phase|Execution|Interview|round| of 5/);
  });

  test("a stopped step shows the stopped mark and is not the current step", () => {
    const root = show(TimelineRail, { busy: false, timeline: [gather("stopped", [step("formulate", prompts.stepLabel("formulate"), "done", null), step("clarification", "Clarification", "stopped", { answered: 0, total: 3 })])] });
    expect(stepRows(root)).toEqual([`done:${prompts.stepLabel("formulate")}:-`, "stopped:Clarification:-"]);
    expect(root.querySelector("[data-step=stopped] .mark")?.getAttribute("aria-label")).toBe("stopped");
  });

  test("the heading and the text before any phase (issue #14, Q4)", () => {
    const root = show(TimelineRail, { busy: false, timeline: [] });
    expect(root.querySelector("h2")?.textContent).toBe("Progress");
    expect(root.textContent).toMatch(/No phase has begun\./);
  });
});

describe("DirectoryDialog", () => {
  test("lists the subdirectories, goes up and into a directory, and chooses", () => {
    const listed: string[] = [];
    const chosen: string[] = [];
    const root = show(DirectoryDialog, { open: true, listing: { path: "/work", parent: "/", dirs: ["a", "b"], error: null }, onList: (p: string) => void listed.push(p), onChoose: (p: string) => void chosen.push(p), onClose: () => undefined });
    const rows = [...root.querySelectorAll("[data-dir]")].map((e) => e.getAttribute("data-dir"));
    expect(rows).toEqual(["..", "a", "b"]);
    (one(root, "[data-dir=b]") as HTMLElement).click();
    (one(root, "[data-dir='..']") as HTMLElement).click();
    (one(root, "button[name=choose]") as HTMLButtonElement).click();
    expect(listed).toEqual(["/work/b", "/"]);
    expect(chosen).toEqual(["/work"]);
  });

  test("offline, the directories and Choose are disabled, and Cancel is not", () => {
    const root = show(DirectoryDialog, { open: true, listing: { path: "/work", parent: "/", dirs: ["a"], error: null }, offline: true, onList: () => undefined, onChoose: () => undefined, onClose: () => undefined });
    expect([...root.querySelectorAll<HTMLButtonElement>("[data-dir]")].map((b) => b.disabled)).toEqual([true, true]);
    expect((one(root, "button[name=choose]") as HTMLButtonElement).disabled).toBe(true);
    expect((one(root, "button[name=cancel]") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("TopBar", () => {
  test("Stop sends stop for the run on one click, and is disabled without a run in progress", () => {
    const stopped: number[] = [];
    const run = { ...emptyRun(3), project: "/p", task: "the task" };
    const root = show(TopBar, { run, connection: "open", onStop: (_i: string, r: number) => void stopped.push(r) });
    const stop = one(root, "button[name=stop]") as HTMLButtonElement;
    expect(stop.textContent?.trim()).toBe("Stop task");
    stop.click();
    flushSync();
    // S25: Stop task is confirmed first.
    one(root, "dialog button[name=confirm-end]").click();
    expect(stopped).toEqual([3]);
    expect(root.textContent).toMatch(/connected/);
    const idle = show(TopBar, { run: null, connection: "reconnecting", onStop: () => undefined });
    expect((one(idle, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
    expect(idle.textContent).toMatch(/reconnecting/);
    const ended = show(TopBar, { run: { ...run, ended: 0 }, connection: "open", onStop: () => undefined });
    expect((one(ended, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed page: the chip reads disconnected and Stop is disabled", () => {
    const run = { ...emptyRun(3), project: "/p", task: "the task" };
    const root = show(TopBar, { run, connection: "failed", onStop: () => undefined });
    expect(one(root, "[role=status]").textContent?.trim()).toBe("disconnected");
    expect((one(root, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
  });
});

// Finding 5 of docs/gui-review.md: the page mounted whole over a fake WebSocket; a draft does not survive its prompt.
describe("App and the draft", () => {
  class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    static all: FakeWebSocket[] = [];
    sent: string[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(_url: string) {
      FakeWebSocket.last = this;
      FakeWebSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.onclose?.({});
    }
    receive(m: unknown) {
      this.onmessage?.({ data: JSON.stringify(m) });
      flushSync();
    }
    receiveRaw(text: string) {
      this.onmessage?.({ data: text });
      flushSync();
    }
  }
  const started = { _tag: "Started", project: "/p", task: "t" };
  const TIME = "2026-09-27T14:00:00.000Z";
  const stamp = (events: readonly unknown[]) => events.map((event) => ({ time: TIME, event }));
  const asked = (prompt: number) => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt) });
  const openPage = async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { default: App } = await import("./components/App.svelte");
    const root = show(App, {});
    const ws = FakeWebSocket.last!;
    ws.receive({ type: "hello", cwd: "/p", current: 1, incarnation: "a" });
    return { root, ws };
  };
  const field = (root: ParentNode) => one(root, "[name=answer]") as HTMLInputElement;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWebSocket.all = [];
  });

  // W2-R1-3: the conversation shown for run 1's decision 1 does not hide run 2's decision 1.
  test("the conversation toggle of one run's decision leaves the next run's decision of the same number displayed", async () => {
    const { root, ws } = await openPage();
    const analyzed = { _tag: "Notified", event: { _tag: "DecisionAnalyzed", decision: 1, question: "Which?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details: [], decision: null }, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } } };
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, analyzed, asked(1)]) }] });
    expect(root.querySelector('section[aria-label^="Decision 1"]')).not.toBe(null);
    one(root, "button[name=conversation]").click();
    flushSync();
    expect(root.querySelector('section[aria-label^="Decision 1"]')).toBe(null);
    ws.receive({ type: "hello", cwd: "/p", current: 2, incarnation: "a" });
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, analyzed, asked(1), { _tag: "Ended", code: 130 }]) }, { id: 2, events: stamp([started, analyzed, asked(1)]) }] });
    expect(root.querySelector('section[aria-label^="Decision 1"]')).not.toBe(null);
  });

  // Issue #87: opening an entry in the page sends the change of the run's shared state, keyed by decision and entry.
  test("toggling an entry sends one ui message with the incarnation, the run, the decision and the entry", async () => {
    const { root, ws } = await openPage();
    const el = (text: string) => ({ text, counterarguments: [] });
    const e1 = { id: "e1", title: "T.", comparative_condition: el("c"), starting_cause: el("s"), intermediate_steps: el("i"), threshold: el("t"), effect_on_persons: el("e"), reason_the_effect_matters: el("r"), extent: { per_person: el("p"), persons_affected: el("a"), likelihood: el("l"), timing: el("w") } };
    const analyzed = { _tag: "Notified", event: { _tag: "DecisionAnalyzed", decision: 3, question: "Which?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details: [], decision: null }, options: [], analysis: { decision: "d", columns: [{ kind: "argued", option: "A", advantages: [e1], disadvantages: [] }], recommendation: { option: "", reason: "" } } } };
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, analyzed, asked(1)]) }] });
    ws.onopen?.({});
    ws.sent = [];
    one(root, ".entry > button.toggle").click();
    flushSync();
    expect(ws.sent.map((m) => JSON.parse(m))).toEqual([{ type: "ui", incarnation: "a", run: 1, flag: { scope: { _tag: "DecisionEntry", decision: 3, entry: "e1" }, open: true } }]);
    ws.receive({ type: "ui", run: 1, state: { version: 1, choices: [{ scope: { _tag: "DecisionEntry", decision: 3, entry: "e1" }, open: true }] } });
    expect(one(root, ".entry > button.toggle").getAttribute("aria-expanded")).toBe("true");
  });

  // S27 with decision support: beside an analysis, which shows the question, the pane keeps only its answers; the
  // analysis's "Show the conversation" shows the conversation itself.
  test("beside an analysis the pane shows only its answers; the analysis's Show the conversation shows the transcript", async () => {
    const { root, ws } = await openPage();
    const presentedQ = { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details: [], decision: null };
    const analyzed = { _tag: "Notified", event: { _tag: "DecisionAnalyzed", decision: 1, question: "Which?", presented: presentedQ, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } } };
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, { _tag: "Notified", event: { _tag: "QuestionPresented", question: presentedQ } }, analyzed, asked(1)]) }] });
    expect(root.querySelector(".pane")).not.toBe(null);
    expect(root.querySelector(".pane .question-text")).toBe(null);
    expect(root.querySelector(".pane .top")).toBe(null);
    expect(root.querySelector(".pane input[name=answer]")).not.toBe(null);
    one(root, ".decision button[name=conversation]").click();
    flushSync();
    expect((root.querySelector(".left .chat") as HTMLElement).classList.contains("hidden")).toBe(false);
    expect(root.querySelector("button[name=question]")).not.toBe(null);
    one(root, "button[name=analysis]").click();
    flushSync();
    expect(root.querySelector('section[aria-label^="Decision 1"]')).not.toBe(null);
  });

  test("the right panel is titled Claude and Codex (issue #5)", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started]) }] });
    expect(root.querySelector('section[aria-label="Claude and Codex"]')).not.toBe(null);
  });

  test("another tab's answer withdraws the draft with a notice; the next prompt's field is empty", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    type(field(root), "draft for question one");
    ws.receive({ type: "event", run: 1, seq: 2, time: TIME, event: { _tag: "Answered", prompt: 1, text: "" } });
    ws.receive({ type: "event", run: 1, seq: 3, time: TIME, event: asked(2) });
    expect(field(root).value).toBe("");
    expect(root.textContent).toContain(prompts.draftWithdrawnNotice("draft for question one"));
  });

  // S27 (Q10): a pending prompt's pane takes the left column; the conversation is one click away and back.
  test("a pending prompt hides the conversation behind its pane; Show the conversation and Back to the question toggle", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, { _tag: "Said", text: "hello" }, asked(1)]) }] });
    const chat = () => root.querySelector(".left .chat") as HTMLElement;
    expect(chat().classList.contains("hidden")).toBe(true);
    expect(root.querySelector(".pane")).not.toBe(null);
    one(root, ".pane button[name=conversation]").click();
    flushSync();
    expect(chat().classList.contains("hidden")).toBe(false);
    expect(root.querySelector(".pane")).toBe(null);
    one(root, "button[name=question]").click();
    flushSync();
    expect(chat().classList.contains("hidden")).toBe(true);
    // The answered prompt gives the column back to the conversation.
    ws.receive({ type: "event", run: 1, seq: 3, time: TIME, event: { _tag: "Answered", prompt: 1, text: "" } });
    expect(chat().classList.contains("hidden")).toBe(false);
  });

  test("after a reconnection whose replay answered the prompt, the draft is withdrawn with a notice", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    type(field(root), "draft for question one");
    ws.receive({ type: "hello", cwd: "/p", current: 1, incarnation: "a" });
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1), { _tag: "Answered", prompt: 1, text: "" }, asked(2)]) }] });
    expect(field(root).value).toBe("");
    expect(root.textContent).toMatch(/your unsent text was discarded: «draft for question one»/);
  });

  // Defect B of docs/page-question-phase-defects.md: three frames in a row the page cannot read end in a failed page
  // that says so, refuses what it cannot send, and loses no typed text (Q5, G-R1-1, P1-R1-2).
  const failThreeTimes = () => {
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.last!.receiveRaw("not json");
      vi.advanceTimersByTime(30_000);
      flushSync();
    }
  };
  const enter = (el: HTMLElement) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    flushSync();
  };

  test("a failed page: the banner, Stop disabled, the prompt usable, the queued answer back in its field, a new one refused", async () => {
    vi.useFakeTimers();
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    ws.close();
    flushSync();
    type(field(root), "queued answer");
    enter(field(root));
    expect(field(root).value).toBe("");
    failThreeTimes();
    expect(one(root, ".failed[role=alert]").textContent).toContain(prompts.CONNECTION_FAILED_NOTICE);
    expect(one(root, "[role=status]").textContent?.trim()).toBe("disconnected");
    expect((one(root, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelectorAll(".choices button")[0] as HTMLButtonElement).disabled).toBe(false);
    expect(field(root).value).toBe("queued answer");
    expect(root.textContent).toContain(prompts.notSentNotice("answer", "disconnected"));
    type(field(root), "typed after the failure");
    enter(field(root));
    expect(field(root).value).toBe("typed after the failure");
    expect(FakeWebSocket.all.flatMap((s) => s.sent)).toEqual([]);
  });

  test("several actions discarded: the newer draft stays, and the answers are kept under Not sent until dismissed", async () => {
    vi.useFakeTimers();
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    ws.close();
    flushSync();
    type(field(root), "answer A");
    enter(field(root));
    type(field(root), "answer C");
    enter(field(root));
    (one(root, "button[name=stop]") as HTMLButtonElement).click();
    flushSync();
    one(root, "dialog button[name=confirm-end]").click();
    flushSync();
    type(field(root), "draft B");
    failThreeTimes();
    expect(field(root).value).toBe("draft B");
    const kept = () => [...root.querySelectorAll(".unsent li .unsent-text")].map((e) => e.textContent);
    expect(one(root, ".unsent").textContent).toContain(prompts.UNSENT_HEADING);
    expect(kept()).toEqual(["answer A", "answer C"]);
    expect(root.textContent).toContain(prompts.notSentNotice("stop", "disconnected"));
    enter(field(root));
    expect(root.textContent).toContain(prompts.notSentNotice("answer", "disconnected"));
    expect(kept()).toEqual(["answer A", "answer C"]);
    (root.querySelectorAll(".unsent button[name=dismiss]")[0] as HTMLButtonElement).click();
    flushSync();
    expect(kept()).toEqual(["answer C"]);
  });
});

// Decision support, plan step 4.2: the analysis over both chat columns.
describe("DecisionView", () => {
  const el = (text: string, counterarguments: unknown[] = []) => ({ text, counterarguments });
  const entry = (id: string, counter: unknown[] = []) => ({
    id,
    title: `Title ${id}.`,
    comparative_condition: el(`c ${id}`, counter),
    starting_cause: el(`s ${id}`),
    intermediate_steps: el(`i ${id}`),
    threshold: el(`t ${id}`),
    effect_on_persons: el(`e ${id}`),
    reason_the_effect_matters: el(`r ${id}`),
    extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
  });
  const arg = (id: string, equivalent_to = "", replies: unknown[] = []) => ({ id, text: `But ${id}.`, equivalent_to, replies });
  const presented = { number: 4, origin: { kind: "relayed" }, context: { blocks: plainBlocks("The service keeps its data in a database."), by: "agent" }, explanations: [], question: plainPieces("Which database?"), options: [], details: [], decision: null };
  const event = {
    _tag: "DecisionAnalyzed" as const,
    decision: 2,
    question: "Which database?",
    presented,
    options: [{ label: "SQLite", description: "" }, { label: "PostgreSQL", description: "" }],
    analysis: {
      decision: "Which database?",
      columns: [
        { kind: "argued", option: "SQLite", advantages: [entry("E1", [arg("A1", "", [arg("A2", "E2")])])], disadvantages: [] },
        { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [entry("E2")] },
      ],
      recommendation: { option: "SQLite", reason: "It serves every user sooner." },
    },
  } as never;

  // S22: the question beside its analysis, as the user was shown it: its number in the heading, its context and itself.
  test("the view's heading names the decision and the question's number; the context and the question follow it", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    expect(root.querySelector("h2")?.textContent?.trim()).toBe(prompts.decisionViewHeading(2, 4));
    expect(root.querySelector(".question-context")?.textContent).toMatch(/keeps its data in a database/);
    expect(root.querySelector(".question-text")?.textContent?.trim()).toBe("Which database?");
  });

  // The developer's decision at the stop of execution phase 1 of the task of L21: the heading stays on one line beside its
  // button, cut with an ellipsis where the line is too narrow, its whole text shown on hover.
  test("the heading carries its whole text as its title, for the hover where it is cut", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    expect(root.querySelector("h2")?.getAttribute("title")).toBe(prompts.decisionViewHeading(2, 4));
  });

  // S39 (W2-R1-2): only the context scrolls; the question text is in no scrolled region of the view.
  test("the question text is outside the scrolled context region, and only the context scrolls", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const context = one(root, ".question-context");
    const asked = one(root, ".question-text");
    expect(asked.closest(".question-context")).toBe(null);
    expect(context.contains(asked)).toBe(false);
    // jsdom applies no component styles, so the rules are read from the component's source: the context region scrolls,
    // and no element between the question text and the view does.
    const source = (await import("./components/DecisionView.svelte?raw")).default;
    const rule = (selector: string) => source.match(new RegExp(`\\n\\s*${selector.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".question-context")).toMatch(/overflow-y: auto/);
    const section = one(root, "section.decision");
    for (let el = asked.parentElement; el !== null && el !== section; el = el.parentElement) {
      for (const cls of el.classList) if (!cls.startsWith("svelte-")) expect(rule(`.${cls}`), `.${cls} scrolls`).not.toMatch(/overflow/);
    }
  });

  // S46 (W3-R1-3): the question's details are shown with its context beside the analysis, as in the terminal.
  test("the question's details are shown in the context region, their pieces marked, the question outside", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const { analysisLines } = await import("../../src/render.ts");
    const details = [...prompts.toolInputBlocks({ command: "rm -rf build" }), { kind: "paragraph" as const, pieces: [...plainPieces("The **build** directory holds the "), ref("bundle", "b"), ...plainPieces(".")] }];
    const withDetails = { ...presented, details, explanations: [{ id: "b", term: "bundle", explanation: "The built page." }] };
    const root = show(DecisionView, { event: { ...(event as object), presented: withDetails } as never, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const context = one(root, ".question-context");
    expect(context.textContent).toContain(prompts.TOOL_INPUT_HEADING);
    expect(context.querySelector("code")?.textContent).toBe("rm -rf build");
    expect(context.querySelector("strong")?.textContent).toBe("build");
    expect([...context.querySelectorAll(".term")].map((m) => m.textContent)).toEqual(["bundle"]);
    expect(one(root, ".question-text").closest(".question-context")).toBe(null);
    // The terminal prints the same details beside its analysis.
    const lines = analysisLines(2, withDetails as never, { columns: [], recommendation: null } as never).join("\n");
    expect(lines).toContain(prompts.TOOL_INPUT_HEADING);
    expect(lines).toContain("rm -rf build");
  });

  test("one column per option in order, the heading Disadvantages: in each, arguments offset by level, symbols, the recommendation", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const shown: string[] = [];
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => void shown.push("conversation") });
    const columns = [...root.querySelectorAll<HTMLElement>(".column")];
    expect(columns.map((c) => c.querySelector("h3")?.textContent?.trim())).toEqual(["SQLite", "PostgreSQL"]);
    expect(columns.map((c) => c.querySelector(".disadvantages-heading")?.textContent?.trim())).toEqual(["Disadvantages:", "Disadvantages:"]);
    const args = [...columns[0].querySelectorAll<HTMLElement>(".argument")];
    expect(args.map((a) => [a.textContent?.trim(), a.dataset.level])).toEqual([["But A1.", "1"], ["But A2. *", "2"]]);
    expect(columns[1].querySelector(".entry .title")?.textContent?.trim()).toBe("Disadvantage 1: Title E2. *");
    expect(columns[0].querySelector(".entry .title")?.textContent?.trim()).toBe("Advantage 1: Title E1.");
    expect(root.querySelector(".recommendation")?.textContent).toMatch(/SQLite/);
    expect(root.querySelector(".recommendation")?.textContent).toMatch(/It serves every user sooner\./);
    one(root, "button[name=conversation]").click();
    expect(shown).toEqual(["conversation"]);
  });

  // Issue #35: both headings, and the entries labeled within each heading.
  test("each column has the headings Advantages: and Disadvantages:, and each entry its label", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const columns = [...root.querySelectorAll<HTMLElement>(".column")];
    expect(columns.map((c) => c.querySelector(".advantages-heading")?.textContent?.trim())).toEqual([prompts.ADVANTAGES_HEADING, prompts.ADVANTAGES_HEADING]);
    expect(columns.map((c) => [...c.querySelectorAll(".entry .label")].map((l) => l.textContent?.trim()))).toEqual([[prompts.advantageLabel(1)], [prompts.disadvantageLabel(1)]]);
  });

  // Issue #35, decision Q7: exactly the texts the view says oppose the option are marked, and only those are colored.
  test("the texts marked as opposing the option are exactly those the view model says oppose it", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const view = viewOf((event as { analysis: Parameters<typeof viewOf>[0] }).analysis);
    const expected = view.columns.flatMap((c) =>
      c.kind === "unclear" ? [] : [...c.advantages, ...c.disadvantages].flatMap((e) => [e.opposes, ...e.elements.flatMap((el) => [el.opposes, ...el.arguments.map((a) => a.opposes)])]),
    );
    const marked = [...root.querySelectorAll<HTMLElement>(".title, .element-text, .argument")].map((n) => n.dataset.opposes === "true");
    expect(marked).toEqual(expected);
    expect(marked.filter(Boolean).length).toBeGreaterThan(0);
    for (const n of root.querySelectorAll<HTMLElement>("[data-opposes=true]")) expect(n.classList.contains("opposes")).toBe(true);
    for (const n of root.querySelectorAll<HTMLElement>("[data-opposes=false]")) expect(n.classList.contains("opposes")).toBe(false);
    for (const n of root.querySelectorAll<HTMLElement>("h3, .advantages-heading, .disadvantages-heading")) expect(n.classList.contains("opposes")).toBe(false);
  });

  // Issue #35, decision Q8: an unclear option's column states what is unclear, in place of its headings.
  test("an unclear column shows its statement and no headings", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const unclear = { ...(event as object), analysis: { decision: "d", columns: [{ kind: "argued", option: "SQLite", advantages: [entry("E1")], disadvantages: [] }, { kind: "unclear", option: "PostgreSQL", unclear: "It could mean a server or a hosted service." }], recommendation: { option: "", reason: "" } } } as never;
    const root = show(DecisionView, { event: unclear, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const column = [...root.querySelectorAll<HTMLElement>(".column")][1];
    expect(column.querySelector("h3")?.textContent?.trim()).toBe("PostgreSQL");
    expect(column.querySelector(".unclear")?.textContent?.trim()).toBe("It could mean a server or a hosted service.");
    expect(column.querySelector(".advantages-heading, .disadvantages-heading, .entry")).toBe(null);
  });

  // Issue #81 (W1-R1-3 kept): the recommendation has a region of its own below the columns, outside their scrollers.
  test("the recommendation is a region of its own below the sideways region, outside the columns' scrollers", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const sideways = one(root, ".sideways");
    const recommendation = one(root, ".recommendation");
    expect(sideways.contains(recommendation)).toBe(false);
    expect(recommendation.closest(".column")).toBe(null);
    expect(sideways.compareDocumentPosition(recommendation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sideways.querySelectorAll(".column > .column-content").length).toBe(2);
  });

  // Decision Q1 (P1-R2-3): the strip is measured from each column's content wrapper, never from its scroller, whose
  // scrollHeight is at least its own height.
  test("the strip follows the columns' content wrappers, less their open bodies, not the scrollers", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: false, open: (id: string) => id === "E1", onToggle: () => undefined, onShowConversation: () => undefined });
    const define = (el: Element, name: string, value: number) => Object.defineProperty(el, name, { configurable: true, get: () => value });
    one(root, ".sideways").style.lineHeight = "100px";
    const [first, second] = [...root.querySelectorAll<HTMLElement>(".column")];
    for (const c of [first, second]) for (const name of ["scrollHeight", "clientHeight", "offsetHeight"]) define(c, name, 600);
    const rect = (height: number) => () => ({ height, width: 0, x: 0, y: 0, top: 0, left: 0, bottom: height, right: 0, toJSON: () => ({}) }) as DOMRect;
    first.querySelector<HTMLElement>(".column-content")!.getBoundingClientRect = rect(400);
    second.querySelector<HTMLElement>(".column-content")!.getBoundingClientRect = rect(150);
    const body = first.querySelector<HTMLElement>(".elements")!;
    body.getBoundingClientRect = rect(300);
    window.dispatchEvent(new Event("resize"));
    flushSync();
    expect(one(root, "section.decision").style.getPropertyValue("--strip")).toBe("150px");
  });

  // Issue #87: every entry starts collapsed, its row the label and the whole title; a disputed entry carries the mark.
  describe("collapsed entries", () => {
    const view = viewOf((event as { analysis: Parameters<typeof viewOf>[0] }).analysis);
    const entries = view.columns.flatMap((c) => (c.kind === "unclear" ? [] : [...c.advantages, ...c.disadvantages]));
    const closed = async (toggled: [string, boolean][] = []) => {
      const { default: DecisionView } = await import("./components/DecisionView.svelte");
      return show(DecisionView, { event, narrow: false, open: () => false, onToggle: (entry: string, open: boolean) => void toggled.push([entry, open]), onShowConversation: () => undefined });
    };
    test("each entry is a collapsed button with its label and whole title; its elements, arguments and referents are absent", async () => {
      const root = await closed();
      const rows = [...root.querySelectorAll<HTMLButtonElement>(".entry > button.toggle")];
      expect(rows.map((b) => b.getAttribute("aria-expanded"))).toEqual(entries.map(() => "false"));
      expect(rows.map((b) => b.querySelector(".title")?.textContent?.trim())).toEqual(entries.map((e) => `${e.label} ${e.title}${e.symbol === null ? "" : ` ${e.symbol}`}`));
      for (const b of rows) {
        const controls = b.getAttribute("aria-controls");
        expect(controls).toBeTruthy();
        expect(document.getElementById(controls!)).toBe(null);
      }
      expect(root.querySelector(".element, .argument, .elements")).toBe(null);
      expect(root.textContent).not.toContain("But A1.");
      // Decision Q2 of the task: the whole title, wrapped, never cut. The analysis's own heading is the one text cut, by
      // the developer's decision in the task of L21; its rule is removed before the check.
      const source = (await import("./components/DecisionView.svelte?raw")).default.replace(/^\s*\.head h2 \{[^}]*\}$/m, "");
      expect(source).not.toMatch(/text-overflow:\s*ellipsis|line-clamp/);
    });
    test("the mark is on exactly the disputed entries, named for what it means", async () => {
      const root = await closed();
      const marks = [...root.querySelectorAll<HTMLElement>(".entry")].map((e) => e.querySelector("[role=img].disputed")?.getAttribute("aria-label") ?? null);
      expect(marks).toEqual(entries.map((e) => (e.disputed ? prompts.ENTRY_DISPUTED_LABEL : null)));
      expect(marks.filter((m) => m !== null).length).toBeGreaterThan(0);
      expect(marks.filter((m) => m === null).length).toBeGreaterThan(0);
    });
    test("a click, Enter or Space on a row asks to open it; the button's name says what opens", async () => {
      const toggled: [string, boolean][] = [];
      const root = await closed(toggled);
      const first = one(root, ".entry > button.toggle") as HTMLButtonElement;
      expect(first.getAttribute("aria-label")).toBe(prompts.entryToggleName(entries[0].label, entries[0].title, false));
      first.click();
      // A native button turns Enter and Space into a click; jsdom does not, so the test checks it is a real button.
      expect(first.tagName).toBe("BUTTON");
      expect(first.getAttribute("type")).toBe("button");
      expect(toggled).toEqual([[entries[0].id, true]]);
    });
    test("an open entry shows its body, controlled by its button, and asks to close", async () => {
      const toggled: [string, boolean][] = [];
      const { default: DecisionView } = await import("./components/DecisionView.svelte");
      const root = show(DecisionView, { event, narrow: false, open: (id: string) => id === entries[0].id, onToggle: (entry: string, open: boolean) => void toggled.push([entry, open]), onShowConversation: () => undefined });
      const first = one(root, ".entry > button.toggle");
      expect(first.getAttribute("aria-expanded")).toBe("true");
      expect(first.getAttribute("aria-label")).toBe(prompts.entryToggleName(entries[0].label, entries[0].title, true));
      expect(document.getElementById(first.getAttribute("aria-controls")!)?.textContent).toContain("But A1.");
      first.click();
      expect(toggled).toEqual([[entries[0].id, false]]);
    });
  });

  // W2-R1-2 of work review 2 (W2-R1-1): below 390 px the context is bounded by the room the section leaves, as allot gives it
  // with no strip and no recommendation, so a long context cannot push the question and the notice out of the view.
  test("below 390 px the context takes the room the section leaves, by allot with no strip", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const { allot, UNBOUNDED_ROOM } = await import("./layout.ts");
    const root = show(DecisionView, { event, narrow: true, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    const define = (el: Element, name: string, value: number) => Object.defineProperty(el, name, { configurable: true, get: () => value });
    define(one(root, "section.decision"), "clientHeight", 300);
    define(one(root, ".context-inner"), "offsetHeight", 1000);
    window.dispatchEvent(new Event("resize"));
    flushSync();
    const expected = allot({ available: 300, context: 1000, recommendation: 0, strip: 0, minContext: 0, minRecommendation: 0, room: UNBOUNDED_ROOM }).context;
    expect(one(root, ".question-context").style.height).toBe(`${expected}px`);
  });

  // W4-R1-1 of work review 4: each text's two-line minimum counts its own region's padding. jsdom applies no component
  // styles, so the computed style is stubbed: lines of 15 px, the context's padding 8 + 8 px, the recommendation's 12 + 12.
  test("cut to their minimums, the recommendation keeps two lines plus its own padding, and the minimum total includes it", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const minimums: number[] = [];
    const root = show(DecisionView, { event, narrow: false, open: () => false, onToggle: () => undefined, onShowConversation: () => undefined, onMinimum: (px: number) => void minimums.push(px) });
    const [contextBox, recommendationBox] = [one(root, ".question-context"), one(root, ".recommendation")];
    const padding = new Map<Element, number>([[contextBox, 8], [recommendationBox, 12]]);
    const original = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      const p = `${padding.get(el) ?? 0}px`;
      return { ...original(el), lineHeight: "15px", fontSize: "12.5px", paddingTop: p, paddingBottom: p, borderTopWidth: "0px", borderBottomWidth: "0px", marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration;
    });
    try {
      const define = (el: Element, name: string, value: number) => Object.defineProperty(el, name, { configurable: true, get: () => value });
      define(one(root, "section.decision"), "clientHeight", 10);
      define(one(root, ".context-inner"), "offsetHeight", 1000);
      define(one(root, ".recommendation-inner"), "offsetHeight", 1000);
      window.dispatchEvent(new Event("resize"));
      flushSync();
      const [minContext, minRecommendation] = [2 * 15 + 16, 2 * 15 + 24];
      expect(parseFloat(recommendationBox.style.height), "the recommendation shows less than two lines").toBeGreaterThanOrEqual(minRecommendation);
      expect(parseFloat(contextBox.style.height)).toBeGreaterThanOrEqual(minContext);
      expect(minimums.at(-1), "the minimum total leaves out the recommendation's padding").toBe(minContext + minRecommendation);
    } finally {
      spy.mockRestore();
    }
  });

  // The task of L21, by the developer's decision at the stop of execution phase 1: the analysis's minimum is bounded by
  // the room the window has beside the question and its first answer, and where the floor exceeds that room, the
  // columns yield first, then the recommendation, then the context, each down to 0 and below its own padding. jsdom
  // applies no component styles and lays nothing out, so the computed style and the boxes are stubbed: lines of 15 px,
  // the context's padding 8 + 8 px, the recommendation's 12 + 12, both texts 1,000 px of content, and the strip from
  // the closed columns' content (ten lines being 150 px).
  describe("the minimum bounded by the room", () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const laidOut = async (props: { room?: Room; columns: number; fixed: number }) => {
      const { default: DecisionView } = await import("./components/DecisionView.svelte");
      const minimums: number[] = [];
      const root = show(DecisionView, { event, narrow: false, open: () => false, onToggle: () => undefined, onShowConversation: () => undefined, onMinimum: (px: number) => void minimums.push(px), ...(props.room === undefined ? {} : { room: props.room }) });
      const section = one(root, "section.decision");
      const [contextBox, recommendationBox] = [one(root, ".question-context"), one(root, ".recommendation")];
      const padding = new Map<Element, number>([[contextBox, 8], [recommendationBox, 12]]);
      const original = window.getComputedStyle.bind(window);
      const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
        const p = `${padding.get(el) ?? 0}px`;
        return { ...original(el), lineHeight: "15px", fontSize: "12.5px", paddingTop: p, paddingBottom: p, borderTopWidth: "0px", borderBottomWidth: "0px", marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration;
      });
      const define = (el: Element, name: string, value: unknown) => Object.defineProperty(el, name, { configurable: true, get: () => value });
      // The heading and the question before the regions: the section's first child at 0, its last (the recommendation,
      // laid out at no height) ending at `fixed`, so the section's children span `fixed` and the regions none of it.
      const kids = [...section.children];
      define(kids[0], "getBoundingClientRect", () => rect(0, 0));
      define(kids[kids.length - 1], "getBoundingClientRect", () => rect(props.fixed, 0));
      for (const c of root.querySelectorAll(".column-content")) define(c, "getBoundingClientRect", () => rect(0, props.columns));
      define(section, "clientHeight", 10);
      define(one(root, ".context-inner"), "offsetHeight", 1000);
      define(one(root, ".recommendation-inner"), "offsetHeight", 1000);
      window.dispatchEvent(new Event("resize"));
      flushSync();
      return { section, contextBox, recommendationBox, minimums, restore: () => spy.mockRestore() };
    };
    const [minContext, minRecommendation] = [2 * 15 + 16, 2 * 15 + 24];
    test("a room smaller than the minimum: the minimum reported is the room, and the columns yield first", async () => {
      const v = await laidOut({ room: 150 as Room, columns: 100, fixed: 0 });
      try {
        expect(v.minimums.at(-1)).toBe(150);
        expect(parseFloat(v.section.style.getPropertyValue("--strip")), "the columns keep their strip").toBeLessThan(100);
        expect(parseFloat(v.contextBox.style.height)).toBe(minContext);
        expect(parseFloat(v.recommendationBox.style.height)).toBe(minRecommendation);
      } finally {
        v.restore();
      }
    });
    test("with a heading and a question of 100 px, the regions share what the room leaves after them", async () => {
      const v = await laidOut({ room: 300 as Room, columns: 170, fixed: 100 });
      try {
        const total = parseFloat(v.contextBox.style.height) + parseFloat(v.recommendationBox.style.height) + parseFloat(v.section.style.getPropertyValue("--strip"));
        expect(total, "the regions take more than the room leaves").toBeLessThanOrEqual(200);
        expect(v.minimums.at(-1)).toBe(300);
      } finally {
        v.restore();
      }
    });
    test("a text allotted less than its own padding loses the padding, and a text allotted nothing is hidden", async () => {
      const v = await laidOut({ room: 10 as Room, columns: 100, fixed: 0 });
      try {
        expect(v.recommendationBox.style.height).toBe("0px");
        expect(v.recommendationBox.style.paddingTop).toBe("0px");
        expect(v.recommendationBox.style.paddingBottom).toBe("0px");
        expect(v.recommendationBox.style.visibility).toBe("hidden");
        expect(v.recommendationBox.getAttribute("aria-hidden")).toBe("true");
        expect(v.contextBox.style.height).toBe("10px");
        expect(v.contextBox.style.paddingTop).toBe("0px");
        expect(v.contextBox.style.paddingBottom).toBe("0px");
        expect(v.contextBox.getAttribute("aria-hidden")).toBe(null);
      } finally {
        v.restore();
      }
    });
    test("a room larger than the minimum: the minimum is reported whole, and no padding is taken away", async () => {
      const v = await laidOut({ room: 1000 as Room, columns: 100, fixed: 0 });
      try {
        expect(v.minimums.at(-1)).toBe(minContext + minRecommendation + 100);
        expect(v.section.style.getPropertyValue("--strip")).toBe("100px");
        for (const box of [v.contextBox, v.recommendationBox]) {
          expect(box.style.paddingTop).toBe("");
          expect(box.style.visibility).toBe("");
        }
      } finally {
        v.restore();
      }
    });
  });

  test("below 390 px the analysis is not laid out; a message asks for a wider window", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const root = show(DecisionView, { event, narrow: true, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    expect(root.querySelector(".column")).toBe(null);
    expect(one(root, "[role=alert]").textContent).toBe(prompts.ENLARGE_WINDOW_NOTICE);
    expect(prompts.ENLARGE_WINDOW_NOTICE).toMatch(/390/);
  });
});

// Issue #6: the whole run in the rail, the plan's stages and steps under its Implementation, and each step's full text
// in a hand-built rich tooltip reachable by hover and by keyboard.
describe("TimelineRail: the plan", () => {
  const recorded = (text = "Add the **schema**.") => ({
    stages: [
      { key: "current-1", number: 1, title: "the schema and its records", steps: [{ id: "S1", number: 1, label: "Structured user questions (Q1)", text, status: "done" as const }, { id: "S2", number: 2, label: "The store", text: "x", status: "started" as const }] },
      { key: "current-2", number: 2, title: "the page", steps: [{ id: "S3", number: 1, label: "The rail", text: "y", status: "unfinished" as const }, { id: "S4", number: 2, label: "The tooltip", text: "z", status: "pending" as const }] },
    ],
  });
  const entry = (state: TimelineEntry["state"], plan: TimelineEntry["plan"]): TimelineEntry => ({ ...fresh, phase: { kind: "execution", n: 1 }, label: "Implementation", state, groups: [], steps: [], plan, currentStep: "S2" });
  const ahead = (kind: "planning" | "work", state: TimelineEntry["state"]): TimelineEntry => ({ ...fresh, phase: { kind, n: 1 }, label: phaseName({ kind, n: 1 }, 1), state, groups: [], steps: [], plan: null });
  const rows = (root: HTMLElement) => [...root.querySelectorAll("[data-plan-step]")].map((e) => `${e.getAttribute("data-plan-step")}:${e.querySelector("[data-plan-step-label]")?.textContent?.trim()}`);

  test("the stages and the numbered steps hang under the Implementation that carries the plan, each with its mark", () => {
    const root = show(TimelineRail, { busy: true, executing: true, timeline: [ahead("planning", "done"), entry("active", recorded()), ahead("work", "ahead")] });
    expect([...root.querySelectorAll("[data-stage]")].map((e) => e.textContent?.trim())).toEqual([prompts.stageHeading(1, "the schema and its records"), prompts.stageHeading(2, "the page")]);
    expect(rows(root)).toEqual([
      `done:${prompts.planStepLabel(1, "Structured user questions (Q1)")}`,
      `current:${prompts.planStepLabel(2, "The store")}`,
      `unfinished:${prompts.planStepLabel(1, "The rail")}`,
      `pending:${prompts.planStepLabel(2, "The tooltip")}`,
    ]);
    // A running step's mark is the circular indicator, named for the step's state and the work (issue #50); its glyph stays for reduced motion.
    const marks = [...root.querySelectorAll("[data-plan-step] > .mark")].map((e) => [e.textContent?.trim(), e.getAttribute("aria-label") ?? e.querySelector("[role=progressbar]")?.getAttribute("aria-label")]);
    expect(marks).toEqual([["✓", prompts.PLAN_STEP_STATE_LABEL.done], ["●", prompts.stepWorkingLabel("planStep")], ["◐", prompts.PLAN_STEP_STATE_LABEL.unfinished], ["○", prompts.PLAN_STEP_STATE_LABEL.pending]]);
    expect(root.querySelector("[data-plan-step=current]")?.getAttribute("aria-current")).toBe("step");
  });

  test("without a running execution call a started step shows as unfinished, not current", () => {
    const root = show(TimelineRail, { busy: false, executing: false, timeline: [entry("active", recorded())] });
    expect(rows(root)[1]).toBe(`unfinished:${prompts.planStepLabel(2, "The store")}`);
  });

  test("a phase ahead and a phase not reached have marks and names of their own", () => {
    const root = show(TimelineRail, { busy: false, executing: false, timeline: [ahead("planning", "stopped"), entry("notReached", null), ahead("work", "ahead")] });
    const marks = [...root.querySelectorAll(".entry > .mark")].map((e) => [e.closest("[data-state]")?.getAttribute("data-state"), e.getAttribute("aria-label")]);
    expect(marks).toEqual([["stopped", prompts.TIMELINE_STATE_LABEL.stopped], ["notReached", prompts.TIMELINE_STATE_LABEL.notReached], ["ahead", prompts.TIMELINE_STATE_LABEL.ahead]]);
  });

  test("a step its phase ended without has a mark and a name of its own, apart from ahead and not reached", () => {
    const step = (kind: TimelineStep["kind"], state: TimelineStep["state"]): TimelineStep => ({ kind, label: prompts.stepLabel(kind), state, count: null, base: { answered: 0, total: 0 }, groups: [] });
    const questions: TimelineEntry = { ...fresh, phase: { kind: "questions" }, label: "Gather Requirements", state: "done", groups: [], steps: [step("formulate", "done"), step("clarification", "skipped")], plan: null };
    const root = show(TimelineRail, { busy: false, executing: false, timeline: [questions, { ...entry("notReached", null), steps: [step("formulate", "notReached")] }, { ...ahead("work", "ahead"), steps: [step("formulate", "ahead")] }] });
    const mark = (state: string) => root.querySelector(`[data-step=${state}] .mark`);
    expect(mark("skipped")?.getAttribute("aria-label")).toBe(prompts.TIMELINE_STATE_LABEL.skipped);
    expect(typeof prompts.TIMELINE_STATE_LABEL.skipped).toBe("string");
    expect(prompts.TIMELINE_STATE_LABEL.skipped).not.toBe(prompts.TIMELINE_STATE_LABEL.notReached);
    const glyph = mark("skipped")?.textContent?.trim();
    expect(glyph).toBeTruthy();
    expect([mark("notReached")?.textContent?.trim(), mark("ahead")?.textContent?.trim()]).not.toContain(glyph);
  });

  test("focus opens the step's full text as a tooltip described by the step, and Escape closes it", () => {
    const root = show(TimelineRail, { busy: false, executing: false, timeline: [entry("active", recorded())] });
    const button = one(root, "[data-plan-step] button");
    button.dispatchEvent(new FocusEvent("focus"));
    flushSync();
    const tip = one(root, "[role=tooltip]");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.querySelector("strong")?.textContent).toBe("schema");
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(root.querySelector("[role=tooltip]")).toBe(null);
    button.dispatchEvent(new MouseEvent("mouseenter"));
    flushSync();
    expect(root.querySelector("[role=tooltip]")).not.toBe(null);
  });

  // W1-R1-1: the pointer crosses a gap between the button and the tooltip; the tooltip waits for it.
  test("after the pointer leaves the button the tooltip waits for it, stays open over the tooltip, and closes after both are left", () => {
    vi.useFakeTimers();
    try {
      const root = show(TimelineRail, { busy: false, executing: false, timeline: [entry("active", recorded())] });
      const button = one(root, "[data-plan-step] button");
      const anchor = button.parentElement as HTMLElement;
      button.dispatchEvent(new MouseEvent("mouseenter"));
      flushSync();
      anchor.dispatchEvent(new MouseEvent("mouseleave"));
      flushSync();
      vi.advanceTimersByTime(TOOLTIP_GRACE_MS - 1);
      flushSync();
      const tip = one(root, "[role=tooltip]");
      tip.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(TOOLTIP_GRACE_MS * 2);
      flushSync();
      expect(root.querySelector("[role=tooltip]")).not.toBe(null);
      anchor.dispatchEvent(new MouseEvent("mouseleave"));
      flushSync();
      expect(root.querySelector("[role=tooltip]")).not.toBe(null);
      vi.advanceTimersByTime(TOOLTIP_GRACE_MS);
      flushSync();
      expect(root.querySelector("[role=tooltip]")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a step's text is sanitized: no script and no event handler survives", () => {
    const root = show(TimelineRail, { busy: false, executing: false, timeline: [entry("active", recorded('<script>window.bad = 1</script><img src="x" onerror="window.bad = 2">'))] });
    const button = one(root, "[data-plan-step] button");
    button.dispatchEvent(new FocusEvent("focus"));
    flushSync();
    const tip = one(root, "[role=tooltip]");
    expect(tip.querySelector("script")).toBe(null);
    expect(tip.querySelector("[onerror]")).toBe(null);
  });
});

// Issue #42 (Q7): an indeterminate indicator written by hand, with no value and no completion, and the elapsed time of
// the current call beside it, ticking once per second.
describe("TimelineRail: the busy indicator", () => {
  const active: TimelineEntry = { ...fresh, phase: { kind: "planning", n: 1 }, label: "Planning", state: "active", groups: [], steps: [], plan: null };
  afterEach(() => vi.useRealTimers());

  test("it is indeterminate: a progressbar without a value, and no element sized or moved by a value", () => {
    const root = show(TimelineRail, { busy: true, executing: false, timeline: [active], callStartedAt: new Date().toISOString() });
    const bar = one(root, "[role=progressbar]");
    expect(bar.getAttribute("aria-label")).toBe(prompts.AGENT_WORKING_LABEL);
    for (const attribute of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "value"]) expect(bar.hasAttribute(attribute)).toBe(false);
    for (const el of [bar, ...bar.querySelectorAll<HTMLElement>("*")]) {
      expect(el.style.width, "a width set from a value").toBe("");
      expect(el.style.transform, "a transform set from a value").toBe("");
    }
    expect(bar.closest("[data-busy]")).not.toBe(null);
  });

  test("the elapsed time of the call advances once per second from the call's start, and nothing marks it complete", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:05.000Z"));
    const root = show(TimelineRail, { busy: true, executing: false, timeline: [active], callStartedAt: "2026-09-28T12:00:00.000Z" });
    expect(one(root, "[data-elapsed]").textContent?.trim()).toBe(prompts.runningFor(5_000));
    vi.advanceTimersByTime(60_000);
    flushSync();
    expect(one(root, "[data-elapsed]").textContent?.trim()).toBe(prompts.runningFor(65_000));
    expect(one(root, "[role=progressbar]").hasAttribute("aria-valuenow")).toBe(false);
  });

  test("no component uses LinearProgressEstimate", async () => {
    const sources = import.meta.glob("./components/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    for (const [file, text] of Object.entries(sources)) expect(text.includes("LinearProgressEstimate"), file).toBe(false);
  });
});

// Issue #26 (S21): the activity line shows a retry as its count of attempts, not as progress.
test("the activity line shows retry 2 of 3", () => {
  const events: UiEvent[] = [
    { _tag: "AgentCallStarted", agent: "codex", purpose: "review" },
    { _tag: "AgentCallEnded", agent: "codex", ok: false },
    { _tag: "TransportRetrying", agent: "codex", attempt: 2, of: 3, delaySeconds: 10, fault: "stream disconnected" },
  ];
  const time = "2026-09-29T00:00:00Z";
  const messages: ServerMessage[] = [
    { type: "hello", cwd: "/p", current: 1, incarnation: "a" },
    { type: "replay", ui: [], runs: [] },
    { type: "event", run: 1, seq: 0, time, event: { _tag: "Started", project: "/p", task: "t" } },
    ...events.map((event, i): ServerMessage => ({ type: "event", run: 1, seq: i + 1, time, event: { _tag: "Notified", event } })),
  ];
  const s = messages.reduce(reduce, initialState);
  const root = show(ActivityLine, { text: s.run?.activity ?? "" });
  expect(one(root, "[data-activity]").textContent).toContain("retry 2 of 3");
});

// W1-R1-4: the activity line shows the indeterminate indicator while the program waits to retry: no value, no estimate.
test("the activity line shows an indeterminate progressbar only while busy, with the markup of the rail's indicator", () => {
  const busy = show(ActivityLine, { text: "Codex — connection lost, retry 1 of 3 (x)", busy: true });
  const bar = one(busy, "[role=progressbar]");
  expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(bar.getAttribute("aria-label")).toBe(prompts.RETRY_WAITING_LABEL);
  const idle = show(ActivityLine, { text: "Codex — review", busy: false });
  expect(idle.querySelector("[role=progressbar]")).toBe(null);
  // The seam: the rail's indicator and the activity line's are the same markup.
  const rail = show(TimelineRail, { timeline: [{ phase: { kind: "planning", n: 1 }, label: "Planning", state: "active", steps: [], plan: null } as unknown as TimelineEntry], busy: true });
  const railBar = one(rail, "[role=progressbar]");
  expect(bar.className).toBe(railBar.className);
  expect(bar.innerHTML.replace(/<!--.*?-->/g, "")).toBe(railBar.innerHTML.replace(/<!--.*?-->/g, ""));
});

// Issue #50: M3's indeterminate circular progress indicator, written by hand: no value and no end, an SVG arc in the
// mark's box, and the static glyph kept for reduced motion.
describe("CircularIndeterminate", () => {
  test("a progressbar with the given name, no value, an SVG arc, and the static glyph in its markup", () => {
    const root = show(CircularIndeterminate, { label: "in progress: An agent is working", glyph: "●" });
    const bar = one(root, "[role=progressbar]");
    expect(bar.getAttribute("aria-label")).toBe("in progress: An agent is working");
    for (const attribute of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "value"]) expect(bar.hasAttribute(attribute)).toBe(false);
    for (const el of [bar, ...bar.querySelectorAll<HTMLElement>("*")]) {
      expect(el.style.width, "a width set from a value").toBe("");
      expect(el.style.transform, "a transform set from a value").toBe("");
    }
    expect(bar.querySelector("svg circle, svg path")).not.toBe(null);
    expect(bar.querySelector("img")).toBe(null);
    expect(one(bar, "[data-glyph]").textContent).toBe("●");
    expect(bar.classList.contains("circular-indeterminate")).toBe(true);
  });
});

// Issue #50: the indicator and the current call's time are on the step that runs, not under the phase; the phase shows
// its own time: how long it has run, or how long it took.
describe("TimelineRail: where the indicator is", () => {
  afterEach(() => vi.useRealTimers());
  const gatherStep = (kind: TimelineStep["kind"], state: TimelineStep["state"]): TimelineStep => ({ kind, label: prompts.stepLabel(kind), state, count: null, base: { answered: 0, total: 0 }, groups: [] });
  const gather = (steps: TimelineStep[]): TimelineEntry => ({ ...fresh, phase: { kind: "questions" }, label: "Gather Requirements", state: "active", groups: [], steps, plan: null });
  const planStep = (id: string, number: number, status: "pending" | "started" | "done" | "unfinished") => ({ id, number, label: `step ${id}`, text: `text ${id}`, status });
  const implementation = (currentStep: string | null, statuses: Record<string, "pending" | "started" | "done" | "unfinished">): TimelineEntry => ({
    ...fresh,
    phase: { kind: "execution", n: 1 },
    label: "Implementation",
    state: "active",
    groups: [],
    steps: [],
    currentStep,
    plan: { stages: [{ key: "current-1", number: 1, title: "t", steps: ["S1", "S2"].map((id, i) => planStep(id, i + 1, statuses[id] ?? "pending")) }] },
  });
  const CALL = "2026-09-29T10:00:00.000Z";
  const entryBar = (root: HTMLElement) => root.querySelector(".entry > [data-busy]");

  test("Gather Requirements: the indicator and the call's time are inside the active step, not in the step ahead or under the phase", () => {
    const root = show(TimelineRail, { busy: true, timeline: [gather([gatherStep("formulate", "active"), gatherStep("clarification", "ahead")])], callStartedAt: CALL });
    const active = one(root, "[data-step=active]");
    expect(active.querySelector("[role=progressbar]")).not.toBe(null);
    expect(active.querySelector("[data-elapsed]")).not.toBe(null);
    const ahead = one(root, "[data-step=ahead]");
    expect(ahead.querySelector("[role=progressbar]")).toBe(null);
    expect(ahead.querySelector("[data-elapsed]")).toBe(null);
    expect(entryBar(root)).toBe(null);
    expect(root.querySelectorAll("[role=progressbar]").length).toBe(1);
  });

  test("Implementation: the indicator and the call's time are inside the current plan step, not under the phase", () => {
    const root = show(TimelineRail, { busy: true, executing: true, timeline: [implementation("S2", { S1: "done", S2: "started" })], callStartedAt: CALL });
    const current = one(root, "[data-plan-step=current]");
    expect(current.querySelector("[role=progressbar]")).not.toBe(null);
    expect(current.querySelector("[data-elapsed]")).not.toBe(null);
    expect(entryBar(root)).toBe(null);
    expect(root.querySelectorAll("[role=progressbar]").length).toBe(1);
  });

  test("Implementation with no step current: the phase carries the indicator, and a step left open shows as unfinished without one", () => {
    const cases: Record<string, "pending" | "started" | "done" | "unfinished">[] = [{}, { S1: "started", S2: "done" }];
    for (const statuses of cases) {
      const root = show(TimelineRail, { busy: true, executing: true, timeline: [implementation(null, statuses)], callStartedAt: CALL });
      expect(entryBar(root)?.querySelector("[role=progressbar]")).not.toBe(null);
      expect(entryBar(root)?.querySelector("[data-elapsed]")).not.toBe(null);
      expect(root.querySelector("[data-plan-step] [role=progressbar]")).toBe(null);
    }
  });

  test("an active step while no call runs shows its static mark and no indicator", () => {
    const root = show(TimelineRail, { busy: false, timeline: [gather([gatherStep("formulate", "done"), gatherStep("clarification", "active")])] });
    expect(root.querySelector("[role=progressbar]")).toBe(null);
    expect(one(root, "[data-step=active] .mark").getAttribute("aria-label")).toBe(prompts.TIMELINE_STATE_LABEL.active);
  });

  test("the running indicator is named for the step and the work; the step keeps aria-current; the mark's box stays", () => {
    const idle = show(TimelineRail, { busy: false, timeline: [gather([gatherStep("formulate", "active")])] });
    const running = show(TimelineRail, { busy: true, timeline: [gather([gatherStep("formulate", "active")])], callStartedAt: CALL });
    const bar = one(running, "[data-step=active] [role=progressbar]");
    expect(bar.getAttribute("aria-label")).toBe(prompts.stepWorkingLabel("phaseStep"));
    expect(one(running, "[data-step=active]").getAttribute("aria-current")).toBe("step");
    // The glyph's box: the same element, with the same class, holds the static glyph or the indicator.
    const mark = (root: HTMLElement) => one(root, "[data-step=active] > .mark");
    expect(mark(running).className).toBe(mark(idle).className);
    expect(bar.parentElement).toBe(mark(running));
    const plan = show(TimelineRail, { busy: true, executing: true, timeline: [implementation("S2", { S2: "started" })], callStartedAt: CALL });
    expect(one(plan, "[data-plan-step=current] [role=progressbar]").getAttribute("aria-label")).toBe(prompts.stepWorkingLabel("planStep"));
    expect(one(plan, "[data-plan-step=current]").getAttribute("aria-current")).toBe("step");
    expect(one(plan, "[data-plan-step=current] [role=progressbar]").parentElement?.classList.contains("mark")).toBe(true);
  });

  test("the active phase shows how long it has run, advancing while no call runs; an ended phase how long it took; others nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T10:11:00.000Z"));
    const at = (iso: string) => `2026-09-29T${iso}.000Z`;
    const root = show(TimelineRail, {
      busy: false,
      timeline: [
        { ...fresh, phase: { kind: "planning", n: 1 }, label: "Planning", state: "done", groups: [], steps: [], plan: null, began: at("09:00:00"), ended: at("09:11:02") },
        { ...fresh, phase: { kind: "execution", n: 1 }, label: "Implementation", state: "stopped", groups: [], steps: [], plan: null, began: at("09:11:02"), ended: at("09:12:05") },
        { ...fresh, phase: { kind: "planning", n: 2 }, label: "Planning 2", state: "active", groups: [], steps: [], plan: null, began: at("10:00:00") },
        { ...fresh, phase: { kind: "execution", n: 2 }, label: "Implementation 2", state: "ahead", groups: [], steps: [], plan: null },
      ],
    });
    const times = () => [...root.querySelectorAll(".entry")].map((e) => e.querySelector(":scope > [data-phase-time]")?.textContent?.trim() ?? null);
    expect(times()).toEqual([prompts.phaseTook(662_000), prompts.phaseTook(63_000), prompts.phaseElapsed(660_000), null]);
    vi.advanceTimersByTime(5_000);
    flushSync();
    expect(times()[2]).toBe(prompts.phaseElapsed(665_000));
  });

  test("a step shown under two Implementations: each tooltip has its own id, and each step is described by its own", () => {
    const ended: TimelineEntry = { ...implementation(null, { S1: "unfinished" }), state: "done", label: "Implementation 1" };
    const later: TimelineEntry = { ...implementation(null, { S1: "done" }), phase: { kind: "execution", n: 2 }, label: "Implementation 2" };
    const root = show(TimelineRail, { busy: false, timeline: [ended, later] });
    const buttons = [...root.querySelectorAll<HTMLElement>("[data-plan-step] button")].filter((b) => b.textContent?.includes("step S1"));
    expect(buttons.length).toBe(2);
    buttons[0].dispatchEvent(new FocusEvent("focus"));
    buttons[1].dispatchEvent(new MouseEvent("mouseenter"));
    flushSync();
    const tips = [...root.querySelectorAll("[role=tooltip]")].map((t) => t.id);
    expect(tips.length).toBe(2);
    expect(new Set(tips).size).toBe(2);
    expect(buttons.map((b) => b.getAttribute("aria-describedby"))).toEqual(tips);
  });

  test("a stage of the current plan and a stage of removed steps with the same number both render", () => {
    const entry: TimelineEntry = {
      ...implementation(null, {}),
      state: "done",
      plan: { stages: [{ key: "current-2", number: 2, title: "now", steps: [planStep("S3", 1, "done")] }, { key: "record-2", number: 2, title: "then", steps: [planStep("S1", 1, "unfinished")] }] },
    };
    const root = show(TimelineRail, { busy: false, timeline: [entry] });
    expect([...root.querySelectorAll("[data-stage]")].map((e) => e.textContent?.trim())).toEqual([prompts.stageHeading(2, "now"), prompts.stageHeading(2, "then")]);
  });

  // The seam of the prompt, the reducer and the rail (P1-R1-5): what executePrompt tells Claude Code to report when it
  // resumes a step is the report that puts the indicator back on that step.
  test("the resume sentence of executePrompt, folded as reports, moves the indicator from S2 to the phase and back to S1", () => {
    expect(prompts.executePrompt.includes(prompts.resumeStepSentence)).toBe(true);
    expect(prompts.resumeStepSentence.includes(`'${prompts.REPORT_STEP_STATUSES[0]}'`)).toBe(true);
    const plan = (s1: "started" | "unfinished", s2: "pending" | "started" | "done") => ({ stages: [{ number: 1, title: "t", steps: [planStep("S1", 1, s1), planStep("S2", 2, s2)] }] });
    const report = (id: string, status: (typeof prompts.REPORT_STEP_STATUSES)[number], p: ReturnType<typeof plan>): UiEvent => ({ _tag: "PlanChanged", phase: 1, plan: p, step: { id, status } });
    const events: UiEvent[] = [
      { _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } },
      { _tag: "AgentCallStarted", agent: "claude", purpose: "execution" },
      report("S1", "started", plan("started", "pending")),
      report("S2", "started", plan("started", "started")),
    ];
    const done = report("S2", "done", plan("started", "done"));
    const resumed = report("S1", prompts.REPORT_STEP_STATUSES[0], plan("started", "done"));
    const rail = (list: UiEvent[]) => {
      const messages: ServerMessage[] = [
        { type: "hello", cwd: "/p", current: 1, incarnation: "a" },
        { type: "replay", ui: [], runs: [] },
        { type: "event", run: 1, seq: 0, time: CALL, event: { _tag: "Started", project: "/p", task: "t" } },
        ...list.map((event, i): ServerMessage => ({ type: "event", run: 1, seq: i + 1, time: CALL, event: { _tag: "Notified", event } })),
      ];
      const run = messages.reduce(reduce, initialState).run!;
      return show(TimelineRail, { timeline: run.timeline, busy: run.busy, executing: executing(run), callStartedAt: callStartedAt(run) });
    };
    const where = (root: HTMLElement) => one(root, "[role=progressbar]").closest("[data-plan-step], .entry")?.querySelector("[data-plan-step-label], [data-label]")?.textContent?.trim();
    expect(where(rail(events))).toBe(prompts.planStepLabel(2, "step S2"));
    expect(where(rail([...events, done]))).toBe("Implementation");
    expect(where(rail([...events, done, resumed]))).toBe(prompts.planStepLabel(1, "step S1"));
  });
});

// S27 (Q10): the question takes the left panel while its prompt is pending: the heading and origin, a top region that
// scrolls on its own (context, details, terms), the question fixed below it, and a bottom region that scrolls on its own
// (the options with their answers, the field, the buttons).
describe("QuestionPane's regions", () => {
  const question: PresentedQuestion = {
    number: 4,
    origin: { kind: "relayed" },
    context: { blocks: [{ kind: "paragraph", pieces: [...plainPieces("The "), ref("service", "s"), ...plainPieces(" keeps its data in a database.")] }], by: "agent" },
    explanations: [{ id: "s", term: "service", explanation: "The program this task builds." }],
    question: [...plainPieces("Which database should the "), ref("service", "s"), ...plainPieces(" use?")],
    options: [
      { label: plainPieces("SQLite"), description: plainPieces("a file"), answer: { token: "1" } },
      { label: plainPieces("More cycles"), description: plainPieces("go on"), answer: { numeric: true } },
    ],
    details: plainBlocks("**The facts** of the case."),
    decision: null,
  };
  const withQuestion = (q: PresentedQuestion = question, text = prompts.optionOrTextPrompt): Widget => ({ ...widget(text), question: q, presentedAt: null });

  test("the heading, the origin line, the context, details and terms on top, the question fixed, the options below", () => {
    const root = show(QuestionPane, { widget: withQuestion(), onAnswer: () => undefined });
    expect(one(root, "h2").textContent?.trim()).toBe(prompts.questionTitle(4));
    expect(one(root, ".origin").textContent?.trim()).toBe(prompts.originLine(question.origin, null));
    const top = one(root, ".top");
    expect(one(top, ".context").textContent).toContain("The service keeps its data in a database.");
    expect(one(top, ".details").innerHTML).toContain("<strong>The facts</strong>");
    // The explanation costs no space until it is asked for: no list of terms (task of issue #36).
    expect(top.querySelector(".terms, dl")).toBe(null);
    expect(top.textContent).not.toContain("The program this task builds.");
    const asked = one(root, ".question-text");
    expect(asked.textContent?.trim()).toBe("Which database should the service use?");
    expect(asked.closest(".top, .bottom")).toBe(null);
    const bottom = one(root, ".bottom");
    const cards = [...bottom.querySelectorAll<HTMLButtonElement>(".options button")];
    expect(cards[0].textContent).toContain("1.");
    expect(cards[0].textContent).toContain("SQLite");
    expect(one(bottom, ".numeric").textContent).toContain(prompts.NUMERIC_OPTION_NOTE);
    expect(bottom.querySelector("input[name=answer]")).not.toBe(null);
  });

  test("a card sends its answer; a numeric option is no button", () => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: withQuestion(), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const cards = [...root.querySelectorAll<HTMLButtonElement>(".options button")];
    expect(cards.length).toBe(1);
    cards[0].click();
    expect(sent).toEqual(["1"]);
  });

  test("a context the program wrote carries the note; the summary to confirm is inside the pane", () => {
    const summary: PresentedQuestion = { ...question, origin: { kind: "confirmSummary" }, context: { blocks: plainBlocks("Interloq asks."), by: "program" }, options: [], explanations: [], details: [{ kind: "document", markdown: "# Requirements\n\nUse SQLite." }], question: plainPieces(prompts.CONFIRM_SUMMARY_QUESTION) };
    const root = show(QuestionPane, { widget: withQuestion(summary, prompts.confirmSummaryPrompt), onAnswer: () => undefined });
    expect(one(root, ".context").textContent).toContain(prompts.PROGRAM_CONTEXT_NOTE);
    expect(one(root, ".top .details").textContent).toContain("Use SQLite.");
  });

  // S28: every occurrence of a term in the context, the details, the question and the options carries its explanation,
  // reachable by hover and by keyboard; Escape closes it.
  test("a term's occurrences open its tooltip on focus and on hover; Escape closes it", () => {
    const root = show(QuestionPane, { widget: withQuestion(), onAnswer: () => undefined });
    const marks = [...root.querySelectorAll<HTMLElement>(".term")];
    expect(marks.map((m) => (m.closest(".context") !== null ? "context" : m.closest("p.question-text") !== null ? "question" : "?"))).toEqual(["context", "question"]);
    marks[1].focus();
    marks[1].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(one(document.body, "[role=tooltip]").textContent).toContain("The program this task builds.");
    expect(marks[1].getAttribute("aria-describedby")).toBe(one(document.body, "[role=tooltip]").id);
    marks[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(document.querySelector("[role=tooltip]")).toBe(null);
    marks[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    flushSync();
    expect(document.querySelector("[role=tooltip]")).not.toBe(null);
  });

  // S41 (W2-R1-4): the numeric option (More cycles) carries its terms like every other option.
  test("a term in the numeric option's label and description is marked and opens its explanation", () => {
    const limit: PresentedQuestion = {
      ...question,
      explanations: [{ id: "c", term: "cycles", explanation: "Rounds of review and response." }, { id: "r", term: "reviewer", explanation: "Codex, which checks the plan." }],
      question: plainPieces("Should the review stop?"),
      context: { blocks: plainBlocks("The review has reached its limit."), by: "agent" },
      details: [],
      options: [{ label: [...plainPieces("More "), ref("cycles", "c")], description: [...plainPieces("let the "), ref("reviewer", "r"), ...plainPieces(" go on")], answer: { numeric: true } }],
    };
    const root = show(QuestionPane, { widget: withQuestion(limit), onAnswer: () => undefined });
    const numeric = one(root, ".numeric");
    const marks = [...numeric.querySelectorAll<HTMLElement>(".term")];
    expect(marks.map((m) => m.textContent)).toEqual(["cycles", "reviewer"]);
    expect(numeric.textContent).toContain(prompts.NUMERIC_OPTION_NOTE);
    marks[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    flushSync();
    expect(one(document.body, "[role=tooltip]").textContent).toContain("Codex, which checks the plan.");
    marks[0].focus();
    marks[0].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(document.getElementById(marks[0].getAttribute("aria-describedby") ?? "")!.textContent).toContain("Rounds of review and response.");
  });

  // S44 (W3-R1-1): a term's tooltip is never inside the card it explains, so a click in it answers nothing.
  test("a click in the tooltip of a term in an option card sends nothing; the tooltip is in no button", () => {
    const sent: string[] = [];
    const q: PresentedQuestion = { ...question, explanations: [{ id: "f", term: "file", explanation: "A file on the disk." }], options: [{ label: plainPieces("SQLite"), description: [...plainPieces("one "), ref("file", "f")], answer: { token: "1" } }] };
    const root = show(QuestionPane, { widget: withQuestion(q), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const mark = one(root, ".options .term");
    mark.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    flushSync();
    const tip = one(document.body, "[role=tooltip]");
    expect(tip.closest("button")).toBe(null);
    tip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    tip.querySelector("p")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(sent).toEqual([]);
  });

  test("Show the conversation calls its handler", () => {
    let shown = 0;
    const root = show(QuestionPane, { widget: withQuestion(), onAnswer: () => undefined, onShowConversation: () => void shown++ });
    one(root, "button[name=conversation]").click();
    expect(shown).toBe(1);
  });
});

// S25 (issue #25): every submission that ends the run, clicked or typed, and Stop task are confirmed in an M3 dialog;
// only confirming sends it; Cancel keeps the typed text and returns focus. The run-ending buttons use the error role.
describe("the confirmation before a run ends, in the page", () => {
  const openDialog = (root: ParentNode) => root.querySelector<HTMLDialogElement>("dialog[open]");
  const pane = (text: string) => {
    const sent: string[] = [];
    const root = show(QuestionPane, { widget: widget(text), onAnswer: (_p: number, t: string) => void sent.push(t) });
    return { root, sent };
  };
  const enter = (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  test("a click on End the run opens the dialog; confirming sends q", () => {
    const { root, sent } = pane(prompts.decisionPrompt);
    const end = [...root.querySelectorAll<HTMLButtonElement>(".choices button")].find((b) => b.textContent?.trim() === prompts.END_RUN_LABEL)!;
    expect(end.closest(".ends-run")).not.toBe(null);
    end.click();
    flushSync();
    expect(sent).toEqual([]);
    expect(openDialog(root)?.textContent).toContain(prompts.confirmEndText("endRun"));
    one(root, "dialog button[name=confirm-end]").click();
    flushSync();
    expect(sent).toEqual(["q"]);
  });

  test("typed q with Enter opens the dialog; Cancel sends nothing and keeps the text in the field", () => {
    const { root, sent } = pane(prompts.decisionPrompt);
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "q");
    enter(input);
    flushSync();
    expect(openDialog(root)).not.toBe(null);
    one(root, "dialog button[name=cancel-end]").click();
    flushSync();
    expect(sent).toEqual([]);
    expect(input.value).toBe("q");
    expect(openDialog(root)).toBe(null);
  });

  test("typed /quit in a message opens the dialog", () => {
    const { root, sent } = pane(prompts.interviewMessagePrompt);
    const field = one(root, "textarea[name=answer]") as HTMLTextAreaElement;
    type(field, "/quit");
    enter(field);
    flushSync();
    expect(openDialog(root)?.textContent).toContain(prompts.confirmEndText("endRun"));
    expect(sent).toEqual([]);
  });

  test("at the cycle limit, 0, an empty submission and an invalid number open the dialog of the halt; a count does not", () => {
    for (const text of ["0", "", "x"]) {
      const { root, sent } = pane(prompts.limitPrompt);
      const input = one(root, "input[name=answer]") as HTMLInputElement;
      type(input, text);
      enter(input);
      flushSync();
      expect(openDialog(root)?.textContent, text).toContain(prompts.confirmEndText("limitStop"));
      one(root, "dialog button[name=confirm-end]").click();
      flushSync();
      expect(sent).toEqual([text]);
    }
    const { root, sent } = pane(prompts.limitPrompt);
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "3");
    enter(input);
    flushSync();
    expect(openDialog(root)).toBe(null);
    expect(sent).toEqual(["3"]);
  });

  test("Stop task opens the dialog; only confirming stops the run", () => {
    const stopped: number[] = [];
    const run = { ...emptyRun(3), project: "/p", task: "t" };
    const root = show(TopBar, { run, connection: "open", onStop: (_i: string, r: number) => void stopped.push(r) });
    one(root, "button[name=stop]").click();
    flushSync();
    expect(stopped).toEqual([]);
    expect(openDialog(root)?.textContent).toContain(prompts.confirmEndText("stopTask"));
    one(root, "dialog button[name=confirm-end]").click();
    flushSync();
    expect(stopped).toEqual([3]);
  });
});

// S25, the seam: the page and the terminal confirm by the one predicate, endingOf of src/input.ts.
test("the question pane and the terminal's confirmation both take endingOf from src/input.ts", async () => {
  const pane = (await import("./components/QuestionPane.svelte?raw")).default;
  const terminal = (await import("../../src/confirmEnd.ts?raw")).default;
  for (const source of [pane, terminal]) expect(source).toMatch(/import \{[^}]*\bendingOf\b[^}]*\} from "(\.\.\/\.\.\/\.\.\/src|\.)\/input\.ts"/);
});

// S28: the words of an answered question in the transcript, and of the question beside its analysis, carry their
// explanations; the transcript shows the question whole, its options' labels on their own lines (S14).
test("an answered question in the transcript marks its words; the question beside an analysis marks its words", async () => {
  const zod = [{ id: "z", term: "zod", explanation: "A library." }];
  const asked: PresentedQuestion = { number: 2, origin: { kind: "relayed" }, context: { blocks: [{ kind: "paragraph", pieces: [ref("Zod", "z"), ...plainPieces(" checks data.")] }], by: "agent" }, explanations: zod, question: [...plainPieces("Use "), ref("zod", "z"), ...plainPieces("?")], options: [{ label: plainPieces("Yes"), description: plainPieces("declare it"), answer: { token: "1" } }], details: [], decision: null };
  const root = show(MessageView, { message: { key: "k", author: "program", heading: null, body: "Use zod?", format: "text", time: "2026-09-27T14:00:00.000Z", showTime: true, band: null, question: asked } });
  expect([...root.querySelectorAll(".term")].map((m) => m.textContent)).toEqual(["Zod", "zod"]);
  expect(one(root, ".option-label").textContent).toContain("Yes");
  expect(one(root, ".option-description").textContent).toBe("declare it");
  const { default: DecisionView } = await import("./components/DecisionView.svelte");
  const presented = asked;
  const analyzed = { _tag: "DecisionAnalyzed", decision: 1, question: "Use zod?", presented, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } } as never;
  const view = show(DecisionView, { event: analyzed, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
  expect([...view.querySelectorAll(".question .term")].length).toBe(2);
});

// S51 (W3-R1-2 of work review 5): code in rendered Markdown keeps its whitespace in the pane, beside an analysis and in
// the transcript, by one shared rule. jsdom has no layout (the widths are measured by e2e L22), so this reads the rule
// from its stylesheet and asserts that each of the three components renders its code inside the class the rule targets.
describe("the shared rule for code in rendered Markdown", () => {
  const ruleOf = (css: string, selector: string) => {
    const at = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").find((block) => block.split("{")[0].split(",").map((s) => s.trim()).includes(selector));
    return at === undefined ? "" : at.split("{")[1];
  };
  test("theme.css keeps the whitespace of inline code and of code blocks, a tab wider than a space", async () => {
    // Read from disk: Vitest's CSS handling gives a `?raw` stylesheet as empty text.
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("web/src/theme.css", "utf8");
    const inline = ruleOf(css, ".markdown code");
    expect(inline).toMatch(/white-space:\s*break-spaces/);
    expect(inline).toMatch(/tab-size:\s*4/);
    const block = ruleOf(css, ".markdown pre code");
    expect(block).toMatch(/white-space:\s*pre\b/);
    expect(ruleOf(css, ".markdown pre")).toMatch(/overflow-x:\s*auto/);
    // Inline code measures its tab stops from its own start, so a tab never looks like one space.
    expect(ruleOf(css, ".markdown :not(pre) > code")).toMatch(/display:\s*inline-block/);
  });
  test("no component copies the rule", async () => {
    for (const source of [await import("./components/QuestionPane.svelte?raw"), await import("./components/DecisionView.svelte?raw"), await import("./components/Message.svelte?raw")]) {
      expect(source.default).not.toMatch(/break-spaces/);
    }
  });
  test("QuestionPane, DecisionView and Message render their code inside .markdown", async () => {
    const details = prompts.toolInputBlocks({ command: " a " });
    const presented: PresentedQuestion = { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("Run `x`."), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details, decision: null };
    const pane = show(QuestionPane, { widget: { ...widget(prompts.optionOrTextPrompt), question: presented, presentedAt: null }, onAnswer: () => undefined });
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const event = { _tag: "DecisionAnalyzed", decision: 1, question: "Q?", presented, options: [], analysis: { decision: "Q?", columns: [], recommendation: { option: "", reason: "" } } } as never;
    const beside = one(show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined }), ".question-context");
    const message = show(MessageView, { message: { key: "1-1", author: "program", heading: "", body: "Q?", format: "text", time: "2026-09-30T10:00:00.000Z", showTime: false, band: null, question: presented } });
    for (const [what, root] of [["the pane", pane], ["beside an analysis", beside], ["the transcript", message]] as const) {
      const codes = [...root.querySelectorAll("code")].filter((c) => c.textContent === " a ");
      expect(codes.length, what).toBe(1);
      expect(codes[0].closest(".markdown"), what).not.toBe(null);
    }
  });
});

// Issue #36 (replacing S59's marking of a split term): a piece that refers to an explanation sits beside inline
// formatting in the question pane and beside an analysis; the formatting is rendered and the word carries its explanation.
describe("a word that refers to an explanation beside inline formatting in the context", () => {
  const presented: PresentedQuestion = { number: 3, origin: { kind: "relayed" }, context: { blocks: [{ kind: "paragraph", pieces: [...plainPieces("The **saved** "), ref("cache key", "k"), ...plainPieces(" identifies the result.")] }], by: "agent" }, explanations: [{ id: "k", term: "cache key", explanation: "The name of a saved result." }], question: plainPieces("Should we keep it?"), options: [], details: [], decision: null };
  const check = (region: Element) => {
    expect(region.querySelector("strong")?.textContent).toBe("saved");
    expect(region.textContent).not.toContain("*");
    const words = [...region.querySelectorAll<HTMLElement>(".term")];
    expect(words.map((m) => m.textContent)).toEqual(["cache key"]);
    words[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    flushSync();
    expect(one(document.body, "[role=tooltip]").textContent).toContain("The name of a saved result.");
  };
  test("in the question pane", () => {
    const root = show(QuestionPane, { widget: { ...widget(prompts.optionOrTextPrompt), question: presented, presentedAt: null }, onAnswer: () => undefined });
    check(one(root, ".context"));
  });
  test("beside an analysis", async () => {
    const { default: DecisionView } = await import("./components/DecisionView.svelte");
    const event = { _tag: "DecisionAnalyzed", decision: 1, question: "Q?", presented, options: [], analysis: { decision: "Q?", columns: [], recommendation: { option: "", reason: "" } } } as never;
    const root = show(DecisionView, { event, narrow: false, open: () => true, onToggle: () => undefined, onShowConversation: () => undefined });
    check(one(root, ".question-context"));
  });
});

// S14 (issue #59): an option's label is set apart from its text: in bold, on its own line, a separate element.
test("each option card shows its label in bold as its own element and its description as another", () => {
  const presented: PresentedQuestion = { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Which?"), options: [{ label: plainPieces("SQLite"), description: plainPieces("one file, no server"), answer: { token: "1" } }, { label: plainPieces("More cycles"), description: plainPieces("go on"), answer: { numeric: true } }], details: [], decision: null };
  const root = show(QuestionPane, { widget: { ...widget(prompts.optionOrTextPrompt), question: presented, presentedAt: null }, onAnswer: () => undefined });
  for (const option of [one(root, ".options button"), one(root, ".numeric")]) {
    const label = one(option, ".option-label");
    const description = one(option, ".option-description");
    expect(label.querySelector("strong")).not.toBe(null);
    expect(label.contains(description)).toBe(false);
    expect(description.contains(label)).toBe(false);
    expect(label.textContent).not.toContain("—");
  }
  expect(one(root, ".options button .option-label strong").textContent).toBe("SQLite");
  expect(one(root, ".options button .option-description").textContent).toBe("one file, no server");
});

// Issue #68: during a wait for a usage limit, the activity line shows M3's determinate linear indicator with the fraction of
// the wait elapsed and the time remaining, in place of the indeterminate one.
test("the activity line shows a determinate progressbar and the time remaining during a usage-limit wait", () => {
  const now = Date.now();
  const wait = { agent: "claude" as const, limitType: "five_hour", fromMs: now - 3_600_000, untilMs: now + 3_600_000 };
  const root = show(ActivityLine, { text: "Claude — waiting", busy: false, wait });
  const bar = one(root, "[role=progressbar]");
  expect(bar.getAttribute("aria-label")).toBe(prompts.USAGE_LIMIT_WAITING_LABEL);
  const value = Number(bar.getAttribute("aria-valuenow"));
  expect(value).toBeGreaterThanOrEqual(49);
  expect(value).toBeLessThanOrEqual(51);
  expect(one(root, "[data-remaining]").textContent).toMatch(/^(1:00:00|59:5\d) left$/);
  const plain = show(ActivityLine, { text: "Codex — review", busy: false, wait: null });
  expect(plain.querySelector("[role=progressbar]")).toBe(null);
  expect(plain.querySelector("[data-remaining]")).toBe(null);
});

// Issue #60: every place the page shows a phase's name derives it from phaseLabel (through phaseName). The expected
// names come from phaseName alone, so a rail entry or a band that writes a name by hand fails whatever the name is.
test("the seam of the phase names: the rail and the bands show phaseName's names", () => {
  const time = "2026-10-07T14:00:00.000Z";
  const phases = foreseenPhases(false, 2);
  const events: unknown[] = [
    { _tag: "Started", project: "/p", task: "t" },
    { _tag: "Notified", event: { _tag: "PhasesForeseen", phases } },
    ...phases.flatMap((phase, i) => [{ _tag: "Notified", event: { _tag: "PhaseBegan", phase } }, { _tag: "Said", text: `line ${i}` }]),
  ];
  const state = [{ type: "hello", cwd: "/p", current: 1, incarnation: "a" }, { type: "replay", ui: [], runs: [] }, ...events.map((event, seq) => ({ type: "event", run: 1, seq, time, event }))].reduce((s, m) => reduce(s, m as Parameters<typeof reduce>[1]), initialState);
  const names = phases.map((p) => phaseName(p, countOfKind(phases, p.kind)));
  const rail = show(TimelineRail, { busy: false, timeline: state.run?.timeline ?? [] });
  expect([...rail.querySelectorAll("[data-label]")].map((e) => e.textContent?.trim())).toEqual(names);
  const panel = show(ChatPanel, { title: "You and Interloq", messages: state.run?.left ?? [], empty: "none" });
  expect([...panel.querySelectorAll(".phase-label")].map((e) => e.textContent?.trim())).toEqual(names.map((n) => prompts.phaseBandLabel(n, clockTime(time))));
});
