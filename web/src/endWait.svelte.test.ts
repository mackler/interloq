// Issue #215: the page sends one endWait frame per wait, whichever dashboard the control was pressed in. The compact
// dashboard's control under a question sends the frame, the full dashboard's control for the same wait is disabled and
// sends no second, and a second run's control sends a frame naming that run and its wait (W1-R1-2). The page is mounted
// whole over a fake WebSocket and fed the events the server sends, as in questionWait.svelte.test.ts.
import { PREPARATION_VIEW_OFF } from "../../src/preparationSwitch.ts";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { plainPieces } from "../../src/pieces.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { helloChain } from "./testChain.ts";

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

const TIME = "2026-11-01T20:00:00.000Z";
const startedOf = (id: string) => ({ _tag: "Started", project: "/p", location: "/p", task: "t", mode: "refinement", item: { id, title: "t" } });
const question = {
  number: 1,
  origin: { kind: "relayed" },
  context: { blocks: [{ kind: "paragraph", pieces: plainPieces("Some context.") }], by: "agent" },
  history: [],
  explanations: [],
  question: plainPieces("Which database?"),
  options: [{ label: plainPieces("SQLite"), description: [], answer: { token: "1" } }, { label: plainPieces("PostgreSQL"), description: [], answer: { token: "2" } }],
  attached: null,
  decision: null,
};
const waiting = (wait: number) => ({
  _tag: "Notified",
  event: { _tag: "UsageLimitWaiting", wait, agent: "claude", purpose: "interview", limitType: "five_hour", basis: { kind: "reset" }, fromMs: Date.now(), untilMs: Date.now() + 3_600_000 },
});
const endWaits = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "endWait");
const buttons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button[name="end-wait"]')];

describe("the control that ends a wait, through the page", () => {
  test("one frame per wait: the compact dashboard's press sends it, the full dashboard's sends no second, a second run's sends its own", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { default: App } = await import("./components/App.svelte");
    const root = document.createElement("div");
    document.body.appendChild(root);
    mounted.push(mount(App, { target: root, props: {} }));
    flushSync();
    const ws = FakeWebSocket.last!;
    ws.receive({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [1, 2], implementation: null }, incarnation: "a" });
    const asked = { _tag: "Asked", prompt: 1, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: null };
    const run1 = [startedOf("11"), { _tag: "Notified", event: { _tag: "QuestionPresented", question } }, asked, waiting(5)];
    const run2 = [startedOf("12")];
    const stamp = (events: readonly unknown[]) => events.map((event) => ({ time: TIME, event }));
    ws.receive({ type: "replay", ui: [], runs: [{ id: 1, events: stamp(run1) }, { id: 2, events: stamp(run2) }] });
    const seqs = new Map([[1, run1.length], [2, run2.length]]);
    const event = (run: number, e: unknown) => {
      const seq = seqs.get(run)!;
      seqs.set(run, seq + 1);
      ws.receive({ type: "event", run, seq, time: TIME, event: e });
    };
    const secondRow = () => root.querySelector<HTMLElement>(`nav[aria-label="${prompts.RUN_TABS_LABEL}"]`)!;
    const showRun = (id: number) => {
      secondRow().querySelector<HTMLInputElement>(`input[type=radio][value="run-${id}"]`)!.click();
      flushSync();
    };
    showRun(1);
    // Run 1's question is pending: the compact dashboard under it carries the control of wait 5.
    expect(root.querySelector("section.pane")).not.toBe(null);
    const compact = buttons(root.querySelector(".dashboard-compact")!);
    expect(compact).toHaveLength(1);
    compact[0]!.click();
    flushSync();
    expect(endWaits(ws)).toEqual([{ type: "endWait", incarnation: "a", run: 1, wait: 5 }]);
    // The question answered, the full dashboard shows the same wait: its control is disabled and sends nothing.
    event(1, { _tag: "Answered", prompt: 1, text: "1" });
    expect(root.querySelector("section.pane")).toBe(null);
    expect(root.querySelector(".dashboard-compact")).toBe(null);
    const full = buttons(root.querySelector(".left .chat")!);
    expect(full).toHaveLength(1);
    expect(full[0]!.disabled).toBe(true);
    full[0]!.click();
    flushSync();
    expect(endWaits(ws)).toHaveLength(1);
    // A second run's wait has its own id, and its control sends a frame naming that run and that wait.
    showRun(2);
    event(2, waiting(7));
    const second = buttons(root).filter((b) => !b.disabled);
    expect(second).toHaveLength(1);
    second[0]!.click();
    flushSync();
    expect(endWaits(ws)).toEqual([
      { type: "endWait", incarnation: "a", run: 1, wait: 5 },
      { type: "endWait", incarnation: "a", run: 2, wait: 7 },
    ]);
  });
});
