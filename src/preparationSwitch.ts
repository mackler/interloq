// The unattended preparation of an item's questions (issue #131) as the server and the page share it: pure, also
// imported by the browser, so it imports nothing of node.
import { Schema } from "effect";

/** An item's mark in the Refinement tab's list (requirements Q6): being prepared, prepared with its count of questions, or set aside with why. */
export const PreparationMarkSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Preparing") }),
  Schema.Struct({ _tag: Schema.Literal("Prepared"), questions: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("SetAside"), reason: Schema.String }),
]);
export type PreparationMark = typeof PreparationMarkSchema.Type;

/**
 * The switch (requirements Q4): on or off, and its generation, incremented each time it is turned on, so that turning
 * it off and on releases every item set aside (requirements G-R1-1). Off by default, unlike the chain's.
 */
export const PreparationSettingsSchema = Schema.Struct({ enabled: Schema.Boolean, generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });
export type PreparationSettings = typeof PreparationSettingsSchema.Type;
export const PREPARATION_OFF: PreparationSettings = { enabled: false, generation: 0 };

/** An item whose preparation finished but whose comments the tracker refused for good, so it could not be recorded on the item. */
export const PreparationFailureSchema = Schema.Struct({ item: Schema.String, digest: Schema.String, generation: Schema.Int, reason: Schema.String });
export type PreparationFailure = typeof PreparationFailureSchema.Type;

/** The developer pressed Refine on an item set aside by the preparation of that key (requirements G-R1-1), recorded whatever became of its comment's deletion. */
export const PreparationReleaseSchema = Schema.Struct({ item: Schema.String, key: Schema.String });
export type PreparationRelease = typeof PreparationReleaseSchema.Type;

/** What plan-review/chain.json keeps of the preparation (requirements F4): the switch, the failures and the releases. */
export const PreparationKeptSchema = Schema.Struct({ settings: PreparationSettingsSchema, failures: Schema.Array(PreparationFailureSchema), released: Schema.Array(PreparationReleaseSchema) });
export type PreparationKept = typeof PreparationKeptSchema.Type;
export const PREPARATION_KEPT_OFF: PreparationKept = { settings: PREPARATION_OFF, failures: [], released: [] };

/**
 * The switch set to `enabled`. Off to on: a new generation, and the failures and releases emptied, since the new
 * generation alone releases every item. On to off: off, all else kept, so that turning it on later is what releases
 * (requirements Q4: while it is off nothing is prepared). Unchanged: the state as it is.
 */
export const switched = (kept: PreparationKept, enabled: boolean): PreparationKept => {
  if (enabled === kept.settings.enabled) return kept;
  return enabled ? { settings: { enabled: true, generation: kept.settings.generation + 1 }, failures: [], released: [] } : { ...kept, settings: { ...kept.settings, enabled: false } };
};

/** Whether a failure still excludes its item: its digest is the item's now and its generation the switch's, so an edit or a cycle of the switch releases it. */
export const failureCounts = (failure: PreparationFailure, digest: string, generation: number): boolean => failure.digest === digest && failure.generation === generation;
export const withFailure = (kept: PreparationKept, failure: PreparationFailure): PreparationKept => ({ ...kept, failures: [...kept.failures.filter((f) => f.item !== failure.item), failure] });
export const withoutFailure = (kept: PreparationKept, item: string): PreparationKept => ({ ...kept, failures: kept.failures.filter((f) => f.item !== item) });

/** Whether the developer released the item set aside by the preparation of that key by pressing Refine. */
export const isReleased = (kept: PreparationKept, item: string, key: string): boolean => kept.released.some((r) => r.item === item && r.key === key);
export const withRelease = (kept: PreparationKept, release: PreparationRelease): PreparationKept => ({ ...kept, released: [...kept.released.filter((r) => r.item !== release.item), release] });
export const withoutRelease = (kept: PreparationKept, item: string): PreparationKept => ({ ...kept, released: kept.released.filter((r) => r.item !== item) });

/** What the page shows under the switch: off; on with nothing eligible left; preparing an item; or the tracker's notice. */
export const PreparationStatusSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Off") }),
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({ _tag: Schema.Literal("Preparing"), item: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Unavailable"), notice: Schema.String }),
]);
export type PreparationStatus = typeof PreparationStatusSchema.Type;
/** The item being prepared, or null: the one function the page uses to tell which row is being prepared. */
export const preparingItemOf = (status: PreparationStatus): string | null => (status._tag === "Preparing" ? status.item : null);

export const PreparationViewSchema = Schema.Struct({ settings: PreparationSettingsSchema, status: PreparationStatusSchema });
export type PreparationView = typeof PreparationViewSchema.Type;
