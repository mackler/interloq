import { describe, expect, test } from "vitest";
import { analysisShown, initialLayout, observe, select } from "./layout.ts";

// Finding 7 of docs/gui-review.md, decision Q3: selectable panels at compact widths. Issue #22: the dashboard and the
// right panel; only the right panel has messages to count.
type Key = { incarnation: string; run: number; prompt: number };
const key = (prompt: number, run = 1, incarnation = "a"): Key => ({ incarnation, run, prompt });
const seen = (right: number, prompt: Key | null = null) => ({ right, prompt });

describe("layout", () => {
  test("the dashboard is selected at first", () => {
    expect(initialLayout.selected).toBe("dashboard");
  });

  test("messages that arrive in the hidden right panel are counted for its badge", () => {
    const l = observe(observe(initialLayout, seen(1), true), seen(4), true);
    expect(l.unseen).toBe(4);
  });

  test("selecting the right panel shows it and clears its count; while shown, nothing is counted", () => {
    const l = select(observe(initialLayout, seen(5), true), "right");
    expect(l.selected).toBe("right");
    expect(l.unseen).toBe(0);
    expect(observe(l, seen(7), true).unseen).toBe(0);
    expect(observe(select(l, "dashboard"), seen(7), true).unseen).toBe(2);
  });

  test("a new prompt selects the dashboard, where it is answered", () => {
    const l = observe(select(initialLayout, "right"), seen(0, key(4)), true);
    expect(l.selected).toBe("dashboard");
    expect(observe(select(l, "right"), seen(0, key(4)), true).selected).toBe("right");
  });

  test("at expanded width both panels show, so nothing is counted", () => {
    const l = observe(initialLayout, seen(3, key(1)), false);
    expect(l.unseen).toBe(0);
  });

  test("a new run (fewer right messages than before) starts the count again", () => {
    const l = observe(observe(initialLayout, seen(10), true), seen(1), true);
    expect(l.unseen).toBe(0);
  });
});

// W2-R1-1: prompt numbers restart with each run and each start of the server, so a prompt is its full key.
describe("the prompt's identity", () => {
  test("prompt 1 of run 2, and prompt 1 of another incarnation, are new prompts that select the dashboard", () => {
    const waiting = select(observe(initialLayout, seen(1, key(1)), true), "right");
    expect(observe(waiting, seen(1, key(1, 2)), true).selected).toBe("dashboard");
    expect(observe(waiting, seen(1, key(1, 1, "b")), true).selected).toBe("dashboard");
    expect(observe(waiting, seen(1, key(1)), true).selected).toBe("right");
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
