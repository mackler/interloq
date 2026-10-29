// A stub GitLab for makeStub of test/stubHttp.ts: one project's issues in memory, answering the listing, the read of
// one issue and the PUT of a change as GitLab's documentation describes them, so the adapter is tested over a server
// whose state its writes change.
import { Effect, Ref, Result } from "effect";
import { gitlabTracker } from "../src/gitlab.ts";
import { itemOfIssue } from "../src/gitlabIssues.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import type { ItemId } from "../src/tracker.ts";
import { gitlabCredential } from "../src/trackerConfig.ts";
import type { FakeItem, FakeTracker, TrackerOperation } from "./fakeTracker.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";
import { type Answer, json, makeStub, type SentRequest } from "./stubHttp.ts";

/** An issue as GitLab sends it: the fields the adapter reads and one it ignores. */
export type ServerIssue = Readonly<{ id: number; iid: number; title: string; description: string | null; state: "opened" | "closed"; labels: readonly string[]; web_url: string }>;

export const serverIssue = (iid: number, labels: readonly string[], more: Partial<ServerIssue> = {}): ServerIssue => ({
  id: 9000 + iid, iid, title: `issue ${iid}`, description: `body ${iid}`, state: "opened", labels, web_url: `https://gitlab.com/${PROJECT}/-/issues/${iid}`, ...more,
});

export type GitlabServer = Readonly<{
  handler: (request: SentRequest) => Answer;
  /** The issues as they stand now, by iid. */
  issues: () => ReadonlyMap<number, ServerIssue>;
  /** Closes an issue as a user would in GitLab, without a request. */
  close: (iid: number) => void;
  /**
   * Issue #171: the next PUT whose JSON body has `field` is answered 500, after applying it (`applied`, as GitLab's
   * PUT 98 of 14 Oct 2026) or without applying it, once.
   */
  failNextPut: (field: string, applied: boolean) => void;
}>;

const PAGE_SIZE_DEFAULT = 20;
const names = (text: unknown): readonly string[] => (typeof text === "string" && text !== "" ? text.split(",") : []);

export const gitlabServer = (initial: readonly ServerIssue[]): GitlabServer => {
  const issues = new Map(initial.map((issue) => [issue.iid, issue]));
  const putFailures: { field: string; applied: boolean }[] = [];
  const handler = (r: SentRequest): Answer => {
    const parts = r.url.pathname.split("/");
    const last = parts.at(-1);
    if (r.method === "GET" && last === "issues") {
      const state = r.url.searchParams.get("state");
      const wanted = names(r.url.searchParams.get("labels"));
      const size = Number(r.url.searchParams.get("per_page") ?? PAGE_SIZE_DEFAULT);
      const page = Number(r.url.searchParams.get("page") ?? "1");
      const matching = [...issues.values()].filter((i) => (state === null || i.state === state) && wanted.every((l) => i.labels.includes(l)));
      const more = page * size < matching.length;
      return json(matching.slice((page - 1) * size, page * size), 200, { "x-next-page": more ? String(page + 1) : "" });
    }
    const issue = issues.get(Number(last));
    if (issue === undefined) return json({ message: "404 Not found" }, 404);
    if (r.method === "GET") return json(issue);
    if (r.method === "PUT") {
      const body = JSON.parse(r.body ?? "{}") as Record<string, unknown>;
      const failing = putFailures.findIndex((f) => Object.hasOwn(body, f.field));
      const failure = failing < 0 ? null : putFailures.splice(failing, 1)[0]!;
      if (failure !== null && !failure.applied) return json({ message: "500 Internal Server Error" }, 500);
      const removed = names(body.remove_labels);
      const kept = issue.labels.filter((l) => !removed.includes(l));
      const next: ServerIssue = {
        ...issue,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        labels: [...kept, ...names(body.add_labels).filter((l) => !kept.includes(l))],
        state: body.state_event === "close" ? "closed" : body.state_event === "reopen" ? "opened" : issue.state,
      };
      issues.set(issue.iid, next);
      return failure !== null ? json({ message: "500 Internal Server Error" }, 500) : json(next);
    }
    return json({ message: "405 Method Not Allowed" }, 405);
  };
  return {
    handler,
    issues: () => new Map(issues),
    failNextPut: (field, applied) => void putFailures.push({ field, applied }),
    close: (iid) => {
      const issue = issues.get(iid);
      if (issue !== undefined) issues.set(iid, { ...issue, state: "closed" });
    },
  };
};

/**
 * The FakeTracker of test/fakeTracker.ts over the real GitLab adapter and a gitlabServer, so a run's scenario tests run
 * against GitLab unchanged; `sent` gives the requests the adapter made and `close` closes an issue as a user would.
 */
export type FakeGitlab = FakeTracker & Readonly<{ sent: () => readonly SentRequest[]; close: (iid: number) => void; server: GitlabServer }>;

export const fakeGitlabTracker = (issues: readonly ServerIssue[]): FakeGitlab => {
  const server = gitlabServer(issues);
  const stub = makeStub(server.handler);
  const token = Result.getOrThrow(gitlabCredential({ INTERLOQ_GITLAB_TOKEN: "glpat-FAKE" }));
  const adapter = Effect.runSync(gitlabTracker({ kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS }, token).pipe(Effect.provide(stub.layer)));
  type Scripted = Readonly<{ operation: TrackerOperation; error: TrackerError; when: "before" | "after" }>;
  const failures = Effect.runSync(Ref.make<readonly Scripted[]>([]));
  const reads = Effect.runSync(Ref.make<readonly ItemId[]>([]));
  const scriptedAt = (operation: TrackerOperation, when: Scripted["when"]): Effect.Effect<void, TrackerError> =>
    Effect.flatMap(
      Ref.modify(failures, (fs): readonly [TrackerError | null, readonly Scripted[]] => {
        const i = fs.findIndex((f) => f.operation === operation && f.when === when);
        return i < 0 ? [null, fs] : [fs[i].error, fs.filter((_, j) => j !== i)];
      }),
      (error) => (error === null ? Effect.void : Effect.fail(error)),
    );
  const scripted = (operation: TrackerOperation) => scriptedAt(operation, "before");
  const after = (operation: TrackerOperation) => scriptedAt(operation, "after");
  const tracker: TrackerShape = {
    list: (state) => Effect.andThen(scripted("list"), adapter.list(state)),
    read: (id) => Effect.andThen(Ref.update(reads, (rs) => [...rs, id]), Effect.andThen(scripted("read"), adapter.read(id))),
    writeRefinement: (id, refinement) => Effect.andThen(scripted("writeRefinement"), Effect.andThen(adapter.writeRefinement(id, refinement), after("writeRefinement"))),
    setState: (id, state) => Effect.andThen(scripted("setState"), Effect.andThen(adapter.setState(id, state), after("setState"))),
    comment: (id, text) => Effect.andThen(scripted("comment"), Effect.andThen(adapter.comment(id, text), after("comment"))),
    comments: (id) => Effect.andThen(scripted("comments"), adapter.comments(id)),
  };
  const items = Effect.sync((): readonly FakeItem[] =>
    [...server.issues().values()].flatMap((issue) => {
      const item = itemOfIssue(GITLAB_LABELS, issue);
      return Result.isSuccess(item) ? [{ ...item.success, open: issue.state === "opened" }] : [];
    }),
  );
  return {
    tracker,
    items,
    reads: Ref.get(reads),
    failNext: (operation, error) => Ref.update(failures, (fs): readonly Scripted[] => [...fs, { operation, error, when: "before" }]),
    failAfterNext: (operation, error) => Ref.update(failures, (fs): readonly Scripted[] => [...fs, { operation, error, when: "after" }]),
    sent: stub.sent,
    close: server.close,
    server,
  };
};
