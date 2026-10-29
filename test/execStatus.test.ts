import { NO_STEP_CHECKS } from "../src/schema.ts";
// Issue #154 (S2): the statuses executePrompt asks for are the statuses the report's schema accepts, derived from the
// schema itself, and the sentences for continuing and blocked are the ones the prompt carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { TEST_ROOT } from "./helpers.ts";

const statuses = S.ExecReport.fields.status.literals;

test("executePrompt names every status the report's schema accepts, and no other beside the plan's step statuses", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS);
  assert.deepEqual([...statuses].sort(), ["blocked", "continuing", "finished", "needs_input", "not_refined"]);
  for (const status of statuses) assert.ok(prompt.includes(`status '${status}'`), status);
  const named = [...prompt.matchAll(/status '([a-z_]+)'/g)].map((m) => m[1]).filter((s) => !(S.StepStatus.literals as readonly string[]).includes(s));
  assert.deepEqual([...new Set(named)].sort(), [...statuses].sort());
});

test("executePrompt describes continuing as work left with nothing for the user, and blocked as a failure the user must act on", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS);
  assert.ok(prompt.includes(prompts.CONTINUING_STATUS_SENTENCE));
  assert.ok(prompt.includes(prompts.BLOCKED_STATUS_SENTENCE));
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /'continuing'/);
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /no question for the user/);
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /without asking the user/);
  assert.match(prompts.BLOCKED_STATUS_SENTENCE, /'blocked'/);
  assert.match(prompts.BLOCKED_STATUS_SENTENCE, /needs the user/);
});

// Issue #186: the execution's verdict that the item is not refined, named by the status and its field from the schema.
test("executePrompt carries the not_refined sentence, which names the status and the report's field for what is missing", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS);
  assert.ok(prompt.includes(prompts.NOT_REFINED_STATUS_SENTENCE));
  assert.ok("missing" in S.ExecReport.fields);
  assert.match(prompts.NOT_REFINED_STATUS_SENTENCE, /'not_refined' with 'missing'/);
});

// Issue #186, work review 1 (W1-R1-1): the AskUserQuestion sentence excludes what the work should achieve, which is
// reported as not_refined; the two sentences divide the cases by one criterion.
test("executePrompt's AskUserQuestion sentence sends a point of what the work should achieve to not_refined", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS);
  assert.ok(prompt.includes(prompts.ASK_USER_SENTENCE));
  assert.ok(prompt.includes(prompts.NOT_REFINED_STATUS_SENTENCE));
  assert.match(prompts.ASK_USER_SENTENCE, /return status 'not_refined'/);
  const criterion = "leave open what the work should achieve";
  assert.ok(prompts.ASK_USER_SENTENCE.includes(criterion));
  assert.ok(prompts.NOT_REFINED_STATUS_SENTENCE.includes(criterion));
});
