// Issue #262: the line said and written when Codex could not resume a review thread.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { threadResumeFailedLine } from "../src/prompts.ts";

const MESSAGE = "thread/resume failed: list_turns is not supported yet (code -32601)";

test("the line names the heading, the thread, the trimmed message, the round and the part", () => {
  const whole = threadResumeFailedLine("Code review", 2, "thread-a", `  ${MESSAGE}\n`);
  assert.ok(whole.startsWith("Code review: "), whole);
  assert.ok(whole.includes("thread-a"), whole);
  assert.ok(whole.includes(`(${MESSAGE})`), whole);
  assert.ok(whole.includes("round 2 starts a new Codex thread"), whole);
  assert.ok(threadResumeFailedLine("Code review", 2, "t", MESSAGE, { _tag: "Whole" }).startsWith("Code review (the whole work): "));
  assert.ok(threadResumeFailedLine("Code review", 2, "t", MESSAGE, { _tag: "Step", id: "S1", label: "l", text: "x" }).startsWith("Code review (step S1): "));
});

test("property: the line contains the thread id and the message trimmed", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ maxLength: 60 }).filter((m) => m.trim().length > 0), fc.integer({ min: 1, max: 99 }), (thread, message, round) => {
      const line = threadResumeFailedLine("Plan review", round, thread, message);
      assert.ok(line.includes(thread));
      assert.ok(line.includes(message.trim()));
    }),
    { numRuns: 200 },
  );
});
