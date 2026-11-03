import { PREPARATION_VIEW_OFF } from "../../src/preparationSwitch.ts";
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage, Stamped } from "../../src/protocol.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { type DraftKey, pendingKey, sameKey } from "./draft.ts";
import { unseenEnds, combinedMark, type Decision, decide, type Mark, defaultPreferences, initialNotifyState, markOf, type NotifyState, type Observation, type Permission, type Preferences, type RunKey, type LimitPause, markRank, markGlyph, markedTabName, markStateText, marksByMode } from "./notify.ts";
import { initialState, reduce, shownRun, type ViewState } from "./state.ts";
import { helloChain } from "./testChain.ts";

// Issue #16: the decision whether to alert the user that a run waits for him, or that a run he watched has ended.

const KEY: DraftKey = { incarnation: "a", run: 1, prompt: 1 };
const RUN: RunKey = { incarnation: "a", run: 1 };
const ON: Preferences = { desktop: "on", sound: "on" };
const observation = (o: Partial<Observation>): Observation => ({
  pending: null,
  run: RUN,
  ended: null,
  visible: false,
  promptShown: true,
  onScreen: true,
  preferences: ON,
  permission: "granted",
  limit: null,
  ...o,
});
const foldDecisions = (observations: readonly Observation[], from: NotifyState = initialNotifyState): Decision[] =>
  observations.reduce<{ state: NotifyState; out: Decision[] }>(
    (acc, o) => {
      const d = decide(acc.state, o);
      return { state: d.state, out: [...acc.out, d] };
    },
    { state: from, out: [] },
  ).out;
const last = (ds: readonly Decision[]): Decision => ds[ds.length - 1]!;
const raiseOf = (d: Decision): string | null => (d._tag === "Idle" ? null : d.raise);

// The observations as the page can see them: keys in order (a run's prompt numbers never decrease, a run is followed
// by later runs, an incarnation by later ones), since the reducer folds a replay into one view.
const step = fc.record({
  bump: fc.constantFrom(0, 0, 1, 1, 2, 3),
  pending: fc.boolean(),
  ended: fc.option(fc.constantFrom(0, 1, 130), { nil: null }),
  visible: fc.boolean(),
  promptShown: fc.boolean(),
  onScreen: fc.boolean(),
  preferences: fc.record({ desktop: fc.constantFrom("on" as const, "off" as const), sound: fc.constantFrom("on" as const, "off" as const) }),
  permission: fc.constantFrom<Permission>("default", "granted", "denied", "unsupported"),
});
const observations = fc.array(step, { maxLength: 30 }).map((steps) => {
  let [incarnation, run, prompt] = [0, 1, 1];
  return steps.map(({ bump, pending, ...rest }): Observation => {
    if (bump === 1) prompt += 1;
    if (bump === 2) [run, prompt] = [run + 1, 1];
    if (bump === 3) [incarnation, run, prompt] = [incarnation + 1, 1, 1];
    const runKey = { incarnation: `i${incarnation}`, run };
    return { ...rest, run: runKey, pending: pending ? { ...runKey, prompt } : null, limit: null };
  });
});
const NUM_RUNS = 200;

describe("decide: properties", () => {
  test("at most once per key: no prompt and no run's end raises twice", () => {
    fc.assert(
      fc.property(observations, (os) => {
        const ds = foldDecisions(os);
        const waiting = ds.flatMap((d) => (d._tag === "Waiting" && d.raise !== null ? [JSON.stringify(d.key)] : []));
        const ended = ds.flatMap((d) => (d._tag === "Ended" && d.raise !== null ? [JSON.stringify(d.key)] : []));
        expect(new Set(waiting).size).toBe(waiting.length);
        expect(new Set(ended).size).toBe(ended.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("every new key raises", () => {
    fc.assert(
      fc.property(observations, (os) => {
        let state = initialNotifyState;
        for (const o of os) {
          const d = decide(state, o);
          if (o.pending !== null && (state.prompt === null || !sameKey(state.prompt, o.pending))) {
            expect(d._tag).toBe("Waiting");
            if (d._tag === "Waiting") {
              expect(d.key).toEqual(o.pending);
              expect(d.raise).not.toBe(null);
            }
          }
          state = d.state;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("observing the last pending key and run again, any number of times, raises nothing", () => {
    const again = fc.array(fc.record({ visible: fc.boolean(), promptShown: fc.boolean(), preferences: fc.constant(ON), permission: fc.constantFrom<Permission>("default", "granted", "denied", "unsupported") }), { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(observations.filter((os) => os.length > 0), again, (os, changes) => {
        const ds = foldDecisions(os);
        const end = os[os.length - 1]!;
        const repeats = foldDecisions(changes.map((c) => ({ ...end, ...c })), last(ds).state);
        for (const d of repeats) expect(raiseOf(d)).toBe(null);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("the decision is Waiting exactly while a prompt is pending, and the mark agrees with the variant", () => {
    fc.assert(
      fc.property(observations, (os) => {
        foldDecisions(os).forEach((d, i) => {
          expect(d._tag === "Waiting").toBe(os[i]!.pending !== null);
          const idle = (a: typeof d & { _tag: "Idle" }): Mark => (a.activity._tag === "None" ? { _tag: "Clear" } : a.activity._tag === "Running" ? { _tag: "Running" } : { _tag: "LimitPaused", pause: a.activity.pause });
          expect(markOf(d)).toEqual(d._tag === "Idle" ? idle(d) : d._tag === "Waiting" ? { _tag: "Waiting" } : { _tag: "Ended", code: d.code });
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("nothing interrupts a tab the user sees", () => {
    fc.assert(
      fc.property(observations, (os) => {
        foldDecisions(os).forEach((d, i) => {
          const o = os[i]!;
          if (o.visible && o.promptShown && d._tag === "Waiting" && d.raise !== null) expect(d.raise).toBe("none");
          if (o.visible && o.onScreen) expect(d._tag).not.toBe("Ended");
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("a desktop notification only with the permission and the preference, a sound only with its preference", () => {
    fc.assert(
      fc.property(observations, (os) => {
        foldDecisions(os).forEach((d, i) => {
          const o = os[i]!;
          const raise = raiseOf(d);
          if (raise === "desktop" || raise === "desktopAndSound") expect(o.permission === "granted" && o.preferences.desktop === "on").toBe(true);
          if (raise === "sound" || raise === "desktopAndSound") expect(o.preferences.sound).toBe("on");
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const started: RunEvent = { _tag: "Started", project: "/p", location: "/p", task: "t", mode: "implementation", item: { id: "1", title: "t" } };
const TIME = "2026-10-08T10:00:00.000Z";
const stamp = (events: readonly RunEvent[]): Stamped[] => events.map((event) => ({ time: TIME, event }));
const asked: RunEvent = { _tag: "Asked", prompt: 1, ...promptOf(prompts.decisionPrompt), countdown: null, deciding: null };
const hello: ServerMessage = { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: 1 }, incarnation: "a" };
const replay: ServerMessage = { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked]) }] };

describe("decide: examples", () => {
  test("a reconnection, whose replay the reducer folds into the same pending prompt, raises once", () => {
    const views = [hello, replay, hello, replay].reduce<ViewState[]>((vs, m) => [...vs, reduce(vs[vs.length - 1] ?? initialState, m)], []);
    const ds = foldDecisions(views.map((v) => observation({ pending: pendingKey(shownRun(v, "implementation")) })));
    expect(ds.filter((d) => d._tag === "Waiting" && d.raise !== null)).toHaveLength(1);
    expect(last(ds)._tag).toBe("Waiting");
  });

  test("a prompt at a visible tab showing it raises nothing that interrupts; showing the conversation it does", () => {
    const shown = decide(initialNotifyState, observation({ pending: KEY, visible: true, promptShown: true }));
    expect(shown).toMatchObject({ _tag: "Waiting", raise: "none" });
    expect(decide(initialNotifyState, observation({ pending: KEY, visible: true, promptShown: false }))).toMatchObject({ _tag: "Waiting", raise: "desktopAndSound" });
  });

  test("permission denied or unsupported with the preference on: still Waiting, no desktop notification", () => {
    for (const permission of ["denied", "unsupported"] as const) {
      const d = decide(initialNotifyState, observation({ pending: KEY, permission, preferences: { desktop: "on", sound: "off" } }));
      expect(d).toMatchObject({ _tag: "Waiting", raise: "none" });
      expect(markOf(d)).toEqual({ _tag: "Waiting" });
    }
  });

  test("the preferences: the sound alone, and neither", () => {
    expect(decide(initialNotifyState, observation({ pending: KEY, preferences: { desktop: "off", sound: "on" } }))).toMatchObject({ _tag: "Waiting", raise: "sound" });
    expect(decide(initialNotifyState, observation({ pending: KEY, preferences: defaultPreferences }))).toMatchObject({ _tag: "Waiting", raise: "none" });
  });

  test("a watched run's end at a hidden tab is Ended until seen on screen, or another run", () => {
    const ended = foldDecisions([observation({}), observation({ ended: 0 })]);
    expect(last(ended)).toMatchObject({ _tag: "Ended", key: RUN, code: 0, raise: "desktopAndSound" });
    expect(markOf(last(ended))).toEqual({ _tag: "Ended", code: 0 });
    const state = last(ended).state;
    expect(decide(state, observation({ ended: 0 }))).toMatchObject({ _tag: "Ended", raise: null });
    expect(decide(state, observation({ ended: 0, visible: true }))._tag).toBe("Idle");
    expect(decide(state, observation({ ended: 0, onScreen: false }))).toMatchObject({ _tag: "Ended", raise: null });
    expect(decide(state, observation({ run: { incarnation: "a", run: 2 } }))._tag).toBe("Idle");
  });

  test("a page whose first observation is an ended run alerts nothing", () => {
    expect(decide(initialNotifyState, observation({ ended: 0 }))).toEqual({ _tag: "Idle", state: expect.anything(), activity: { _tag: "None" } });
  });

  test("a run that ends on screen in a visible page is seen at once: Idle, and still Idle when hidden or left later", () => {
    const ds = foldDecisions([observation({ visible: true }), observation({ ended: 0, visible: true }), observation({ ended: 0, visible: false }), observation({ ended: 0, visible: true, onScreen: false })]);
    expect(ds.slice(1).map((d) => d._tag)).toEqual(["Idle", "Idle", "Idle"]);
    expect(ds.map(raiseOf)).toEqual([null, null, null, null]);
  });

  // Issue #209: an end is seen only when its run is on screen in a visible page.
  test("a run that ends off screen in a visible page raises once and is Ended until shown", () => {
    const ds = foldDecisions([
      observation({ visible: true, onScreen: false }),
      observation({ ended: 130, visible: true, onScreen: false }),
      observation({ ended: 130, visible: true, onScreen: false }),
      observation({ ended: 130, visible: false, onScreen: true }),
      observation({ ended: 130, visible: true, onScreen: true }),
      observation({ ended: 130, visible: true, onScreen: false }),
    ]);
    expect(ds[1]).toMatchObject({ _tag: "Ended", key: RUN, code: 130, raise: "desktopAndSound" });
    expect(markOf(ds[1]!)).toEqual({ _tag: "Ended", code: 130 });
    expect(ds[2]).toMatchObject({ _tag: "Ended", raise: null });
    expect(ds[3]).toMatchObject({ _tag: "Ended", raise: null });
    expect(ds[4]!._tag).toBe("Idle");
    expect(ds[5]!._tag).toBe("Idle");
  });

  test("an end's code is carried, halted and abandoned alike", () => {
    for (const code of [1, 2]) {
      const ds = foldDecisions([observation({ onScreen: false, visible: true }), observation({ ended: code, onScreen: false, visible: true })]);
      expect(last(ds)).toMatchObject({ _tag: "Ended", code });
    }
  });

  test("property: an end raises once exactly when its first ended observation is not on screen in a visible page, and is Ended until it is", () => {
    const seenArb = fc.array(fc.record({ visible: fc.boolean(), onScreen: fc.boolean() }), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(fc.constantFrom(0, 1, 2, 130), seenArb, (code, views) => {
        const ds = foldDecisions([observation({}), ...views.map((v) => observation({ ...v, ended: code }))]).slice(1);
        const seen = (v: { visible: boolean; onScreen: boolean }) => v.visible && v.onScreen;
        const raised = ds.filter((d) => raiseOf(d) !== null);
        expect(raised.length).toBe(seen(views[0]!) ? 0 : 1);
        if (!seen(views[0]!)) expect(raiseOf(ds[0]!)).not.toBe(null);
        const firstSeen = views.findIndex(seen);
        ds.forEach((d, i) => expect(d._tag).toBe(firstSeen === -1 || i < firstSeen ? "Ended" : "Idle"));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("unseenEnds", () => {
  test("the end-marked runs of the given incarnation alone", () => {
    const states: NotifyState[] = [
      { ...initialNotifyState, endMark: { incarnation: "a", run: 1 } },
      { ...initialNotifyState, endMark: { incarnation: "b", run: 2 } },
      { ...initialNotifyState, endMark: { incarnation: "a", run: 3 } },
      initialNotifyState,
    ];
    expect([...unseenEnds(states, "a")].sort()).toEqual([1, 3]);
    expect(unseenEnds(states, null).size).toBe(0);
  });
});

// Issue #120, S17, and issue #139: the title, the icon and each tab show one mark of several runs, by one precedence.
const PAUSE: LimitPause = { fromMs: 0, untilMs: 3_600_000, known: true };
const markArb = fc.oneof(
  fc.constant<Mark>({ _tag: "Clear" }),
  fc.constant<Mark>({ _tag: "Running" }),
  fc.record({ fromMs: fc.nat(), untilMs: fc.nat(), known: fc.boolean() }).map((pause): Mark => ({ _tag: "LimitPaused", pause })),
  fc.constant<Mark>({ _tag: "Waiting" }),
  fc.integer({ min: 0, max: 255 }).map((code): Mark => ({ _tag: "Ended", code })),
);
describe("combinedMark", () => {
  test("property: an element of maximal rank, the first such, Clear for none", () => {
    fc.assert(
      fc.property(fc.array(markArb, { maxLength: 5 }), (marks) => {
        const combined = combinedMark(marks);
        if (marks.length === 0) expect(combined).toEqual({ _tag: "Clear" });
        else expect(combined).toBe(marks.find((m) => markRank(m) === Math.max(...marks.map(markRank))));
      }),
    );
  });
  test("property: its rank does not depend on the order of its input", () => {
    fc.assert(fc.property(fc.array(markArb, { maxLength: 5 }), (marks) => {
      expect(markRank(combinedMark([...marks].reverse()))).toBe(markRank(combinedMark(marks)));
    }));
  });
  test("examples: the precedence, pair by pair", () => {
    const clear: Mark = { _tag: "Clear" };
    const running: Mark = { _tag: "Running" };
    const paused: Mark = { _tag: "LimitPaused", pause: PAUSE };
    const finished: Mark = { _tag: "Ended", code: 0 };
    const halted: Mark = { _tag: "Ended", code: 1 };
    const waiting: Mark = { _tag: "Waiting" };
    expect(combinedMark([clear, running])).toBe(running);
    expect(combinedMark([running, paused])).toBe(paused);
    expect(combinedMark([paused, finished])).toBe(finished);
    expect(combinedMark([finished, halted])).toBe(halted);
    expect(combinedMark([halted, waiting])).toBe(waiting);
    expect(combinedMark([{ _tag: "Ended", code: 130 }, finished])).toEqual({ _tag: "Ended", code: 130 });
    expect(combinedMark([])).toEqual(clear);
  });
});

describe("decide: the activity of a run in progress (issue #139)", () => {
  test("a run in progress is Running, with a limit LimitPaused, none for no run or an ended one", () => {
    expect(decide(initialNotifyState, observation({}))).toMatchObject({ _tag: "Idle", activity: { _tag: "Running" } });
    expect(decide(initialNotifyState, observation({ limit: PAUSE }))).toMatchObject({ _tag: "Idle", activity: { _tag: "LimitPaused", pause: PAUSE } });
    expect(decide(initialNotifyState, observation({ run: null }))).toMatchObject({ _tag: "Idle", activity: { _tag: "None" } });
    expect(markOf(decide(initialNotifyState, observation({})))).toEqual({ _tag: "Running" });
    expect(markOf(decide(initialNotifyState, observation({ limit: PAUSE })))).toEqual({ _tag: "LimitPaused", pause: PAUSE });
  });
  test("waiting wins over a pending limit; an end wins over activity; a seen end is none", () => {
    expect(decide(initialNotifyState, observation({ pending: KEY, limit: PAUSE }))._tag).toBe("Waiting");
    const ended = foldDecisions([observation({}), observation({ ended: 1 })]);
    expect(last(ended)._tag).toBe("Ended");
    const seen = decide(last(ended).state, observation({ ended: 1, visible: true }));
    expect(seen).toMatchObject({ _tag: "Idle", activity: { _tag: "None" } });
    expect(markOf(seen)).toEqual({ _tag: "Clear" });
  });
});

describe("the glyphs and words of the marks (issue #139)", () => {
  const all: Mark[] = [{ _tag: "Running" }, { _tag: "LimitPaused", pause: PAUSE }, { _tag: "Waiting" }, { _tag: "Ended", code: 0 }, { _tag: "Ended", code: 1 }];
  test("five distinct glyphs, none for Clear", () => {
    expect(markGlyph({ _tag: "Clear" })).toBe(null);
    expect(new Set(all.map(markGlyph)).size).toBe(5);
    expect(markGlyph({ _tag: "Running" })).toBe(prompts.RUNNING_MARK);
    expect(markGlyph({ _tag: "LimitPaused", pause: PAUSE })).toBe(prompts.LIMIT_PAUSED_MARK);
  });
  test("markedTabName agrees with the second row's names, and carries the pause's end", () => {
    expect(markedTabName("Tab", { _tag: "Clear" })).toBe("Tab");
    expect(markedTabName("Tab", { _tag: "Waiting" })).toBe(prompts.waitingTabName("Tab"));
    for (const code of [0, 1, 2, 130]) expect(markedTabName("Tab", { _tag: "Ended", code })).toBe(prompts.endedTabName("Tab", code));
    expect(markedTabName("Tab", { _tag: "Running" })).toBe(`${prompts.RUNNING_MARK} Tab`);
    expect(markedTabName("Tab", { _tag: "LimitPaused", pause: PAUSE })).toBe(`${prompts.LIMIT_PAUSED_MARK} Tab ${prompts.limitPauseText(0, 3_600_000, true)}`);
  });
  test("markStateText: words for every mark but Clear", () => {
    expect(markStateText({ _tag: "Clear" })).toBe(null);
    expect(markStateText({ _tag: "Running" })).toBe(prompts.RUN_WORKING_TEXT);
    expect(markStateText({ _tag: "Waiting" })).toBe(prompts.RUN_WAITING_TEXT);
    expect(markStateText({ _tag: "Ended", code: 1 })).toBe(prompts.runEndedText(1));
    expect(markStateText({ _tag: "LimitPaused", pause: PAUSE })).toBe(prompts.runLimitPausedText(prompts.limitPauseText(0, 3_600_000, true)));
  });
  test("marksByMode: each mode's combined mark", () => {
    const byMode = marksByMode([
      { mode: "refinement", mark: { _tag: "Running" } },
      { mode: "refinement", mark: { _tag: "Waiting" } },
      { mode: "implementation", mark: { _tag: "LimitPaused", pause: PAUSE } },
    ]);
    expect(byMode).toEqual({ refinement: { _tag: "Waiting" }, implementation: { _tag: "LimitPaused", pause: PAUSE } });
    expect(marksByMode([])).toEqual({ refinement: { _tag: "Clear" }, implementation: { _tag: "Clear" } });
  });
});
