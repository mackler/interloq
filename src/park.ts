// Parking a halted implementation run's work (issue #147, requirements Q1): the branch it is kept on, the trailer that
// marks the commit of its leftovers, and the record of the parking in the run's records directory. Pure.
import { type Brand, Effect, Result, Schema } from "effect";
import { itemInRoot, type RunRoot } from "./artifacts.ts";
import type { ItemId } from "./tracker.ts";
import { PARKED_ENDINGS } from "./runEnding.ts";

/** A branch name git accepts (`git check-ref-format --branch`), built by parkBranchOf alone. */
export type BranchName = Brand.Branded<string, "BranchName">;
export type InvalidBranch = Readonly<{ _tag: "InvalidBranch"; text: string }>;

/** Interloq's prefix of the branches that keep a halted run's work. */
export const PARK_BRANCH_PREFIX = "interloq/halted";
/** The flag the park commit is made with, which the commit message and the run's record both name. */
export const PARK_NO_VERIFY = "--no-verify";
/** The trailer that marks the park commit, so its paths are found again from git after a restart. */
export const PARK_TRAILER = "Interloq-Parked";

/** The last component of a run's root: its records directory's own name. */
export const rootName = (root: RunRoot): string => root.slice(root.lastIndexOf("/") + 1);

// git's rules of a ref name (git-check-ref-format(1)), each component and the whole.
const FORBIDDEN_CHAR = /[\u0000- \u007f~^:?*[\\]/u;
const badComponent = (c: string): boolean => c === "" || c.startsWith(".") || c.endsWith(".lock");
export const branchNameOf = (text: string): Result.Result<BranchName, InvalidBranch> =>
  FORBIDDEN_CHAR.test(text) || text.includes("..") || text.includes("@{") || text === "@" || text.endsWith(".") || text.split("/").some(badComponent)
    ? Result.fail({ _tag: "InvalidBranch", text })
    : Result.succeed(text as BranchName);

/** `interloq/halted/<item>/<records directory name>`: the item and the run's records found together. */
export const parkBranchOf = (item: ItemId, root: RunRoot): Result.Result<BranchName, InvalidBranch> =>
  branchNameOf(`${PARK_BRANCH_PREFIX}/${itemInRoot(item)}/${rootName(root)}`);

/** The trailer line of the park commit of the run whose root is given. */
export const parkTrailerOf = (root: RunRoot): string => `${PARK_TRAILER}: ${rootName(root)}`;

const Version = Schema.Literal(2);
/**
 * `parked.json` in the halted run's records directory: the parking intended (written before any git write), done (with
 * the paths committed and whether the run's conversation.md holds its line), or nothing needed keeping.
 */
// Issue #185: the ending whose work is parked; null in a parked.json written before the field, which src/earlierPlan.ts
// classifies from its run's conversation.md.
const Ending = Schema.NullOr(Schema.Literals(PARKED_ENDINGS)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));
export const ParkRecordSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Intended"), version: Version, branch: Schema.String, start_commit: Schema.String, time: Schema.String, ending: Ending }),
  Schema.Struct({
    _tag: Schema.Literal("Parked"),
    version: Version,
    branch: Schema.String,
    commit: Schema.String,
    start_commit: Schema.String,
    committed: Schema.Array(Schema.String),
    recorded: Schema.Boolean,
    time: Schema.String,
    ending: Ending,
  }),
  Schema.Struct({ _tag: Schema.Literal("Nothing"), version: Version, time: Schema.String, ending: Ending }),
]);
export type ParkRecord = typeof ParkRecordSchema.Type;
export type ParkedRecord = Extract<ParkRecord, { _tag: "Parked" }>;

/**
 * Issue #185 (G-R1-1): the state of the repository before a parking: ready, on a detached HEAD, or part way through an
 * operation, each of which refuses the parking with a text of its own.
 */
export type GitState =
  | Readonly<{ _tag: "Ready" }>
  | Readonly<{ _tag: "Detached" }>
  | Readonly<{ _tag: "InProgress"; operation: "rebase" | "merge" | "cherry-pick" | "revert" }>;

/** Issue #185 (F1): what merging a parked run's branch did: merged at a commit, or a content conflict with git's message. */
export type MergeOutcome = Readonly<{ _tag: "Merged"; commit: string }> | Readonly<{ _tag: "Conflicted"; message: string }>;

/** What committing a halted run's leftovers did: nothing was left, or the commit it made. */
export type LeftoverCommit = Readonly<{ _tag: "NothingLeft" }> | Readonly<{ _tag: "Committed"; commit: string }>;
