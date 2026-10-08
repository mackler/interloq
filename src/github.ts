// The GitHub tracker (issue #120, part 1): the Tracker port over GitHub Issues, an edge. The HTTP client is injected
// as a service and the token is a parameter: this module never mentions process.env, by the developer's instruction,
// since a global is a hidden input. Errors are built from statuses and the adapter's own words, never from an
// HttpClientError or its request, which carry the Authorization header.
import { Effect, Layer, Option, Result, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { NoTracker, type TrackerCredentialMissing, TrackerAuthRefused, TrackerBodyInvalid, TrackerItemNotFound, TrackerStateAmbiguous, TrackerUnreachable } from "./errors.ts";
import { type GithubIssue, GithubIssue as GithubIssueSchema, isPullRequest, issueNumberOf, itemOf, labelNamesOf, nextPage, relabeled } from "./githubIssues.ts";
import type { Config, GithubTrackerConfig } from "./schema.ts";
import { Tracker, type TrackerError, type TrackerShape } from "./services.ts";
import type { ItemId, ItemState, TrackerItem } from "./tracker.ts";
import { type Environment, type GithubToken, githubCredential } from "./trackerConfig.ts";
import { OPENING_LINE, type Refinement, withRefinement } from "./refinement.ts";

const TRACKER = "GitHub";
const API = "https://api.github.com";
const PAGE_SIZE = "100";

const decodeIssue = Schema.decodeUnknownResult(GithubIssueSchema);
const decodeIssues = Schema.decodeUnknownResult(Schema.Array(GithubIssueSchema));

/** What a request is for, which decides what a 404 means and what a body that does not decode names. */
export type Target = Readonly<{ kind: "listing"; what: string }> | Readonly<{ kind: "item"; id: ItemId }>;
const named = (target: Target): string => (target.kind === "item" ? target.id : target.what);

/**
 * What a status of GitHub's answer means, or null for a 2xx: the one mapping, whether the client returned the answer
 * or failed it with a StatusCodeError (a client wrapped by HttpClient.filterStatusOk; W1-R1-2).
 */
export const statusFailure = (status: number, method: string, target: Target): TrackerError | null => {
  if (status >= 200 && status <= 299) return null;
  if (status === 401 || status === 403) return new TrackerAuthRefused({ tracker: TRACKER, status });
  if ((status === 404 || status === 410) && target.kind === "item") return new TrackerItemNotFound({ id: target.id });
  return new TrackerUnreachable({ tracker: TRACKER, message: `GitHub answered ${method} ${named(target)} with status ${status}` });
};

/**
 * A failure of the client as the tracker's error. Of the HttpClientError only a StatusCodeError's status is read,
 * since every reason holds the request, whose headers carry the token.
 */
const clientFailure = (error: HttpClientError.HttpClientError, method: string, target: Target): TrackerError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "StatusCodeError":
      return statusFailure(reason.response.status, method, target) ?? new TrackerUnreachable({ tracker: TRACKER, message: `the client refused GitHub's answer to ${method} ${named(target)} with status ${reason.response.status}` });
    case "DecodeError":
    case "EmptyBodyError":
      return new TrackerBodyInvalid({ id: named(target), message: "GitHub's answer could not be decoded" });
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return new TrackerUnreachable({ tracker: TRACKER, message: `the request ${method} ${named(target)} reached no answer from GitHub` });
  }
};

/** One answer of GitHub: its JSON and the next page's URL. */
type Answer = Readonly<{ json: unknown; link: string | undefined }>;

export const githubTracker = (config: GithubTrackerConfig, token: GithubToken): Effect.Effect<TrackerShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const issuesUrl = `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`;
    const authorized = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
        HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
        HttpClientRequest.setHeader("user-agent", "Interloq"),
      );

    /** Sends a request and maps every failure once: the network, a refused token, a missing item, any other status, a body that is not JSON. */
    const send = (request: HttpClientRequest.HttpClientRequest, target: Target): Effect.Effect<Answer, TrackerError> =>
      Effect.gen(function* () {
        const response: HttpClientResponse.HttpClientResponse = yield* Effect.mapError(client.execute(authorized(request)), (error) => clientFailure(error, request.method, target));
        const refused = statusFailure(response.status, request.method, target);
        if (refused !== null) return yield* Effect.fail(refused);
        const json = yield* Effect.mapError(response.json, () => new TrackerBodyInvalid({ id: named(target), message: "GitHub's answer is not JSON" }));
        return { json, link: response.headers["link"] };
      });

    /** Every page of a listing, following each answer's Link header until there is none. */
    const pages = (request: HttpClientRequest.HttpClientRequest, target: Target, before: readonly GithubIssue[]): Effect.Effect<readonly GithubIssue[], TrackerError> =>
      Effect.flatMap(send(request, target), ({ json, link }): Effect.Effect<readonly GithubIssue[], TrackerError> => {
        const issues = decodeIssues(json);
        if (Result.isFailure(issues)) return Effect.fail(new TrackerBodyInvalid({ id: named(target), message: `GitHub's answer is not a list of issues: ${issues.failure.message}` }));
        const all = [...before, ...issues.success];
        return Option.match(nextPage(link), { onNone: () => Effect.succeed(all), onSome: (url) => pages(HttpClientRequest.get(url), target, all) });
      });

    /** An issue as an item; a pull request is none, and an issue with no state or two is its typed failure. */
    const itemOfIssue = (issue: GithubIssue, id: string): Result.Result<TrackerItem, TrackerError> =>
      Result.mapError(itemOf(config.labels, issue), (failure) =>
        failure._tag === "Ambiguous" ? new TrackerStateAmbiguous({ id, labels: failure.labels }) : new TrackerBodyInvalid({ id, message: "the issue is closed and carries no stage label, so it is in no state" }),
      );

    const list = (state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError> => {
      // An open issue with no stage label is unrefined (requirements, Q1), so only the whole open list finds those.
      const params = state === "unrefined" ? { state: "open", per_page: PAGE_SIZE } : { state: "open", per_page: PAGE_SIZE, labels: config.labels[state] };
      const target: Target = { kind: "listing", what: `the ${state} issues of ${config.owner}/${config.repo}` };
      return Effect.flatMap(pages(HttpClientRequest.get(issuesUrl).pipe(HttpClientRequest.setUrlParams(params)), target, []), (issues): Effect.Effect<readonly TrackerItem[], TrackerError> => {
        const items = Result.all(issues.filter((issue) => !isPullRequest(issue)).map((issue) => itemOfIssue(issue, String(issue.number))));
        return Result.isFailure(items) ? Effect.fail(items.failure) : Effect.succeed(items.success.filter((item) => item.state === state));
      });
    };

    /** The issue an id names; an id outside GitHub's format and a pull request are items that do not exist. */
    const issueOf = (id: ItemId): Effect.Effect<GithubIssue & Readonly<{ url: string }>, TrackerError> =>
      Option.match(issueNumberOf(id), {
        onNone: () => Effect.fail(new TrackerItemNotFound({ id })),
        onSome: (number) => {
          const url = `${issuesUrl}/${number}`;
          return Effect.flatMap(send(HttpClientRequest.get(url), { kind: "item", id }), ({ json }): Effect.Effect<GithubIssue & Readonly<{ url: string }>, TrackerError> => {
            const issue = decodeIssue(json);
            if (Result.isFailure(issue)) return Effect.fail(new TrackerBodyInvalid({ id, message: `GitHub's answer is not an issue: ${issue.failure.message}` }));
            return isPullRequest(issue.success) ? Effect.fail(new TrackerItemNotFound({ id })) : Effect.succeed({ ...issue.success, url });
          });
        },
      });

    /** The issue an id names with the item it is: an issue read refuses (no state, or two) is refused here too, so that no write reaches it. */
    const itemIssueOf = (id: ItemId): Effect.Effect<Readonly<{ issue: GithubIssue & Readonly<{ url: string }>; item: TrackerItem }>, TrackerError> =>
      Effect.flatMap(issueOf(id), (issue) => Effect.map(Effect.fromResult(itemOfIssue(issue, id)), (item) => ({ issue, item })));

    const read = (id: ItemId): Effect.Effect<TrackerItem, TrackerError> => Effect.map(itemIssueOf(id), ({ item }) => item);

    const patch = (url: string, id: ItemId, body: Readonly<Record<string, unknown>>): Effect.Effect<void, TrackerError> =>
      Effect.asVoid(send(HttpClientRequest.patch(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)), { kind: "item", id }));

    /** The developer's text is never replaced: withRefinement appends the section or replaces it alone. */
    const writeRefinement = (id: ItemId, refinement: Refinement): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(itemIssueOf(id), ({ issue }) => {
        const body = withRefinement(issue.body ?? "", refinement);
        return Result.isFailure(body) ? Effect.fail(new TrackerBodyInvalid({ id, message: `the issue's section "${OPENING_LINE}" is malformed: ${body.failure.reason}` })) : patch(issue.url, id, { body: body.success });
      });

    /**
     * One PATCH of the full label set, not a DELETE and a POST, which could stop half done: after the add alone the
     * issue carries two stage labels, which blocks its stage's listing (Q3); after the remove alone an open issue reads
     * as unrefined. A label added on GitHub between the read and the PATCH is overwritten.
     */
    const setState = (id: ItemId, state: ItemState): Effect.Effect<void, TrackerError> =>
      Effect.flatMap(itemIssueOf(id), ({ issue }) => patch(issue.url, id, { labels: relabeled(labelNamesOf(issue), config.labels, state) }));

    const tracker: TrackerShape = { list, read, writeRefinement, setState };
    return tracker;
  });

/**
 * The GitHub tracker of a configuration, its token from the environment given: refused, before any request, when the
 * configuration names no tracker or the credential is absent.
 */
export const githubTrackerFrom = (config: Config, env: Environment): Result.Result<Layer.Layer<Tracker, never, HttpClient.HttpClient>, TrackerCredentialMissing | NoTracker> => {
  const tracker = config.tracker;
  return tracker === null ? Result.fail(new NoTracker()) : Result.map(githubCredential(env), (token) => githubTrackerLayer(tracker, token));
};
export const githubTrackerLayer = (config: GithubTrackerConfig, token: GithubToken): Layer.Layer<Tracker, never, HttpClient.HttpClient> => Layer.effect(Tracker, githubTracker(config, token));
