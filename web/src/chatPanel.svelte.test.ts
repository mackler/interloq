import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ChatPanel from "./components/ChatPanel.svelte";
import { phaseBandLabel } from "../../src/prompts.ts";
import type { Band, Message } from "./state.ts";
import { clockTime, fullTime } from "./time.ts";

// P3-R1-1: a panel hidden by the compact layout stays mounted; while hidden it ignores scroll events, and shown again
// it goes to its end if it was following. jsdom has no layout, so the list's geometry is stubbed.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const message = (i: number): Message => ({ key: `k${i}`, author: "codex", heading: null, body: `message ${i}`, format: "text", time: "2026-09-27T14:00:00.000Z", showTime: i === 0, band: null });
const panel = (visible: boolean) => {
  const props = $state({ title: "Claude Code and Codex", messages: [message(0)], empty: "none", visible });
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(ChatPanel, { target, props }));
  flushSync();
  const list = target.querySelector<HTMLElement>(".list")!;
  let top = 0;
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  return { props, target, list, top: () => top };
};
const scrolledUp = (list: HTMLElement) => {
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  flushSync();
};

describe("ChatPanel while hidden", () => {
  test("a shown panel scrolled up counts new messages on its chip", () => {
    const p = panel(true);
    scrolledUp(p.list);
    p.props.messages = [message(0), message(1), message(2)];
    flushSync();
    expect(p.target.textContent).toMatch(/2 new messages/);
  });

  test("a hidden panel ignores scroll events, so it keeps following; shown again, it goes to its end", async () => {
    const p = panel(false);
    scrolledUp(p.list);
    p.props.messages = [message(0), message(1), message(2)];
    flushSync();
    expect(p.target.textContent).not.toMatch(/new message/);
    p.props.visible = true;
    flushSync();
    await tick();
    await tick();
    expect(p.top()).toBe(1000);
  });
});

// Issue #15: a panel shows each phase as a band of its kind's tone, opened by a label with its name and start time.
describe("ChatPanel's phase bands", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 8, 27, 14, 0, s)).toISOString();
  const band = (kind: Band["kind"], n: number, s: number): Band => ({ key: `${kind}-${n}`, kind, name: `${kind === "planning" ? "Planning" : "Execution"} ${n}`, began: T(s) });
  const inBand = (i: number, b: Band | null): Message => ({ ...message(i), author: "codex", band: b });

  test("consecutive messages of a band are one band element with its label; messages before any phase are outside", () => {
    const [p1, e1, p2] = [band("planning", 1, 10), band("execution", 1, 20), band("planning", 2, 30)];
    const messages = [inBand(0, null), inBand(1, p1), inBand(2, p1), inBand(3, e1), inBand(4, p2)];
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ChatPanel, { target, props: { title: "You and Interloq", messages, empty: "none" } }));
    flushSync();
    const bands = [...target.querySelectorAll<HTMLElement>(".band")];
    expect(bands.map((b) => [...b.classList].find((c) => c.startsWith("band-")))).toEqual(["band-planning", "band-execution", "band-planning"]);
    expect(bands.map((b) => b.querySelectorAll("article").length)).toEqual([2, 1, 1]);
    for (const [b, expected] of bands.map((b, i) => [b, [p1, e1, p2][i]] as const)) {
      const labels = b.querySelectorAll<HTMLElement>(".phase-label");
      expect(labels.length).toBe(1);
      expect(labels[0].textContent?.trim()).toBe(phaseBandLabel(expected.name, clockTime(expected.began)));
      expect(labels[0].title).toBe(fullTime(expected.began));
    }
    expect(bands[0].querySelector(".phase-label")?.textContent?.trim()).toMatch(/^Planning 1 · \S/);
    const outside = [...target.querySelectorAll("article")].filter((a) => a.closest(".band") === null);
    expect(outside.map((a) => a.textContent?.includes("message 0"))).toEqual([true]);
  });
});
