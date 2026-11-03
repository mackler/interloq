/**
 * How a run ended (issue #44), as the program concluded it: one variant per ending, each carrying what its display
 * needs, so that no contradictory combination can be built and the page never infers an ending from an exit code.
 * Pure, also imported by the browser. The exit code is derived from the ending (`exitCodeOfEnding`), so the two can
 * never disagree.
 */
import { Schema } from "effect";
import { type AbandonLabel, AbandonLabelSchema, type ParkNote, ParkNoteSchema } from "./chain.ts";
import { ItemState } from "./tracker.ts";
import { ABANDONED_EXIT_CODE } from "./prompts.ts";

/** What a completed run accomplished: a refinement's write-back, an obsolete issue, or an implementation. */
export type CompletedWork =
  | Readonly<{ _tag: "Refined" }>
  | Readonly<{ _tag: "Obsolete"; labeled: boolean }>
  /** The command lines of the final commands, all passed; empty where none is configured. */
  | Readonly<{ _tag: "Implemented"; finalCommands: readonly string[] }>;

/** A parking that kept the work or found none to keep: the only notes a send-back that returns can carry. */
export type KeptPark = Extract<ParkNote, { _tag: "Parked" } | { _tag: "NothingParked" }>;

/** What is known of the item's label after a failed return to refined. */
export type ReturnCheck =
  /** No write was sent: Interloq did not change the label. */
  | Readonly<{ _tag: "NotSent" }>
  /** A write was sent and the item was not read back (a timeout included). */
  | Readonly<{ _tag: "Unchecked" }>
  /** The read-back after the last write found this state. */
  | Readonly<{ _tag: "Held"; state: ItemState }>;

/** Issue #192's return of the item to refined, as confirmed. */
export type ItemReturn = Readonly<{ _tag: "Returned" }> | Readonly<{ _tag: "NotReturned"; cause: string; check: ReturnCheck }>;

export type Ending =
  | Readonly<{ _tag: "Completed"; work: CompletedWork }>
  | Readonly<{ _tag: "SentBack"; missing: string; park: KeptPark }>
  | Readonly<{ _tag: "Halted"; reason: string; records: string | null; park: ParkNote | null; item: ItemReturn | null }>
  | Readonly<{ _tag: "Interrupted"; park: ParkNote | null; item: ItemReturn | null }>
  | Readonly<{ _tag: "Abandoned"; reason: string; park: ParkNote | null; label: AbandonLabel }>
  /** An `Ended` recorded before this change: how it ended is not established. */
  | Readonly<{ _tag: "Unestablished" }>;

/** An ending the program concludes; never Unestablished. */
export type ConcludedEnding = Exclude<Ending, { _tag: "Unestablished" }>;

export const UNESTABLISHED: Ending = { _tag: "Unestablished" };

const CompletedWorkSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Refined") }),
  Schema.Struct({ _tag: Schema.Literal("Obsolete"), labeled: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("Implemented"), finalCommands: Schema.Array(Schema.String) }),
]);
const KeptParkSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Parked"), branch: Schema.String, commit: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("NothingParked") }),
]);
const ReturnCheckSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NotSent") }),
  Schema.Struct({ _tag: Schema.Literal("Unchecked") }),
  Schema.Struct({ _tag: Schema.Literal("Held"), state: ItemState }),
]);
const ItemReturnSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Returned") }),
  Schema.Struct({ _tag: Schema.Literal("NotReturned"), cause: Schema.String, check: ReturnCheckSchema }),
]);
const parkOrNone = Schema.NullOr(ParkNoteSchema);
const itemOrNone = Schema.NullOr(ItemReturnSchema);

export const EndingSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Completed"), work: CompletedWorkSchema }),
  Schema.Struct({ _tag: Schema.Literal("SentBack"), missing: Schema.String, park: KeptParkSchema }),
  Schema.Struct({ _tag: Schema.Literal("Halted"), reason: Schema.String, records: Schema.NullOr(Schema.String), park: parkOrNone, item: itemOrNone }),
  Schema.Struct({ _tag: Schema.Literal("Interrupted"), park: parkOrNone, item: itemOrNone }),
  Schema.Struct({ _tag: Schema.Literal("Abandoned"), reason: Schema.String, park: parkOrNone, label: AbandonLabelSchema }),
  Schema.Struct({ _tag: Schema.Literal("Unestablished") }),
]);

/** The run's recorded exit code (behavior 11), derived from its ending: a send-back keeps 0. */
export const exitCodeOfEnding = (ending: ConcludedEnding): number => {
  switch (ending._tag) {
    case "Completed":
    case "SentBack":
      return 0;
    case "Halted":
      return 1;
    case "Interrupted":
      return 130;
    case "Abandoned":
      return ABANDONED_EXIT_CODE;
  }
};

/** Whether the ending is drawn in the error color (decision Q2): a halted or an abandoned run alone. */
export const endingAlerts = (ending: Ending): boolean => ending._tag === "Halted" || ending._tag === "Abandoned";

/** Whether the run reached its end, so the phases it did not begin were not needed: completed or sent back. */
export const endsAtItsEnd = (ending: Ending): boolean => ending._tag === "Completed" || ending._tag === "SentBack";
