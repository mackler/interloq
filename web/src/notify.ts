// Issue #16: whether the page alerts the user that a run waits for him, or that a run he watched has ended (pure).
// The page observes the pending prompt by its full key (incarnation, run, prompt), so that a reconnecting tab, whose
// replay the reducer folds into the same pending key, alerts nothing again. The decision is one tagged union whose
// variant is at once the reason and what the title marker and the favicon badge show; the interrupt to fire now (a
// desktop notification, a sound) exists only inside the variant of its reason. Firing it is an edge (web/src/alerts.ts).

import { type Ending, endingAlerts } from "../../src/ending.ts";
import { type DraftKey, sameKey } from "./draft.ts";
import { RUN_MODES, type RunMode } from "../../src/runMode.ts";
import {
  endedTabName,
  endingMarkOf,
  LIMIT_PAUSED_MARK,
  limitPauseText,
  RUN_WAITING_TEXT,
  RUN_WORKING_TEXT,
  runEndedText,
  runLimitPausedText,
  RUNNING_MARK,
  TITLE_WAITING_MARK,
  waitingTabName,
} from "../../src/prompts.ts";

/** A run of one start of the server (run ids restart with each incarnation). */
export type RunKey = Readonly<{ incarnation: string; run: number }>;
export type Toggle = "on" | "off";
/** The viewer's choices, remembered by web/src/storage.ts: both opt-in, both off until turned on. */
export type Preferences = Readonly<{ desktop: Toggle; sound: Toggle }>;
export const defaultPreferences: Preferences = { desktop: "off", sound: "off" };
/** The browser's answer for desktop notifications, not a preference; `unsupported` where there is no Notification API. */
export type Permission = "default" | "granted" | "denied" | "unsupported";

/**
 * What the page observes: the pending prompt's key, the shown run and its ending (null while it runs; issue #44), whether the
 * document is visible, whether the prompt is on screen (not the conversation chosen instead), and (issue #209) whether
 * the run is the one the selected primary tab's second row shows, whatever the document's visibility.
 */
export type Observation = Readonly<{
  pending: DraftKey | null;
  /** Issue #139: the shown run's usage-limit wait while it runs, null otherwise. */
  limit: LimitPause | null;
  run: RunKey | null;
  ended: Ending | null;
  visible: boolean;
  promptShown: boolean;
  onScreen: boolean;
  preferences: Preferences;
  permission: Permission;
}>;

/**
 * The prompt last alerted, the run whose end was last alerted or seen, the run last observed in progress, and the run
 * whose end has not been seen since it ended (issue #209: not yet on screen in a visible page), whose mark is shown.
 */
export type NotifyState = Readonly<{ prompt: DraftKey | null; ended: RunKey | null; running: RunKey | null; endMark: RunKey | null }>;
export const initialNotifyState: NotifyState = { prompt: null, ended: null, running: null, endMark: null };

/** What fires once when a reason is first alerted. */
export type Interrupt = "none" | "desktop" | "sound" | "desktopAndSound";

/**
 * Issue #139: a usage-limit wait of a run in progress. `known` is true only where the reset was stated (the basis
 * `reset`), since otherwise `untilMs` is only the next try (issue #170) and no end may be claimed.
 */
export type LimitPause = Readonly<{ fromMs: number; untilMs: number; known: boolean }>;

/** Issue #139: what a run in progress is doing while nothing is needed from the user; reports, never alerts. */
export type Activity = Readonly<{ _tag: "None" }> | Readonly<{ _tag: "Running" }> | Readonly<{ _tag: "LimitPaused"; pause: LimitPause }>;

/** The decision: the reason, which the mark shows, and the interrupt to fire now (null when alerted before). */
export type Decision =
  | Readonly<{ _tag: "Idle"; state: NotifyState; activity: Activity }>
  | Readonly<{ _tag: "Waiting"; state: NotifyState; key: DraftKey; raise: Interrupt | null }>
  | Readonly<{ _tag: "Ended"; state: NotifyState; key: RunKey; ending: Ending; raise: Interrupt | null }>;

/**
 * What a run's tab, the title marker and the favicon badge show, derived from a decision and never stored (issue #139:
 * five states). Issue #44: an `Ended` mark carries the run's ending, whose own glyph it shows (`endingMarkOf`).
 */
export type Mark =
  | Readonly<{ _tag: "Clear" }>
  | Readonly<{ _tag: "Running" }>
  | Readonly<{ _tag: "LimitPaused"; pause: LimitPause }>
  | Readonly<{ _tag: "Waiting" }>
  | Readonly<{ _tag: "Ended"; ending: Ending }>;

const activityMark = (activity: Activity): Mark =>
  activity._tag === "None" ? { _tag: "Clear" } : activity._tag === "Running" ? { _tag: "Running" } : { _tag: "LimitPaused", pause: activity.pause };

export const markOf = (decision: Decision): Mark =>
  decision._tag === "Idle" ? activityMark(decision.activity) : decision._tag === "Waiting" ? { _tag: "Waiting" } : { _tag: "Ended", ending: decision.ending };

/**
 * Issue #139: the precedence of the marks when several runs share one tab, title or icon: Waiting 5 > halted (`Ended`
 * whose ending alerts) 4 > any other end 3 > `LimitPaused` 2 > `Running` 1 > `Clear` 0. Issue #44: an abandonment
 * alerts as a halt does, since no answer came and the user has to look; a send-back, an interruption and an end not
 * established rank with a completion, since none says that something went wrong which the user did not already know.
 * Waiting is first because it is the only state whose meaning expires: in a chain a question counts down and an
 * unanswered one abandons the run (issue #185), while a halt is final and its mark stays until the run is seen (issue
 * #209), so being outranked delays it and loses nothing; it also keeps issue #16's order. Halted outranks every report
 * because it says something went wrong and the user has to look; finished outranks the two in-progress states because
 * it is news that clears once seen, while those are continuous; a limit pause outranks running because a paused run is
 * the one that looks like a hang. Within one run the states never coexist except waiting with a pending limit, which
 * `decide` settles as Waiting.
 */
export const markRank = (mark: Mark): number => {
  switch (mark._tag) {
    case "Clear":
      return 0;
    case "Running":
      return 1;
    case "LimitPaused":
      return 2;
    case "Ended":
      return endingAlerts(mark.ending) ? 4 : 3;
    case "Waiting":
      return 5;
  }
};

/** The mark of several runs' decisions (issue #120, S17; issue #139): the first of maximal rank, Clear for none. */
export const combinedMark = (marks: readonly Mark[]): Mark =>
  marks.reduce<Mark | null>((best, m) => (best === null || markRank(m) > markRank(best) ? m : best), null) ?? { _tag: "Clear" };

/** Issue #139: the one choice of a mark's glyph, shared by the tabs, the title and the icon. */
export const markGlyph = (mark: Mark): string | null => {
  switch (mark._tag) {
    case "Clear":
      return null;
    case "Running":
      return RUNNING_MARK;
    case "LimitPaused":
      return LIMIT_PAUSED_MARK;
    case "Waiting":
      return TITLE_WAITING_MARK;
    case "Ended":
      return endingMarkOf(mark.ending);
  }
};

const pauseText = (pause: LimitPause): string => limitPauseText(pause.fromMs, pause.untilMs, pause.known);

/** Issue #139: a tab's name with its mark, as `waitingTabName` and `endedTabName` write it for the second row. */
export const markedTabName = (name: string, mark: Mark): string => {
  switch (mark._tag) {
    case "Clear":
      return name;
    case "Running":
      return `${RUNNING_MARK} ${name}`;
    case "LimitPaused":
      return `${LIMIT_PAUSED_MARK} ${name} ${pauseText(mark.pause)}`;
    case "Waiting":
      return waitingTabName(name);
    case "Ended":
      return endedTabName(name, mark.ending);
  }
};

/** Issue #139: the words of a mark's state, for accessible names; null for Clear. */
export const markStateText = (mark: Mark): string | null => {
  switch (mark._tag) {
    case "Clear":
      return null;
    case "Running":
      return RUN_WORKING_TEXT;
    case "LimitPaused":
      return runLimitPausedText(pauseText(mark.pause));
    case "Waiting":
      return RUN_WAITING_TEXT;
    case "Ended":
      return runEndedText(mark.ending);
  }
};

/** Issue #139: each mode's combined mark of its runs' marks. */
export const marksByMode = (entries: readonly Readonly<{ mode: RunMode; mark: Mark }>[]): Readonly<Record<RunMode, Mark>> =>
  Object.fromEntries(RUN_MODES.map((mode) => [mode, combinedMark(entries.filter((e) => e.mode === mode).map((e) => e.mark))])) as Record<RunMode, Mark>;

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
 * in progress is raised once (issue #209): seen at once when the run is on screen in a visible page (`Idle`), otherwise
 * `Ended` until it is, or until another run takes its place. A pending prompt takes precedence over an end.
 */
export const decide = (state: NotifyState, observed: Observation): Decision => {
  const run = observed.run;
  const running = run !== null && observed.ended === null ? run : state.running;
  const endsNow = run !== null && observed.ended !== null && sameRun(state.running, run) && !sameRun(state.ended, run);
  const seen = observed.visible && observed.onScreen;
  const raisedEnd = endsNow && !seen;
  const marked = raisedEnd ? run : state.endMark;
  const endMark = marked !== null && !seen && sameRun(marked, run) ? marked : null;
  const next: NotifyState = { prompt: state.prompt, ended: endsNow ? run : state.ended, running, endMark };
  if (observed.pending !== null) {
    const fresh = state.prompt === null || !sameKey(state.prompt, observed.pending);
    const raise = fresh ? interruptOf(observed.visible && observed.promptShown, observed) : null;
    return { _tag: "Waiting", state: { ...next, prompt: observed.pending }, key: observed.pending, raise };
  }
  if (endMark !== null && observed.ended !== null) return { _tag: "Ended", state: next, key: endMark, ending: observed.ended, raise: raisedEnd ? interruptOf(false, observed) : null };
  const activity: Activity = run === null || observed.ended !== null ? { _tag: "None" } : observed.limit !== null ? { _tag: "LimitPaused", pause: observed.limit } : { _tag: "Running" };
  return { _tag: "Idle", state: next, activity };
};

/** Issue #209: the ids of the runs of one incarnation whose end has not been seen, which their second-row tabs mark. */
export const unseenEnds = (states: readonly NotifyState[], incarnation: string | null): ReadonlySet<number> =>
  new Set(incarnation === null ? [] : states.flatMap((s) => (s.endMark !== null && s.endMark.incarnation === incarnation ? [s.endMark.run] : [])));
