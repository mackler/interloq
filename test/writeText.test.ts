import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Effect, Option, Ref, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { githubTracker } from "../src/github.ts";
import { gitlabTracker } from "../src/gitlab.ts";
import { GITLAB_DESCRIPTION_LIMIT } from "../src/gitlabIssues.ts";
import * as prompts from "../src/prompts.ts";
import { itemTextOf, type ItemText, readRefinement, refinementOf, withDeveloperText, withoutRefinement, withRefinement } from "../src/refinement.ts";
import type { TrackerShape } from "../src/services.ts";
import { type ItemId, itemIdOf, type TrackerItem } from "../src/tracker.ts";
import { githubCredential, gitlabCredential } from "../src/trackerConfig.ts";
import { heldTrackerEnv, landed, readCitedWithRetry, type TrackerRetryEnv, writeWithRetry } from "../src/trackerRetry.ts";
import { makeFakeTracker } from "./fakeTracker.ts";
import { fakeGitlabTracker, serverIssue } from "./fakeGitlab.ts";
import { LABELS } from "./githubLabels.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";
import { type Answer, json, makeStub, type SentRequest } from "./stubHttp.ts";
import { ScriptedUi } from "./helpers.ts";
import * as S from "../src/schema.ts";

// Issue #216: the tracker writes the developer's title and text in one request, and reads a cited issue whatever its labels.

const id = (t: string): ItemId => Result.getOrThrow(itemIdOf(t));
const text = (title: string, body: string): ItemText => Result.getOrThrow(itemTextOf(title, body));
const SECTION = Result.getOrThrow(withRefinement("old text", Result.getOrThrow(refinementOf("the requirements"))));
const GH = "https://api.github.com/repos/mackler/interloq/issues";
const GL = `https://gitlab.com/api/v4/projects/${encodeURIComponent(PROJECT)}/issues`;
const route = (table: Readonly<Record<string, Answer>>) => (r: SentRequest): Answer => table[`${r.method} ${r.url.origin}${r.url.pathname}`] ?? json({ message: "Not Found" }, 404);
const ghIssue = (n: number, labels: readonly string[], more: Record<string, unknown> = {}) => ({ number: n, title: `issue ${n}`, body: `body ${n}`, state: "open", labels: labels.map((name) => ({ name })), ...more });
const glIssue = (n: number, labels: readonly string[], more: Record<string, unknown> = {}) => ({ id: 9000 + n, iid: n, title: `issue ${n}`, description: `body ${n}`, state: "opened", labels: [...labels], ...more });
const gh = <A, E>(answer: (r: SentRequest) => Answer, use: (t: TrackerShape) => Effect.Effect<A, E>) => {
  const stub = makeStub(answer);
  const token = Result.getOrThrow(githubCredential({ INTERLOQ_GITHUB_TOKEN: "github_pat_SECRET" }));
  return { stub, run: Effect.runPromise(Effect.flatMap(githubTracker({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null, obsoleteLabel: null }, token), use).pipe(Effect.provide(stub.layer))) };
};
const gl = <A, E>(answer: (r: SentRequest) => Answer, use: (t: TrackerShape) => Effect.Effect<A, E>) => {
  const stub = makeStub(answer);
  const token = Result.getOrThrow(gitlabCredential({ INTERLOQ_GITLAB_TOKEN: "glpat-SECRET" }));
  return { stub, run: Effect.runPromise(Effect.flatMap(gitlabTracker({ kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS, prepareLabel: null, obsoleteLabel: null }, token), use).pipe(Effect.provide(stub.layer))) };
};
const bodyOf = (r: SentRequest): Record<string, unknown> => JSON.parse(r.body ?? "null");

test("GitHub: writeText is one GET then one PATCH of the title and the body, the section kept byte for byte", async () => {
  const { stub, run } = gh(route({ [`GET ${GH}/7`]: json(ghIssue(7, [LABELS.unrefined], { body: SECTION })), [`PATCH ${GH}/7`]: json({}) }), (t) => t.writeText(id("7"), text("New title", "new text")));
  await run;
  assert.deepEqual(stub.sent().map((r) => r.method), ["GET", "PATCH"]);
  const sent = bodyOf(stub.sent()[1]);
  assert.deepEqual(Object.keys(sent).sort(), ["body", "title"]);
  assert.equal(sent.title, "New title");
  assert.equal(Result.getOrThrow(withoutRefinement(String(sent.body))), "new text");
  assert.deepEqual(Result.getOrThrow(readRefinement(String(sent.body))), Result.getOrThrow(readRefinement(SECTION)));
});

test("GitHub: readCited reads a closed issue with no stage label, and one with a stage label, as closed", async () => {
  for (const labels of [[], [LABELS.implemented]]) {
    const { run } = gh(route({ [`GET ${GH}/3`]: json(ghIssue(3, labels, { state: "closed", body: null })) }), (t) => t.readCited(id("3")));
    assert.deepEqual(await run, { id: "3", title: "issue 3", body: "", open: false });
  }
  const { run } = gh(route({}), (t) => Effect.flip(t.readCited(id("4"))));
  assert.equal((await run)._tag, "TrackerItemNotFound");
});

test("GitLab: writeText is one GET then one PUT of the title and the description; a closed issue and the limit are refused with no PUT", async () => {
  const ok = gl(route({ [`GET ${GL}/7`]: json(glIssue(7, [GITLAB_LABELS.unrefined], { description: SECTION })), [`PUT ${GL}/7`]: json({}) }), (t) => t.writeText(id("7"), text("New title", "new text")));
  await ok.run;
  assert.deepEqual(ok.stub.sent().map((r) => r.method), ["GET", "PUT"]);
  const sent = bodyOf(ok.stub.sent()[1]);
  assert.deepEqual(Object.keys(sent).sort(), ["description", "title"]);
  assert.equal(Result.getOrThrow(withoutRefinement(String(sent.description))), "new text");
  const closed = gl(route({ [`GET ${GL}/8`]: json(glIssue(8, [], { state: "closed" })) }), (t) => Effect.flip(t.writeText(id("8"), text("T", "x"))));
  assert.equal((await closed.run)._tag, "TrackerBodyInvalid");
  assert.equal(closed.stub.sent().filter((r) => r.method === "PUT").length, 0);
  const long = gl(route({ [`GET ${GL}/9`]: json(glIssue(9, [GITLAB_LABELS.refined])) }), (t) => Effect.flip(t.writeText(id("9"), text("T", "d".repeat(GITLAB_DESCRIPTION_LIMIT + 1)))));
  assert.equal((await long.run)._tag, "TrackerBodyInvalid");
  assert.equal(long.stub.sent().filter((r) => r.method === "PUT").length, 0);
});

test("GitLab: readCited reads an open issue with no Interloq label as open, and a 404 is TrackerItemNotFound", async () => {
  const { run } = gl(route({ [`GET ${GL}/5`]: json(glIssue(5, ["bug"])) }), (t) => t.readCited(id("5")));
  assert.deepEqual(await run, { id: "5", title: "issue 5", body: "body 5", open: true });
  const missing = gl(route({}), (t) => Effect.flip(t.readCited(id("6"))));
  assert.equal((await missing.run)._tag, "TrackerItemNotFound");
});

test("GitLab: a title and text written through the fake server read back", async () => {
  const fake = fakeGitlabTracker([serverIssue(2, [GITLAB_LABELS.unrefined], { description: SECTION })]);
  await Effect.runPromise(fake.tracker.writeText(id("2"), text("Brought up to date", "the new text")));
  const item = await Effect.runPromise(fake.tracker.read(id("2")));
  assert.equal(item.title, "Brought up to date");
  assert.equal(Result.getOrThrow(withoutRefinement(item.body)), "the new text");
});

test("the fake: writeText rewrites around the section, and readCited reads a closed implemented item as closed", async () => {
  const fake = await Effect.runPromise(makeFakeTracker([
    { id: id("1"), title: "t", body: SECTION, state: "unrefined", url: Option.none(), open: true },
    { id: id("2"), title: "done", body: "b", state: "implemented", url: Option.none(), open: false },
  ]));
  await Effect.runPromise(fake.tracker.writeText(id("1"), text("T2", "x")));
  const [one] = await Effect.runPromise(fake.items);
  assert.equal(one!.title, "T2");
  assert.equal(one!.body, Result.getOrThrow(withDeveloperText(SECTION, text("T2", "x"))));
  assert.deepEqual(await Effect.runPromise(fake.tracker.readCited(id("2"))), { id: "2", title: "done", body: "b", open: false });
});

const arbItem = fc.record({ title: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== "" && !/[\r\n]/u.test(s)), body: fc.string({ maxLength: 20 }).filter((s) => !s.includes("Refined using Interloq")) });
test("landed of a writeText succeeds on the item withDeveloperText produced, and fails with otherText on any other title or text", () => {
  fc.assert(fc.property(arbItem, arbItem, (a, b) => {
    const t = text(a.title, a.body);
    const item = (title: string, body: string): TrackerItem => ({ id: id("1"), title, body, state: "unrefined", url: Option.none(), activity: Option.none() });
    const write = { kind: "writeText" as const, item: id("1"), text: t };
    const ok = Result.isSuccess(landed(write, item(t.title, Result.getOrThrow(withDeveloperText(SECTION, t)))));
    const other = landed(write, item(b.title, b.body));
    const same = b.title === a.title && b.body === a.body;
    return ok && (same || (Result.isFailure(other) && other.failure.kind === "otherText"));
  }), { numRuns: 200, seed: 20261102 });
});

test("a writeText answered 500 after being applied counts done by the read-back with no repeat; a readCited with no answer is repeated", async () => {
  const fake = await Effect.runPromise(makeFakeTracker([{ id: id("1"), title: "t", body: "b", state: "unrefined", url: Option.none(), open: true }]));
  const env: TrackerRetryEnv = heldTrackerEnv(new ScriptedUi([]), { ...S.defaultConfig, maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.01 }, Effect.runSync(Ref.make<readonly string[]>([])));
  await Effect.runPromise(fake.failAfterNext("writeText", new TrackerUnreachable({ tracker: "GitHub", message: "500", status: 500 })));
  await Effect.runPromise(writeWithRetry(fake.tracker, { kind: "writeText", item: id("1"), text: text("New", "c") }, env));
  assert.equal((await Effect.runPromise(fake.items))[0]!.title, "New");
  await Effect.runPromise(fake.failNext("readCited", new TrackerUnreachable({ tracker: "GitHub", message: "down", status: null })));
  const cited = await Effect.runPromise(readCitedWithRetry(fake.tracker, id("1"), env));
  assert.equal(cited.title, "New");
});

test("the operations' words and the check's text", () => {
  assert.equal(prompts.trackerOperationText({ kind: "writeText", item: id("4"), text: text("T", "x") }), "writing the brought-up-to-date title and text to item 4");
  assert.equal(prompts.trackerOperationText({ kind: "readCited", item: id("4") }), "reading the cited issue 4");
  assert.equal(prompts.writeCheckText("4", { kind: "held", held: { kind: "otherText" } }), "After the last attempt, item 4 held a title or text other than the one written.");
});
