import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage, Stamped } from "../../src/protocol.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { type DraftKey, pendingKey, sameKey } from "./draft.ts";
import { combinedMark, type Decision, decide, type Mark, defaultPreferences, initialNotifyState, markOf, type NotifyState, type Observation, type Permission, type Preferences, type RunKey } from "./notify.ts";
import { initialState, reduce, shownRun, type ViewState } from "./state.ts";

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
  formShown: false,
  preferences: ON,
  permission: "granted",
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
  formShown: fc.boolean(),
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
    return { ...rest, run: runKey, pending: pending ? { ...runKey, prompt } : null };
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
          expect(markOf(d)).toEqual(d._tag === "Idle" ? { _tag: "Clear" } : d._tag === "Waiting" ? { _tag: "Waiting" } : { _tag: "Ended", code: d.code });
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
          if (o.visible) expect(d._tag).not.toBe("Ended");
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
const asked: RunEvent = { _tag: "Asked", prompt: 1, ...promptOf(prompts.decisionPrompt) };
const hello: ServerMessage = { type: "hello", location: "/p", current: { refinement: null, implementation: 1 }, incarnation: "a" };
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

  test("a watched run's end at a hidden tab is Ended until seen, the form shown, or another run", () => {
    const ended = foldDecisions([observation({}), observation({ ended: 0 })]);
    expect(last(ended)).toMatchObject({ _tag: "Ended", key: RUN, code: 0, raise: "desktopAndSound" });
    expect(markOf(last(ended))).toEqual({ _tag: "Ended", code: 0 });
    const state = last(ended).state;
    expect(decide(state, observation({ ended: 0 }))).toMatchObject({ _tag: "Ended", raise: null });
    expect(decide(state, observation({ ended: 0, visible: true }))._tag).toBe("Idle");
    expect(decide(state, observation({ ended: 0, formShown: true }))._tag).toBe("Idle");
    expect(decide(state, observation({ run: { incarnation: "a", run: 2 } }))._tag).toBe("Idle");
  });

  test("a page whose first observation is an ended run alerts nothing", () => {
    expect(decide(initialNotifyState, observation({ ended: 0 }))).toEqual({ _tag: "Idle", state: expect.anything() });
  });

  test("a run that ends at a visible tab is seen at once: Idle, and still Idle when the tab is hidden later", () => {
    const ds = foldDecisions([observation({ visible: true }), observation({ ended: 0, visible: true }), observation({ ended: 0, visible: false })]);
    expect(ds[1]!._tag).toBe("Idle");
    expect(ds[2]!._tag).toBe("Idle");
  });
});

// Issue #120, S17: the title and the icon show one mark for the two tabs' runs.
describe("combinedMark", () => {
  const markArb = fc.oneof(fc.constant<Mark>({ _tag: "Clear" }), fc.constant<Mark>({ _tag: "Waiting" }), fc.integer({ min: 0, max: 255 }).map((code): Mark => ({ _tag: "Ended", code })));
  test("Waiting exactly when some mark waits, Ended when none waits and some ended, Clear otherwise", () => {
    fc.assert(
      fc.property(fc.array(markArb, { maxLength: 4 }), (marks) => {
        const combined = combinedMark(marks);
        const waiting = marks.some((m) => m._tag === "Waiting");
        const ended = marks.find((m) => m._tag === "Ended");
        if (waiting) expect(combined).toBe(marks.find((m) => m._tag === "Waiting"));
        else if (ended !== undefined) expect(combined).toBe(ended);
        else expect(combined).toEqual({ _tag: "Clear" });
      }),
    );
  });
  test("examples: waiting over ended, ended over clear, an empty list clear", () => {
    expect(combinedMark([{ _tag: "Ended", code: 0 }, { _tag: "Waiting" }])).toEqual({ _tag: "Waiting" });
    expect(combinedMark([{ _tag: "Clear" }, { _tag: "Ended", code: 130 }])).toEqual({ _tag: "Ended", code: 130 });
    expect(combinedMark([{ _tag: "Clear" }, { _tag: "Clear" }])).toEqual({ _tag: "Clear" });
    expect(combinedMark([])).toEqual({ _tag: "Clear" });
  });
});
