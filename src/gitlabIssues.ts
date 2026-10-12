// What the GitLab adapter decides without I/O: an issue's id, its state and its item, the bodies of a state change and
// of a close, and the texts of its refusals. Pure; the edge is src/gitlab.ts.
//
// An open issue carries exactly one of the four state labels (GITLAB_LABELED_STATES), and a closed issue is deployed
// (the developer's decision of 9 Oct 2026). GitLab Free has no scoped labels, so nothing in GitLab enforces the one
// label: an open issue with none or with several is a typed failure naming its labels, never a guess.
import { Option, Result, Schema } from "effect";
import { GITLAB_LABELED_STATES, type GitlabLabeledState, type GitlabLabels } from "./schema.ts";
import type { ItemId, ItemState, TrackerItem } from "./tracker.ts";

/** The fields of GitLab's issue object the adapter reads; the many others are ignored. Labels are plain names by default. */
export const GitlabIssue = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Literals(["opened", "closed"]),
  labels: Schema.Array(Schema.String),
});
export type GitlabIssue = typeof GitlabIssue.Type;

/** An open issue with no state label, with every label it carries. */
export type NoStateLabel = Readonly<{ _tag: "NoStateLabel"; labels: readonly string[] }>;
/** An open issue with two or more state labels, naming them in the issue's order. */
export type Ambiguous = Readonly<{ _tag: "Ambiguous"; labels: readonly string[] }>;

/** The issue number (`iid`) an item id names: a positive decimal integer without leading zeros; anything else names no issue. */
export const iidOf = (id: ItemId): Option.Option<number> => (/^[1-9][0-9]*$/u.test(id) && Number.isSafeInteger(Number(id)) ? Option.some(Number(id)) : Option.none());

/** The state labels among an issue's labels, in the issue's order. */
export const stateLabelsOf = (labels: GitlabLabels, names: readonly string[]): readonly string[] => names.filter((name) => GITLAB_LABELED_STATES.some((state) => labels[state] === name));

/** An issue's state: a closed issue is deployed whatever its labels; an open one is its one state label's. */
export const stateOfIssue = (labels: GitlabLabels, issue: Pick<GitlabIssue, "state" | "labels">): Result.Result<ItemState, NoStateLabel | Ambiguous> => {
  if (issue.state === "closed") return Result.succeed("deployed");
  const found = stateLabelsOf(labels, issue.labels);
  if (found.length > 1) return Result.fail({ _tag: "Ambiguous", labels: found });
  const state = GITLAB_LABELED_STATES.find((s) => labels[s] === found[0]);
  return state === undefined ? Result.fail({ _tag: "NoStateLabel", labels: issue.labels }) : Result.succeed(state);
};

/** The item of an issue: its id the issue's number in decimal, a null description the empty string. */
export const itemOfIssue = (labels: GitlabLabels, issue: GitlabIssue): Result.Result<TrackerItem, NoStateLabel | Ambiguous> =>
  Result.map(stateOfIssue(labels, issue), (state) => ({ id: String(issue.iid) as ItemId, title: issue.title, body: issue.description ?? "", state }));

/** The body of a state change: the target's label added and every other state label removed, in one request. */
export const relabelBody = (labels: GitlabLabels, to: GitlabLabeledState): Readonly<{ add_labels: string; remove_labels: string }> => ({
  add_labels: labels[to],
  remove_labels: GITLAB_LABELED_STATES.filter((state) => state !== to).map((state) => labels[state]).join(","),
});

/** The body that makes an item deployed: the issue closed, its labels left as they are. */
export const CLOSE_BODY = { state_event: "close" } as const;

/** Why a write to a closed issue was refused: Interloq never reopens a closed issue (the developer's decision G-R1-1). */
export const closedRefusalText = (iid: number, what: string): string => `issue #${iid} is closed, and Interloq never reopens a closed issue, so ${what}`;

/** An open issue without exactly one state label, named with the labels it carries. */
export const noStateLabelText = (failure: NoStateLabel, iid: number): string =>
  `issue #${iid} is open and carries no state label, so its state is unknown; ${failure.labels.length === 0 ? "it carries no label" : `its labels are ${failure.labels.map((l) => JSON.stringify(l)).join(", ")}`}`;

