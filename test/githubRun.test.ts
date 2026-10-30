// Issue #171: the loss of 14 Oct 2026 in this repository, reproduced through the real GitHub adapter over the stub HTTP
// client: the refinement of issue #155 wrote its requirements, then `GET 155`, the write's read of the item, reached no
// answer and the run halted. The request is now repeated and the run finishes; a refused credential is not repeated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { githubTracker } from "../src/github.ts";
import { readRefinement } from "../src/refinement.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { type Services, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import { githubCredential } from "../src/trackerConfig.ts";
import { LABELS } from "./githubLabels.ts";
import { questionEntry, summaryReply, type TestOptions, tempRepo, testLayer } from "./helpers.ts";
import { type Answer, json, makeStub, type SentRequest } from "./stubHttp.ts";

type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const oneQuestion: TestOptions = {
  answers: ["A"],
  steps: [{ output: { questions: [q("Q1")] } }],
  closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }],
  reviews: [{ issues: [] }, { issues: [] }],
  config: { maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.01 },
};
const ID = Result.getOrThrow(itemIdOf("155"));
const TOKEN = Result.getOrThrow(githubCredential({ INTERLOQ_GITHUB_TOKEN: "github_pat_SECRET" }));

/** A stateful GitHub holding issue #155, whose answers can be scripted ahead of its own. */
const githubServer = (scripted: Answer[]) => {
  let issue = { number: 155, title: "Retry", body: "Repeat a failed request.", state: "open", labels: [{ name: LABELS.unrefined }], html_url: "https://github.com/mackler/interloq/issues/155" };
  const handler = (r: SentRequest): Answer => {
    const next = scripted.shift();
    if (next !== undefined) return next;
    if (r.method === "PATCH") {
      const body = JSON.parse(r.body ?? "{}") as { body?: string; labels?: string[] };
      issue = { ...issue, ...(body.body === undefined ? {} : { body: body.body }), ...(body.labels === undefined ? {} : { labels: body.labels.map((name) => ({ name })) }) };
    }
    return json(issue);
  };
  return { handler, issue: () => issue };
};

const refine = async (scripted: Answer[]) => {
  const server = githubServer(scripted);
  const stub = makeStub(server.handler);
  const tracker = Effect.runSync(githubTracker({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null }, TOKEN).pipe(Effect.provide(stub.layer)));
  const { layer, probe } = testLayer(tempRepo(), oneQuestion);
  const exit = await Effect.runPromiseExit(refinementRun("Retry\n\nRepeat a failed request.", ID, "checked").pipe(Effect.provide(Layer.succeed(Tracker, tracker)), Effect.provide(layer as Layer.Layer<Services>)));
  return { exit, probe, server, stub };
};

test("a write-back whose read of the item reaches no answer once is repeated, and the refinement finishes refined", async () => {
  const { exit, server, stub } = await refine(["transport"]);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.ok(Option.isSome(Result.getOrThrow(readRefinement(server.issue().body))));
  assert.deepEqual(server.issue().labels.map((l) => l.name), [LABELS.refined]);
  // The writes' reads: the requirements (twice, the first unanswered), the refinement's record (issue #186) and the state.
  assert.equal(stub.sent().filter((r) => r.method === "GET").length, 4, "the read was not repeated");
});

test("a refused credential is not repeated: the refinement halts with TrackerStepFailed and asks nothing", async () => {
  const { exit, probe, stub } = await refine([json({ message: "Bad credentials" }, 401)]);
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error) && error.value._tag === "TrackerStepFailed");
  assert.equal(stub.sent().length, 1);
  assert.ok(!probe.ui.notified.some((e) => e._tag === "TrackerRetrying"));
});
