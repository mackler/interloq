// Issue #27 (requirements, Tests): the seam from one source between what src/run.ts notifies after each plan-writing
// call and what the page's reducer shows as Claude Code's latest message. After every PlanWritten the dashboard holds
// the heading and the pointer sentence, never the planning call's serialized reply, and no event the run sends the page
// holds a `resultText` by which that reply could reach it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import type { RunRoot } from "../src/artifacts.ts";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { documentLabel, planWrittenBody, planWrittenHeading } from "../src/prompts.ts";
import type { Stamped } from "../src/protocol.ts";
import { readRefinement } from "../src/refinement.ts";
import { subjectHeading } from "../src/render.ts";
import { implementationRun } from "../src/run.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { countOfKind, phaseName, type UiEvent } from "../src/uiEvents.ts";
import { emptyRun, foldEvent, type RunView } from "../web/src/state.ts";
import { EARLIER_ROOT, fakeTrackerOf, finished, issue, notRefined, respond, runTask, scriptedItem, scriptedStart, tempRepo, testLayer, testWiring } from "./helpers.ts";

const T = "2026-11-06T00:00:00.000Z";
const noQuestions = { questions_for_user: [] };
const plan = (text: string) => ({ output: noQuestions, plan: text });

/** Every key of a value, searched recursively. */
const keysOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : typeof value === "object" && value !== null ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

/** The dashboard's latest message of Claude Code right after each PlanWritten, folded from the notified events. */
const afterEachPlan = (notified: readonly UiEvent[]) => {
  const seen: { event: Extract<UiEvent, { _tag: "PlanWritten" }>; run: RunView }[] = [];
  notified.reduce((run, event) => {
    const next = foldEvent(run, { time: T, event: { _tag: "Notified", event } } as Stamped);
    if (event._tag === "PlanWritten") seen.push({ event, run: next });
    return next;
  }, emptyRun(1));
  return seen;
};

const assertSeam = (notified: readonly UiEvent[], expected: readonly boolean[]) => {
  for (const event of notified) assert.ok(!keysOf(event).includes("resultText"), `${event._tag} carries resultText`);
  const plans = afterEachPlan(notified);
  assert.deepEqual(plans.map((p) => p.event.revised), expected);
  plans.forEach(({ event, run }, i) => {
    const stage = phaseName({ kind: "planning", n: event.phase }, Math.max(1, countOfKind(run.timeline.map((e) => e.phase), "planning")));
    assert.deepEqual(run.dashboard.claude, { heading: planWrittenHeading(stage), body: planWrittenBody(expected[i]!, stage, documentLabel({ plan: event.phase })), running: [] });
  });
};

test("a first plan: wrote", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [plan("v1")], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  await runTask(layer);
  assertSeam(probe.ui.notified, [false]);
});

test("planning 2 after the work review accepts an issue: revised, in Planning 2", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [plan("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, plan("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  await runTask(layer);
  assertSeam(probe.ui.notified, [false, true]);
});

test("the plan written after a withdrawn verdict: wrote", async () => {
  const verdictResponse = { ...respond([["V1-R1-1", "accepted"]]), missing: "" };
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: notRefined("The requirements do not say how long a note is kept.") }, { output: verdictResponse }, { output: {}, plan: "v1" }],
    reviews: [{ issues: [issue("V1-R1-1", "The requirements state 30 days.")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assertSeam(probe.ui.notified, [false]);
});

test("planning 1 taking an earlier run's plan: revised", async () => {
  const repo = tempRepo();
  const dir = path.join(repo, "plan-review", EARLIER_ROOT as RunRoot);
  fs.mkdirSync(path.join(dir, "planning-1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "planning-1", "round-1.json"), JSON.stringify({ version: 2, kind: "no_response", subject: "planning-1", phase: 1, round: 1, reconstructed: false, review: { issues: [] } }));
  fs.writeFileSync(path.join(dir, "conversation.md"), `# Conversation record\n\n${prompts.reviewConvergedMarkdown(subjectHeading({ plan: 1 }), 1, prompts.PLAN_FILE_LABEL)}`);
  const steps = [{ id: "S1", number: 1, label: "Step S1", text: "The text of S1.", status: "pending" }];
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ version: 2, plan: { stages: [{ number: 1, title: "Plan", steps }] } }));
  const tree = execFileSync("git", ["-C", repo, "write-tree"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ version: 2, tree, uncommitted: [], start_commit: null, time: "2025-12-31T00:00:00.000Z" }));
  const revision = { questions_for_user: [], plan: { stages: [{ number: 1, title: "Plan", steps: steps.map(({ status: _, ...rest }) => rest) }] } };
  const { layer, probe } = testLayer(repo, { steps: [{ output: revision }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished], tracker: fakeTrackerOf([scriptedItem]) });
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(scriptedItem.body)));
  const exit = await Effect.runPromiseExit(implementationRun(`${scriptedItem.title}\n\n${scriptedItem.body}`, scriptedItem.id, section, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  assertSeam(probe.ui.notified, [true]);
});
