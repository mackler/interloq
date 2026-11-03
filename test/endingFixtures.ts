// Issue #44: one sample of every ending, for the tests of the program, the manager, the protocol and the page.
// It imports only src/ending.ts, src/chain.ts and src/tracker.ts, which the browser imports too.
import { type ConcludedEnding, type Ending, exitCodeOfEnding, type ItemReturn } from "../src/ending.ts";

export const COMPLETED: ConcludedEnding = { _tag: "Completed", work: { _tag: "Implemented", finalCommands: [] } };
export const COMPLETED_SUITE: ConcludedEnding = { _tag: "Completed", work: { _tag: "Implemented", finalCommands: ["npm test", "npm run test:e2e"] } };
export const REFINED: ConcludedEnding = { _tag: "Completed", work: { _tag: "Refined" } };
export const OBSOLETE_LABELED: ConcludedEnding = { _tag: "Completed", work: { _tag: "Obsolete", labeled: true } };
export const OBSOLETE_UNLABELED: ConcludedEnding = { _tag: "Completed", work: { _tag: "Obsolete", labeled: false } };
export const SENT_BACK_PARKED: ConcludedEnding = {
  _tag: "SentBack",
  missing: "the requirements do not say which tab lists the item",
  park: { _tag: "Parked", branch: "interloq/halted/7/runs-x", commit: "0123456789abcdef0123" },
};
export const SENT_BACK_NOTHING: ConcludedEnding = { _tag: "SentBack", missing: "the outcome of a refusal", park: { _tag: "NothingParked" } };
const haltedWith = (item: ItemReturn | null): ConcludedEnding => ({ _tag: "Halted", reason: "the tracker step failed.", records: "/p/plan-review/runs/r", park: null, item });
export const HALTED: ConcludedEnding = haltedWith(null);
export const HALTED_NO_RECORDS: ConcludedEnding = { _tag: "Halted", reason: "no tracker is configured.", records: null, park: null, item: null };
export const HALTED_GUARD: ConcludedEnding = {
  _tag: "Halted",
  reason: "the item was stopped.",
  records: "/p/plan-review/runs/r",
  park: { _tag: "Parked", branch: "interloq/halted/7/runs-x", commit: "abcdef0123456789" },
  item: { _tag: "Returned" },
};
export const HALTED_NOT_SENT: ConcludedEnding = haltedWith({ _tag: "NotReturned", cause: "git failed", check: { _tag: "NotSent" } });
export const HALTED_UNCHECKED: ConcludedEnding = haltedWith({ _tag: "NotReturned", cause: "timed out", check: { _tag: "Unchecked" } });
export const HALTED_HELD: ConcludedEnding = haltedWith({ _tag: "NotReturned", cause: "the tracker refused", check: { _tag: "Held", state: "implementing" } });
export const INTERRUPTED: ConcludedEnding = { _tag: "Interrupted", park: null, item: null };
export const INTERRUPTED_RETURNED: ConcludedEnding = { _tag: "Interrupted", park: null, item: { _tag: "Returned" } };
export const ABANDONED: ConcludedEnding = {
  _tag: "Abandoned",
  reason: "no answer came within 120 seconds.",
  park: { _tag: "Parked", branch: "interloq/halted/7/runs-y", commit: "fedcba9876543210" },
  label: { _tag: "SetRefined" },
};
export const ABANDONED_PARK_FAILED: ConcludedEnding = {
  _tag: "Abandoned",
  reason: "no answer came within 120 seconds.",
  park: { _tag: "ParkFailed", message: "the commit was refused" },
  label: { _tag: "KeptImplementing" },
};
export const UNESTABLISHED_ENDING: Ending = { _tag: "Unestablished" };

/** Every sample, each ReturnCheck and both kinds of a send-back's parking represented. */
export const ENDINGS: readonly Ending[] = [
  COMPLETED,
  COMPLETED_SUITE,
  REFINED,
  OBSOLETE_LABELED,
  OBSOLETE_UNLABELED,
  SENT_BACK_PARKED,
  SENT_BACK_NOTHING,
  HALTED,
  HALTED_NO_RECORDS,
  HALTED_GUARD,
  HALTED_NOT_SENT,
  HALTED_UNCHECKED,
  HALTED_HELD,
  INTERRUPTED,
  INTERRUPTED_RETURNED,
  ABANDONED,
  ABANDONED_PARK_FAILED,
  UNESTABLISHED_ENDING,
];

/** The `Ended` event of a run that ended so, its code derived as the program derives it. */
export const endedEvent = (ending: ConcludedEnding) => ({ _tag: "Ended" as const, code: exitCodeOfEnding(ending), ending });
/** The page's mark of a run that ended so (web/src/notify.ts). */
export const endedMark = (ending: Ending) => ({ _tag: "Ended" as const, ending });
