// Issue #183: a disputed point of the plan's or the work's review on which both agents state that nothing in the work
// would differ is not put to the developer; one with a stated difference is, with the difference in its options; and in
// the work review an answer that keeps Claude Code's position goes on with the review instead of a plan revision. The
// first two cases restate the disputes of iou-notes recorded in the developer's report: W2-R1-1 of the run of item #80
// and W1-R1-4 of the run of item #81.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import { NO_WORK_EFFECT_HEADING } from "../src/prompts.ts";
import * as S from "../src/schema.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { fakeTrackerOf, finished, presentedQuestions, respond, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

const NONE = { kind: "none" } as const;
const differs = (difference: string) => ({ kind: "differs", difference }) as const;
const noQuestions = { questions_for_user: [] };
/** Lets each case's loop run past two rounds without a correction: the idle limit is not what these cases test. */
const config = { maxIdleRounds: 5 };
const stated = (id: string, problem: string, evidence: string, effect: S.WorkEffectReply): S.Issue => ({ id, severity: "major", location: "S22", problem, evidence, [S.WORK_EFFECT_FIELD]: effect }) as S.Issue;
const disposed = (id: string, action: S.Disposition["action"], rationale: string, effect: S.WorkEffectReply) => ({ id, action, rationale, duplicate_of: "", reverses: "", [S.WORK_EFFECT_FIELD]: effect });
const response = (...dispositions: ReturnType<typeof disposed>[]) => respond([], { dispositions });
const runOf = (wiring: Parameters<typeof program>[1], project: string) => Effect.runPromise(Effect.scoped(program(scriptedStart(project), wiring)));
const conversation = (dir: string): string => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const planningPhases = (notified: readonly UiEvent[]): number => notified.filter((e) => e._tag === "PhaseBegan" && e.phase.kind === "planning").length;
const pauses = (ui: Parameters<typeof presentedQuestions>[0]) => presentedQuestions(ui).filter((q) => q.origin.kind === "pause");

// Item #80, point W2-R1-1: after the pre-commit formatter rewrapped website/README.md, Claude Code reran the one test that
// reads it, as the project's testing rule requires; Codex objected that the step's text does not name that command.
const ITEM_80 = {
  problem: "Step S22 ran website_tag_prefix_test.sh, a command its text does not name.",
  evidence: "The pre-commit formatter rewrapped website/README.md and the test was run again before the commit.",
  rationale: "The project's testing rule requires rerunning the test that reads a file the formatter changed; it took 0 s and changed nothing.",
};

test("item #80 (W2-R1-1): a point raised again on which both agents state no effect is settled without a pause, and the run finishes", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const issue = stated("W1-R1-1", ITEM_80.problem, ITEM_80.evidence, NONE);
  const { wiring, probe } = testWiring(tempRepo(), {
    config,
    tracker,
    steps: [{ output: noQuestions, plan: "v1" }, { output: response(disposed("W1-R1-1", "rejected", ITEM_80.rationale, NONE)) }, { output: response(disposed("W1-R1-1", "rejected", ITEM_80.rationale, NONE)) }],
    reviews: [{ issues: [] }, { issues: [issue] }, { issues: [issue] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.deepEqual(pauses(probe.ui), [], "a pause was presented");
  assert.equal(planningPhases(probe.ui.notified), 1);
  const text = conversation(probe.dir);
  assert.ok(text.includes(NO_WORK_EFFECT_HEADING), text.slice(-2000));
  const settled = text.slice(text.indexOf(NO_WORK_EFFECT_HEADING));
  assert.ok(settled.includes(ITEM_80.problem) && settled.includes(ITEM_80.rationale), "both positions are in the settled line");
  const entries = json(probe.dir, "work-review-log.json").entries.filter((e: { id: string }) => e.id === "W1-R1-1");
  assert.ok(entries.length >= 1);
  for (const e of entries) assert.deepEqual(e.work_effects, { reviewer: NONE, planner: NONE });
  const round = json(probe.dir, "work-review-1/round-1.json");
  assert.deepEqual([round.review.issues[0].workEffect, round.response.dispositions[0].workEffect], [NONE, NONE]);
  assert.equal((await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)?.state, "implemented");
});

// Item #81, point W1-R1-4: step S10 ran every script test that names a changed file, as its text says; Codex objected that
// two of them do not exercise the change.
const ITEM_81 = {
  problem: "Step S10 ran gateway_token_claims_test.sh and gateway_check_token_test.sh, which do not exercise the changed files.",
  evidence: "One names RELEASING.md only in a comment; the other writes its own stand-in deployment.yaml.",
  rationale: "The step's text runs every script test that names a changed file, and it did; running them cost only time.",
};

test("item #81 (W1-R1-4): raised again in the next work review with no effect stated by either agent, it is settled without a pause", async () => {
  const defect = stated("W1-R1-1", "The token check accepts an expired token.", "e", differs("gateway/check.ts changes"));
  const point = stated("W1-R1-4", ITEM_81.problem, ITEM_81.evidence, NONE);
  const { wiring, probe } = testWiring(tempRepo(), {
    config,
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: response(disposed("W1-R1-1", "accepted", "Correct it.", differs("x")), disposed("W1-R1-4", "rejected", ITEM_81.rationale, NONE)) },
      { output: noQuestions, plan: "v2" },
      { output: response(disposed("W1-R1-4", "rejected", ITEM_81.rationale, NONE)) },
    ],
    reviews: [{ issues: [] }, { issues: [defect, point] }, { issues: [] }, { issues: [point] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.deepEqual(pauses(probe.ui), []);
  const text = conversation(probe.dir);
  const settled = text.slice(text.indexOf(NO_WORK_EFFECT_HEADING));
  assert.ok(text.includes(NO_WORK_EFFECT_HEADING) && settled.includes(ITEM_81.problem) && settled.includes(ITEM_81.rationale), text.slice(-2000));
});

const README = "website/README.md would be committed unwrapped";

test("a point raised again on which Codex states a difference is asked, and its options name the difference; Codex's position leaves for a revision", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    config,
    answers: ["1"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: response(disposed("W1-R1-1", "rejected", ITEM_80.rationale, NONE)) }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [stated("W1-R1-1", ITEM_80.problem, ITEM_80.evidence, NONE)] }, { issues: [stated("W1-R1-1", ITEM_80.problem, ITEM_80.evidence, differs(README))] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  const asked = pauses(probe.ui);
  assert.equal(asked.length, 1);
  assert.ok(JSON.stringify(asked[0].options).includes(README), JSON.stringify(asked[0].options));
  assert.equal(planningPhases(probe.ui.notified), 2, "Codex's position leaves for a planning phase");
});

test("an answer that keeps Claude Code's position is recorded, and the work review goes on with no revision", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    config,
    answers: ["2"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: response(disposed("W1-R1-1", "rejected", ITEM_80.rationale, NONE)) }, { output: response(disposed("W1-R1-1", "rejected", ITEM_80.rationale, NONE)) }],
    reviews: [{ issues: [] }, { issues: [stated("W1-R1-1", ITEM_80.problem, ITEM_80.evidence, NONE)] }, { issues: [stated("W1-R1-1", ITEM_80.problem, ITEM_80.evidence, differs(README))] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(pauses(probe.ui).length, 1);
  assert.equal(planningPhases(probe.ui.notified), 1, "no planning phase 2");
  assert.equal(probe.planner.execPrompts.length, 1);
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /W1-R1-1/);
  assert.equal(json(probe.dir, "work-review-1/round-3.json").kind, "no_response", "the review went on to round 3, which raised no issue");
});

test("the plan review: a point raised again with no effect stated by either agent is settled, and planning goes on to execution", async () => {
  const issue = stated("P1-R1-1", "Step S2 names a check its change does not touch.", "e", NONE);
  const rationale = "The step's selection rule chose it; nothing in the work would differ.";
  const { wiring, probe } = testWiring(tempRepo(), {
    config,
    steps: [{ output: noQuestions, plan: "v1" }, { output: response(disposed("P1-R1-1", "rejected", rationale, NONE)) }, { output: response(disposed("P1-R1-1", "rejected", rationale, NONE)) }],
    reviews: [{ issues: [issue] }, { issues: [issue] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.deepEqual(pauses(probe.ui), []);
  assert.ok(conversation(probe.dir).includes(NO_WORK_EFFECT_HEADING));
  assert.equal(probe.planner.execPrompts.length, 1);
});
