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
  GITLAB_PAGE_SIZE,
  type GitlabIssue,
  GitlabIssue as GitlabIssueSchema,
  type GitlabTarget,
  gitlabPageProblem,
  gitlabStatusFailure,
  gitlabTargetName,
  iidOf,
  itemOfIssue,
  nextPageOf,
  type NoStateLabel,
  noStateLabelText,
} from "./gitlabIssues.ts";
import type { GitlabTrackerConfig } from "./schema.ts";
import { Tracker, type TrackerError, type TrackerShape } from "./services.ts";
import type { ItemId, ItemState, TrackerItem } from "./tracker.ts";
import { type Environment, type GitlabToken, gitlabCredential } from "./trackerConfig.ts";

const TRACKER = "GitLab";
const API = "https://gitlab.com/api/v4";

const decodeIssue = Schema.decodeUnknownResult(GitlabIssueSchema);
const decodeIssues = Schema.decodeUnknownResult(Schema.Array(GitlabIssueSchema));

/**
 * A failure of the client as the tracker's error. Of the HttpClientError only a StatusCodeError's status is read,
 * since every reason holds the request, whose headers carry the token.
 */
const clientFailure = (error: HttpClientError.HttpClientError, method: string, target: GitlabTarget): TrackerError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "StatusCodeError":
      return gitlabStatusFailure(reason.response.status, method, target) ?? new TrackerUnreachable({ tracker: TRACKER, message: `the client refused GitLab's answer to ${method} ${gitlabTargetName(target)} with status ${reason.response.status}` });
    case "DecodeError":
    case "EmptyBodyError":
      return new TrackerBodyInvalid({ id: gitlabTargetName(target), message: "GitLab's answer could not be decoded" });
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return new TrackerUnreachable({ tracker: TRACKER, message: `the request ${method} ${gitlabTargetName(target)} reached no answer from GitLab` });
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

    /** Sends a request and maps every failure once: the network, a refused token, a missing item, any other status, a body that is not JSON. */
    const send = (request: HttpClientRequest.HttpClientRequest, target: GitlabTarget): Effect.Effect<Answer, TrackerError> =>
      Effect.gen(function* () {
        const response: HttpClientResponse.HttpClientResponse = yield* Effect.mapError(client.execute(authorized(request)), (error) => clientFailure(error, request.method, target));
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
    const list = (state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError> => {
      if (state === "deployed") return Effect.succeed([]);
      const params = { state: "opened", labels: config.labels[state], per_page: String(GITLAB_PAGE_SIZE) };
      const target: GitlabTarget = { kind: "listing", what: `the ${state} issues of ${config.project}` };
      return Effect.flatMap(pages(params, target, 1, []), (issues): Effect.Effect<readonly TrackerItem[], TrackerError> => {
        const items = Result.all(issues.map(itemOf));
        return Result.isFailure(items) ? Effect.fail(items.failure) : Effect.succeed(items.success.filter((item) => item.state === state));
      });
    };

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

    const notBuilt = Effect.fail(new TrackerUnreachable({ tracker: TRACKER, message: "not built" }));
    const tracker: TrackerShape = { list, read, writeRefinement: () => notBuilt, setState: () => notBuilt };
    return tracker;
  });

export const gitlabTrackerLayer = (config: GitlabTrackerConfig, token: GitlabToken): Layer.Layer<Tracker, never, HttpClient.HttpClient> => Layer.effect(Tracker, gitlabTracker(config, token));
/** The GitLab tracker of its configuration, its token from the environment given: refused, before any request, when the credential is absent. */
export const gitlabTrackerFrom = (config: GitlabTrackerConfig, env: Environment): Result.Result<Layer.Layer<Tracker, never, HttpClient.HttpClient>, TrackerCredentialMissing> =>
  Result.map(gitlabCredential(env), (token) => gitlabTrackerLayer(config, token));
