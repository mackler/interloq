import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { describe, TrackerUnreachable } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { readRefinement } from "../src/refinement.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { type Services, Tracker } from "../src/services.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, questionEntry, refinementFails, respond, runFails, scriptedItem, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

// Issue #120, S6 (the developer's decision of 8 Oct 2026): a refinement run is the question phase and nothing after it;
// it writes requirements.md back to its item as the section Refined using Interloq and sets the item to refined. It sets
// nothing when it starts, and a run that halts or is stopped leaves the item unrefined.

type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: "A" });
const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: { id: "", context: [], text: [], explanations: [], options: [] }, asked_ids: [], answered_ids: [], complete, summary });
const REQUIREMENTS = "# Requirements\n\nQ1: A";
const item: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("120")), title: "Two modes", body: "Make the page two tabs.", state: "unrefined" };
/** One question, answered, and a summary confirmed: the question review, the interview and the requirements review. */
const oneQuestion: TestOptions = {
  answers: ["A", ""],
  steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", false, "") }, { output: turn("Done.", true, REQUIREMENTS) }],
  reviews: [{ issues: [] }, { issues: [] }],
};

const refine = (options: TestOptions, tracker: FakeTracker = fakeTrackerOf([item])) => {
  const { layer, probe } = testLayer(tempRepo(), options);
  const exit = Effect.runPromiseExit(refinementRun("Two modes\n\nMake the page two tabs.", item.id).pipe(Effect.provide(Layer.succeed(Tracker, tracker.tracker)), Effect.provide(layer as Layer.Layer<Services>)));
  return { exit, probe, tracker };
};
const held = async (tracker: FakeTracker): Promise<FakeItem> => (await Effect.runPromise(tracker.items)).find((i) => i.id === item.id) ?? assert.fail("the item is gone");
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};

test("a refinement run ends after requirements.md with no planning call, writes it back to the item as its section and sets refined", async () => {
  const { exit, probe, tracker } = refine(oneQuestion);
  const ended = await exit;
  assert.ok(Exit.isSuccess(ended), Exit.isFailure(ended) ? Cause.pretty(ended.cause) : "");
  assert.equal(probe.planner.prompts.filter((p) => p.includes("Produce an implementation plan")).length, 0, "a planning call was made");
  assert.equal(probe.planner.execPrompts.length, 0);
  const after = await held(tracker);
  assert.equal(after.state, "refined");
  // The seam: the section the item holds is requirements.md as the store wrote it.
  const section = Result.getOrThrow(readRefinement(after.body));
  assert.ok(Option.isSome(section));
  assert.equal(section.value, fs.readFileSync(probe.requirements, "utf8"));
  assert.ok(after.body.startsWith(item.body), "the developer's text changed");
  assert.ok(probe.ui.said.some((s) => s.includes(`item ${item.id}`) && s.includes("refined")));
});

test("a refinement run with an empty agreed list ends successfully, writes the section, sets refined and says it found nothing to settle", async () => {
  const { exit, probe, tracker } = refine({ steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] });
  assert.ok(Exit.isSuccess(await exit));
  const after = await held(tracker);
  assert.equal(after.state, "refined");
  assert.ok(Option.isSome(Result.getOrThrow(readRefinement(after.body))));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.NOTHING_TO_SETTLE));
  assert.ok(probe.ui.said.includes(prompts.NOTHING_TO_SETTLE));
  // W2-R1-1: the success line comes after it, once both tracker steps succeeded.
  const said = probe.ui.said;
  const written = said.findIndex((s) => s === prompts.refinementWrittenLine(item.id, probe.requirements) || (s.includes(`item ${item.id}`) && s.includes("set to refined")));
  assert.ok(written > said.indexOf(prompts.NOTHING_TO_SETTLE), "the write-back is not said after the empty list's line");
});

// W2-R1-1 of work review 2: the empty list's line is written before the tracker steps, so it claims neither of them.
test("a refinement with an empty agreed list whose section cannot be written claims no write-back and no state", async () => {
  const tracker = fakeTrackerOf([item]);
  await Effect.runPromise(tracker.failNext("writeRefinement", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset" })));
  const { exit, probe } = refine({ steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] }, tracker);
  assert.equal(failureOf(await exit)._tag, "TrackerStepFailed");
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.ok(conversation.includes(prompts.NOTHING_TO_SETTLE));
  const written = prompts.refinementWrittenLine(item.id, probe.requirements);
  for (const text of [conversation, ...probe.ui.said]) {
    assert.ok(!text.includes(written), `a write-back is claimed: ${text}`);
    assert.ok(!text.includes("set to refined"), `a state is claimed: ${text}`);
  }
});

test("a refinement run that halts or is stopped leaves the item unrefined and its body unchanged", async () => {
  const halted = refine({
    answers: ["0"],
    steps: [{ output: { questions: [q("Q1")] } }, { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [q("Q1")] } }],
    reviews: [{ issues: [{ id: "Q-R1-1", severity: "major", location: "Q1", problem: "p", evidence: "e" }] }],
    config: { maxRounds: 1 },
  });
  assert.equal(failureOf(await halted.exit)._tag, "RoundLimitStop");
  const stopped = refine({ answers: ["/quit"], steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", false, "") }], reviews: [{ issues: [] }] });
  assert.equal(failureOf(await stopped.exit)._tag, "UserStopped");
  for (const run of [halted, stopped]) assert.deepEqual(await held(run.tracker), item);
});

test("a refinement whose section cannot be written keeps its records, sets no state, and halts naming the step", async () => {
  const tracker = fakeTrackerOf([item]);
  await Effect.runPromise(tracker.failNext("writeRefinement", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset" })));
  const { exit, probe } = refine(oneQuestion, tracker);
  const error = failureOf(await exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /could not be written to item 120[^]*connection reset[^]*records of the run are kept/);
  assert.deepEqual(await held(tracker), item);
  assert.match(fs.readFileSync(probe.requirements, "utf8"), /Q1: A/);
});

test("a refinement whose state cannot be set keeps the section written, the state unchanged, and says so", async () => {
  const tracker = fakeTrackerOf([item]);
  await Effect.runPromise(tracker.failNext("setState", new TrackerUnreachable({ tracker: "GitHub", message: "timeout" })));
  const { exit } = refine(oneQuestion, tracker);
  const error = failureOf(await exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /were written to item 120, but its state was not changed to refined: [^]*timeout/);
  const after = await held(tracker);
  assert.equal(after.state, "unrefined");
  assert.ok(Option.isSome(Result.getOrThrow(readRefinement(after.body))));
});

// Issue #120, S8 (the developer's decision of 8 Oct 2026): a refinement run drops the project snapshot of Claude Code's
// planning calls, whose hook still denies a write outside the records before it happens; Codex's turns keep theirs, their
// only guard. One run tests both sides, since a test of either alone would pass while they disagreed.
test("a refinement run survives a project change during a Claude Code planning call, and a Codex turn in it still halts on one", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    mode: "refinement",
    steps: [{ output: { questions: [q("Q1")] }, touchProject: true }],
    reviews: [{ issues: [], touchProject: true }],
  });
  const error = await refinementFails(layer, "ProjectChanged");
  assert.equal(error._tag === "ProjectChanged" ? error.during : null, "review");
  assert.equal(probe.reviewer.prompts.length, 1, "the run did not go on to the question review");
});

test("an implementation run still halts on a project change during a Claude Code planning call", async () => {
  const { layer } = testLayer(tempRepo(), { mode: "implementation", steps: [{ output: { questions_for_user: [] }, plan: "v1", touchProject: true }] });
  const error = await runFails(layer, "ProjectChanged");
  assert.equal(error._tag === "ProjectChanged" ? error.during : null, "planning");
});
