// Abandoning an implementation run that got no answer within the wait (issue #185, requirements Q1 and G-R1-1): its
// work moved to the item's branch and the working branch returned to where the run began (parkWork, the ending
// "abandoned"), then the item's label set to refined through the tracker's repeats, asking nothing, since the developer
// is away. A git step that fails leaves the work and the label as they were, and the chain ends; a label that cannot be
// set is said with what the tracker last reported, and the chain goes on. An Effect over the services, like src/sendBack.ts.
import { Effect } from "effect";
import type { AbandonLabel, ParkNote } from "./chain.ts";
import { type RunError, trackerFailureText } from "./errors.ts";
import { parkWork } from "./parking.ts";
import { abandonLabelFailedLine, abandonLabelSetLine, abandonParkFailedLine } from "./prompts.ts";
import { labelAfterParking } from "./runEnding.ts";
import { type Services, Store, Tracker, Ui } from "./services.ts";
import type { ItemId } from "./tracker.ts";
import { runTrackerEnv, unattendedTrackerEnv, writeWithRetry } from "./trackerRetry.ts";

/** What an abandonment left: the parking's note and what became of the item's label, always stated. */
export type Abandoned = Readonly<{ park: ParkNote; label: AbandonLabel }>;

export const abandonRun = (item: ItemId): Effect.Effect<Abandoned, RunError, Services | Tracker> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const tracker = yield* Tracker;
    const sayAndWrite = (line: string) => Effect.andThen(ui.say(line), store.converse(`${line}\n\n`));
    // Uninterruptible, so a Stop task or the server's fault takes effect only once parked.json records the outcome.
    const park = yield* Effect.uninterruptible(parkWork(store, item, "abandoned"));
    if (park._tag === "ParkFailed") {
      yield* sayAndWrite(abandonParkFailedLine(item, park.message));
      return { park, label: { _tag: "KeptImplementing" } };
    }
    const branch = park._tag === "Parked" ? park.branch : null;
    const env = unattendedTrackerEnv(yield* runTrackerEnv);
    const state = labelAfterParking("abandoned") ?? "refined";
    const written = yield* Effect.result(writeWithRetry(tracker, { kind: "setState", item, state }, env));
    if (written._tag === "Success") {
      yield* sayAndWrite(abandonLabelSetLine(item, branch));
      return { park, label: { _tag: "SetRefined" } };
    }
    const failure = written.failure;
    if (failure._tag !== "TrackerWriteFailed") return yield* Effect.fail(failure);
    const cause = trackerFailureText(failure.error);
    const held = failure.check.kind === "held" && failure.check.held.kind === "state" ? failure.check.held.state : null;
    yield* sayAndWrite(abandonLabelFailedLine(item, branch, held, cause));
    return { park, label: held === null ? { _tag: "Unconfirmed", cause } : { _tag: "StillHeld", state: held, cause } };
  });
