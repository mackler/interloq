// Issue #219: the requests one listing sends. A listing reads an item's comments only where its comment activity changed
// since they were read, so two loads a minute of iou-notes' 62 unrefined items no longer pass GitLab's 100 a minute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { platformLayer } from "../src/platform.ts";
import { makeRunManager, type RunManager } from "../src/runManager.ts";
import type { ItemsAnswer } from "../src/protocol.ts";
import { OFF_SETTINGS } from "../src/chain.ts";
import { commentText, runCommentKey } from "../src/itemComments.ts";
import { digestOf, preparationCommentText, preparedComments } from "../src/preparedComments.ts";
import { githubTracker } from "../src/github.ts";
import { githubCredential } from "../src/trackerConfig.ts";
import type { TrackerShape } from "../src/services.ts";
import type { FakeTracker } from "./fakeTracker.ts";
import { fakeGitlabTracker, serverIssue } from "./fakeGitlab.ts";
import { GITLAB_LABELS } from "./gitlabLabels.ts";
import { LABELS } from "./githubLabels.ts";
import { json, makeStub, type SentRequest } from "./stubHttp.ts";
import { tempRepo, testWiring, trackerAccessOf } from "./helpers.ts";

const managerOver = (repo: string, tracker: TrackerShape): Promise<RunManager> =>
  Effect.runPromise(makeRunManager((ui) => ({ ...testWiring(repo, {}).wiring, ui: Effect.succeed(ui) }), repo, [], "test", trackerAccessOf({ tracker } as FakeTracker), OFF_SETTINGS).pipe(Effect.provide(platformLayer)));
const sentBack = (n: number) => commentText({ _tag: "SentBack", key: runCommentKey(`runs/r${n}`), date: "2026-11-01", missing: "what was missing" });
const counts = (answer: ItemsAnswer): readonly (readonly [string, number])[] => (answer.result._tag === "Listed" ? answer.result.items.map((i) => [i.id, i.sentBack] as const) : assert.fail(answer.result.notice));

test("GitLab: 62 unrefined issues, 3 with notes: 4 requests, then 1 with nothing changed, then 2 after a note", async () => {
  const gitlab = fakeGitlabTracker(Array.from({ length: 62 }, (_, i) => serverIssue(i + 1, [GITLAB_LABELS.unrefined])));
  for (const iid of [3, 17, 40]) gitlab.server.note(iid, sentBack(iid));
  const manager = await managerOver(tempRepo(), gitlab.tracker);
  const sentNow = () => gitlab.sent().length;
  const before = sentNow();
  const listed = await Effect.runPromise(manager.listItems("refinement"));
  assert.equal(sentNow() - before, 4, "the issues' page and three notes listings");
  const once = counts(listed);
  assert.deepEqual(once.filter(([, n]) => n !== 0), [["3", 1], ["17", 1], ["40", 1]]);
  const again = sentNow();
  assert.deepEqual(counts(await Effect.runPromise(manager.listItems("refinement"))), once);
  assert.equal(sentNow() - again, 1, "nothing changed: the issues' page alone");
  gitlab.server.note(17, sentBack(170));
  const noted = sentNow();
  const after = counts(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(sentNow() - noted, 2, "the issues' page and the changed issue's notes");
  assert.deepEqual(after.filter(([, n]) => n !== 0), [["3", 1], ["17", 2], ["40", 1]]);
});

// Work review 1 of issue #219 (W1-R1-2): the GitHub stub keeps each issue's comments, its count and its updated_at
// advancing with each comment the test adds, so a listing after a comment refreshes that issue alone.
const githubServer = (seed: ReadonlyMap<number, readonly string[]>) => {
  const comments = new Map<number, string[]>(Array.from({ length: 62 }, (_, i) => [i + 1, [...(seed.get(i + 1) ?? [])]]));
  const updated = new Map<number, number>();
  const issue = (n: number) => ({ number: n, title: `issue ${n}`, body: "", state: "open", labels: [], comments: comments.get(n)!.length, updated_at: new Date(Date.UTC(2026, 10, 5, 12) + (updated.get(n) ?? 0) * 1000).toISOString() });
  const stub = makeStub((r: SentRequest) => {
    const match = /\/issues\/(\d+)\/comments$/u.exec(r.url.pathname);
    if (match !== null) return json(comments.get(Number(match[1]))!.map((body, i) => ({ id: Number(match[1]) * 100 + i, body, created_at: "2026-11-01T00:00:00Z" })));
    return json(Array.from({ length: 62 }, (_, i) => issue(i + 1)));
  });
  const shape = Effect.runSync(githubTracker({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null, obsoleteLabel: null }, Result.getOrThrow(githubCredential({ INTERLOQ_GITHUB_TOKEN: "github_pat_FAKE" }))).pipe(Effect.provide(stub.layer)));
  const add = (n: number, body: string) => {
    comments.get(n)!.push(body);
    updated.set(n, (updated.get(n) ?? 0) + 1);
  };
  return { stub, shape, add };
};

test("GitHub: 62 unrefined issues, 3 with comments: 4 requests, then 1 with nothing changed, then 2 after a comment", async () => {
  const github = githubServer(new Map([3, 17, 40].map((n) => [n, [sentBack(n)]])));
  const manager = await managerOver(tempRepo(), github.shape);
  const listed = counts(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(github.stub.sent().length, 4);
  assert.deepEqual(listed.filter(([, n]) => n !== 0), [["3", 1], ["17", 1], ["40", 1]]);
  assert.deepEqual(counts(await Effect.runPromise(manager.listItems("refinement"))), listed);
  assert.equal(github.stub.sent().length, 5);
  github.add(17, sentBack(170));
  const after = counts(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(github.stub.sent().length, 7, "the issues' page and the changed issue's comments");
  assert.deepEqual(after.filter(([, n]) => n !== 0), [["3", 1], ["17", 2], ["40", 1]]);
});

// Work review 1 of issue #219 (W1-R1-2): the preparation marks of a cached listing equal a fresh manager's over the same
// tracker state, after one item's preparation changed, over both adapters.
const KEY = runCommentKey("2026-11-01T00-00-00-000Z-preparation-x");
const prepared = (title: string, body: string): readonly string[] =>
  Result.getOrThrow(preparedComments(KEY, [], { _tag: "Prepared", key: KEY, digest: digestOf({ title, body }), count: 0, generation: 0, date: "2026-11-01" })).map((c) => c.text);
const setAside = (title: string, body: string): string =>
  preparationCommentText({ _tag: "SetAside", key: KEY, digest: digestOf({ title, body }), generation: 0, date: "2026-11-01", cause: { _tag: "Failed", reason: "a test" } });
const marks = (answer: ItemsAnswer) => (answer.result._tag === "Listed" ? answer.result.items.map((i) => [i.id, i.preparation] as const) : assert.fail(answer.result.notice));
const markedOf = (m: ReturnType<typeof marks>, ids: readonly string[]) => m.filter(([id]) => ids.includes(id));

test("GitLab: a cached listing's preparation marks equal a fresh manager's, before and after a commented item's preparation is added", async () => {
  const gitlab = fakeGitlabTracker(Array.from({ length: 62 }, (_, i) => serverIssue(i + 1, [GITLAB_LABELS.unrefined])));
  for (const body of prepared("issue 5", "body 5")) gitlab.server.note(5, body);
  gitlab.server.note(6, setAside("issue 6", "body 6"));
  gitlab.server.note(7, "a developer's note");
  const manager = await managerOver(tempRepo(), gitlab.tracker);
  await Effect.runPromise(manager.listItems("refinement"));
  const cached = marks(await Effect.runPromise(manager.listItems("refinement")));
  assert.deepEqual(markedOf(cached, ["5", "6"]).map(([, m]) => m?._tag), ["Prepared", "SetAside"]);
  assert.deepEqual(cached, marks(await Effect.runPromise((await managerOver(tempRepo(), gitlab.tracker)).listItems("refinement"))));
  for (const body of prepared("issue 7", "body 7")) gitlab.server.note(7, body);
  const refreshed = marks(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(markedOf(refreshed, ["7"])[0]![1]?._tag, "Prepared");
  assert.deepEqual(refreshed, marks(await Effect.runPromise((await managerOver(tempRepo(), gitlab.tracker)).listItems("refinement"))));
});

test("GitHub: a cached listing's preparation marks equal a fresh manager's, before and after a commented item's preparation is added", async () => {
  const github = githubServer(new Map([[5, prepared("issue 5", "")], [6, [setAside("issue 6", "")]], [7, ["a developer's note"]]]));
  const manager = await managerOver(tempRepo(), github.shape);
  await Effect.runPromise(manager.listItems("refinement"));
  const cached = marks(await Effect.runPromise(manager.listItems("refinement")));
  assert.deepEqual(markedOf(cached, ["5", "6"]).map(([, m]) => m?._tag), ["Prepared", "SetAside"]);
  assert.deepEqual(cached, marks(await Effect.runPromise((await managerOver(tempRepo(), github.shape)).listItems("refinement"))));
  for (const body of prepared("issue 7", "")) github.add(7, body);
  const refreshed = marks(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(markedOf(refreshed, ["7"])[0]![1]?._tag, "Prepared");
  assert.deepEqual(refreshed, marks(await Effect.runPromise((await managerOver(tempRepo(), github.shape)).listItems("refinement"))));
});
