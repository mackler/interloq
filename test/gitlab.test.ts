import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Effect, Layer, Option, Result } from "effect";
import { trackerFailureText } from "../src/errors.ts";
import { gitlabTracker, gitlabTrackerFrom } from "../src/gitlab.ts";
import { GITLAB_DESCRIPTION_LIMIT } from "../src/gitlabIssues.ts";
import { readRefinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { Tracker } from "../src/services.ts";
import type { GitlabTrackerConfig } from "../src/schema.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import { commentIdOf, type ItemId, itemIdOf } from "../src/tracker.ts";
import { type GitlabToken, gitlabCredential } from "../src/trackerConfig.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";
import { gitlabServer, serverIssue } from "./fakeGitlab.ts";
import { type Answer, json, makeStub, type SentRequest, type Stub } from "./stubHttp.ts";

// The GitLab adapter over a stub HTTP client, asserting the requests it sends as well as what it returns.
const SECRET = "glpat-SECRET123";
const TOKEN: GitlabToken = Result.getOrThrow(gitlabCredential({ INTERLOQ_GITLAB_TOKEN: SECRET }));
const CONFIG: GitlabTrackerConfig = { kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS, prepareLabel: null };
const ISSUES = "https://gitlab.com/api/v4/projects/adammackler%2Fiou-notes/issues";
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));

/** A GitLab issue object with the fields GitLab sends and a few it sends that the adapter ignores. */
export const issue = (iid: number, labels: readonly string[], more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 9000 + iid, iid, project_id: 77, title: `issue ${iid}`, description: `body ${iid}`, state: "opened", labels: [...labels], author: { username: "adammackler" }, web_url: pageOf(iid), ...more,
});
/** An issue's page on gitlab.com, as GitLab sends it in `web_url`. */
const pageOf = (iid: number): string => `https://gitlab.com/${PROJECT}/-/issues/${iid}`;

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
    assert.deepEqual(items, [{ id: id("5"), title: "issue 5", body: "body 5", state, url: Option.some(pageOf(5)) }]);
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
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("7"))), { id: id("7"), title: "issue 7", body: "", state: "implementing", url: Option.some(pageOf(7)) });
  assert.deepEqual(await withTracker(stub, (t) => t.read(id("8"))), { id: id("8"), title: "issue 8", body: "body 8", state: "deployed", url: Option.some(pageOf(8)) });
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

// Issue #171: a 5xx is TrackerUnreachable with its status, a transport failure with none; a 404 on the listing (a wrong
// project), a 422 and a 429 are TrackerRequestRefused, never repeated; a 404 on a read TrackerItemNotFound.
test("a 500, a 503 and a transport failure are TrackerUnreachable; a 404 on the listing, a 422 and a 429 TrackerRequestRefused; a 404 on a read TrackerItemNotFound", async () => {
  for (const filtered of [false, true]) {
    for (const status of [500, 503]) {
      const error = await failure(makeStub(() => json({}, status), { filtered }), (t) => t.list("refined"));
      assert.deepEqual(error._tag === "TrackerUnreachable" && error.status, status);
    }
    const unreached = await failure(makeStub(() => "transport", { filtered }), (t) => t.list("refined"));
    assert.equal(unreached._tag === "TrackerUnreachable" && unreached.status, null);
    for (const status of [404, 422, 429]) {
      const error = await failure(makeStub(() => json({ message: "x" }, status), { filtered }), (t) => t.list("refined"));
      assert.deepEqual(error._tag === "TrackerRequestRefused" && error.status, status);
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

// The writes: one PUT with a JSON body, after the GET that read refuses through; a closed issue is never reopened.
const refinement = (text: string) => Result.getOrThrow(refinementOf(text));
const puts = (stub: Stub): readonly SentRequest[] => stub.sent().filter((r) => r.method === "PUT");
const putBody = (r: SentRequest): Record<string, unknown> => JSON.parse(r.body ?? "null");
const serverStub = (...issues: Parameters<typeof serverIssue>[]) => {
  const server = gitlabServer(issues.map((args) => serverIssue(...args)));
  return { server, stub: makeStub(server.handler) };
};

test("a state change PUTs one JSON body that adds the state's label and removes the other three, other labels kept", async () => {
  const { server, stub } = serverStub([4, ["bug", "Unrefined"]]);
  await withTracker(stub, (t) => t.setState(id("4"), "refined"));
  assert.deepEqual(stub.sent().map(where), [`GET ${ISSUES}/4`, `PUT ${ISSUES}/4`]);
  const [put] = puts(stub);
  assert.equal(put.headers["content-type"], "application/json");
  assert.deepEqual(putBody(put), { add_labels: "Refined", remove_labels: "Unrefined,Implementing,Implemented" });
  assert.equal([...put.url.searchParams].length, 0);
  assert.deepEqual(server.issues().get(4)?.labels, ["bug", "Refined"]);
});

test("deployed on an open issue PUTs the close alone; on a closed issue it succeeds with one GET and no PUT", async () => {
  const { server, stub } = serverStub([5, ["Implemented"]], [6, ["Implemented"], { state: "closed" }]);
  await withTracker(stub, (t) => Effect.andThen(t.setState(id("5"), "deployed"), t.setState(id("6"), "deployed")));
  assert.deepEqual(stub.sent().map(where), [`GET ${ISSUES}/5`, `PUT ${ISSUES}/5`, `GET ${ISSUES}/6`]);
  assert.deepEqual(putBody(puts(stub)[0]), { state_event: "close" });
  assert.equal(server.issues().get(5)?.state, "closed");
});

test("setState to each state but deployed on a closed issue sends one GET, no PUT, and fails naming the closed issue", async () => {
  for (const state of ["unrefined", "refined", "implementing", "implemented"] as const) {
    const { server, stub } = serverStub([42, ["Implementing"], { state: "closed" }]);
    const error = await failure(stub, (t) => t.setState(id("42"), state));
    assert.deepEqual(stub.sent().map(where), [`GET ${ISSUES}/42`], state);
    assert.equal(error._tag, "TrackerBodyInvalid");
    assert.equal(error._tag === "TrackerBodyInvalid" && error.message, `issue #42 is closed, and Interloq never reopens a closed issue, so its state was not set to ${state}`);
    assert.equal(server.issues().get(42)?.state, "closed");
  }
});

test("writeRefinement on a closed issue sends one GET, no PUT, and fails naming the closed issue", async () => {
  const { server, stub } = serverStub([43, ["Unrefined"], { state: "closed", description: "Text." }]);
  const error = await failure(stub, (t) => t.writeRefinement(id("43"), refinement("r")));
  assert.deepEqual(stub.sent().map(where), [`GET ${ISSUES}/43`]);
  assert.equal(error._tag === "TrackerBodyInvalid" && error.message, "issue #43 is closed, and Interloq never reopens a closed issue, so the refinement was not written");
  assert.equal(server.issues().get(43)?.description, "Text.");
});

test("a refinement is PUT as the description after the developer's text, which stays intact, and reads back", async () => {
  const developer = "What the developer wrote.\r\n\r\nTrailing spaces   ";
  const { stub } = serverStub([12, ["Unrefined"], { description: developer }]);
  const r = refinement("## Plan\n\n- one\n- two");
  await withTracker(stub, (t) => t.writeRefinement(id("12"), r));
  const [put] = puts(stub);
  assert.equal(where(put), `PUT ${ISSUES}/12`);
  assert.deepEqual(Object.keys(putBody(put)), ["description"]);
  const body = String(putBody(put).description);
  assert.deepEqual(Result.getOrThrow(readRefinement(body)), Option.some(r));
  assert.equal(Result.getOrThrow(withoutRefinement(body)), developer);
  assert.equal(await withTracker(stub, (t) => Effect.map(t.read(id("12")), (item) => item.body)), body);
});

test("a second refinement replaces the first; a null description takes the section alone", async () => {
  const first = Result.getOrThrow(withRefinement("text", refinement("first")));
  const { stub } = serverStub([1, ["Unrefined"], { description: first }], [2, ["Unrefined"], { description: null }]);
  await withTracker(stub, (t) => Effect.andThen(t.writeRefinement(id("1"), refinement("second")), t.writeRefinement(id("2"), refinement("only"))));
  const [one, two] = puts(stub).map((p) => String(putBody(p).description));
  assert.deepEqual(Result.getOrThrow(readRefinement(one)), Option.some(refinement("second")));
  assert.equal(Result.getOrThrow(withoutRefinement(one)), "text");
  assert.equal(Result.getOrThrow(withoutRefinement(two)), "");
});

test("a malformed section and a description over GitLab's limit are TrackerBodyInvalid and nothing is PUT", async () => {
  const { stub } = serverStub([3, ["Unrefined"], { description: "x\n\n## Refined using Interloq\nno end" }], [4, ["Unrefined"], { description: "d".repeat(GITLAB_DESCRIPTION_LIMIT) }]);
  const malformed = await failure(stub, (t) => t.writeRefinement(id("3"), refinement("r")));
  assert.match(malformed._tag === "TrackerBodyInvalid" ? malformed.message : "", /Refined using Interloq/u);
  const long = await failure(stub, (t) => t.writeRefinement(id("4"), refinement("r")));
  assert.match(long._tag === "TrackerBodyInvalid" ? long.message : "", /more than GitLab's limit of 1000000/u);
  assert.equal(puts(stub).length, 0);
});

test("writes on an ambiguous or an unlabeled open issue PUT nothing", async () => {
  const { stub } = serverStub([8, ["Implementing", "Refined"]], [9, ["bug"]]);
  for (const n of ["8", "9"]) {
    assert.notEqual((await failure(stub, (t) => t.writeRefinement(id(n), refinement("r"))))._tag, "TrackerUnreachable");
    assert.notEqual((await failure(stub, (t) => t.setState(id(n), "implementing")))._tag, "TrackerUnreachable");
  }
  assert.equal(puts(stub).length, 0);
});

test("a PUT refused for the token is TrackerAuthRefused", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, ["Refined"])), [`PUT ${ISSUES}/7`]: json({ message: "403 Forbidden" }, 403) }));
  assert.equal((await failure(stub, (t) => t.setState(id("7"), "implementing")))._tag, "TrackerAuthRefused");
});

test("gitlabTrackerFrom refuses an absent or blank INTERLOQ_GITLAB_TOKEN before any request, naming the variable", () => {
  for (const env of [{}, { INTERLOQ_GITLAB_TOKEN: " " }]) {
    const refused = gitlabTrackerFrom(CONFIG, env);
    assert.ok(Result.isFailure(refused));
    assert.equal(refused.failure.variable, "INTERLOQ_GITLAB_TOKEN");
  }
});

test("the four operations in sequence through Tracker, built from the config and the environment, over one stub GitLab", async () => {
  const { server, stub } = serverStub([1, ["Unrefined", "bug"], { description: "Do it." }], [2, ["Refined"]]);
  const layer = Layer.provide(Result.getOrThrow(gitlabTrackerFrom(CONFIG, { INTERLOQ_GITLAB_TOKEN: SECRET })), stub.layer);
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
  assert.deepEqual(server.issues().get(1)?.labels, ["bug", "Refined"]);
  for (const r of stub.sent()) assert.equal(r.headers["private-token"], SECRET);
});


// A refused connection sent nothing and is tried again, at most three attempts in all; any other transport failure
// may have reached GitLab and is not.
const refusedThen = (times: number, then: Answer): Stub => {
  let left = times;
  return makeStub(() => (left-- > 0 ? "refused" : then));
};

test("a GET refused twice and then answered succeeds after exactly three requests", async () => {
  const stub = refusedThen(2, json(issue(1, ["Refined"])));
  assert.equal((await withTracker(stub, (t) => t.read(id("1")))).state, "refined");
  assert.equal(stub.sent().length, 3);
});

test("a PUT refused twice and then answered succeeds after exactly three PUTs", async () => {
  let puts = 0;
  const stub = makeStub((r) => (r.method === "GET" ? json(issue(1, ["Refined"])) : puts++ < 2 ? "refused" : json(issue(1, ["Implementing"]))));
  await withTracker(stub, (t) => t.setState(id("1"), "implementing"));
  assert.deepEqual(stub.sent().map((r) => r.method), ["GET", "PUT", "PUT", "PUT"]);
});

test("a request refused three times fails TrackerUnreachable after exactly three requests", async () => {
  const stub = refusedThen(3, json(issue(1, ["Refined"])));
  assert.equal((await failure(stub, (t) => t.read(id("1"))))._tag, "TrackerUnreachable");
  assert.equal(stub.sent().length, 3);
});

test("a transport failure that is not a refused connection is not retried", async () => {
  const stub = makeStub(() => "transport");
  assert.equal((await failure(stub, (t) => t.read(id("1"))))._tag, "TrackerUnreachable");
  assert.equal(stub.sent().length, 1);
});

test("a refused connection mixed with a reset, as one aggregate, is sent once and not retried (W1-R1-1)", async () => {
  const stub = makeStub(() => "refusedMixed");
  assert.equal((await failure(stub, (t) => t.read(id("1"))))._tag, "TrackerUnreachable");
  assert.equal(stub.sent().length, 1);
});

// Issue #186, requirements Q3: a note on an issue, and the listing of its notes.
const note = (id: number, body: string, system = false): Record<string, unknown> => ({ id, body, created_at: `2026-10-0${id}T00:00:00Z`, system, author: { username: "adammackler" } });

test("a comment is one POST of its text to the issue's notes, after the issue is read", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [GITLAB_LABELS.implementing])), [`POST ${ISSUES}/7/notes`]: json(note(1, "sent back"), 201) }));
  await withTracker(stub, (t) => t.comment(id("7"), "sent back"));
  const posts = stub.sent().filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(where(posts[0]), `POST ${ISSUES}/7/notes`);
  assert.deepEqual(JSON.parse(posts[0].body ?? ""), { body: "sent back" });
  assert.ok(stub.sent().every((r) => !r.url.toString().includes(SECRET)));
});

test("a comment on a closed issue is TrackerBodyInvalid after one GET, and nothing is POSTed", async () => {
  const stub = makeStub(route({ [`GET ${ISSUES}/7`]: json(issue(7, [GITLAB_LABELS.implementing], { state: "closed" })) }));
  assert.equal((await failure(stub, (t) => t.comment(id("7"), "x")))._tag, "TrackerBodyInvalid");
  assert.deepEqual(stub.sent().map((r) => r.method), ["GET"]);
});

test("an issue's notes are listed oldest first across pages, without GitLab's system notes", async () => {
  const stub = makeStub((r) =>
    r.url.searchParams.get("page") === "2"
      ? json([note(3, "third"), note(4, "added label", true)])
      : json([note(1, "first"), note(2, "changed the description", true)], 200, { "x-next-page": "2" }),
  );
  const comments = await withTracker(stub, (t) => t.comments(id("7")));
  assert.deepEqual(comments, [
    { id: "1", body: "first", created: "2026-10-01T00:00:00Z" },
    { id: "3", body: "third", created: "2026-10-03T00:00:00Z" },
  ]);
  const params = stub.sent()[0].url.searchParams;
  assert.equal(where(stub.sent()[0]), `GET ${ISSUES}/7/notes`);
  assert.deepEqual([params.get("per_page"), params.get("sort"), params.get("order_by"), params.get("page")], ["100", "asc", "created_at", "1"]);
});

test("a page of notes that repeats a note fails the listing", async () => {
  const stub = makeStub((r) => (r.url.searchParams.get("page") === "2" ? json([note(1, "first")]) : json([note(1, "first")], 200, { "x-next-page": "2" })));
  assert.equal((await failure(stub, (t) => t.comments(id("7"))))._tag, "TrackerBodyInvalid");
});

test("over the stub GitLab, a note written is listed and a relabel's system note is not", async () => {
  const server = gitlabServer([serverIssue(7, [GITLAB_LABELS.implementing])]);
  const stub = makeStub(server.handler);
  const comments = await withTracker(stub, (t) => Effect.andThen(t.comment(id("7"), "sent back"), Effect.andThen(t.setState(id("7"), "unrefined"), t.comments(id("7")))));
  assert.deepEqual(comments.map((c) => c.body), ["sent back"]);
  assert.equal(stub.sent().filter((r) => r.url.pathname.endsWith("/notes")).length, 2);
});

test("the token is in no error the adapter produced", () => {
  assert.ok(errors.length >= 20);
  for (const error of errors) {
    const shown = `${JSON.stringify(error)} ${String(error)} ${error.message} ${trackerFailureText(error)}`;
    assert.ok(!shown.includes("SECRET123"), JSON.stringify(error));
  }
});

// Issue #131: Interloq deletes its own notes; a note already gone counts as deleted, and a closed issue is no refusal.
const noteId = (text: string) => Result.getOrThrow(commentIdOf(text));
test("deleteComment sends one DELETE of the issue's note with PRIVATE-TOKEN, and a 204 succeeds", async () => {
  const stub = makeStub(route({ [`DELETE ${ISSUES}/7/notes/55`]: new Response(null, { status: 204 }) }));
  await withTracker(stub, (t) => t.deleteComment(id("7"), noteId("55")));
  assert.equal(stub.sent().length, 1);
  assert.equal(stub.sent()[0].method, "DELETE");
  assert.equal(stub.sent()[0].headers["private-token"], SECRET);
});
test("deleteComment of a note already gone (404) succeeds", async () => {
  const stub = makeStub(() => json({ message: "404 Not found" }, 404));
  await withTracker(stub, (t) => t.deleteComment(id("7"), noteId("55")));
});
test("deleteComment of a refused connection is tried again, as every request is", async () => {
  let n = 0;
  const stub = makeStub(() => (n++ === 0 ? "refused" : new Response(null, { status: 204 })));
  await withTracker(stub, (t) => t.deleteComment(id("7"), noteId("55")));
  assert.equal(stub.sent().length, 2);
});
test("deleteComment with an id outside GitLab's format sends nothing and is TrackerItemNotFound", async () => {
  const stub = makeStub(() => new Response(null, { status: 204 }));
  assert.equal((await failure(stub, (t) => t.deleteComment(id("x"), noteId("55"))))._tag, "TrackerItemNotFound");
  assert.equal((await failure(stub, (t) => t.deleteComment(id("7"), noteId("c-1"))))._tag, "TrackerItemNotFound");
  assert.equal(stub.sent().length, 0);
});

// Issue #131 (requirements Q3, F2): the open items in a state that carry the preparation's mark, newest first.
const MARKED: GitlabTrackerConfig = { ...CONFIG, prepareLabel: "Prepare" };
const withMarked = <A, E>(stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.flatMap(gitlabTracker(MARKED, TOKEN), use).pipe(Effect.provide(stub.layer)));
test("listMarked asks for the state's label and the mark, open, newest first, paged by X-Next-Page", async () => {
  const stub = makeStub((r) => (r.url.searchParams.get("page") === "2" ? json([issue(3, ["Unrefined", "Prepare"])], 200, { "x-next-page": "" }) : json([issue(9, ["Unrefined", "Prepare"])], 200, { "x-next-page": "2" })));
  assert.deepEqual(ids(await withMarked(stub, (t) => t.listMarked("unrefined"))), ["9", "3"]);
  const params = stub.sent()[0].url.searchParams;
  assert.deepEqual([params.get("labels"), params.get("state"), params.get("order_by"), params.get("sort"), params.get("per_page"), params.get("page")], [`${GITLAB_LABELS.unrefined},Prepare`, "opened", "created_at", "desc", "100", "1"]);
});
test("listMarked of deployed, or with no preparation label configured, sends nothing", async () => {
  const stub = makeStub(() => json([issue(1, [])]));
  assert.deepEqual(await withMarked(stub, (t) => t.listMarked("deployed")), []);
  assert.deepEqual(await withTracker(stub, (t) => t.listMarked("unrefined")), []);
  assert.equal(stub.sent().length, 0);
});
