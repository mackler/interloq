// The endings of an implementation run that park its work (issue #186, requirements "The three endings of a run,
// stated once"): a halt, a send-back, and a guard stop (issue #185's ending, a run abandoned for want of an answer, joins
// them when it is built). They end the same way, the work parked on the item's branch by parkWork of src/parking.ts with
// the same handling of a failed parking, and differ only in the item's label and the comment written. Pure.
import type { ParkNote } from "./chain.ts";
import type { CommentKey, InterloqComment } from "./itemComments.ts";
import type { ItemState } from "./tracker.ts";

/** An ending whose work is parked. */
export type ParkedEnding = "halted" | "sentBack" | "stoppedUnrefined";

/** The label the item gets after the parking; null where it keeps implementing. */
export const labelAfterParking = (ending: ParkedEnding): ItemState | null => {
  switch (ending) {
    case "halted":
    case "stoppedUnrefined":
      return null;
    case "sentBack":
      return "unrefined";
  }
};

/** The comment Interloq writes on the item after the parking; null where it writes none. */
export const commentAfterParking = (ending: ParkedEnding, key: CommentKey, date: string, missing: string): InterloqComment | null => {
  switch (ending) {
    case "halted":
      return null;
    case "sentBack":
      return { _tag: "SentBack", key, date, missing };
    case "stoppedUnrefined":
      return { _tag: "StoppedUnrefined", key, date, missing };
  }
};

/** Whether a chain goes on after the ending (requirements Q6): a parking that failed ends it, the work left in place. */
export const chainContinues = (_ending: ParkedEnding, note: ParkNote): boolean => note._tag !== "ParkFailed";
