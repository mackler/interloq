// What the GitHub adapter decides without I/O (issue #120, part 1): an issue's state from its labels, the label set of
// a state change, the next page of a listing and an id's issue number. Pure; the edge is src/github.ts.
import { Option, Result, Schema } from "effect";
import type { GithubLabels } from "./schema.ts";
import { ITEM_STATES, type ItemId, type ItemState, type TrackerItem } from "./tracker.ts";

/**
 * The fields of GitHub's issue object the adapter reads; the many others are ignored. A label is an object with a
 * name (as GitHub returns it) or a string. `pull_request` is present on an entry that is a pull request.
 */
export const GithubIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  labels: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
export type GithubIssue = typeof GithubIssue.Type;

/** A closed issue with no stage label: by the developer's decision a closed issue is never unrefined. */
export type NoState = Readonly<{ _tag: "NoState" }>;
/** An issue with two or more stage labels (requirements, Q3), naming them. */
export type Ambiguous = Readonly<{ _tag: "Ambiguous"; labels: readonly string[] }>;

export const labelNamesOf = (issue: GithubIssue): readonly string[] => issue.labels.map((l) => (typeof l === "string" ? l : l.name));

/** `GET /repos/{owner}/{repo}/issues` returns pull requests as well as issues; a pull request is not an item. */
export const isPullRequest = (issue: GithubIssue): boolean => "pull_request" in issue;

/**
 * An issue's state: its one stage label's; none makes an open issue unrefined (requirements, Q1) and a closed one
 * stateless; two or more are ambiguous (Q3). Labels outside the mapping are ignored.
 */
export const stateOf = (labels: GithubLabels, issue: Readonly<{ open: boolean; labelNames: readonly string[] }>): Result.Result<ItemState, NoState | Ambiguous> => {
  const stages = stageLabelsOf(labels, issue.labelNames);
  if (stages.length > 1) return Result.fail({ _tag: "Ambiguous", labels: stages });
  const state = ITEM_STATES.find((s) => labels[s] === stages[0]);
  if (state !== undefined) return Result.succeed(state);
  return issue.open ? Result.succeed("unrefined") : Result.fail({ _tag: "NoState" });
};

/** The stage labels among an issue's labels, in the issue's order. */
export const stageLabelsOf = (labels: GithubLabels, labelNames: readonly string[]): readonly string[] => labelNames.filter((name) => ITEM_STATES.some((state) => labels[state] === name));

/** The item of an issue: its id the issue's number in decimal, a null body the empty string. */
export const itemOf = (labels: GithubLabels, issue: GithubIssue): Result.Result<TrackerItem, NoState | Ambiguous> =>
  Result.map(stateOf(labels, { open: issue.state === "open", labelNames: labelNamesOf(issue) }), (state) => ({
    // An integer's decimal text is never blank, which is all itemIdOf requires.
    id: String(issue.number) as ItemId,
    title: issue.title,
    body: issue.body ?? "",
    state,
  }));

const LINK_ENTRY = /<([^>]*)>((?:\s*;\s*[^;,]*)*)/gu;
const NEXT_REL = /;\s*rel\s*=\s*"?([^";,]*)"?/u;
/** The URL with rel="next" in a `Link` header (`<url>; rel="next", <url>; rel="last"`), none when absent. */
export const nextPage = (link: string | undefined): Option.Option<string> =>
  Option.fromNullishOr(
    [...(link ?? "").matchAll(LINK_ENTRY)].find((m) => {
      const rel = NEXT_REL.exec(m[2]);
      return rel !== null && rel[1].split(/\s+/u).includes("next");
    })?.[1],
  );

/** The GitHub issue number an id names: a positive decimal integer without leading zeros; anything else is not a GitHub id. */
export const issueNumberOf = (id: ItemId): Option.Option<number> => (/^[1-9][0-9]*$/u.test(id) && Number.isSafeInteger(Number(id)) ? Option.some(Number(id)) : Option.none());

/** The full label set of a state change: every stage label removed, the new state's added, the others kept in order. */
export const relabeled = (current: readonly string[], labels: GithubLabels, to: ItemState): readonly string[] => {
  const stage = new Set(ITEM_STATES.map((state) => labels[state]));
  return [...current.filter((name) => !stage.has(name)), labels[to]];
};
