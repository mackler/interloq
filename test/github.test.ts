import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Option, Result } from "effect";
import { githubTracker, githubTrackerFrom } from "../src/github.ts";
import { Tracker } from "../src/services.ts";
import { readRefinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import type { GithubTrackerConfig } from "../src/schema.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import { type ItemId, type ItemState, itemIdOf } from "../src/tracker.ts";
import { type GithubToken, githubCredential } from "../src/trackerConfig.ts";
import { LABELS } from "./githubLabels.ts";
import { type Answer, json, makeStub, type SentRequest, type Stub } from "./stubHttp.ts";

// Issue #120, part 1: the GitHub adapter over a stub HTTP client.
const TOKEN: GithubToken = Result.getOrThrow(githubCredential({ INTERLOQ_GITHUB_TOKEN: "github_pat_SECRET123" }));
const CONFIG: GithubTrackerConfig = { kind: "github", owner: "mackler", repo: "interloq", labels: LABELS };
const ISSUES = "https://api.github.com/repos/mackler/interloq/issues";
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));

/** A GitHub issue object with the fields GitHub sends and a few it sends that the adapter ignores. */
export const issue = (number: number, labels: readonly string[], more: Record<string, unknown> = {}): Record<string, unknown> => ({ number, title: `issue ${number}`, body: `body ${number}`, state: "open", labels: labels.map((name) => ({ id: number, name, color: "ededed" })), user: { login: "mackler" }, html_url: pageOf(number), ...more });
/** The issue's page on github.com, as GitHub sends it in `html_url`. */
const pageOf = (number: number): string => `https://github.com/mackler/interloq/issues/${number}`;

/** Every error the tests produced, so that the last test can look for the token in them. */
const errors: TrackerError[] = [];
const withTracker = <A, E>(stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.flatMap(githubTracker(CONFIG, TOKEN), use).pipe(Effect.provide(stub.layer)));
const failure = async (stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<unknown, TrackerError>): Promise<TrackerError> => {
  const error: TrackerError = await withTracker(stub, (t) => Effect.flip(use(t)));
  errors.push(error);
  return error;
};
const route = (table: Readonly<Record<string, Answer>>) => (r: SentRequest): Answer => table[`${r.method} ${r.url.origin}${r.url.pathname}`] ?? json({ message: "Not Found" }, 404);
const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

test("a listing drops the pull requests GitHub returns among the issues", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, []), issue(2, [], { pull_request: { url: "u" } }), issue(3, ["bug"])]) }));
  assert.deepEqual(ids(await withTracker(stub, (t) => t.list("unrefined"))), ["1", "3"]);
});

test("a listing gives each item its issue's html_url, and lists an issue without one with no address", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, []), issue(2, [], { html_url: undefined })]) }));
  const items = await withTracker(stub, (t) => t.list("unrefined"));
  assert.deepEqual(items.map((i) => i.url), [Option.some(pageOf(1)), Option.none()]);
});

test("a listing follows the Link header to its second page and concatenates both", async () => {
  const page2 = `${ISSUES}?state=open&per_page=100&page=2`;
  const stub = makeStub((r) => (r.url.searchParams.get("page") === "2" ? json([issue(3, [])]) : json([issue(1, []), issue(2, [])], 200, { link: `<${page2}>; rel="next", <${page2}>; rel="last"` })));
  assert.deepEqual(ids(await withTracker(stub, (t) => t.list("unrefined"))), ["1", "2", "3"]);
  assert.equal(stub.sent().length, 2);
  assert.equal(stub.sent()[1].url.toString(), page2);
});

test("unrefined lists the labeled and the unlabeled open issues, and no issue of another stage", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, [LABELS.unrefined]), issue(2, ["bug"]), issue(3, [LABELS.refined]), issue(4, [])]) }));
  assert.deepEqual(ids(await withTracker(stub, (t) => t.list("unrefined"))), ["1", "2", "4"]);
  const params = stub.sent()[0].url.searchParams;
  assert.equal(params.get("state"), "open");
  assert.equal(params.get("labels"), null);
});

test("a labeled state asks GitHub for open issues with its label", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(5, [LABELS.implementing, "bug"])]) }));
  const items = await withTracker(stub, (t) => t.list("implementing"));
  assert.deepEqual(items, [{ id: id("5"), title: "issue 5", body: "body 5", state: "implementing", url: Option.some(pageOf(5)) }]);
  const params = stub.sent()[0].url.searchParams;
  assert.equal(params.get("state"), "open");
  assert.equal(params.get("labels"), LABELS.implementing);
  assert.equal(params.get("per_page"), "100");
});

test("an issue with two stage labels fails its stage's whole listing, naming the issue and its labels", async () => {
  for (const state of ["refined", "unrefined"] as const satisfies readonly ItemState[]) {
    const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, [LABELS.refined]), issue(9, [LABELS.refined, "bug", LABELS.implementing])]) }));
    const error = await failure(stub, (t) => t.list(state));
    assert.equal(error._tag, "TrackerStateAmbiguous", state);
    assert.deepEqual(error._tag === "TrackerStateAmbiguous" && { id: error.id, labels: error.labels }, { id: "9", labels: [LABELS.refined, LABELS.implementing] });
  }
});

test("a 401 and a 403 are TrackerAuthRefused, not an empty list", async () => {
  for (const status of [401, 403]) {
    const error = await failure(makeStub(() => json({ message: "Bad credentials" }, status)), (t) => t.list("unrefined"));
    assert.deepEqual(error._tag === "TrackerAuthRefused" && error.status, status);
  }
});

// Issue #171: an answer outside 2xx and 4xx is TrackerUnreachable with its status, a request that reached no answer with
// none; any other 4xx is TrackerRequestRefused, which is never repeated.
test("a 500 and a 503 are TrackerUnreachable with their status, a transport failure with none, over the plain and the filtered client", async () => {
  for (const filtered of [false, true]) {
    for (const status of [500, 503]) {
      const error = await failure(makeStub(() => json({}, status), { filtered }), (t) => t.list("refined"));
      assert.deepEqual(error._tag === "TrackerUnreachable" && error.status, status);
    }
    const error = await failure(makeStub(() => "transport", { filtered }), (t) => t.list("refined"));
    assert.equal(error._tag, "TrackerUnreachable");
    assert.equal(error._tag === "TrackerUnreachable" && error.status, null);
  }
});

test("a 404 on the repository, a 422 and a 429 are TrackerRequestRefused, over the plain and the filtered client", async () => {
  for (const filtered of [false, true]) {
    for (const status of [404, 422, 429]) {
      const error = await failure(makeStub(() => json({ message: "x" }, status), { filtered }), (t) => t.list("refined"));
      assert.deepEqual(error._tag === "TrackerRequestRefused" && error.status, status);
    }
    const error = await failure(makeStub(() => json({ message: "x" }, 422), { filtered }), (t) => t.setState(id("4"), "refined"));
    assert.equal(error._tag, "TrackerRequestRefused");
  }
});

test("a body that is not JSON, or not issues, is TrackerBodyInvalid", async () => {
  for (const answer of [new Response("<html>", { status: 200 }), json([{ number: "one" }]), json({ message: "x" })]) {
    const error = await failure(makeStub(() => answer), (t) => t.list("unrefined"));
    assert.equal(error._tag, "TrackerBodyInvalid");
  }
});

// W1-R1-2: a client that fails a non-2xx answer (HttpClient.filterStatusOk), or fails to decode one, maps as a returned answer does.
test("over a client wrapped by filterStatusOk, a 401 and a 403 are TrackerAuthRefused, a 404 on an item TrackerItemNotFound, a 500 TrackerUnreachable", async () => {
  for (const status of [401, 403]) {
    const error = await failure(makeStub(() => json({ message: "Bad credentials" }, status), { filtered: true }), (t) => t.list("unrefined"));
    assert.deepEqual(error._tag === "TrackerAuthRefused" && error.status, status);
  }
  assert.equal((await failure(makeStub(() => json({ message: "Not Found" }, 404), { filtered: true }), (t) => t.read(id("4"))))._tag, "TrackerItemNotFound");
  assert.equal((await failure(makeStub(() => json({}, 500), { filtered: true }), (t) => t.list("refined")))._tag, "TrackerUnreachable");
});

test("a client failing with a DecodeError or an EmptyBodyError is TrackerBodyInvalid, on a listing and on a read", async () => {
  for (const answer of ["decode", "emptyBody"] as const) {
    assert.equal((await failure(makeStub(() => answer), (t) => t.list("unrefined")))._tag, "TrackerBodyInvalid", answer);
    assert.equal((await failure(makeStub(() => answer), (t) => t.read(id("1"))))._tag, "TrackerBodyInvalid", answer);
  }
});

test("read gives an issue with its state; a closed issue with one stage label has it", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [LABELS.implemented], { body: null, state: "closed" })) }));
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("7"))), { id: id("7"), title: "issue 7", body: "", state: "implemented", url: Option.some(pageOf(7)) });
});

test("read of a pull request, a 404, a 410 and an id not in GitHub's format is TrackerItemNotFound", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/2`]: json(issue(2, [], { pull_request: {} })), [`GET ${ISSUES}/3`]: json({ message: "gone" }, 410) }));
  for (const text of ["2", "3", "4"]) assert.equal((await failure(stub, (t) => t.read(id(text))))._tag, "TrackerItemNotFound", text);
  const none = makeStub(() => json(issue(1, [])));
  assert.equal((await failure(none, (t) => t.read(id("abc"))))._tag, "TrackerItemNotFound");
  assert.equal((await failure(none, (t) => t.read(id("01"))))._tag, "TrackerItemNotFound");
  assert.equal(none.sent().length, 0);
});

test("read of a closed issue without a stage label is TrackerBodyInvalid; of an ambiguous one TrackerStateAmbiguous", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/1`]: json(issue(1, ["bug"], { state: "closed" })), [`GET ${ISSUES}/2`]: json(issue(2, [LABELS.implementing, LABELS.refined])) }));
  assert.equal((await failure(stub, (t) => t.read(id("1"))))._tag, "TrackerBodyInvalid");
  assert.equal((await failure(stub, (t) => t.read(id("2"))))._tag, "TrackerStateAmbiguous");
});

test("every request carries the bearer token and GitHub's headers", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([]), [`GET ${ISSUES}/1`]: json(issue(1, [])) }));
  await withTracker(stub, (t) => Effect.andThen(t.list("refined"), t.read(id("1"))));
  assert.equal(stub.sent().length, 2);
  for (const r of stub.sent()) {
    assert.equal(r.headers.authorization, "Bearer github_pat_SECRET123");
    assert.equal(r.headers.accept, "application/vnd.github+json");
    assert.equal(r.headers["x-github-api-version"], "2022-11-28");
    assert.equal(r.headers["user-agent"], "Interloq");
  }
});

// S8: the writes, and the tracker built from the configuration and the environment.
const refinement = (text: string) => Result.getOrThrow(refinementOf(text));
const patches = (stub: Stub): readonly SentRequest[] => stub.sent().filter((r) => r.method === "PATCH");
const patchBody = (r: SentRequest): Record<string, unknown> => JSON.parse(r.body ?? "null");

test("a refinement is PATCHed into the body after the developer's text, which stays intact, and reads back", async () => {
  const developer = "What the developer wrote.\r\n\r\nTrailing spaces   ";
  const stub = makeStub(route({ [`GET ${ISSUES}/12`]: json(issue(12, [], { body: developer })), [`PATCH ${ISSUES}/12`]: json(issue(12, [])) }));
  const r = refinement("## Plan\n\n- one\n- two");
  await withTracker(stub, (t) => t.writeRefinement(id("12"), r));
  const [patch] = patches(stub);
  assert.equal(patch.url.toString(), `${ISSUES}/12`);
  assert.equal(patch.headers.authorization, "Bearer github_pat_SECRET123");
  const body = String(patchBody(patch).body);
  assert.deepEqual(Object.keys(patchBody(patch)), ["body"]);
  assert.deepEqual(Result.getOrThrow(readRefinement(body)), Option.some(r));
  assert.equal(Result.getOrThrow(withoutRefinement(body)), developer);
});

test("a second refinement replaces the first; a null body takes the section alone", async () => {
  const first = Result.getOrThrow(withRefinement("text", refinement("first")));
  const stub = makeStub(route({ [`GET ${ISSUES}/1`]: json(issue(1, [], { body: first })), [`GET ${ISSUES}/2`]: json(issue(2, [], { body: null })), [`PATCH ${ISSUES}/1`]: json({}), [`PATCH ${ISSUES}/2`]: json({}) }));
  await withTracker(stub, (t) => Effect.andThen(t.writeRefinement(id("1"), refinement("second")), t.writeRefinement(id("2"), refinement("only"))));
  const [one, two] = patches(stub).map((p) => String(patchBody(p).body));
  assert.deepEqual(Result.getOrThrow(readRefinement(one)), Option.some(refinement("second")));
  assert.equal(Result.getOrThrow(withoutRefinement(one)), "text");
  assert.equal(Result.getOrThrow(withoutRefinement(two)), "");
});

test("a body with a malformed section is TrackerBodyInvalid and nothing is PATCHed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/3`]: json(issue(3, [], { body: "x\n\n## Refined using Interloq\nno end" })) }));
  assert.equal((await failure(stub, (t) => t.writeRefinement(id("3"), refinement("r"))))._tag, "TrackerBodyInvalid");
  assert.equal(patches(stub).length, 0);
});

test("a state change sends one PATCH of the full label set: the old stage label removed, the new one added, others kept", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/4`]: json(issue(4, ["bug", LABELS.implementing])), [`GET ${ISSUES}/5`]: json(issue(5, [])), [`PATCH ${ISSUES}/4`]: json({}), [`PATCH ${ISSUES}/5`]: json({}) }));
  await withTracker(stub, (t) => Effect.andThen(t.setState(id("4"), "refined"), t.setState(id("5"), "implementing")));
  assert.deepEqual(patches(stub).map(patchBody), [{ labels: ["bug", LABELS.refined] }, { labels: [LABELS.implementing] }]);
});

test("a state change of an ambiguous issue is TrackerStateAmbiguous and nothing is PATCHed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/6`]: json(issue(6, [LABELS.implementing, LABELS.refined])) }));
  assert.equal((await failure(stub, (t) => t.setState(id("6"), "implementing")))._tag, "TrackerStateAmbiguous");
  assert.equal(patches(stub).length, 0);
});

// W1-R1-1: an item the port cannot read is not one it may write.
test("a refinement of an ambiguous issue is TrackerStateAmbiguous and nothing is PATCHed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/8`]: json(issue(8, [LABELS.implementing, LABELS.refined])), [`PATCH ${ISSUES}/8`]: json({}) }));
  assert.equal((await failure(stub, (t) => t.writeRefinement(id("8"), refinement("r"))))._tag, "TrackerStateAmbiguous");
  assert.equal(patches(stub).length, 0);
});

test("a refinement or a state change of a closed issue without a stage label is TrackerBodyInvalid and nothing is PATCHed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/9`]: json(issue(9, ["bug"], { state: "closed" })), [`PATCH ${ISSUES}/9`]: json({}) }));
  assert.equal((await failure(stub, (t) => t.writeRefinement(id("9"), refinement("r"))))._tag, "TrackerBodyInvalid");
  assert.equal((await failure(stub, (t) => t.setState(id("9"), "implementing")))._tag, "TrackerBodyInvalid");
  assert.equal(patches(stub).length, 0);
});

test("a PATCH refused for the token is TrackerAuthRefused", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [])), [`PATCH ${ISSUES}/7`]: json({ message: "Resource not accessible" }, 403) }));
  assert.equal((await failure(stub, (t) => t.setState(id("7"), "implementing")))._tag, "TrackerAuthRefused");
});

test("githubTrackerFrom refuses an absent credential before any request", () => {
  const absent = githubTrackerFrom(CONFIG, {});
  assert.ok(Result.isFailure(absent));
  assert.deepEqual(absent.failure._tag === "TrackerCredentialMissing" && absent.failure.variable, "INTERLOQ_GITHUB_TOKEN");
});

test("the four operations in sequence through Tracker, built from the config and the environment, over one stub GitHub", async () => {
  const state = new Map<number, Record<string, unknown>>([[1, issue(1, ["bug"], { body: "Do it." })], [2, issue(2, [LABELS.refined])]]);
  const stub = makeStub((r) => {
    const n = Number(r.url.pathname.split("/").at(-1));
    if (r.method === "GET" && r.url.pathname.endsWith("/issues")) {
      const label = r.url.searchParams.get("labels");
      return json([...state.values()].filter((i) => label === null || (i.labels as { name: string }[]).some((l) => l.name === label)));
    }
    if (r.method === "GET") return state.has(n) ? json(state.get(n)) : json({}, 404);
    const patch = patchBody(r);
    const next = { ...state.get(n), ...("labels" in patch ? { labels: (patch.labels as string[]).map((name) => ({ name })) } : patch) };
    state.set(n, next);
    return json(next);
  });
  const layer = Layer.provide(Result.getOrThrow(githubTrackerFrom(CONFIG, { INTERLOQ_GITHUB_TOKEN: "github_pat_SECRET123" })), stub.layer);
  const program = Effect.gen(function* () {
    const tracker = yield* Tracker;
    const before = yield* tracker.list("unrefined");
    const item = yield* tracker.read(before[0].id);
    yield* tracker.writeRefinement(item.id, refinement("Refined."));
    yield* tracker.setState(item.id, "refined");
    return { before, after: yield* tracker.list("refined"), unrefined: yield* tracker.list("unrefined") };
  });
  const { before, after, unrefined } = await Effect.runPromise(Effect.provide(program, layer));
  assert.deepEqual(ids(before), ["1"]);
  assert.deepEqual(ids(after), ["1", "2"]);
  assert.deepEqual(unrefined, []);
  assert.deepEqual(Result.getOrThrow(readRefinement(after[0].body)), Option.some(refinement("Refined.")));
  assert.ok(after[0].body.startsWith("Do it."));
  for (const r of stub.sent()) assert.equal(r.headers.authorization, "Bearer github_pat_SECRET123");
});

// Issue #186, requirements Q3: a comment on an item, and the listing of its comments.
const commentOf = (body: string | null, created: string): Record<string, unknown> => ({ id: 1, body, created_at: created, user: { login: "mackler" } });

test("a comment is one POST of its text to the issue's comments, after the issue is read", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [LABELS.implementing])), [`POST ${ISSUES}/7/comments`]: json(commentOf("sent back", "2026-10-29T00:00:00Z"), 201) }));
  await withTracker(stub, (t) => t.comment(id("7"), "sent back"));
  const posts = stub.sent().filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.pathname, "/repos/mackler/interloq/issues/7/comments");
  assert.deepEqual(JSON.parse(posts[0].body ?? ""), { body: "sent back" });
});

test("a comment on an ambiguous issue is TrackerStateAmbiguous and nothing is POSTed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [LABELS.refined, LABELS.implementing])) }));
  assert.equal((await failure(stub, (t) => t.comment(id("7"), "x")))._tag, "TrackerStateAmbiguous");
  assert.ok(stub.sent().every((r) => r.method === "GET"));
});

test("an issue's comments follow the Link header to the second page, joined in order, a null body read as empty", async () => {
  const page2 = `${ISSUES}/7/comments?per_page=100&page=2`;
  const stub = makeStub((r) =>
    r.url.searchParams.get("page") === "2"
      ? json([commentOf("third", "2026-10-03T00:00:00Z")])
      : json([commentOf("first", "2026-10-01T00:00:00Z"), commentOf(null, "2026-10-02T00:00:00Z")], 200, { link: `<${page2}>; rel="next"` }),
  );
  const comments = await withTracker(stub, (t) => t.comments(id("7")));
  assert.deepEqual(comments, [
    { id: "1", body: "first", created: "2026-10-01T00:00:00Z" },
    { id: "1", body: "", created: "2026-10-02T00:00:00Z" },
    { id: "1", body: "third", created: "2026-10-03T00:00:00Z" },
  ]);
  assert.equal(stub.sent()[0].url.pathname, "/repos/mackler/interloq/issues/7/comments");
  assert.equal(stub.sent()[0].url.searchParams.get("per_page"), "100");
});

test("the comments of an issue GitHub does not have, or of an id outside its format, are TrackerItemNotFound", async () => {
  const stub = makeStub(route({}));
  assert.equal((await failure(stub, (t) => t.comments(id("7"))))._tag, "TrackerItemNotFound");
  assert.equal((await failure(stub, (t) => t.comments(id("x7"))))._tag, "TrackerItemNotFound");
});

test("a 500 on a comment's POST is TrackerUnreachable with its status", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [])), [`POST ${ISSUES}/7/comments`]: json({ message: "oops" }, 500) }));
  const error = await failure(stub, (t) => t.comment(id("7"), "x"));
  assert.deepEqual(error._tag === "TrackerUnreachable" && error.status, 500);
});

test("the token is in no error the adapter produced", () => {
  assert.ok(errors.length >= 10);
  for (const error of errors) assert.ok(!`${JSON.stringify(error)} ${String(error)} ${error.message}`.includes("SECRET123"), JSON.stringify(error));
});
