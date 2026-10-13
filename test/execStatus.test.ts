// Issue #154 (S2): the statuses executePrompt asks for are the statuses the report's schema accepts, derived from the
// schema itself, and the sentences for continuing and blocked are the ones the prompt carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { TEST_ROOT } from "./helpers.ts";

const statuses = S.ExecReport.fields.status.literals;

test("executePrompt names every status the report's schema accepts, and no other beside the plan's step statuses", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true);
  assert.deepEqual([...statuses].sort(), ["blocked", "continuing", "finished", "needs_input"]);
  for (const status of statuses) assert.ok(prompt.includes(`status '${status}'`), status);
  const named = [...prompt.matchAll(/status '([a-z_]+)'/g)].map((m) => m[1]).filter((s) => !(S.StepStatus.literals as readonly string[]).includes(s));
  assert.deepEqual([...new Set(named)].sort(), [...statuses].sort());
});

test("executePrompt describes continuing as work left with nothing for the user, and blocked as a failure the user must act on", () => {
  const prompt = prompts.executePrompt(TEST_ROOT, "t", true);
  assert.ok(prompt.includes(prompts.CONTINUING_STATUS_SENTENCE));
  assert.ok(prompt.includes(prompts.BLOCKED_STATUS_SENTENCE));
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /'continuing'/);
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /no question for the user/);
  assert.match(prompts.CONTINUING_STATUS_SENTENCE, /without asking the user/);
  assert.match(prompts.BLOCKED_STATUS_SENTENCE, /'blocked'/);
  assert.match(prompts.BLOCKED_STATUS_SENTENCE, /needs the user/);
});
