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

test("GitHub: 62 unrefined issues, 3 with comments: 4 requests, then 1 with nothing changed", async () => {
  const issue = (n: number) => ({ number: n, title: `issue ${n}`, body: "", state: "open", labels: [], comments: [3, 17, 40].includes(n) ? 1 : 0, updated_at: "2026-11-05T12:00:00Z" });
  const stub = makeStub((r: SentRequest) => {
    const match = /\/issues\/(\d+)\/comments$/u.exec(r.url.pathname);
    if (match !== null) return json([{ id: Number(match[1]) * 10, body: sentBack(Number(match[1])), created_at: "2026-11-01T00:00:00Z" }]);
    return json(Array.from({ length: 62 }, (_, i) => issue(i + 1)));
  });
  const shape = Effect.runSync(githubTracker({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null, obsoleteLabel: null }, Result.getOrThrow(githubCredential({ INTERLOQ_GITHUB_TOKEN: "github_pat_FAKE" }))).pipe(Effect.provide(stub.layer)));
  const manager = await managerOver(tempRepo(), shape);
  const listed = counts(await Effect.runPromise(manager.listItems("refinement")));
  assert.equal(stub.sent().length, 4);
  assert.deepEqual(listed.filter(([, n]) => n !== 0), [["3", 1], ["17", 1], ["40", 1]]);
  assert.deepEqual(counts(await Effect.runPromise(manager.listItems("refinement"))), listed);
  assert.equal(stub.sent().length, 5);
});
