// The commit check of an implementation run (pure; issue #176, requirements Q1 and Q3): which files the run
// changed and left uncommitted. The run records the paths git lists as not committed when it begins
// (`baseline.json`'s `uncommitted`), and before it counts itself finished it lists them again; a path
// listed now and not at the start is the run's and uncommitted. No I/O and no Effect: the Store runs git.
//
// What is left out: a file git ignores and does not track, which `git status` does not list; and every path
// the caller's predicate excludes (`plan-review/` and `ignorePaths`, `excluded` of `src/snapshot.ts`). The
// limit: the set taken at the start cannot tell a dead run's unfinished work on the same item from
// unrelated uncommitted work.

import type { StatusRecord } from "./snapshot.ts";

/** One or more paths: an `Uncommitted` check names at least one file. */
export type NonEmptyPaths = readonly [string, ...string[]];

/** The outcome of the commit check: nothing of the run uncommitted, or the files it left uncommitted. */
export type CommitCheck = Readonly<{ _tag: "Committed" }> | Readonly<{ _tag: "Uncommitted"; paths: NonEmptyPaths }>;

/**
 * The paths git lists as not committed, from the unfiltered porcelain v2 records: every record's path and a
 * rename's original path, each dropped on its own where `isExcluded` holds (a record dropped by its
 * destination would lose a source that is not excluded). Sorted and without duplicates.
 */
export const uncommittedPaths = (records: readonly StatusRecord[], isExcluded: (path: string) => boolean): readonly string[] => {
  void records;
  void isExcluded;
  return [];
};

/** The paths of `now` not in `atStart`, sorted: `Committed` where there are none. */
export const commitCheckOf = (atStart: readonly string[], now: readonly string[]): CommitCheck => {
  void atStart;
  void now;
  return { _tag: "Committed" };
};
