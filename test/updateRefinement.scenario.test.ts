// Issue #216 (S9): a refinement run begins with Bring Up to Date; the item is written once after agreement, before any
// question, and the questions are asked of the updated text.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Option, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { readRefinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import type * as S from "../src/schema.ts";
import type { TrackerShape } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem } from "./fakeTracker.ts";
import { fakeTrackerOf, issue, questionEntry, respond, scriptedItem, scriptedStart, summaryReply, type TestOptions, tempRepo, testWiring } from "./helpers.ts";

const SECTION = Result.getOrThrow(withRefinement("The check is in src/old.ts.", Result.getOrThrow(refinementOf("old requirements"))));
const ITEM: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("216")), title: "Bring it up to date", body: SECTION, state: "unrefined" };
const AMENDED = { title: "Bring it up to date", text: "The check is in src/new.ts." };
const updateResponse = (t: typeof AMENDED, outcome: S.UpdateOutcomeReply = { kind: "current" }): S.UpdateResponse =>
  ({ ...respond([["U-R1-1", "accepted"]]), issue: t, outcome, developer_passages: [] }) as S.UpdateResponse;
const stored = (id: string) => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });

const refine = async (item: FakeItem, options: TestOptions, wrap?: (t: TrackerShape) => TrackerShape) => {
  const tracker = fakeTrackerOf([item]);
  const writes: string[] = [];
  const watched = (t: TrackerShape): TrackerShape => ({ ...t, writeText: (id, text) => Effect.sync(() => writes.push(text.text)).pipe(Effect.andThen(t.writeText(id, text))) });
  const { wiring, probe } = testWiring(tempRepo(), { ...options, tracker, config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01, ...options.config } });
  const wired = { ...wiring, tracker: () => Result.succeed(Layer_succeed(watched(wrap === undefined ? tracker.tracker : wrap(tracker.tracker)))) };
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement", item.id, "unchecked"), wired)));
  const after = (await Effect.runPromise(tracker.items))[0]!;
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  return { code, probe, after, conversation, writes };
};
import { Layer } from "effect";
import { Tracker } from "../src/services.ts";
const Layer_succeed = (t: TrackerShape) => Layer.succeed(Tracker, t);

const asking: TestOptions = {
  steps: [{ output: updateResponse(AMENDED) }, { output: { questions: [stored("Q1")] } }],
  terms: [{ output: { entries: [] } }],
  updateChecks: [{ issues: [issue("U-R1-1", "src/old.ts is gone")] }, { issues: [] }],
  reviews: [{ issues: [] }, { issues: [] }],
  answers: ["A"],
  closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }],
};

test("(a) a stale statement amended and agreed: one writeText before the first question, the question list asked of the amended text, the section untouched", async () => {
  const { code, probe, after, writes, conversation } = await refine(ITEM, asking);
  assert.equal(code, 0);
  assert.deepEqual(writes, [AMENDED.text]);
  assert.equal(after.title, AMENDED.title);
  assert.ok(after.body.startsWith(AMENDED.text));
  const list = probe.planner.prompts.find((p) => p.includes("Do not write a plan yet"));
  assert.ok(list?.includes("src/new.ts") && !list.includes("src/old.ts"), list);
  assert.ok(conversation.indexOf(prompts.issueUpdatedLine("216")) < conversation.indexOf("question Q1?") || !conversation.includes("question Q1?"));
  assert.equal(after.state, "refined");
  assert.notDeepEqual(Result.getOrThrow(readRefinement(after.body)), Option.none());
});

test("(b) nothing raised: no writeText, and the run goes on as before", async () => {
  const { code, writes, after } = await refine(ITEM, { ...asking, steps: [{ output: { questions: [stored("Q1")] } }], updateChecks: [] });
  assert.equal(code, 0);
  assert.deepEqual(writes, []);
  assert.equal(Result.getOrThrow(withoutRefinement(after.body)), "The check is in src/old.ts.");
});

test("(c) found already built: obsolete with the label configured, unrefined without it; no question asked, exit code 0", async () => {
  const obsolete = { steps: [{ output: updateResponse({ title: ITEM.title, text: "The check is in src/old.ts." }, { kind: "obsolete", reason: "issue #210 built it" }) }], updateChecks: [{ issues: [issue("U-R1-1", "built by #210")] }, { issues: [] }] };
  const labeled = await refine(ITEM, { ...obsolete, config: { tracker: { kind: "github", owner: "o", repo: "r", labels: { unrefined: "u", refined: "r", implementing: "i", implemented: "d", deployed: "x" }, prepareLabel: null, obsoleteLabel: "obsolete" } } });
  assert.equal(labeled.code, 0);
  assert.equal(labeled.after.state, "obsolete");
  assert.equal(labeled.probe.ui.asked.length, 0);
  assert.ok(labeled.conversation.includes(prompts.issueObsoleteLine("216", "issue #210 built it", true)));
  const unlabeled = await refine(ITEM, obsolete);
  assert.equal(unlabeled.code, 0);
  assert.equal(unlabeled.after.state, "unrefined");
  assert.deepEqual(unlabeled.writes, []);
});

test("(e) a writeText answered 500 after applying it is read back and counted done", async () => {
  let failed = false;
  const failing = (t: TrackerShape): TrackerShape => ({
    ...t,
    writeText: (id, text) => Effect.andThen(t.writeText(id, text), Effect.suspend(() => (failed ? Effect.void : ((failed = true), Effect.fail(new TrackerUnreachable({ tracker: "GitHub", message: "500", status: 500 })))))),
  });
  const { code, after, conversation } = await refine(ITEM, asking, failing);
  assert.equal(code, 0);
  assert.equal(after.title, AMENDED.title);
  assert.ok(conversation.includes("read back shows it was applied"), conversation);
});

test("(f) P1-R3-1: after an amendment, Help me decide on an agreed question gives the analysis call the amended statement", async () => {
  // The analysis call fails, which halts the run; its prompt is what the test reads.
  const { probe } = await refine(ITEM, { ...asking, steps: [...asking.steps!, { callFailed: "the analysis is not scripted" }], answers: ["/decide"] });
  const analysis = probe.planner.prompts.find((p) => p.includes("question Q1?") && p.includes("offers a choice between"));
  assert.ok(analysis !== undefined, "an analysis call was made");
  assert.ok(analysis.includes("src/new.ts") && !analysis.includes("src/old.ts"), analysis);
});

import { runCommentKey } from "../src/itemComments.ts";
import { digestOf, preparedComments, type PreparedQuestion } from "../src/preparedComments.ts";
import { seededId } from "./fakeTracker.ts";

test("(d) a prepared item whose text is corrected writes it, discards the preparation and prepares the questions in the run", async () => {
  const key = runCommentKey("2026-10-30T00-00-00-000Z-preparation-216");
  const q = stored("P1");
  const pqs: PreparedQuestion[] = [{ entry: q, terms: { id: q.id, explanations: [], context: q.context, history: q.history, question: q.question, reason: q.reason, proposed_answers: q.proposed_answers } }];
  const texts = Result.getOrThrow(preparedComments(key, pqs, { _tag: "Prepared", key, digest: digestOf(ITEM), count: 1, generation: 1, date: "2026-10-30" }));
  const item: FakeItem = { ...ITEM, comments: texts.map((c, i) => ({ id: seededId(`p-${i + 1}`), body: c.text, created: "2026-10-30T00:00:00Z" })) };
  const { code, probe, writes } = await refine(item, asking);
  assert.equal(code, 0);
  assert.deepEqual(writes, [AMENDED.text]);
  assert.ok(probe.planner.prompts.some((p) => p.includes("Do not write a plan yet")), "the questions were prepared in the run");
  assert.ok(probe.ui.notified.every((e) => e._tag !== "QuestionPresented" || !JSON.stringify(e).includes("question P1?")), "a discarded prepared question was asked");
});
