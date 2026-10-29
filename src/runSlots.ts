// How many runs a mode keeps (pure; issue #191): one implementation run in progress at a time, the limit the git-index
// hazard sets (CLAUDE.md, "Not yet known or not yet built"), and any number of refinement runs, each of a different item,
// since a refinement run builds no temporary git index and compares no project snapshot (behavior 3). The run manager
// holds a Slot per mode; this module decides what a start is refused for and where a run goes when it starts and ends.

import type { RunMode } from "./runMode.ts";
import { refinementInProgressText, runInProgressText } from "./prompts.ts";

/** What the slot needs of a run: its id and its item. */
export type SlotRun = Readonly<{ id: number; item: string }>;
/** A mode's runs in progress, in the order they started, and its ended runs kept for the replay. */
export type Slot<R extends SlotRun> = Readonly<{ current: readonly R[]; last: readonly R[] }>;

export const EMPTY_SLOT: Slot<never> = { current: [], last: [] };

/** Why a start of `item` in `mode` is refused, or null: implementation while any run is in progress, refinement while a run of that item is. */
export const refusalOf = <R extends SlotRun>(mode: RunMode, slot: Slot<R>, item: string): string | null => {
  switch (mode) {
    case "implementation":
      return slot.current.length === 0 ? null : runInProgressText(mode);
    case "refinement":
      return slot.current.some((r) => r.item === item) ? refinementInProgressText(item) : null;
  }
};

/**
 * The slot with `run` reserved in progress, after the runs already there. A refinement drops the ended run of the same
 * item, which is kept for the replay only until a newer refinement of that item starts.
 */
export const reserved = <R extends SlotRun>(mode: RunMode, slot: Slot<R>, run: R): Slot<R> => {
  switch (mode) {
    case "implementation":
      return { current: [run], last: slot.last };
    case "refinement":
      return { current: [...slot.current, run], last: slot.last.filter((r) => r.item !== run.item) };
  }
};

/**
 * The slot with the run of that id ended, `change` applied to it: an implementation run replaces the ended one, a
 * refinement run the ended run of its item. The same slot where no run in progress has that id.
 */
export const endedIn = <R extends SlotRun>(mode: RunMode, slot: Slot<R>, id: number, change: (r: R) => R): Slot<R> => {
  const run = slot.current.find((r) => r.id === id);
  if (run === undefined) return slot;
  const current = slot.current.filter((r) => r.id !== id);
  const ended = change(run);
  switch (mode) {
    case "implementation":
      return { current, last: [ended] };
    case "refinement":
      return { current, last: [...slot.last.filter((r) => r.item !== run.item), ended] };
  }
};

/** Every run the slot holds, the ended ones first. */
export const runsOf = <R extends SlotRun>(slot: Slot<R>): readonly R[] => [...slot.last, ...slot.current];
