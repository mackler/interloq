import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import { recordPath } from "../src/artifacts.ts";
import { describe, TrackerUnreachable } from "../src/errors.ts";
import { readRefinement, refinementOf, withRefinement } from "../src/refinement.ts";
import { implementationRun } from "../src/run.ts";
import { itemIdOf } from "../src/tracker.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, finished, issue, respond, scriptedItem, type TestOptions, tempRepo, testLayer, TEST_ROOT } from "./helpers.ts";

// Issue #120, S7 (the developer's decisions of 8 Oct 2026): an implementation run has no question phase; it sets its item
// to implementing before any agent call and implemented when it finishes; one that halts or is stopped sets nothing more.
// The item's section Refined using Interloq is the run's requirements.md, which the reviewers are told to follow.

const noQuestions = { questions_for_user: [] };
const developerText = "Make the page two tabs.";
const withSection: FakeItem = { ...scriptedItem, id: Result.getOrThrow(itemIdOf("120")), title: "Two modes", body: Result.getOrThrow(withRefinement(developerText, Result.getOrThrow(refinementOf("# Requirements\n\nQ1: two tabs.")))), state: "refined" };
const withoutSection: FakeItem = { ...withSection, id: Result.getOrThrow(itemIdOf("121")), body: developerText };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

/** Runs the item's implementation as program does: the section read from the item the fake holds. */
const implement = async (item: FakeItem, options: TestOptions, tracker: FakeTracker = fakeTrackerOf([item])) => {
  const { layer, probe } = testLayer(tempRepo(), { ...options, tracker });
  const held = (await Effect.runPromise(tracker.items)).find((i) => i.id === item.id) ?? assert.fail("no item");
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(held.body)));
  const exit = await Effect.runPromiseExit(implementationRun(`${held.title}\n\n${held.body}`, held.id, section).pipe(Effect.provide(layer)));
  return { exit, probe, tracker, section };
};
const stateOf = async (tracker: FakeTracker, item: FakeItem): Promise<string> => (await Effect.runPromise(tracker.items)).find((i) => i.id === item.id)?.state ?? assert.fail("no item");
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), Cause.pretty(exit.cause));
  return error.value;
};

test("an implementation run asks no question list, begins with planning, sets implementing before its first call and implemented at the end", async () => {
  const tracker = fakeTrackerOf([withSection]);
  const during: string[] = [];
  const options: TestOptions = { ...converging, steps: [{ output: noQuestions, plan: "v1", onCall: () => during.push(Effect.runSync(tracker.items)[0].state) }] };
  const { exit, probe } = await implement(withSection, options, tracker);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assert.deepEqual(during, ["implementing"]);
  assert.equal(await stateOf(tracker, withSection), "implemented");
  assert.ok(!probe.planner.prompts.some((p) => p.includes("question list")), "a question list was asked for");
  const phases = probe.ui.notified.flatMap((e) => (e._tag === "PhaseBegan" ? [e.phase.kind] : []));
  assert.equal(phases[0], "planning");
  assert.ok(!phases.includes("questions"));
  const foreseen = probe.ui.notified.find((e) => e._tag === "PhasesForeseen");
  assert.ok(foreseen !== undefined && foreseen._tag === "PhasesForeseen" && foreseen.phases.every((p) => p.kind !== "questions"));
});

test("the item's section is the run's requirements.md, and the plan review and the work review Codex receives name it; without a section neither does", async () => {
  const sectioned = await implement(withSection, converging);
  assert.ok(Exit.isSuccess(sectioned.exit));
  assert.ok(sectioned.section !== null);
  assert.equal(fs.readFileSync(sectioned.probe.requirements, "utf8"), sectioned.section);
  const named = recordPath(TEST_ROOT, { kind: "requirements" });
  assert.equal(path.join(path.dirname(path.dirname(path.dirname(sectioned.probe.dir))), named), sectioned.probe.requirements);
  const [planReview, workReview] = sectioned.probe.reviewer.prompts;
  assert.ok(planReview.includes(named) && workReview.includes(named), "a review prompt does not name the run's requirements.md");

  const bare = await implement(withoutSection, converging);
  assert.ok(Exit.isSuccess(bare.exit));
  assert.equal(bare.section, null);
  assert.ok(!fs.existsSync(bare.probe.requirements));
  assert.ok(bare.probe.reviewer.prompts.every((p) => !p.includes("requirements.md")));
});

test("a halt in the work review and a stop leave the item implementing", async () => {
  const halted = await implement(withSection, {
    answers: ["0"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(failureOf(halted.exit)._tag, "RoundLimitStop");
  assert.equal(await stateOf(halted.tracker, withSection), "implementing");
  const stopped = await implement(withSection, { answers: ["q"], steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }], reviews: [{ issues: [issue("P1-R1-1")] }], config: { maxRounds: 1 } });
  assert.equal(failureOf(stopped.exit)._tag, "UserStopped");
  assert.equal(await stateOf(stopped.tracker, withSection), "implementing");
});

test("an item that cannot be set to implementing halts the run before any agent call", async () => {
  const tracker = fakeTrackerOf([withSection]);
  await Effect.runPromise(tracker.failNext("setState", new TrackerUnreachable({ tracker: "GitHub", message: "connection reset" })));
  const { exit, probe } = await implement(withSection, converging, tracker);
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /could not be set to implementing, so the run made no agent call: [^]*connection reset/);
  assert.deepEqual([probe.planner.prompts, probe.reviewer.prompts], [[], []]);
  assert.equal(await stateOf(tracker, withSection), "refined");
});

test("an item that cannot be set to implemented at the end keeps the records and says the work is done and the item stays implementing", async () => {
  const tracker = fakeTrackerOf([withSection]);
  const failLater = () => Effect.runSync(tracker.failNext("setState", new TrackerUnreachable({ tracker: "GitHub", message: "timeout" })));
  const { exit, probe } = await implement(withSection, { ...converging, execs: [finished], steps: [{ output: noQuestions, plan: "v1", onCall: failLater }] }, tracker);
  const error = failureOf(exit);
  assert.equal(error._tag, "TrackerStepFailed");
  assert.match(describe(error), /the work is done, but item 120 could not be set to implemented and stays implementing: [^]*timeout[^]*records of the run are kept/);
  assert.equal(await stateOf(tracker, withSection), "implementing");
  assert.ok(fs.existsSync(path.join(probe.dir, "plan.json")));
});
