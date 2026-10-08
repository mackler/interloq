import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { githubTracker } from "../src/github.ts";
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
export const issue = (number: number, labels: readonly string[], more: Record<string, unknown> = {}): Record<string, unknown> => ({ number, title: `issue ${number}`, body: `body ${number}`, state: "open", labels: labels.map((name) => ({ id: number, name, color: "ededed" })), user: { login: "mackler" }, ...more });

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
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(5, [LABELS.refining, "bug"])]) }));
  const items = await withTracker(stub, (t) => t.list("refining"));
  assert.deepEqual(items, [{ id: id("5"), title: "issue 5", body: "body 5", state: "refining" }]);
  const params = stub.sent()[0].url.searchParams;
  assert.equal(params.get("state"), "open");
  assert.equal(params.get("labels"), LABELS.refining);
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

test("a transport failure, a 500 and a 404 on the repository are TrackerUnreachable", async () => {
  for (const answer of ["transport", json({}, 500), json({ message: "Not Found" }, 404)] as const) {
    const error = await failure(makeStub(() => answer), (t) => t.list("refined"));
    assert.equal(error._tag, "TrackerUnreachable");
  }
});

test("a body that is not JSON, or not issues, is TrackerBodyInvalid", async () => {
  for (const answer of [new Response("<html>", { status: 200 }), json([{ number: "one" }]), json({ message: "x" })]) {
    const error = await failure(makeStub(() => answer), (t) => t.list("unrefined"));
    assert.equal(error._tag, "TrackerBodyInvalid");
  }
});

test("read gives an issue with its state; a closed issue with one stage label has it", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [LABELS.implemented], { body: null, state: "closed" })) }));
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("7"))), { id: id("7"), title: "issue 7", body: "", state: "implemented" });
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
  const stub = makeStub(route({ [`GET ${ISSUES}/1`]: json(issue(1, ["bug"], { state: "closed" })), [`GET ${ISSUES}/2`]: json(issue(2, [LABELS.refining, LABELS.refined])) }));
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

test("the token is in no error the adapter produced", () => {
  assert.ok(errors.length >= 10);
  for (const error of errors) assert.ok(!`${JSON.stringify(error)} ${String(error)} ${error.message}`.includes("SECRET123"), JSON.stringify(error));
});
