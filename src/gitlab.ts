// The GitLab tracker: the Tracker port over the issues of one GitLab project on gitlab.com, an edge. The HTTP client is
// injected as a service and the token is a parameter: this module never mentions process.env. Errors are built from
// statuses and the adapter's own words, never from an HttpClientError or its request, which carry the PRIVATE-TOKEN
// header.
//
// Established by iou-notes against gitlab.com from its container since 8 Oct 2026: the PRIVATE-TOKEN header, and the
// project addressed by its URL-encoded path. From GitLab's documentation, unproven until the first real call: the
// listing `GET /projects/:id/issues` with `state`, `labels`, `per_page` and `page`, paged by the `X-Next-Page` header;
// `GET /projects/:id/issues/:iid`; `PUT /projects/:id/issues/:iid` with `description`, `add_labels`, `remove_labels` and
// `state_event`; and a description's limit of 1,000,000 characters.
import { Effect, Layer, Option, Result, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { type TrackerCredentialMissing, TrackerBodyInvalid, TrackerItemNotFound, TrackerStateAmbiguous, TrackerUnreachable } from "./errors.ts";
import {
  type Ambiguous,
  CLOSE_BODY,
  closedRefusalText,
  connectionRefused,
  descriptionTooLongText,
  GITLAB_CONNECT_ATTEMPTS,
  GITLAB_PAGE_SIZE,
  type GitlabIssue,
  GitlabIssue as GitlabIssueSchema,
  commentsOfNotes,
  GitlabNote,
  type GitlabTarget,
  gitlabPageProblem,
  gitlabStatusFailure,
  gitlabTargetName,
  iidOf,
  itemOfIssue,
  nextPageOf,
  type NoStateLabel,
  noStateLabelText,
  refinedDescription,
  relabelBody,
} from "./gitlabIssues.ts";
import { OPENING_LINE, type Refinement } from "./refinement.ts";
import type { GitlabLabeledState, GitlabTrackerConfig } from "./schema.ts";
import { Tracker, type TrackerError, type TrackerShape } from "./services.ts";
import { type CommentId, type ItemComment, type ItemId, type ItemState, positiveDecimalOf, type TrackerItem } from "./tracker.ts";
import { type Environment, type GitlabToken, gitlabCredential } from "./trackerConfig.ts";

const TRACKER = "GitLab";
const API = "https://gitlab.com/api/v4";

const decodeIssue = Schema.decodeUnknownResult(GitlabIssueSchema);
const decodeIssues = Schema.decodeUnknownResult(Schema.Array(GitlabIssueSchema));
const decodeNotes = Schema.decodeUnknownResult(Schema.Array(GitlabNote));

/**
 * A failure of the client as the tracker's error. Of the HttpClientError only a StatusCodeError's status is read,
 * since every reason holds the request, whose headers carry the token.
 */
const clientFailure = (error: HttpClientError.HttpClientError, method: string, target: GitlabTarget): TrackerError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "StatusCodeError":
      return gitlabStatusFailure(reason.response.status, method, target) ?? new TrackerUnreachable({ tracker: TRACKER, message: `the client refused GitLab's answer to ${method} ${gitlabTargetName(target)} with status ${reason.response.status}`, status: reason.response.status });
    case "DecodeError":
    case "EmptyBodyError":
      return new TrackerBodyInvalid({ id: gitlabTargetName(target), message: "GitLab's answer could not be decoded" });
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return new TrackerUnreachable({ tracker: TRACKER, message: `the request ${method} ${gitlabTargetName(target)} reached no answer from GitLab`, status: null });
  }
};

/** One answer of GitLab: its JSON and the next page's header. */
type Answer = Readonly<{ json: unknown; nextPage: string | undefined }>;

/** An issue's state failure as the tracker's error, naming the issue and the labels found. */
const stateFailure = (failure: NoStateLabel | Ambiguous, iid: number): TrackerError =>
  failure._tag === "Ambiguous" ? new TrackerStateAmbiguous({ id: String(iid), labels: failure.labels }) : new TrackerBodyInvalid({ id: String(iid), message: noStateLabelText(failure, iid) });

export const gitlabTracker = (config: GitlabTrackerConfig, token: GitlabToken): Effect.Effect<TrackerShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const issuesUrl = `${API}/projects/${encodeURIComponent(config.project)}/issues`;
    const authorized = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      request.pipe(HttpClientRequest.setHeader("private-token", token), HttpClientRequest.setHeader("accept", "application/json"));

    /**
     * Executes a request, again while its connection is refused, up to GITLAB_CONNECT_ATTEMPTS in all and with no
     * wait: a refused connection sent nothing. Any other failure, a reset or a timeout that may have reached GitLab
     * included, is not tried again. Only the cause's codes are read.
     */
    const execute = (request: HttpClientRequest.HttpClientRequest, attempt: number): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
      Effect.catch(client.execute(request), (error) =>
        error.reason._tag === "TransportError" && connectionRefused(error.reason.cause) && attempt < GITLAB_CONNECT_ATTEMPTS ? execute(request, attempt + 1) : Effect.fail(error),
      );

    /** Sends a request and maps every failure once: the network, a refused token, a missing item, any other status, a body that is not JSON. */
    const send = (request: HttpClientRequest.HttpClientRequest, target: GitlabTarget): Effect.Effect<Answer, TrackerError> =>
      Effect.gen(function* () {
        const response: HttpClientResponse.HttpClientResponse = yield* Effect.mapError(execute(authorized(request), 1), (error) => clientFailure(error, request.method, target));
        const refused = gitlabStatusFailure(response.status, request.method, target);
        if (refused !== null) return yield* Effect.fail(refused);
        const json = yield* Effect.mapError(response.json, () => new TrackerBodyInvalid({ id: gitlabTargetName(target), message: "GitLab's answer is not JSON" }));
        return { json, nextPage: response.headers["x-next-page"] };
      });

    /** Every page of a listing from `page`, following X-Next-Page until it is empty; a page the server repeated fails the listing. */
    const pages = (params: Readonly<Record<string, string>>, target: GitlabTarget, page: number, before: readonly GitlabIssue[]): Effect.Effect<readonly GitlabIssue[], TrackerError> =>
      Effect.flatMap(send(HttpClientRequest.get(issuesUrl).pipe(HttpClientRequest.setUrlParams({ ...params, page: String(page) })), target), ({ json, nextPage }): Effect.Effect<readonly GitlabIssue[], TrackerError> => {
        const issues = decodeIssues(json);
        if (Result.isFailure(issues)) return Effect.fail(new TrackerBodyInvalid({ id: gitlabTargetName(target), message: `GitLab's answer is not a list of issues: ${issues.failure.message}` }));
        const next = nextPageOf(nextPage);
        const problem = gitlabPageProblem(page, next, new Set(before.map((issue) => issue.iid)), issues.success);
        if (problem !== null) return Effect.fail(new TrackerBodyInvalid({ id: gitlabTargetName(target), message: `GitLab did not follow the page parameter: ${problem}` }));
        const all = [...before, ...issues.success];
        return Option.match(next, { onNone: () => Effect.succeed(all), onSome: (n) => pages(params, target, n, all) });
      });

    /** An issue as an item; an open issue without exactly one state label is its typed failure, naming the issue. */
    const itemOf = (issue: GitlabIssue): Result.Result<TrackerItem, TrackerError> => Result.mapError(itemOfIssue(config.labels, issue), (failure) => stateFailure(failure, issue.iid));

    /** A deployed item is a closed issue (the developer's decision of 9 Oct 2026), and a listing holds open issues only. */
    /** The open issues carrying the state's label and the further labels given, with the extra parameters; an issue without exactly one state label fails the listing. */
    const listed = (state: GitlabLabeledState, more: readonly string[], extra: Readonly<Record<string, string>>, what: string): Effect.Effect<readonly TrackerItem[], TrackerError> => {
      const params = { state: "opened", labels: [config.labels[state], ...more].join(","), per_page: String(GITLAB_PAGE_SIZE), ...extra };
      const target: GitlabTarget = { kind: "listing", what: `${what} of ${config.project}` };
      return Effect.flatMap(pages(params, target, 1, []), (issues): Effect.Effect<readonly TrackerItem[], TrackerError> => {
        const items = Result.all(issues.map(itemOf));
        return Result.isFailure(items) ? Effect.fail(items.failure) : Effect.succeed(items.success.filter((item) => item.state === state));
      });
    };
    const list = (state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError> => (state === "deployed" ? Effect.succeed([]) : listed(state, [], {}, `the ${state} issues`));
    /** Issue #131: the marked issues in a state, newest first by GitLab's own order; none, and no request, for deployed or with no mark configured. */
    const listMarked = (state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError> =>
      state === "deployed" || config.prepareLabel === null ? Effect.succeed([]) : listed(state, [config.prepareLabel], { order_by: "created_at", sort: "desc" }, `the marked ${state} issues`);

    /** The issue an id names, with its URL and its item: an id outside GitLab's format is an item that does not exist, and no request is sent. */
    const itemIssueOf = (id: ItemId): Effect.Effect<Readonly<{ issue: GitlabIssue; url: string; item: TrackerItem }>, TrackerError> =>
      Option.match(iidOf(id), {
        onNone: () => Effect.fail(new TrackerItemNotFound({ id })),
        onSome: (iid) => {
          const url = `${issuesUrl}/${iid}`;
          return Effect.flatMap(send(HttpClientRequest.get(url), { kind: "item", id }), ({ json }): Effect.Effect<Readonly<{ issue: GitlabIssue; url: string; item: TrackerItem }>, TrackerError> => {
            const issue = decodeIssue(json);
            if (Result.isFailure(issue)) return Effect.fail(new TrackerBodyInvalid({ id, message: `GitLab's answer is not an issue: ${issue.failure.message}` }));
            return Effect.map(Effect.fromResult(itemOf(issue.success)), (item) => ({ issue: issue.success, url, item }));
          });
        },
      });

    const read = (id: ItemId): Effect.Effect<TrackerItem, TrackerError> => Effect.map(itemIssueOf(id), ({ item }) => item);

    /** One PUT with a JSON body, never query parameters. */
    const put = (url: string, id: ItemId, body: Readonly<Record<string, unknown>>): Effect.Effect<void, TrackerError> =>
      Effect.asVoid(send(HttpClientRequest.put(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)), { kind: "item", id }));

    /** A write to a closed issue, refused after its GET and before any PUT: Interloq never reopens a closed issue (the developer's decision G-R1-1). */
    const closedRefusal = (id: ItemId, issue: GitlabIssue, what: string): Effect.Effect<never, TrackerError> => Effect.fail(new TrackerBodyInvalid({ id, message: closedRefusalText(issue.iid, what) }));

    /** The developer's text is never replaced: withRefinement appends the section or replaces it alone, and a text over GitLab's limit is refused, never truncated. */
    const writeRefinement = (id: ItemId, refinement: Refinement): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(itemIssueOf(id), ({ issue, url }) => {
        if (issue.state === "closed") return closedRefusal(id, issue, "the refinement was not written");
        const description = refinedDescription(issue.description ?? "", refinement);
        if (Result.isSuccess(description)) return put(url, id, { description: description.success });
        const failure = description.failure;
        return Effect.fail(new TrackerBodyInvalid({ id, message: failure._tag === "DescriptionTooLong" ? descriptionTooLongText(failure) : `the issue's section "${OPENING_LINE}" is malformed: ${failure.reason}` }));
      });

    /**
     * Deployed closes an open issue and is already true of a closed one. Any other state on an open issue is one PUT that
     * adds its label and removes the other state labels, so the change cannot stop half done; on a closed issue it is refused.
     */
    const setState = (id: ItemId, state: ItemState): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(itemIssueOf(id), ({ issue, url }) => {
        if (state === "deployed") return issue.state === "closed" ? Effect.void : put(url, id, CLOSE_BODY);
        return issue.state === "closed" ? closedRefusal(id, issue, `its state was not set to ${state}`) : put(url, id, relabelBody(config.labels, state));
      });

    /** Issue #186: one POST of a note, after the issue is read; a closed issue is refused, since Interloq writes to no closed issue (G-R1-1). */
    const comment = (id: ItemId, text: string): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(itemIssueOf(id), ({ issue, url }) =>
        issue.state === "closed" ? closedRefusal(id, issue, "the comment was not written") : Effect.asVoid(send(HttpClientRequest.post(`${url}/notes`).pipe(HttpClientRequest.bodyJsonUnsafe({ body: text })), { kind: "item", id })),
      );

    /** Every page of an issue's notes from `page`, oldest first, following X-Next-Page; a page the server repeated fails the listing. */
    const notePages = (url: string, id: ItemId, page: number, before: readonly GitlabNote[]): Effect.Effect<readonly GitlabNote[], TrackerError> => {
      const params = { per_page: String(GITLAB_PAGE_SIZE), sort: "asc", order_by: "created_at", page: String(page) };
      return Effect.flatMap(send(HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(params)), { kind: "item", id }), ({ json, nextPage }): Effect.Effect<readonly GitlabNote[], TrackerError> => {
        const notes = decodeNotes(json);
        if (Result.isFailure(notes)) return Effect.fail(new TrackerBodyInvalid({ id, message: `GitLab's answer is not a list of notes: ${notes.failure.message}` }));
        const next = nextPageOf(nextPage);
        const problem = gitlabPageProblem(page, next, new Set(before.map((n) => n.id)), notes.success.map((n) => ({ iid: n.id })), "note");
        if (problem !== null) return Effect.fail(new TrackerBodyInvalid({ id, message: `GitLab did not follow the page parameter: ${problem}` }));
        const all = [...before, ...notes.success];
        return Option.match(next, { onNone: () => Effect.succeed(all), onSome: (n) => notePages(url, id, n, all) });
      });
    };

    /** Issue #186: the issue's notes that are comments, oldest first; an id outside GitLab's format names no item and sends nothing. */
    const comments = (id: ItemId): Effect.Effect<readonly ItemComment[], TrackerError> =>
      Option.match(iidOf(id), {
        onNone: () => Effect.fail(new TrackerItemNotFound({ id })),
        onSome: (iid) => Effect.map(notePages(`${issuesUrl}/${iid}/notes`, id, 1, []), commentsOfNotes),
      });
    /**
     * Issue #131: one DELETE of the note, with no read of the issue first: a closed issue is no refusal, since deleting
     * Interloq's own note changes nothing the developer decided (G-R1-1 forbids reopening, not deleting a note). A note
     * already gone (404) counts as deleted, so the operation is idempotent and the tracker retry may repeat it; the
     * mapping is here, not in gitlabStatusFailure, which other requests share. A refused connection is tried again, as
     * every request is.
     */
    const deleteComment = (id: ItemId, comment: CommentId): Effect.Effect<void, TrackerError> =>
      Option.match(Option.all([iidOf(id), positiveDecimalOf(comment)]), {
        onNone: () => Effect.fail(new TrackerItemNotFound({ id })),
        onSome: ([iid, note]) => {
          const request = HttpClientRequest.delete(`${issuesUrl}/${iid}/notes/${note}`);
          const target: GitlabTarget = { kind: "item", id };
          return Effect.flatMap(
            Effect.catch(execute(authorized(request), 1), (error) =>
              error.reason._tag === "StatusCodeError" && error.reason.response.status === 404 ? Effect.succeed(null) : Effect.fail(clientFailure(error, request.method, target)),
            ),
            (response): Effect.Effect<void, TrackerError> => {
              if (response === null || response.status === 404) return Effect.void;
              const refused = gitlabStatusFailure(response.status, request.method, target);
              return refused === null ? Effect.void : Effect.fail(refused);
            },
          );
        },
      });
    const tracker: TrackerShape = { list, listMarked, read, writeRefinement, setState, comment, comments, deleteComment };
    return tracker;
  });

export const gitlabTrackerLayer = (config: GitlabTrackerConfig, token: GitlabToken): Layer.Layer<Tracker, never, HttpClient.HttpClient> => Layer.effect(Tracker, gitlabTracker(config, token));
/** The GitLab tracker of its configuration, its token from the environment given: refused, before any request, when the credential is absent. */
export const gitlabTrackerFrom = (config: GitlabTrackerConfig, env: Environment): Result.Result<Layer.Layer<Tracker, never, HttpClient.HttpClient>, TrackerCredentialMissing> =>
  Result.map(gitlabCredential(env), (token) => gitlabTrackerLayer(config, token));
