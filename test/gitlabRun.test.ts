// The scenarios of a refinement run and an implementation run against GitLab: the port's fake replaced by the real
// GitLab adapter over a stub GitLab (test/fakeGitlab.ts), with the assertions of test/refinementRun.test.ts and
// test/implementationRun.test.ts. They pass unchanged, so the port did not move. And a run whose issue is closed during
// it halts at its next tracker write, which reads the issue and sends no write (the developer's decision G-R1-1).
import { NO_STEP_CHECKS } from "../src/schema.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { describe } from "../src/errors.ts";
import { readRefinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { implementationRun, refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { type Services, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import { fakeGitlabTracker, type FakeGitlab, serverIssue } from "./fakeGitlab.ts";
import { finished, questionEntry, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: { id: "", context: [], history: [], text: [], explanations: [], options: [] }, asked_ids: [], answered_ids: [], complete, summary });
const REQUIREMENTS = "# Requirements\n\nQ1: A";
const DEVELOPER = "Make the page two tabs.";
const ID = Result.getOrThrow(itemIdOf("120"));
/** One question, answered, and a summary confirmed; `onSummary` runs when the summary's turn is called. */
const oneQuestion = (onSummary: () => void = () => {}): TestOptions => ({
  answers: ["A", ""],
  steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", false, "") }, { output: turn("Done.", true, REQUIREMENTS), onCall: onSummary }],
  reviews: [{ issues: [] }, { issues: [] }],
});
const noQuestions = { questions_for_user: [] };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

const refine = async (options: TestOptions, gitlab: FakeGitlab) => {
  const { layer, probe } = testLayer(tempRepo(), options);
  const exit = await Effect.runPromiseExit(refinementRun(`Two modes\n\n${DEVELOPER}`, ID, "checked").pipe(Effect.provide(Layer.succeed(Tracker, gitlab.tracker)), Effect.provide(layer as Layer.Layer<Services>)));
  return { exit, probe };
};
const implement = async (options: TestOptions, gitlab: FakeGitlab) => {
  const { layer, probe } = testLayer(tempRepo(), { ...options, tracker: gitlab });
  const item = await Effect.runPromise(gitlab.tracker.read(ID));
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(item.body)));
  const exit = await Effect.runPromiseExit(implementationRun(`${item.title}\n\n${item.body}`, item.id, section, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  return { exit, probe };
};
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};
const writes = (gitlab: FakeGitlab) => gitlab.sent().filter((r) => r.method === "PUT");
const issue120 = (gitlab: FakeGitlab) => gitlab.server.issues().get(120) ?? assert.fail("issue #120 is gone");

test("a refinement run against GitLab writes requirements.md after the developer's text and sets Refined by one PUT", async () => {
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Unrefined", "frontend"], { title: "Two modes", description: DEVELOPER })]);
  const { exit, probe } = await refine(oneQuestion(), gitlab);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  const after = issue120(gitlab);
  const section = Result.getOrThrow(readRefinement(after.description ?? ""));
  assert.ok(Option.isSome(section));
  assert.equal(section.value, fs.readFileSync(probe.requirements, "utf8"));
  assert.equal(Result.getOrThrow(withoutRefinement(after.description ?? "")), DEVELOPER);
  assert.deepEqual(after.labels, ["frontend", "Refined"]);
  const labelWrites = writes(gitlab).filter((r) => (r.body ?? "").includes("add_labels"));
  assert.equal(labelWrites.length, 1);
  assert.deepEqual(JSON.parse(labelWrites[0].body ?? "null"), { add_labels: "Refined", remove_labels: "Unrefined,Implementing,Implemented" });
});

test("an implementation run against GitLab sets Implementing before its first agent call and Implemented at the end", async () => {
  const body = Result.getOrThrow(withRefinement(DEVELOPER, Result.getOrThrow(refinementOf("# Requirements\n\nQ1: two tabs."))));
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Refined"], { title: "Two modes", description: body })]);
  const during: (readonly string[])[] = [];
  const options: TestOptions = { ...converging, steps: [{ output: noQuestions, plan: "v1", onCall: () => during.push(issue120(gitlab).labels) }] };
  const { exit, probe } = await implement(options, gitlab);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.deepEqual(during, [["Implementing"]]);
  assert.deepEqual(issue120(gitlab).labels, ["Implemented"]);
  assert.equal(issue120(gitlab).state, "opened");
  assert.equal(fs.readFileSync(probe.requirements, "utf8"), "# Requirements\n\nQ1: two tabs.");
});

test("a refinement run whose issue is closed during the run halts at the write-back with one GET and no PUT, its records kept", async () => {
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Unrefined"], { title: "Two modes", description: DEVELOPER })]);
  const sentAtClose: number[] = [];
  const { exit, probe } = await refine(oneQuestion(() => {
    gitlab.close(120);
    sentAtClose.push(gitlab.sent().length);
  }), gitlab);
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /issue #120 is closed, and Interloq never reopens a closed issue, so the refinement was not written/u);
  assert.ok(fs.existsSync(probe.requirements) && fs.existsSync(path.join(probe.dir, "conversation.md")));
  const after = gitlab.sent().slice(sentAtClose[0]);
  assert.deepEqual(after.map((r) => r.method), ["GET"]);
  assert.equal(issue120(gitlab).description, DEVELOPER);
  assert.deepEqual(issue120(gitlab).labels, ["Unrefined"]);
});

test("an implementation run whose issue is closed during the run halts at setImplemented with no PUT after the close", async () => {
  const body = Result.getOrThrow(withRefinement(DEVELOPER, Result.getOrThrow(refinementOf("# Requirements\n\nQ1: two tabs."))));
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Refined"], { title: "Two modes", description: body })]);
  const sentAtClose: number[] = [];
  const options: TestOptions = { ...converging, execScripts: [{ onCall: () => {
    gitlab.close(120);
    sentAtClose.push(gitlab.sent().length);
  } }] };
  const { exit, probe } = await implement(options, gitlab);
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.equal(error._tag === "TrackerStepFailed" && error.step, "setImplemented");
  assert.match(describe(error), /issue #120 is closed, and Interloq never reopens a closed issue, so its state was not set to implemented/u);
  assert.ok(fs.existsSync(path.join(probe.dir, "conversation.md")));
  assert.deepEqual(gitlab.sent().slice(sentAtClose[0]).map((r) => r.method), ["GET"]);
  assert.deepEqual(issue120(gitlab).labels, ["Implementing"]);
  assert.equal(issue120(gitlab).state, "closed");
});

// Issue #171: the loss of 14 Oct 2026 in iou-notes, reproduced through the real GitLab adapter: PUT 98 answered 500 and
// GitLab had applied the write, so the item got its section and never its label. The read-back finds the section.
const FAST = { maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.01 };
test("a refinement whose PUT of the description answers 500 after applying it goes on: one section, and the Refined label", async () => {
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Unrefined"], { title: "Two modes", description: DEVELOPER })]);
  gitlab.server.failNextPut("description", true);
  const { exit } = await refine({ ...oneQuestion(), config: FAST }, gitlab);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  const description = issue120(gitlab).description ?? "";
  assert.equal(description.split("## Refined using Interloq").length - 1, 1);
  assert.deepEqual(issue120(gitlab).labels, ["Refined"]);
  assert.equal(writes(gitlab).filter((r) => (r.body ?? "").includes("description")).length, 1);
});

test("a refinement whose PUT of the description answers 500 without applying it is repeated and ends with one section", async () => {
  const gitlab = fakeGitlabTracker([serverIssue(120, ["Unrefined"], { title: "Two modes", description: DEVELOPER })]);
  gitlab.server.failNextPut("description", false);
  const { exit } = await refine({ ...oneQuestion(), config: FAST }, gitlab);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  const description = issue120(gitlab).description ?? "";
  assert.equal(description.split("## Refined using Interloq").length - 1, 1);
  assert.deepEqual(issue120(gitlab).labels, ["Refined"]);
  assert.equal(writes(gitlab).filter((r) => (r.body ?? "").includes("description")).length, 2);
});
