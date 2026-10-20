// Parking a halted implementation run's work (issue #147, requirements Q1): its leftovers committed with --no-verify, a
// branch made at that commit, the working branch returned to the commit the run began at. An Effect over a StoreShape
// and no other I/O. It runs in phases recorded in the run's parked.json, so that the same call made again after a
// restart finishes the parking from wherever the server ended (P1-R1-3). The halted item keeps the label implementing;
// nothing here touches the tracker.
import { Clock, Effect, Result } from "effect";
import type { ParkNote } from "./chain.ts";
import { describe } from "./errors.ts";
import { type BranchName, type ParkedRecord, parkBranchOf, parkTrailerOf } from "./park.ts";
import { nothingParkedLine, PARK_NO_START_COMMIT, parkBranchTakenText, parkCommitMessage, parkedRecordLine } from "./prompts.ts";
import type { StoreError, StoreShape } from "./services.ts";
import type { ItemId } from "./tracker.ts";

/** Stops the parking with its note: a value, never a failure, carried in the error channel to leave the phases early. */
type Early = Readonly<{ _tag: "Early"; note: ParkNote }>;
const early = (note: ParkNote): Effect.Effect<never, Early> => Effect.fail({ _tag: "Early", note });
const failed = (message: string): Effect.Effect<never, Early> => early({ _tag: "ParkFailed", message });

/** Parks the work of the halted run whose store is given. Never fails: a StoreError becomes ParkFailed with its text. */
export const parkHalted = (store: StoreShape, item: ItemId): Effect.Effect<ParkNote> => {
  const time = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
  const nothing = Effect.gen(function* () {
    yield* store.saveParked({ _tag: "Nothing", version: 2, time: yield* time });
    yield* store.converse(`${nothingParkedLine}\n\n`);
    return yield* early({ _tag: "NothingParked" });
  });
  const recorded = (record: ParkedRecord): Effect.Effect<ParkNote, StoreError> =>
    Effect.gen(function* () {
      yield* store.converse(`${parkedRecordLine(record)}\n\n`);
      yield* store.saveParked({ ...record, recorded: true });
      return { _tag: "Parked", branch: record.branch, commit: record.commit } as const;
    });
  const phases: Effect.Effect<ParkNote, StoreError | Early> = Effect.gen(function* () {
    const previous = yield* store.loadParked();
    if (previous?._tag === "Parked") return previous.recorded ? ({ _tag: "Parked", branch: previous.branch, commit: previous.commit } as const) : yield* recorded(previous);
    if (previous?._tag === "Nothing") return { _tag: "NothingParked" } as const;
    const baseline = yield* store.baseline();
    // Halted after its item was labeled implementing but before its baseline: no agent call ran, nothing was committed.
    if (baseline === null) return yield* nothing;
    const start = baseline.start_commit;
    if (start === null) return yield* failed(PARK_NO_START_COMMIT);
    const branchResult = parkBranchOf(item, store.root);
    if (Result.isFailure(branchResult)) return yield* failed(`the branch name ${branchResult.failure.text} is not one git accepts.`);
    const branch: BranchName = branchResult.success;
    if (previous === null) yield* store.saveParked({ _tag: "Intended", version: 2, branch, start_commit: start, time: yield* time });
    yield* store.commitLeftovers(parkCommitMessage(item, store.root, branch));
    const tip = yield* store.branchTip(branch);
    const head = yield* store.head();
    if (tip === null && head === start) return yield* nothing;
    if (tip === null) yield* store.createBranch(branch);
    else if (tip !== head && head !== start) return yield* failed(parkBranchTakenText(branch, tip, head ?? "(none)"));
    if (head !== start) yield* store.resetTo(start);
    const commit = yield* store.branchTip(branch);
    if (commit === null) return yield* failed(`the branch ${branch} was not created.`);
    const record: ParkedRecord = {
      _tag: "Parked",
      version: 2,
      branch,
      commit,
      start_commit: start,
      committed: yield* store.parkedPaths(start, branch, parkTrailerOf(store.root)),
      recorded: false,
      time: yield* time,
    };
    yield* store.saveParked(record);
    return yield* recorded(record);
  });
  return phases.pipe(
    Effect.catch((e) => Effect.succeed<ParkNote>(e._tag === "Early" ? e.note : { _tag: "ParkFailed", message: describe(e) })),
  );
};
