// Issue #221: the live panel's terminal look, its state icons, its scrollback and its handle, mounted in jsdom.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import LiveOutput from "./components/LiveOutput.svelte";
import * as prompts from "../../src/prompts.ts";
import { type OutputEvent, type ProcessKey, type ProcessStatus, SCROLLBACK_LINES } from "../../src/liveOutput.ts";
import { applyOutput, EMPTY_PANEL, type LivePanel, PANEL_LINES, PROCESS_MARK } from "./livePanel.ts";
import { MIN_PANEL_LINES } from "./panelHeight.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});

const K = "claude:t1" as ProcessKey;
const fold = (events: readonly OutputEvent[]): LivePanel => events.reduce(applyOutput, EMPTY_PANEL);
const start = (name = "npm test"): OutputEvent => ({ _tag: "Started", key: K, name });
const print = (text: string, name = "npm test"): OutputEvent => ({ _tag: "Printed", key: K, name, text });
const end = (status: ProcessStatus, name = "npm test"): OutputEvent => ({ _tag: "Finished", key: K, name, status });

const mountPanel = (panel: LivePanel, extra: { resize?: boolean; compact?: boolean; lines?: number } = {}) => {
  const committed: number[] = [];
  const target = document.createElement("div");
  document.body.appendChild(target);
  const props = {
    panel,
    lines: extra.lines ?? PANEL_LINES,
    ...(extra.resize === true ? { resize: { available: null, onLines: (n: number) => void committed.push(n) } } : {}),
    ...(extra.compact === true ? { compact: true } : {}),
  };
  mounted.push(mount(LiveOutput, { target, props }));
  flushSync();
  return { target, committed };
};
const mark = (target: HTMLElement, label: string) => target.querySelector(`[role="img"][aria-label="${label}"]`);

describe("the live panel", () => {
  test("no text of the old note or headers appears", () => {
    const text = mountPanel(fold([start(), print("ok\n"), end({ _tag: "Exited", code: 0 })])).target.textContent ?? "";
    for (const old of ["Interloq does not write or check this text", "Still running", "No process is running"]) expect(text).not.toContain(old);
    expect(prompts).not.toHaveProperty("LIVE_OUTPUT_NOTE");
    expect(prompts).not.toHaveProperty("OUTPUT_FINISHED_HEADER");
    expect(prompts).not.toHaveProperty("outputRunningHeader");
  });

  test("a running process is an icon named in words", () => {
    const { target } = mountPanel(fold([start()]));
    const icon = target.querySelector(`[data-live-processes] [role="img"]`);
    expect(icon?.getAttribute("aria-label")).toBe(prompts.outputRunningName("npm test", null));
    expect(icon?.textContent).toBe(PROCESS_MARK.running);
  });

  test("each ending has its icon, named by the ended line, with its short detail", () => {
    const failed: ProcessStatus = { _tag: "Exited", code: 1 };
    const f = mountPanel(fold([start(), end(failed)])).target;
    const icon = [...f.querySelectorAll("[data-live-line]")].at(-1)?.querySelector(`[data-mark="failed"][aria-label="${prompts.outputEndedLine("npm test", failed)}"]`);
    expect(icon?.textContent).toBe(PROCESS_MARK.failed);
    expect(icon?.parentElement?.textContent).toContain("exit 1");
    expect(mark(mountPanel(fold([start(), end({ _tag: "Exited", code: 0 })])).target, prompts.outputEndedLine("npm test", { _tag: "Exited", code: 0 }))?.textContent).toBe(PROCESS_MARK.succeeded);
    expect(mark(mountPanel(fold([start(), end({ _tag: "Stopped" })])).target, prompts.outputEndedLine("npm test", { _tag: "Stopped" }))?.textContent).toBe(PROCESS_MARK.stopped);
  });

  test("a name of 300 characters is whole on its begun line and in the bounded running list; a line of 2,000 characters is whole", () => {
    const name = "n".repeat(300);
    const { target } = mountPanel(fold([start(name), print("z".repeat(2000) + "\n", name)]));
    const list = target.querySelector("[data-live-processes]");
    expect(list?.textContent).toContain(name);
    expect(list?.classList.contains("bounded")).toBe(true);
    const lines = [...target.querySelectorAll("[data-live-line]")].map((l) => l.textContent ?? "");
    expect(lines[0]).toContain(name);
    expect(lines[1]).toContain("z".repeat(2000));
  });

  test("a color is a colored span, and markup stays characters", () => {
    const { target } = mountPanel(fold([print("\u001b[31mred\u001b[0m <b>x</b>\n")]));
    const red = [...target.querySelectorAll("[data-live-line] span")].find((s) => s.textContent === "red") as HTMLElement | undefined;
    expect(red?.style.color).toBe("rgb(224, 85, 97)");
    expect(target.textContent).toContain("<b>x</b>");
    expect(target.querySelector("[data-live-output] b")).toBe(null);
  });

  test("the handle is a separator with its value, moved by the keys and by a drag committed on release", () => {
    const { target, committed } = mountPanel(fold([start()]), { resize: true });
    const handle = target.querySelector("[data-live-resize]") as HTMLElement;
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-label")).toBe(prompts.LIVE_OUTPUT_RESIZE_LABEL);
    expect(handle.getAttribute("aria-valuenow")).toBe("12");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(MIN_PANEL_LINES));
    expect(handle.getAttribute("aria-valuetext")).toBe(prompts.panelHeightText(12));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(committed).toEqual([13]);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(committed.at(-1)).toBe(Number(handle.getAttribute("aria-valuemax")));
    committed.length = 0;
    handle.setPointerCapture = vi.fn();
    const linePx = 18;
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientY: 500, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientY: 500 - 2 * linePx, pointerId: 1, bubbles: true }));
    flushSync();
    expect(handle.getAttribute("aria-valuenow")).toBe("14");
    expect((target.querySelector("[data-live-screen]") as HTMLElement).style.getPropertyValue("--shown")).toBe("14");
    expect(committed).toEqual([]);
    handle.dispatchEvent(new PointerEvent("pointerup", { clientY: 500 - 2 * linePx, pointerId: 1, bubbles: true }));
    expect(committed).toEqual([14]);
  });

  test("the compact form has no separator", () => {
    expect(mountPanel(fold([start()]), { compact: true, lines: 4 }).target.querySelector("[role=separator]")).toBe(null);
  });

  test("1,200 lines render the 1,000 the scrollback keeps", () => {
    const panel = Array.from({ length: 1200 }, (_, i) => print(`line ${i}\n`)).reduce(applyOutput, EMPTY_PANEL);
    expect(mountPanel(panel).target.querySelectorAll("[data-live-line]").length).toBe(SCROLLBACK_LINES);
  });
});

// The screen's own geometry decides whether it follows its end before each update, not a scroll event that may not have
// run yet (the race L36 met at 1280 × 800 under the suite's load). jsdom lays nothing out, so the screen is given its
// geometry here: 100 px shown of 1,000.
describe("the live panel following its end", () => {
  const geometry = (target: HTMLElement): { screen: HTMLElement; top: () => number; set: (n: number) => void } => {
    const screen = target.querySelector<HTMLElement>("[data-live-screen]");
    if (screen === null) throw new Error("no screen");
    let top = 0;
    Object.defineProperty(screen, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(screen, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(screen, "scrollTop", { configurable: true, get: () => top, set: (n: number) => void (top = n) });
    return { screen, top: () => top, set: (n) => void (top = n) };
  };
  const lines = (n: number): LivePanel => Array.from({ length: n }, (_, i) => print(`line ${i}\n`)).reduce(applyOutput, EMPTY_PANEL);
  const mountLive = (panel: LivePanel) => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({ panel, lines: PANEL_LINES });
    mounted.push(mount(LiveOutput, { target, props }));
    flushSync();
    return { target, props };
  };

  test("a screen scrolled up with no scroll event yet is not pinned to its end by new output (following its end)", () => {
    const { target, props } = mountLive(lines(50));
    const g = geometry(target);
    g.set(400);
    props.panel = lines(60);
    flushSync();
    expect(g.top()).not.toBe(1000);
  });

  test("a screen at its end with no scroll event yet stays at its end on new output (following its end)", () => {
    const { target, props } = mountLive(lines(50));
    const g = geometry(target);
    g.set(900);
    props.panel = lines(60);
    flushSync();
    expect(g.top()).toBe(1000);
  });

  test("a resize after a scroll up, with no new output, leaves the screen where it was (following its end)", () => {
    const callbacks: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      const { target } = mountLive(lines(50));
      const g = geometry(target);
      g.set(400);
      g.screen.dispatchEvent(new Event("scroll"));
      flushSync();
      for (const callback of callbacks) callback();
      expect(g.top()).toBe(400);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
