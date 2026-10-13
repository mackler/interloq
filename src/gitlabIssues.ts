// What the GitLab adapter decides without I/O: an issue's id, its state and its item, the bodies of a state change and
// of a close, and the texts of its refusals. Pure; the edge is src/gitlab.ts.
//
// An open issue carries exactly one of the four state labels (GITLAB_LABELED_STATES), and a closed issue is deployed
// (the developer's decision of 9 Oct 2026). GitLab Free has no scoped labels, so nothing in GitLab enforces the one
// label: an open issue with none or with several is a typed failure naming its labels, never a guess.
import { Option, Result, Schema } from "effect";
import { TrackerAuthRefused, TrackerItemNotFound, TrackerUnreachable } from "./errors.ts";
import { type Refinement, type SectionMalformed, withRefinement } from "./refinement.ts";
import type { TrackerError } from "./services.ts";
import { errorCode } from "./transport.ts";
import { GITLAB_LABELED_STATES, type GitlabLabeledState, type GitlabLabels } from "./schema.ts";
import { type ItemId, type ItemState, itemUrlFrom, positiveDecimalOf, type TrackerItem } from "./tracker.ts";

const TRACKER = "GitLab";

/** The fields of GitLab's issue object the adapter reads; the many others are ignored. Labels are plain names by default. */
export const GitlabIssue = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Literals(["opened", "closed"]),
  labels: Schema.Array(Schema.String),
  // The issue's page on gitlab.com (issue #125), optional so that a response without it still lists the issue.
  web_url: Schema.optionalKey(Schema.String),
});
export type GitlabIssue = typeof GitlabIssue.Type;

/** An open issue with no state label, with every label it carries. */
export type NoStateLabel = Readonly<{ _tag: "NoStateLabel"; labels: readonly string[] }>;
/** An open issue with two or more state labels, naming them in the issue's order. */
export type Ambiguous = Readonly<{ _tag: "Ambiguous"; labels: readonly string[] }>;

/** The issue number (`iid`) an item id names: a positive decimal integer without leading zeros; anything else names no issue. */
export const iidOf = (id: ItemId): Option.Option<number> => positiveDecimalOf(id);

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

/** The item of an issue: its id the issue's number in decimal, a null description the empty string, its address its web_url. */
export const itemOfIssue = (labels: GitlabLabels, issue: GitlabIssue): Result.Result<TrackerItem, NoStateLabel | Ambiguous> =>
  Result.map(stateOfIssue(labels, issue), (state) => ({ id: String(issue.iid) as ItemId, title: issue.title, body: issue.description ?? "", state, url: itemUrlFrom(issue.web_url) }));

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


/** The largest `per_page` GitLab documents. */
export const GITLAB_PAGE_SIZE = 100;

/** The next page of a listing from GitLab's `X-Next-Page` header; absent, empty or not a positive integer is the last page. */
export const nextPageOf = (header: string | undefined): Option.Option<number> => (header === undefined ? Option.none() : positiveDecimalOf(header));

/** What is wrong with a page of a listing, or null: an issue repeated or already seen, or a next page not after the current one. */
export const gitlabPageProblem = (current: number, next: Option.Option<number>, seen: ReadonlySet<number>, page: readonly Pick<GitlabIssue, "iid">[]): string | null => {
  const iids = page.map((issue) => issue.iid);
  const repeated = iids.find((iid, i) => seen.has(iid) || iids.indexOf(iid) < i);
  if (repeated !== undefined) return `issue #${repeated} came twice`;
  return Option.isSome(next) && next.value <= current ? `the next page ${next.value} is not after the page ${current}` : null;
};

/** GitLab's limit on an issue's description, by its documentation; unproven by a real call. */
export const GITLAB_DESCRIPTION_LIMIT = 1_000_000;
/** A refinement that would make the description longer than GitLab's limit: refused before any request, never truncated. */
export type DescriptionTooLong = Readonly<{ _tag: "DescriptionTooLong"; limit: number; length: number }>;

/** The issue's description with the refinement through withRefinement, unchanged, refused over the limit. */
export const refinedDescription = (description: string, refinement: Refinement): Result.Result<string, SectionMalformed | DescriptionTooLong> =>
  Result.flatMap(withRefinement(description, refinement), (text): Result.Result<string, DescriptionTooLong> =>
    // Measured in UTF-16 code units, never fewer than GitLab's own count of characters.
    text.length > GITLAB_DESCRIPTION_LIMIT ? Result.fail({ _tag: "DescriptionTooLong", limit: GITLAB_DESCRIPTION_LIMIT, length: text.length }) : Result.succeed(text),
  );

export const descriptionTooLongText = (failure: DescriptionTooLong): string =>
  `the refinement would make the issue's description ${failure.length} characters long, more than GitLab's limit of ${failure.limit}`;

/** What a request is for, which decides what a 404 means and what a body that does not decode names. */
export type GitlabTarget = Readonly<{ kind: "listing"; what: string }> | Readonly<{ kind: "item"; id: ItemId }>;
export const gitlabTargetName = (target: GitlabTarget): string => (target.kind === "item" ? target.id : target.what);

/**
 * What a status of GitLab's answer means, or null for a 2xx: the one mapping, never built from a client error object,
 * whose request carries the token. A 401 or 403 is the token refused, a refusal by its Planner role included. A 404 on
 * a listing is a project path that does not exist, a fault of the configuration, not a missing item.
 */
export const gitlabStatusFailure = (status: number, method: string, target: GitlabTarget): TrackerError | null => {
  if (status >= 200 && status <= 299) return null;
  if (status === 401 || status === 403) return new TrackerAuthRefused({ tracker: TRACKER, status });
  if (status === 404 && target.kind === "item") return new TrackerItemNotFound({ id: target.id });
  return new TrackerUnreachable({ tracker: TRACKER, message: `GitLab answered ${method} ${gitlabTargetName(target)} with status ${status}` });
};

/** The attempts of one request whose connection is refused, the first included. */
export const GITLAB_CONNECT_ATTEMPTS = 3;

/**
 * Whether a client's transport failure is a refused connection, which sent nothing and so may be tried again; a reset
 * or a timeout may have reached GitLab and is not. Node's fetch fails with a TypeError whose cause carries the system
 * error's code, or an AggregateError of the addresses it tried; the shape is inferred, not observed against gitlab.com.
 * Only codes are read: nothing of the error is copied anywhere. An aggregate is judged by its errors alone, because Node
 * copies its first error's code onto it (W1-R1-1).
 */
export const connectionRefused = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  if (cause instanceof AggregateError) return cause.errors.length > 0 && cause.errors.every(connectionRefused);
  if (errorCode(cause) === "ECONNREFUSED") return true;
  return connectionRefused((cause as { cause?: unknown }).cause);
};
