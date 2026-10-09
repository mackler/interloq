// Issue #16: whether the page alerts the user that a run waits for him, or that a run he watched has ended (pure).
// The page observes the pending prompt by its full key (incarnation, run, prompt), so that a reconnecting tab, whose
// replay the reducer folds into the same pending key, alerts nothing again. The decision is one tagged union whose
// variant is at once the reason and what the title marker and the favicon badge show; the interrupt to fire now (a
// desktop notification, a sound) exists only inside the variant of its reason. Firing it is an edge (web/src/alerts.ts).

import { type DraftKey, sameKey } from "./draft.ts";

/** A run of one start of the server (run ids restart with each incarnation). */
export type RunKey = Readonly<{ incarnation: string; run: number }>;
export type Toggle = "on" | "off";
/** The viewer's choices, remembered by web/src/storage.ts: both opt-in, both off until turned on. */
export type Preferences = Readonly<{ desktop: Toggle; sound: Toggle }>;
export const defaultPreferences: Preferences = { desktop: "off", sound: "off" };
/** The browser's answer for desktop notifications, not a preference; `unsupported` where there is no Notification API. */
export type Permission = "default" | "granted" | "denied" | "unsupported";

/**
 * What the page observes: the pending prompt's key, the shown run and its exit code (null while it runs), whether the
 * document is visible, whether the prompt is on screen (not the conversation chosen instead), and whether the form for
 * a new task is shown.
 */
export type Observation = Readonly<{
  pending: DraftKey | null;
  run: RunKey | null;
  ended: number | null;
  visible: boolean;
  promptShown: boolean;
  formShown: boolean;
  preferences: Preferences;
  permission: Permission;
}>;

/**
 * The prompt last alerted, the run whose end was last alerted or seen, the run last observed in progress, and the run
 * whose end mark is still shown.
 */
export type NotifyState = Readonly<{ prompt: DraftKey | null; ended: RunKey | null; running: RunKey | null; endMark: RunKey | null }>;
export const initialNotifyState: NotifyState = { prompt: null, ended: null, running: null, endMark: null };

/** What fires once when a reason is first alerted. */
export type Interrupt = "none" | "desktop" | "sound" | "desktopAndSound";

/** The decision: the reason, which the mark shows, and the interrupt to fire now (null when alerted before). */
export type Decision =
  | Readonly<{ _tag: "Idle"; state: NotifyState }>
  | Readonly<{ _tag: "Waiting"; state: NotifyState; key: DraftKey; raise: Interrupt | null }>
  | Readonly<{ _tag: "Ended"; state: NotifyState; key: RunKey; code: number; raise: Interrupt | null }>;

/** What the title marker and the favicon badge show, derived from a decision and never stored. */
export type Mark = Readonly<{ _tag: "Clear" }> | Readonly<{ _tag: "Waiting" }> | Readonly<{ _tag: "Ended"; code: number }>;

export const markOf = (decision: Decision): Mark =>
  decision._tag === "Idle" ? { _tag: "Clear" } : decision._tag === "Waiting" ? { _tag: "Waiting" } : { _tag: "Ended", code: decision.code };

/** The mark of several runs' decisions (issue #120, S17): a waiting one if any, else an ended one if any, else Clear. */
export const combinedMark = (marks: readonly Mark[]): Mark =>
  marks.find((m) => m._tag === "Waiting") ?? marks.find((m) => m._tag === "Ended") ?? { _tag: "Clear" };

const sameRun = (a: RunKey | null, b: RunKey | null): boolean => a !== null && b !== null && a.incarnation === b.incarnation && a.run === b.run;

/** The interrupt of a reason first alerted: none at a tab where the user sees it, otherwise what he chose and may have. */
const interruptOf = (seen: boolean, observed: Observation): Interrupt => {
  if (seen) return "none";
  const desktop = observed.preferences.desktop === "on" && observed.permission === "granted";
  const sound = observed.preferences.sound === "on";
  return desktop && sound ? "desktopAndSound" : desktop ? "desktop" : sound ? "sound" : "none";
};

/**
 * The decision for one observation. A pending prompt is a state: `Waiting` while it is pending, raised once per key,
 * whatever the visibility (only the interrupt is suppressed at a tab showing it). The end of a run this page watched
 * in progress is raised once: seen at once at a visible tab (`Idle`), otherwise `Ended` until the tab is visible, the
 * form for a new task is shown, or another run is shown. A pending prompt takes precedence over an end.
 */
export const decide = (state: NotifyState, observed: Observation): Decision => {
  const run = observed.run;
  const running = run !== null && observed.ended === null ? run : state.running;
  const endsNow = run !== null && observed.ended !== null && sameRun(state.running, run) && !sameRun(state.ended, run);
  const raisedEnd = endsNow && !observed.visible;
  const marked = raisedEnd ? run : state.endMark;
  const endMark = marked !== null && !observed.visible && !observed.formShown && sameRun(marked, run) ? marked : null;
  const next: NotifyState = { prompt: state.prompt, ended: endsNow ? run : state.ended, running, endMark };
  if (observed.pending !== null) {
    const fresh = state.prompt === null || !sameKey(state.prompt, observed.pending);
    const raise = fresh ? interruptOf(observed.visible && observed.promptShown, observed) : null;
    return { _tag: "Waiting", state: { ...next, prompt: observed.pending }, key: observed.pending, raise };
  }
  if (endMark !== null && observed.ended !== null) return { _tag: "Ended", state: next, key: endMark, code: observed.ended, raise: raisedEnd ? interruptOf(false, observed) : null };
  return { _tag: "Idle", state: next };
};
