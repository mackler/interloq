// The mode of a run (issue #120, parts 2 to 4, the developer's decision of 8 Oct 2026): a refinement run or an
// implementation run, each started from an item of the project's tracker in the page's tab of its mode. Pure, also
// imported by the browser; the one source of the mode for the server, the protocol and the page.
import { Schema } from "effect";
import type { ItemState } from "./tracker.ts";

export const RUN_MODES = ["refinement", "implementation"] as const;
export const RunMode = Schema.Literals(RUN_MODES);
export type RunMode = typeof RunMode.Type;

/** The state of the items a mode's tab lists: Refinement the unrefined items, Implementation the refined ones. */
export const listedState = (mode: RunMode): ItemState => {
  switch (mode) {
    case "refinement":
      return "unrefined";
    case "implementation":
      return "refined";
  }
};

/** The state a run sets on its item when it starts: none for a refinement run (decision of 9 Oct 2026). */
export const stateAtStart = (mode: RunMode): ItemState | null => {
  switch (mode) {
    case "refinement":
      return null;
    case "implementation":
      return "implementing";
  }
};

/** The state a run sets on its item when it finishes; a run that halts or is stopped sets nothing. */
export const stateAtEnd = (mode: RunMode): ItemState => {
  switch (mode) {
    case "refinement":
      return "refined";
    case "implementation":
      return "implemented";
  }
};

/**
 * Whether Claude Code's planning calls in a run of this mode take the project snapshot, the second check of behavior 3
 * (issue #120, the developer's decision of 8 Oct 2026): a refinement run drops it, its hook remaining the first.
 */
export const guardsPlanningProject = (mode: RunMode): boolean => {
  switch (mode) {
    case "refinement":
      return false;
    case "implementation":
      return true;
  }
};
