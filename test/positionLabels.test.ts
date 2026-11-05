// Issue #159: the options of a disputed pause name the outcome, never an agent (src/prompts.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type { PauseOrigin, QuestionOrigin } from "../src/question.ts";

const pauseOf = (pause: prompts.DisputedPauseKind): PauseOrigin => {
  switch (pause) {
    case "reversal":
      return { pause, id: "P1-R2-1", reverses: "P1-R1-1" };
    case "repeatedUnderNewId":
      return { pause, id: "P1-R2-1", repeats: "P1-R1-1" };
    default:
      return { pause, id: "P1-R2-1" };
  }
};

test("the program's own labels of every disputed pause are distinct outcomes naming no agent", () => {
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) {
    const { reviewer, planner } = prompts.positionLabels(kind, "review");
    for (const label of [reviewer, planner]) {
      assert.notEqual(label.trim(), "", kind);
      assert.equal(prompts.namesAgent(label), false, `${kind}: ${label}`);
    }
    assert.notEqual(reviewer, planner, kind);
  }
  // Issue #38: every kind's third label is the resolution of both concerns.
  const resolution = "Make the change that meets both concerns";
  assert.deepEqual(prompts.positionLabels("reraised", "review"), { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution });
  assert.deepEqual(prompts.positionLabels("secondClarification", "review"), { reviewer: "Make the change the point asks for", planner: "Wait for the requested explanation before making a change", resolution });
  assert.deepEqual(prompts.positionLabels("disputedSelfCorrection", "review"), { reviewer: "Keep the correction", planner: "Withdraw the correction", resolution });
});

test("namesAgent finds an agent's name as a whole word in any case", () => {
  for (const text of ["Follow Codex (the reviewer)", "follow claude code", "CLAUDE", prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION]) assert.equal(prompts.namesAgent(text), true, text);
  for (const text of ["Keep the correction", "Claudette agrees", "Make the change the point asks for", "codexes"]) assert.equal(prompts.namesAgent(text), false, text);
});

test("isDisputedPause holds for the disputed pauses alone", () => {
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) assert.equal(prompts.isDisputedPause({ kind: "pause", pass: "review", heading: "Planning 1", ...pauseOf(kind) }), true, kind);
  const others: readonly QuestionOrigin[] = [
    { kind: "pause", pass: "review", heading: "Planning 1", pause: "identical", fileLabel: "plan.json" },
    { kind: "pause", pass: "review", heading: "Planning 1", pause: "idle", idle: 3 },
    { kind: "relayed" },
  ];
  for (const origin of others) assert.equal(prompts.isDisputedPause(origin), false, JSON.stringify(origin));
});

test("the question of a disputed pause asks for an outcome, not for whose position stands", () => {
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) {
    const q = prompts.pauseQuestion(pauseOf(kind), "review");
    assert.doesNotMatch(q, /Whose position/);
    assert.match(q, /\?$/);
  }
  assert.equal(prompts.pauseQuestion(pauseOf("reraised"), "review"), "Codex has raised a point that Claude Code does not accept in full. Which outcome do you want?");
  assert.doesNotMatch(prompts.pauseQuestion(pauseOf("disputedSelfCorrection"), "review"), /as Codex asked|as Claude Code now holds/);
  assert.doesNotMatch(prompts.TASK_DISPUTE_QUESTION, /Codex's or Claude Code's\?/);
  assert.match(prompts.TASK_DISPUTE_QUESTION, /\?$/);
});
