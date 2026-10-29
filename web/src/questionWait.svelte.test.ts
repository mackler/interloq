// Issue #153 (requirements Q1): the question stays on the page while its decision's analysis is prepared. The page is
// mounted whole over a fake WebSocket and fed the events the server sends.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { plainPieces } from "../../src/pieces.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { writePreferences } from "./storage.ts";
import { helloChain } from "./testChain.ts";
import { NotificationStub } from "./test-setup.ts";
import { tabTitle } from "./title.ts";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.last = this;
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
}

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const openPage = async () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const { default: App } = await import("./components/App.svelte");
  const root = document.createElement("div");
  document.body.appendChild(root);
  mounted.push(mount(App, { target: root, props: {} }));
  flushSync();
  const ws = FakeWebSocket.last!;
  ws.receive({ type: "hello", chain: helloChain, location: "/p", current: { refinement: [1], implementation: null }, incarnation: "a" });
  return { root, ws };
};

const TIME = "2026-10-29T14:00:00.000Z";
const started = { _tag: "Started", project: "/p", location: "/p", task: "t", mode: "refinement", item: { id: "11", title: "t" } };
const question = {
  number: 1,
  origin: { kind: "relayed" },
  context: { blocks: [{ kind: "paragraph", pieces: plainPieces("Some context.") }], by: "agent" },
  history: [],
  explanations: [{ id: "t", term: "database", senses: ["A program that keeps data."] }],
  question: [{ text: "Which ", ref: "", code: false }, { text: "database", ref: "t", code: false }, { text: "?", ref: "", code: false }],
  options: [{ label: plainPieces("SQLite"), description: [], answer: { token: "1" } }, { label: plainPieces("PostgreSQL"), description: [], answer: { token: "2" } }],
  attached: null,
  decision: null,
};
const presented = { _tag: "Notified", event: { _tag: "QuestionPresented", question } };
const offered = (hint: string) => ({ _tag: "Asked", prompt: 1, ...promptOf(prompts.withOffer(hint)), countdown: null, deciding: null });
const frame = (hint: string) => ({ _tag: "Asked", prompt: 2, ...promptOf(hint), countdown: null, deciding: 1 });
const begin = (ws: FakeWebSocket, hint: string) => ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: [started, presented, offered(hint)].map((event) => ({ time: TIME, event })) }] });
let seq = 3;
const event = (ws: FakeWebSocket, e: unknown) => ws.receive({ type: "event", run: 1, seq: seq++, time: TIME, event: e });

const pane = (root: ParentNode) => root.querySelector<HTMLElement>("section.pane");
const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>(`[role=group][aria-label="${prompts.PROPOSED_ANSWERS_LABEL}"] button`)];
const helpMeDecide = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>(".choices button")].find((b) => b.textContent?.trim() === prompts.HELP_ME_DECIDE);
const contextToggle = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>(".pane button.toggle")].find((b) => b.textContent?.trim() === prompts.CONTEXT_HEADING)!;
const field = (root: ParentNode) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>("[name=answer]")!;
const type = (root: ParentNode, text: string) => {
  field(root).value = text;
  field(root).dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};
const enter = (root: ParentNode) => {
  field(root).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  flushSync();
};
const answers = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "answer");

describe("the question while its analysis is prepared", () => {
  test("nothing is reset, submission is inert while starting, and live, without Help me decide, once preparing", async () => {
    seq = 3;
    const { root, ws } = await openPage();
    begin(ws, prompts.optionOrTextPrompt);
    const before = pane(root)!;
    contextToggle(root).click();
    flushSync();
    before.scrollTop = 40;
    type(root, "half an answer");
    helpMeDecide(root)!.click();
    flushSync();
    expect(answers(ws).at(-1)).toEqual({ type: "answer", incarnation: "a", run: 1, prompt: 1, text: "/decide" });
    expect(field(root).value).toBe("half an answer");
    event(ws, { _tag: "Answered", prompt: 1, text: "/decide" });
    // Starting: the same pane, its section open and its scroll kept; the choices inert; Enter sends nothing.
    expect(pane(root)).toBe(before);
    expect(contextToggle(root).getAttribute("aria-expanded")).toBe("true");
    expect(before.scrollTop).toBe(40);
    expect(cards(root).every((c) => c.disabled)).toBe(true);
    const sent = ws.sent.length;
    type(root, "a longer answer");
    enter(root);
    cards(root)[1]!.click();
    flushSync();
    expect(ws.sent.length).toBe(sent);
    expect(field(root).value).toBe("a longer answer");
    // Preparing: live, no Help me decide, the term still a focusable word, the text kept.
    event(ws, frame(prompts.optionOrTextPrompt));
    expect(pane(root)).toBe(before);
    expect(contextToggle(root).getAttribute("aria-expanded")).toBe("true");
    expect(before.scrollTop).toBe(40);
    expect(helpMeDecide(root)).toBe(undefined);
    expect(root.querySelector(".pane .term[data-ref=t]")).not.toBe(null);
    expect(field(root).value).toBe("a longer answer");
    expect(cards(root).every((c) => !c.disabled)).toBe(true);
    cards(root)[1]!.click();
    flushSync();
    expect(answers(ws).at(-1)).toEqual({ type: "answer", incarnation: "a", run: 1, prompt: 2, text: "2" });
  });

  test("Enter in the message field while starting sends nothing and keeps the text", async () => {
    seq = 3;
    const { root, ws } = await openPage();
    begin(ws, prompts.interviewMessagePrompt);
    helpMeDecide(root)!.click();
    flushSync();
    event(ws, { _tag: "Answered", prompt: 1, text: "/decide" });
    const sent = ws.sent.length;
    type(root, "a message");
    enter(root);
    expect(ws.sent.length).toBe(sent);
    expect(field(root).value).toBe("a message");
  });

  test("the frame withdrawn and the analysis ready: the decision page replaces the question", async () => {
    seq = 3;
    const { root, ws } = await openPage();
    begin(ws, prompts.optionOrTextPrompt);
    event(ws, { _tag: "Answered", prompt: 1, text: "/decide" });
    event(ws, frame(prompts.optionOrTextPrompt));
    event(ws, { _tag: "PromptWithdrawn", prompt: 2 });
    event(ws, { _tag: "Notified", event: { _tag: "DecisionAnalyzed", decision: 1, question: "Which database?", presented: question, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } } });
    event(ws, presented);
    event(ws, { _tag: "Asked", prompt: 3, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: null });
    expect(root.querySelector("section.decision")).not.toBe(null);
  });

  test("a question being analyzed raises no notification and no title mark; asked beside its analysis it does", async () => {
    seq = 3;
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    writePreferences({ desktop: "on", sound: "off" });
    NotificationStub.permission = "granted";
    try {
      const { ws } = await openPage();
      begin(ws, prompts.optionOrTextPrompt);
      expect(NotificationStub.calls).toHaveLength(1);
      event(ws, { _tag: "Answered", prompt: 1, text: "/decide" });
      event(ws, frame(prompts.optionOrTextPrompt));
      expect(NotificationStub.calls).toHaveLength(1);
      expect(document.title).toBe(tabTitle("/p"));
      event(ws, { _tag: "PromptWithdrawn", prompt: 2 });
      event(ws, presented);
      event(ws, { _tag: "Asked", prompt: 3, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: null });
      expect(NotificationStub.calls).toHaveLength(2);
      expect(document.title).toBe(tabTitle("/p", { _tag: "Waiting" }));
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      NotificationStub.reset();
      visibility = "visible";
    }
  });
});
