// The endings of an implementation run that park its work (issue #186, requirements "The three endings of a run,
// stated once"): a halt, a send-back, a guard stop, and since issue #185 a run abandoned because no answer came within the
// wait. They end the same way, the work parked on the item's branch by parkWork of src/parking.ts with the same handling
// of a failed parking, and differ only in the item's label and the comment written. Pure.
import type { ParkNote } from "./chain.ts";
import type { CommentKey, InterloqComment } from "./itemComments.ts";
import type { ItemState } from "./tracker.ts";

/** The endings whose work is parked. */
export const PARKED_ENDINGS = ["halted", "sentBack", "stoppedUnrefined", "abandoned"] as const;
/** An ending whose work is parked. */
export type ParkedEnding = (typeof PARKED_ENDINGS)[number];

/** The label the item gets after the parking; null where it keeps implementing. */
export const labelAfterParking = (ending: ParkedEnding): ItemState | null => {
  switch (ending) {
    case "halted":
    case "stoppedUnrefined":
      return null;
    case "sentBack":
      return "unrefined";
    // Issue #185 (requirements Q1): the work is on its branch and the working branch back where the run began.
    case "abandoned":
      return "refined";
  }
};

/** The comment Interloq writes on the item after the parking; null where it writes none. */
export const commentAfterParking = (ending: ParkedEnding, key: CommentKey, date: string, missing: string): InterloqComment | null => {
  switch (ending) {
    case "halted":
    case "abandoned":
      return null;
    case "sentBack":
      return { _tag: "SentBack", key, date, missing };
    case "stoppedUnrefined":
      return { _tag: "StoppedUnrefined", key, date, missing };
  }
};

/** Whether a chain goes on after the ending (requirements Q6): a parking that failed ends it, the work left in place. */
export const chainContinues = (_ending: ParkedEnding, note: ParkNote): boolean => note._tag !== "ParkFailed";
