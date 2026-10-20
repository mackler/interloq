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

// Work review 1 of issue #147, W1-R1-4: a draft and its error survive an event that leaves the settings as they were.
describe("ChainControl's drafts", () => {
  const live = () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const props = $state({ shown: chainShown({ ...initialView, chain: initialState(DEFAULT_SETTINGS) }, (iso) => fullTime(iso))!, onChange: (_: ChainFrameSettings) => {}, now: () => new Date(2026, 9, 20, 22, 0) });
    mounted.push(mount(ChainControl, { target: root, props }));
    flushSync();
    const replace = (shown: typeof props.shown) => {
      props.shown = shown;
      flushSync();
    };
    return { root, props, replace };
  };

  test("an invalid number of runs and its error stay when an equal but new shown arrives", () => {
    const { root, props, replace } = live();
    commit(input(root, "chain-runs"), "abc");
    expect(root.textContent).toContain(prompts.CHAIN_INVALID_RUNS);
    replace({ ...props.shown, status: "another status" });
    expect(input(root, "chain-runs").value).toBe("abc");
    expect(root.textContent).toContain(prompts.CHAIN_INVALID_RUNS);
  });

  test("an hour typed and not committed stays when an equal but new shown arrives", () => {
    const { root, props, replace } = live();
    const field = input(root, "chain-cutoff");
    field.value = "07:00";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    replace({ ...props.shown, settings: { ...props.shown.settings, limits: { ...props.shown.settings.limits } }, status: "another status" });
    expect(input(root, "chain-cutoff").value).toBe("07:00");
  });

  test("a real change of the run limit replaces the draft and clears the error", () => {
    const { root, props, replace } = live();
    commit(input(root, "chain-runs"), "abc");
    const limits = { ...props.shown.settings.limits, runs: 4 as never };
    replace({ ...props.shown, settings: { ...props.shown.settings, limits } });
    expect(input(root, "chain-runs").value).toBe("4");
    expect(root.textContent).not.toContain(prompts.CHAIN_INVALID_RUNS);
  });
});

// Work review 2 of issue #147, W2-R1-2: an empty runs field is valid and means no limit, so committing it clears the
// error, even where the server's run limit stays null and nothing else would reset the field.
describe("ChainControl's empty runs field", () => {
  test("clearing an invalid number of runs clears its error and sends no limit", () => {
    const { root, sent } = control(initialState(DEFAULT_SETTINGS));
    commit(input(root, "chain-runs"), "abc");
    expect(root.textContent).toContain(prompts.CHAIN_INVALID_RUNS);
    expect(sent.length).toBe(0);
    commit(input(root, "chain-runs"), "");
    expect(root.textContent).not.toContain(prompts.CHAIN_INVALID_RUNS);
    expect(root.textContent).toContain(prompts.CHAIN_RUNS_SUPPORT);
    expect(root.querySelector(".support.error")).toBeNull();
    expect(sent.at(-1)).toEqual({ enabled: true, runs: null, cutoff: null });
  });
});
