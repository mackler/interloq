import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Effect, Result } from "effect";
import { gitlabTracker } from "../src/gitlab.ts";
import type { GitlabTrackerConfig } from "../src/schema.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { type GitlabToken, gitlabCredential } from "../src/trackerConfig.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";
import { type Answer, json, makeStub, type SentRequest, type Stub } from "./stubHttp.ts";

// The GitLab adapter over a stub HTTP client, asserting the requests it sends as well as what it returns.
const SECRET = "glpat-SECRET123";
const TOKEN: GitlabToken = Result.getOrThrow(gitlabCredential({ INTERLOQ_GITLAB_TOKEN: SECRET }));
const CONFIG: GitlabTrackerConfig = { kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS };
const ISSUES = "https://gitlab.com/api/v4/projects/adammackler%2Fiou-notes/issues";
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));

/** A GitLab issue object with the fields GitLab sends and a few it sends that the adapter ignores. */
export const issue = (iid: number, labels: readonly string[], more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 9000 + iid, iid, project_id: 77, title: `issue ${iid}`, description: `body ${iid}`, state: "opened", labels: [...labels], author: { username: "adammackler" }, ...more,
});

/** Every error the tests produced, so that the last test can look for the token in them. */
export const errors: TrackerError[] = [];
const withTracker = <A, E>(stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.flatMap(gitlabTracker(CONFIG, TOKEN), use).pipe(Effect.provide(stub.layer)));
const failure = async (stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<unknown, TrackerError>): Promise<TrackerError> => {
  const error: TrackerError = await withTracker(stub, (t) => Effect.flip(use(t)));
  errors.push(error);
  return error;
};
const route = (table: Readonly<Record<string, Answer>>) => (r: SentRequest): Answer => table[`${r.method} ${r.url.origin}${r.url.pathname}`] ?? json({ message: "404 Not found" }, 404);
const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);
const where = (r: SentRequest): string => `${r.method} ${r.url.origin}${r.url.pathname}`;

test("a labeled state asks GitLab for the project's open issues with its label, 100 a page from page 1", async () => {
  for (const state of ["unrefined", "refined", "implementing", "implemented"] as const) {
    const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(5, [GITLAB_LABELS[state], "bug"])]) }));
    const items = await withTracker(stub, (t) => t.list(state));
    assert.deepEqual(items, [{ id: id("5"), title: "issue 5", body: "body 5", state }]);
    const [sent] = stub.sent();
    assert.equal(where(sent), `GET ${ISSUES}`);
    assert.deepEqual(Object.fromEntries(sent.url.searchParams), { state: "opened", labels: GITLAB_LABELS[state], per_page: "100", page: "1" });
  }
});

test("deployed lists nothing and sends no request, since a deployed item is a closed issue", async () => {
  const stub = makeStub(() => json([issue(1, [])]));
  assert.deepEqual(await withTracker(stub, (t) => t.list("deployed")), []);
  assert.equal(stub.sent().length, 0);
});

test("a listing follows X-Next-Page to its second page and concatenates both", async () => {
  const stub = makeStub((r) => (r.url.searchParams.get("page") === "2" ? json([issue(3, ["Refined"])], 200, { "x-next-page": "" }) : json([issue(1, ["Refined"]), issue(2, ["Refined"])], 200, { "x-next-page": "2" })));
  assert.deepEqual(ids(await withTracker(stub, (t) => t.list("refined"))), ["1", "2", "3"]);
  assert.deepEqual(stub.sent().map((r) => r.url.searchParams.get("page")), ["1", "2"]);
});

test("a server that ignores the page parameter fails the listing after two requests", async () => {
  const stub = makeStub(() => json([issue(1, ["Refined"])], 200, { "x-next-page": "2" }));
  const error = await failure(stub, (t) => t.list("refined"));
  assert.equal(error._tag, "TrackerBodyInvalid");
  assert.match(error._tag === "TrackerBodyInvalid" ? error.message : "", /issue #1 came twice/u);
  assert.equal(stub.sent().length, 2);
});

test("an issue with two state labels fails the whole listing, naming the issue and its state labels", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, ["Refined"]), issue(9, ["Refined", "bug", "Implementing"])]) }));
  const error = await failure(stub, (t) => t.list("refined"));
  assert.equal(error._tag, "TrackerStateAmbiguous");
  assert.deepEqual(error._tag === "TrackerStateAmbiguous" && { id: error.id, labels: error.labels }, { id: "9", labels: ["Refined", "Implementing"] });
});

test("an open issue without a state label in a listing, which only a server ignoring labels returns, fails it by name", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(4, ["bug"])]) }));
  const error = await failure(stub, (t) => t.list("refined"));
  assert.equal(error._tag, "TrackerBodyInvalid");
  assert.match(error._tag === "TrackerBodyInvalid" ? `${error.id} ${error.message}` : "", /4 issue #4 .*"bug"/u);
});

test("read gives an issue with its one label's state, and a closed issue as deployed", async () => {
  const stub = makeStub(route({
    [`GET ${ISSUES}/7`]: json(issue(7, ["Implementing", "bug"], { description: null })),
    [`GET ${ISSUES}/8`]: json(issue(8, ["Refined"], { state: "closed" })),
  }));
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("7"))), { id: id("7"), title: "issue 7", body: "", state: "implementing" });
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("8"))), { id: id("8"), title: "issue 8", body: "body 8", state: "deployed" });
  assert.deepEqual(stub.sent().map(where), [`GET ${ISSUES}/7`, `GET ${ISSUES}/8`]);
});

test("read of an open issue with no state label, or two, fails naming the issue and its labels", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/3`]: json(issue(3, [])), [`GET ${ISSUES}/4`]: json(issue(4, ["Unrefined", "Refined"])) }));
  const none = await failure(stub, (t) => t.read(id("3")));
  assert.equal(none._tag, "TrackerBodyInvalid");
  assert.match(none._tag === "TrackerBodyInvalid" ? none.message : "", /issue #3 .*no label/u);
  const two = await failure(stub, (t) => t.read(id("4")));
  assert.deepEqual(two._tag === "TrackerStateAmbiguous" && { id: two.id, labels: two.labels }, { id: "4", labels: ["Unrefined", "Refined"] });
});

test("read of an id outside GitLab's format sends nothing and is TrackerItemNotFound; a 404 is too", async () => {
  const stub = makeStub(route({}));
  for (const text of ["abc", "#4", "04"]) assert.equal((await failure(stub, (t) => t.read(id(text))))._tag, "TrackerItemNotFound", text);
  assert.equal(stub.sent().length, 0);
  assert.equal((await failure(stub, (t) => t.read(id("4"))))._tag, "TrackerItemNotFound");
  assert.equal(stub.sent().length, 1);
});

test("a 401 and a 403 are TrackerAuthRefused, not an empty list", async () => {
  for (const filtered of [false, true]) for (const status of [401, 403]) {
    const error = await failure(makeStub(() => json({ message: "401 Unauthorized" }, status), { filtered }), (t) => t.list("unrefined"));
    assert.deepEqual(error._tag === "TrackerAuthRefused" && error.status, status);
  }
});

test("a 404 on the listing (a wrong project), a 500 and a transport failure are TrackerUnreachable; a 404 on a read TrackerItemNotFound", async () => {
  for (const filtered of [false, true]) {
    for (const answer of ["transport", json({}, 500), json({ message: "404 Project Not Found" }, 404)] as const) {
      const error = await failure(makeStub(() => answer, { filtered }), (t) => t.list("refined"));
      assert.equal(error._tag, "TrackerUnreachable");
    }
    assert.equal((await failure(makeStub(() => json({ message: "404 Not found" }, 404), { filtered }), (t) => t.read(id("4"))))._tag, "TrackerItemNotFound");
  }
});

test("a body that is not JSON, not issues, or a client's decode or empty-body failure is TrackerBodyInvalid", async () => {
  for (const answer of [new Response("<html>", { status: 200 }), json([{ iid: "one" }]), json({ message: "x" }), "decode", "emptyBody"] as const) {
    assert.equal((await failure(makeStub(() => answer), (t) => t.list("unrefined")))._tag, "TrackerBodyInvalid");
  }
  for (const answer of [json({ iid: 1 }), "decode", "emptyBody"] as const) {
    assert.equal((await failure(makeStub(() => answer), (t) => t.read(id("1"))))._tag, "TrackerBodyInvalid");
  }
});

test("every request carries the token in PRIVATE-TOKEN and in no URL", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}`]: json([issue(1, ["Refined"])]), [`GET ${ISSUES}/1`]: json(issue(1, ["Refined"])) }));
  await withTracker(stub, (t) => Effect.andThen(t.list("refined"), t.read(id("1"))));
  assert.equal(stub.sent().length, 2);
  for (const r of stub.sent()) {
    assert.equal(r.headers["private-token"], SECRET);
    assert.equal(r.headers["accept"], "application/json");
    assert.ok(!r.url.toString().includes(SECRET));
  }
});

test("for any number of open issues, paged 100 at a time with X-Next-Page, the listing returns each once, in order", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 350 }), async (n) => {
    const all = Array.from({ length: n }, (_, i) => issue(i + 1, ["Implemented"]));
    const stub = makeStub((r) => {
      const page = Number(r.url.searchParams.get("page"));
      const size = Number(r.url.searchParams.get("per_page"));
      const more = page * size < n;
      return json(all.slice((page - 1) * size, page * size), 200, { "x-next-page": more ? String(page + 1) : "" });
    });
    const items = await withTracker(stub, (t) => t.list("implemented"));
    return JSON.stringify(ids(items)) === JSON.stringify(all.map((i) => String(i.iid))) && stub.sent().length === Math.max(1, Math.ceil(n / 100));
  }), { numRuns: 25, seed: 20261012 });
});
