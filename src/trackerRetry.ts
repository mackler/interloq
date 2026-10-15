// The tracker retry of issue #171: a tracker request that reached no answer, or that the tracker answered with a server
// error, is repeated with backoff; when the repeats run out the developer is asked. This part is pure: the run's
// writes as data, the waits, which failures are repeated, and whether the item already holds a write's outcome.

import { Option, Result } from "effect";
import type { TrackerUnreachable } from "./errors.ts";
import { type Refinement, readRefinement } from "./refinement.ts";
import { backoffDelays } from "./retry.ts";
import type { Config } from "./schema.ts";
import type { TrackerError } from "./services.ts";
import type { ItemId, ItemState, TrackerItem } from "./tracker.ts";

/** A write of a run to its item: the requirements written back, or the item's state set. */
export type TrackerWrite =
  | Readonly<{ kind: "writeRefinement"; item: ItemId; refinement: Refinement }>
  | Readonly<{ kind: "setState"; item: ItemId; state: ItemState }>;

export type TrackerRetrySettings = Pick<Config, "maxTrackerRetries" | "trackerRetryDelaySeconds">;

/** The waits before repeat 1, 2, …, maxTrackerRetries in seconds (requirements Q1: 15, 30, 60, 120, 240 by default). */
export const trackerRetryDelays = (settings: TrackerRetrySettings): readonly number[] => backoffDelays(settings.maxTrackerRetries, settings.trackerRetryDelaySeconds);

/** Whether a failure is repeated: a request that reached no answer, or a server error (behavior 14's principle). */
export const retryable = (error: TrackerError): error is TrackerUnreachable => error._tag === "TrackerUnreachable";

/**
 * Whether a failed write may have been applied: the tracker answered it with a server error (the `iou-notes` case of
 * 14 Oct 2026: `PUT 98` answered 500 and GitLab had applied it), so the item is read back (requirements Q2). A request
 * that reached no answer is repeated directly, which every operation's idempotency makes safe.
 */
export const uncertainWrite = (error: TrackerError): boolean => error._tag === "TrackerUnreachable" && error.status !== null;

/** What the item held, read back after a write that did not land. */
export type HeldState =
  | Readonly<{ kind: "noSection" }>
  | Readonly<{ kind: "otherSection" }>
  | Readonly<{ kind: "state"; state: ItemState }>;

/** What a halt says about the item after the last write (requirements Q2): what it held, or that it could not be checked. */
export type WriteCheck = Readonly<{ kind: "unchecked" }> | Readonly<{ kind: "held"; held: HeldState }>;

/** Success when the item already holds the write's outcome; otherwise what it held. A malformed section is another section. */
export const landed = (write: TrackerWrite, item: TrackerItem): Result.Result<void, HeldState> => {
  switch (write.kind) {
    case "writeRefinement": {
      const section = readRefinement(item.body);
      if (Result.isFailure(section)) return Result.fail({ kind: "otherSection" });
      if (Option.isNone(section.success)) return Result.fail({ kind: "noSection" });
      return section.success.value === write.refinement ? Result.succeed(undefined) : Result.fail({ kind: "otherSection" });
    }
    case "setState":
      return item.state === write.state ? Result.succeed(undefined) : Result.fail({ kind: "state", state: item.state });
  }
};
