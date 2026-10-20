// Issue #147 (S13): the chain's control: the frames it sends and what it shows.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { type ChainState, cutoffOf, DEFAULT_SETTINGS, initialState, OFF_SETTINGS } from "../../src/chain.ts";
import { Result } from "effect";
import type { ChainFrameSettings } from "../../src/protocol.ts";
import ChainControl from "./components/ChainControl.svelte";
import { chainShown, initialState as initialView } from "./state.ts";
import { chainFrame } from "./tabs.ts";
import { fullTime } from "./time.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const control = (state: ChainState, now = new Date(2026, 9, 20, 22, 0)) => {
  const sent: ChainFrameSettings[] = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  const shown = chainShown({ ...initialView, chain: state }, (iso) => fullTime(iso))!;
  mounted.push(mount(ChainControl, { target: root, props: { shown, onChange: (s: ChainFrameSettings) => void sent.push(s), now: () => now } }));
  flushSync();
  return { root, sent };
};
const input = (root: HTMLElement, name: string) => root.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
const commit = (field: HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
};

describe("ChainControl", () => {
  test("the switch sends the frame with enabled false and the fields' values; an empty form turns on", () => {
    const { root, sent } = control(initialState(DEFAULT_SETTINGS));
    expect(input(root, "chain").checked).toBe(true);
    input(root, "chain").click();
    flushSync();
    expect(chainFrame(sent.at(-1)!)).toEqual({ type: "chain", settings: { enabled: false, runs: null, cutoff: null } });
    unmount(mounted.pop()!);
    const off = control(initialState(OFF_SETTINGS));
    input(off.root, "chain").click();
    flushSync();
    expect(off.sent.at(-1)).toEqual({ enabled: true, runs: null, cutoff: null });
  });

  test("a typed hour sends the instant it resolves to now, and the resolved moment shows under the field", () => {
    const { root, sent } = control(initialState(DEFAULT_SETTINGS));
    commit(input(root, "chain-cutoff"), "07:00");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: null, cutoff: new Date(2026, 9, 21, 7, 0).toISOString() });
    unmount(mounted.pop()!);
    const cutoff = Result.getOrThrow(cutoffOf(new Date(2026, 9, 21, 7, 0).toISOString()));
    const set = control({ ...initialState(DEFAULT_SETTINGS), settings: { enabled: true, limits: { runs: null, cutoff } } });
    expect(set.root.textContent).toContain(prompts.chainCutoffResolved(fullTime(new Date(cutoff).toISOString())));
  });

  test("a number of runs is sent; one that is not a positive whole number sends nothing and shows the error", () => {
    const { root, sent } = control(initialState(DEFAULT_SETTINGS));
    commit(input(root, "chain-runs"), "3");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: 3, cutoff: null });
    const before = sent.length;
    for (const bad of ["0", "-1", "2.5", "two"]) commit(input(root, "chain-runs"), bad);
    expect(sent.length).toBe(before);
    expect(root.textContent).toContain(prompts.CHAIN_INVALID_RUNS);
  });

  test("each reason a chain ended shows its text", () => {
    const state: ChainState = { ...initialState(DEFAULT_SETTINGS), chain: { _tag: "Idle", ended: { _tag: "NoItems" }, history: [] } };
    const { root } = control(state);
    expect(root.textContent).toContain(prompts.chainEndedText({ _tag: "NoItems" }, (iso) => iso));
    expect(root.textContent).not.toMatch(/\$|cost/i);
  });
});
