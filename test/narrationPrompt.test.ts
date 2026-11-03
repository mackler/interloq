// Issue #40 (requirement 1): executePrompt tells Claude Code what it may claim of a command's outcome in its messages.
// A prompt test shows only that the instruction is present beside its neighbors; it cannot show that a real agent
// obeys it. What a reader relies on is what Interloq observes itself (the final suite's line, issue #162).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { TEST_ROOT } from "./helpers.ts";

test("executePrompt carries the narration sentence once, between the checks' sentence and the background sentence", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS);
  const sentence = prompts.NARRATION_OUTCOME_SENTENCE;
  assert.ok(sentence.trim() !== "");
  assert.equal(prompt.split(sentence).length - 1, 1);
  const at = prompt.indexOf(sentence);
  assert.ok(prompt.indexOf(prompts.REPORT_CHECKS_SENTENCE) < at);
  assert.ok(at < prompt.indexOf(prompts.BACKGROUND_SUITE_SENTENCE));
});

test("the narration sentence states each of its three clauses", () => {
  const sentence = prompts.NARRATION_OUTCOME_SENTENCE;
  assert.match(sentence, /exited/);
  assert.match(sentence, /read/);
  assert.match(sentence, /earlier run/);
  assert.match(sentence, /running/);
  assert.match(sentence, /passing|passed/);
});
