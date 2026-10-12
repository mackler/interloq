import { describe, expect, test } from "vitest";
import { analysisShown, initialLayout, observe, select } from "./layout.ts";

// Finding 7 of docs/gui-review.md, decision Q3: selectable panels at compact widths.
type Key = { incarnation: string; run: number; prompt: number };
const key = (prompt: number, run = 1, incarnation = "a"): Key => ({ incarnation, run, prompt });
const seen = (left: number, right: number, prompt: Key | null = null) => ({ counts: { left, right }, prompt });

describe("layout", () => {
  test("the left panel is selected at first", () => {
    expect(initialLayout.selected).toBe("left");
  });

  test("messages that arrive in the hidden panel are counted for its badge; the shown panel's are not", () => {
    const l = observe(observe(initialLayout, seen(2, 1), true), seen(3, 4), true);
    expect(l.unseen).toEqual({ left: 0, right: 4 });
  });

  test("selecting a panel shows it and clears its count", () => {
    const l = select(observe(initialLayout, seen(0, 5), true), "right");
    expect(l.selected).toBe("right");
    expect(l.unseen.right).toBe(0);
    const back = observe(l, seen(2, 5), true);
    expect(back.unseen).toEqual({ left: 2, right: 0 });
  });

  test("a new prompt selects the left panel, where it is answered", () => {
    const l = observe(select(initialLayout, "right"), seen(1, 0, key(4)), true);
    expect(l.selected).toBe("left");
    expect(observe(select(l, "right"), seen(1, 0, key(4)), true).selected).toBe("right");
  });

  test("at expanded width both panels show, so nothing is counted", () => {
    const l = observe(select(initialLayout, "right"), seen(3, 3, key(1)), false);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });

  test("a new run (fewer messages than before) starts the counts again", () => {
    const l = observe(observe(initialLayout, seen(10, 10), true), seen(1, 0), true);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });
});

// W2-R1-1: prompt numbers restart with each run and each start of the server, so a prompt is its full key.
describe("the prompt's identity", () => {
  test("prompt 1 of run 2, and prompt 1 of another incarnation, are new prompts that select the left panel", () => {
    const waiting = select(observe(initialLayout, seen(1, 1, key(1)), true), "right");
    expect(observe(waiting, seen(1, 1, key(1, 2)), true).selected).toBe("left");
    expect(observe(waiting, seen(1, 1, key(1, 1, "b")), true).selected).toBe("left");
    expect(observe(waiting, seen(1, 1, key(1)), true).selected).toBe("right");
  });
});

// W2-R1-3: the conversation shown instead of an analysis belongs to one decision of one run of one server start.
test("analysisShown: hidden only for the decision it was hidden for, not for the same number in another run or incarnation", () => {
  const k = (decision: number, run = 1, incarnation = "a") => ({ incarnation, run, decision });
  expect(analysisShown(null, k(1))).toBe(true);
  expect(analysisShown(k(1), k(1))).toBe(false);
  expect(analysisShown(k(1), k(2))).toBe(true);
  expect(analysisShown(k(1), k(1, 2))).toBe(true);
  expect(analysisShown(k(1), k(1, 1, "b"))).toBe(true);
});
