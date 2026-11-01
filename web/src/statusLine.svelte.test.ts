import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import StatusLine from "./components/StatusLine.svelte";
import { END_WAIT_LABEL } from "../../src/prompts.ts";
import type { EndableWait, LimitWait } from "./state.ts";

// Issue #215: "Try again now" beside a wait's countdown, in the full and the compact status line, while it runs.
let mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = 1_000_000;
const retry: EndableWait = { fromMs: NOW, untilMs: NOW + 10_000, waitId: 4 };
const limit: LimitWait = { agent: "claude", purpose: "planning", limitType: "five_hour", basis: { kind: "reset" }, fromMs: NOW, untilMs: NOW + 60_000, waitId: 5 };
const status = { _tag: "Activity" as const, text: "waiting" };

const mountLine = (props: { retry?: EndableWait | null; wait?: LimitWait | null; compact?: boolean; sent?: boolean }) => {
  const ended: number[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(StatusLine, { target, props: { status, retry: props.retry ?? null, wait: props.wait ?? null, compact: props.compact ?? false, onEndWait: (w: number) => void ended.push(w), endWaitSent: () => props.sent ?? false } }));
  flushSync();
  const button = () => target.querySelector<HTMLButtonElement>('button[name="end-wait"]');
  return { target, button, ended };
};

describe("the control that ends a wait", () => {
  test("no control without a wait, nor for a retry without a countdown", () => {
    expect(mountLine({}).button()).toBe(null);
  });

  for (const compact of [false, true])
    test(`a usage-limit wait and a retry's countdown each show it in the ${compact ? "compact" : "full"} line`, () => {
      const l = mountLine({ wait: limit, compact });
      expect(l.button()?.textContent?.trim()).toBe(END_WAIT_LABEL);
      expect(mountLine({ retry, compact }).button()?.textContent?.trim()).toBe(END_WAIT_LABEL);
    });

  test("the control goes once the clock passes the wait's end", () => {
    const l = mountLine({ retry });
    expect(l.button()).not.toBe(null);
    vi.advanceTimersByTime(10_001);
    flushSync();
    expect(l.button()).toBe(null);
  });

  test("a click calls onEndWait with the wait's id; the limit wait wins over a retry", () => {
    const l = mountLine({ wait: limit, retry });
    l.button()!.click();
    expect(l.ended).toEqual([5]);
  });

  test("the control is disabled once a frame was sent for its wait", () => {
    expect(mountLine({ retry, sent: true }).button()!.disabled).toBe(true);
  });
});
