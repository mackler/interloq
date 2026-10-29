// Issue #147 (S13): the chain's control: the frames it sends and what it shows.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { type ChainState, cutoffOf, DEFAULT_SETTINGS, initialState, OFF_SETTINGS } from "../../src/chain.ts";
import { Result } from "effect";
import { chainSettingsOf, type ChainFrameSettings } from "../../src/protocol.ts";
import ChainControl from "./components/ChainControl.svelte";
import { chainSent, chainShown, chainUnsent, initialState as initialView, reduce, type ViewState } from "./state.ts";
import { helloChain } from "./testChain.ts";
import type { ServerMessage } from "../../src/protocol.ts";
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

// Issue #192 (S11): a chain entry whose item was returned to refined, or could not be, says so.
describe("ChainControl's returned items", () => {
  const halted = (returned: NonNullable<ChainState["chain"]["history"][number]["returned"]>) => ({
    ...initialState(DEFAULT_SETTINGS),
    chain: { _tag: "Idle" as const, ended: null, history: [{ item: "7" as never, title: "seven", root: null, outcome: { _tag: "Halted" as const, park: { _tag: "ParkFailed" as const, message: "m" } }, returned }] },
  });
  test("an entry returned shows itemReturnedLine; one not returned shows itemNotReturnedLine with its cause", () => {
    expect(control(halted({ _tag: "Returned" })).root.textContent).toContain(prompts.itemReturnedLine("7"));
    expect(control(halted({ _tag: "NotReturned", cause: "the tracker could not be reached" })).root.textContent).toContain(prompts.itemNotReturnedLine("7", "the tracker could not be reached", null));
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
    const settings = Result.getOrThrow(chainSettingsOf({ enabled: true, runs: 4, cutoff: null }));
    replace(chainShown({ ...initialView, chain: { ...initialState(DEFAULT_SETTINGS), settings } }, (iso) => fullTime(iso))!);
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

// Work review 3 of issue #147, W3-R1-1, and the work review of 21 Oct 2026, W1-R1-1 (S30): two changes made before the
// server answers never undo each other, since each frame is composed from the frames not yet acknowledged, which the
// page's ViewState holds, so they survive the control's remount, a frame handed back and a server restart.
describe("ChainControl's consecutive changes", () => {
  const NOW = new Date(2026, 9, 20, 22, 0);
  const CUTOFF = new Date(2026, 9, 21, 7, 0).toISOString();
  const helloOf = (incarnation: string): ServerMessage => ({ type: "hello", chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation });
  const shownOf = (view: ViewState) => chainShown(view, (iso) => fullTime(iso))!;
  // A harness of the page: its view, the control's props derived from it, and each frame recorded as App records it.
  const live = () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sent: ChainFrameSettings[] = [];
    let view = reduce(initialView, helloOf("a"));
    const props = $state({ shown: shownOf(view), onChange: (s: ChainFrameSettings) => {
      sent.push(s);
      apply(chainSent(view, s, false));
    }, now: () => NOW });
    function apply(next: ViewState) {
      view = next;
      props.shown = shownOf(next);
    }
    const settle = (next: ViewState) => {
      apply(next);
      flushSync();
    };
    mounted.push(mount(ChainControl, { target: root, props }));
    flushSync();
    // The server's broadcast of the given settings, through the reducer.
    const serverHas = (frame: ChainFrameSettings) => settle(reduce(view, { type: "chain", state: { ...view.chain!, settings: Result.getOrThrow(chainSettingsOf(frame)) } }));
    const click = () => {
      input(root, "chain").click();
      flushSync();
    };
    const remount = () => {
      unmount(mounted.pop()!);
      mounted.push(mount(ChainControl, { target: root, props }));
      flushSync();
    };
    return { root, sent, serverHas, click, remount, restart: (incarnation: string) => settle(reduce(view, helloOf(incarnation))), unsent: (frame: ChainFrameSettings) => settle(chainUnsent(view, frame)) };
  };
  const type = (field: HTMLInputElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  };

  test("(a) runs 3, then a cutoff: the second frame carries both", () => {
    const { root, sent } = live();
    commit(input(root, "chain-runs"), "3");
    commit(input(root, "chain-cutoff"), "07:00");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
  });

  test("(b) runs 3, then the switch: the frame carries enabled false and runs 3", () => {
    const { root, sent, click } = live();
    commit(input(root, "chain-runs"), "3");
    click();
    expect(sent.at(-1)).toEqual({ enabled: false, runs: 3, cutoff: null });
  });

  test("(c) the first of two changes acknowledged, then the switch: the frame carries all three, the hour kept", () => {
    const { root, sent, serverHas, click } = live();
    commit(input(root, "chain-runs"), "3");
    commit(input(root, "chain-cutoff"), "07:00");
    serverHas(sent[0]!);
    expect(input(root, "chain-cutoff").value).toBe("07:00");
    click();
    expect(sent.at(-1)).toEqual({ enabled: false, runs: 3, cutoff: CUTOFF });
    expect(input(root, "chain-cutoff").value).toBe("07:00");
  });

  test("(d) another tab's change replaces the drafts, and the next frame is composed from it", () => {
    const { root, sent, serverHas } = live();
    commit(input(root, "chain-runs"), "3");
    serverHas({ enabled: true, runs: 7, cutoff: null });
    expect(input(root, "chain-runs").value).toBe("7");
    commit(input(root, "chain-cutoff"), "07:00");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: 7, cutoff: CUTOFF });
  });

  test("(e) a run limit not yet acknowledged survives the control's remount, and the next frame carries it", () => {
    const { root, sent, remount } = live();
    commit(input(root, "chain-runs"), "3");
    remount();
    expect(input(root, "chain-runs").value).toBe("3");
    commit(input(root, "chain-cutoff"), "07:00");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
  });

  test("(f) a frame handed back resets its own field and keeps a draft in the other", () => {
    const { root, sent, unsent } = live();
    commit(input(root, "chain-runs"), "3");
    type(input(root, "chain-cutoff"), "07:00");
    unsent(sent[0]!);
    expect(input(root, "chain-runs").value).toBe("");
    expect(input(root, "chain-cutoff").value).toBe("07:00");
  });

  test("(g) a frame sent to a server that ended is dropped on the restart: its field reset, the other draft kept", () => {
    const { root, sent, restart } = live();
    commit(input(root, "chain-runs"), "3");
    type(input(root, "chain-cutoff"), "07:00");
    restart("b");
    expect(input(root, "chain-runs").value).toBe("");
    expect(input(root, "chain-cutoff").value).toBe("07:00");
    commit(input(root, "chain-cutoff"), "07:00");
    expect(sent.at(-1)).toEqual({ enabled: true, runs: null, cutoff: CUTOFF });
  });
});
