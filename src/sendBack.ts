// Sending an item back to refinement (issue #186, the developer's instruction of 19 Oct 2026): the verdict that the item
// is not refined stood, so the run parks its work, comments on the item what its requirements left out and labels it
// unrefined; or, where the refinement that last refined it asked the developer nothing (requirements Q5), stops it
// there with its work parked and its comment, and it keeps implementing. The ending's label and comment come from
// src/runEnding.ts, so the three endings that park are stated once.
import { Clock, Effect } from "effect";
import type { ParkNote } from "./chain.ts";
import { NotRefinedStopped, type RunError, SendBackIncomplete, SendBackNotParked, SendBackUnanswered, TrackerStepFailed, trackerFailureText, describe } from "./errors.ts";
import { commentDateOf, commentText, lastRefinementAsked, runCommentKey, sentBackCount } from "./itemComments.ts";
import { rootName } from "./park.ts";
import { parkWork } from "./parking.ts";
import { sentBackLine, stoppedUnrefinedLine, type TrackerStep } from "./prompts.ts";
import { commentAfterParking, labelAfterParking, type ParkedEnding } from "./runEnding.ts";
import { type Services, Store, Tracker, type TrackerError, Ui } from "./services.ts";
import type { ItemId } from "./tracker.ts";
import { readCommentsWithRetry, runTrackerEnv, type TrackerWrite, writeWithRetry } from "./trackerRetry.ts";

const TRACKER_ERRORS: ReadonlySet<string> = new Set<TrackerError["_tag"]>(["TrackerUnreachable", "TrackerRequestRefused", "TrackerAuthRefused", "TrackerItemNotFound", "TrackerBodyInvalid", "TrackerStateAmbiguous"]);
const isTrackerError = (e: TrackerError | RunError): e is TrackerError => TRACKER_ERRORS.has(e._tag);

/** What a send-back leaves: the parking's note, for the chain (the run parked its own work), and the verdict. */
export type SentBack = Readonly<{ park: ParkNote; missing: string }>;

/**
 * Sends item `item` back for verdict `n`, in this order: the item's comments read (whether its last refinement asked
 * the developer anything); the work parked, uninterruptibly, so a Stop task or the server's fault takes effect only once
 * parked.json records the outcome (review P1-R1-3); a parking that failed is SendBackNotParked, with no comment and no
 * label. After the parking every failure is SendBackIncomplete, carrying the note and the ending (review P1-R1-2).
 */
export const sendBack = (item: ItemId, n: number, missing: string): Effect.Effect<SentBack, RunError, Services | Tracker> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const tracker = yield* Tracker;
    const env = yield* runTrackerEnv;
    const comments = yield* readCommentsWithRetry(tracker, item, env).pipe(
      Effect.mapError((e): RunError => (isTrackerError(e) ? new TrackerStepFailed({ item, step: "readComments", cause: trackerFailureText(e), done: null, check: null }) : e)),
    );
    const ending: ParkedEnding = lastRefinementAsked(comments) ? "sentBack" : "stoppedUnrefined";
    const park = yield* Effect.uninterruptible(parkWork(store, item, ending));
    if (park._tag === "ParkFailed") return yield* Effect.fail(new SendBackNotParked({ item, message: park.message, park }));
    // A stop by the developer during a tracker step's question stays a stop (130), and one left unanswered (issue #185)
    // stays its own ending; every other failure is incomplete.
    const incomplete = (error: RunError): RunError => (error._tag === "UserStopped" || error._tag === "SendBackUnanswered" ? error : new SendBackIncomplete({ item, ending, park, cause: describe(error) }));
    const sayAndWrite = (line: string) => Effect.andThen(ui.say(line), store.converse(`${line}\n\n`));
    const write = (write: TrackerWrite, step: TrackerStep) =>
      writeWithRetry(tracker, write, env).pipe(
        Effect.mapError((e): RunError =>
          e._tag === "TrackerWriteFailed"
            ? new TrackerStepFailed({ item, step, cause: trackerFailureText(e.error), done: null, check: e.check })
            : e._tag === "NoAnswer"
              ? new SendBackUnanswered({ item, step: write.kind === "comment" ? "comment" : "label", park, where: e.where, seconds: e.seconds, question: e.question, then: e.then })
              : e,
        ),
      );
    yield* Effect.gen(function* () {
      const key = runCommentKey(rootName(store.root), `verdict-${n}`);
      const comment = commentAfterParking(ending, key, commentDateOf(yield* Clock.currentTimeMillis), missing);
      if (comment !== null) yield* write({ kind: "comment", item, text: commentText(comment), key }, "commentSendBack");
      const label = labelAfterParking(ending);
      if (label !== null) yield* write({ kind: "setState", item, state: label }, "setUnrefined");
    }).pipe(Effect.mapError(incomplete));
    if (ending === "stoppedUnrefined") {
      yield* sayAndWrite(stoppedUnrefinedLine(item));
      return yield* Effect.fail(new NotRefinedStopped({ item, missing, reason: "refinementAskedNothing", park }));
    }
    yield* sayAndWrite(sentBackLine(item, sentBackCount(comments) + 1));
    return { park, missing };
  });
