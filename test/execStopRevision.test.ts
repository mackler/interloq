// Issue #181 (requirements Q6, Q7): an execution that stopped without a question the developer answered is revised from
// Claude Code's own account of the stop, which travels in the revision prompt; an answered stop keeps its record in
// user-decisions.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const ANSWERED_SENTENCE = /The last entry of plan-review\/runs\/[^/\s]+\/user-decisions\.md contains the user's input for this stop/u;

test("an unanswered stop's revision carries Claude Code's summary, what it needs and the work left, and not the user's input", () => {
  for (const status of ["needs_input", "blocked", "aborted"] as const) {
    const stop: prompts.ExecStop = { _tag: "Unanswered", status, summary: "Steps S1 and S2 are done.", question: "Which port should the server use?", remainingWork: "S3: wire the server." };
    const text = prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 1, { _tag: "ExecutionEnded", stop, workReview: "converged" }, NO_STEP_CHECKS);
    assert.ok(text.includes(stop.summary), status);
    assert.ok(text.includes(stop.question), status);
    assert.ok(text.includes(stop.remainingWork), status);
    assert.ok(text.includes(status), status);
    assert.match(text, /was not asked/u);
    assert.doesNotMatch(text, ANSWERED_SENTENCE);
  }
});

test("an unanswered stop with nothing stated says so", () => {
  const stop: prompts.ExecStop = { _tag: "Unanswered", status: "aborted", summary: "", question: "", remainingWork: "" };
  const text = prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 1, { _tag: "ExecutionEnded", stop, workReview: "converged" }, NO_STEP_CHECKS);
  assert.match(text, /none stated/u);
});

test("an answered stop's revision points at the user's input in user-decisions.md", () => {
  const text = prompts.revisePlanAfterExecutionPrompt(TEST_ROOT, "t", false, 1, { _tag: "ExecutionEnded", stop: { _tag: "Answered" }, workReview: "converged" }, NO_STEP_CHECKS);
  assert.match(text, ANSWERED_SENTENCE);
});

test("the line said at an unanswered stop names the status and the revision without a question", () => {
  const line = prompts.execStopRevisionLine("Implementation", "blocked");
  assert.ok(line.includes("blocked"));
  assert.match(line, /without a question/u);
});
