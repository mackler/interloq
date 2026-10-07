import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { taskOf } from "../src/program.ts";

// Issue #88: a run's task is a Task, which only a text with a character other than whitespace inhabits.
const RUNS = { numRuns: 300, seed: 20261007 };
const whitespace = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r", " ", " ", "﻿") });

test("property: taskOf succeeds exactly on a text with a character other than whitespace, and keeps the text unchanged", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme" }), (text) => {
      const task = taskOf(text);
      if (text.trim() === "") assert.ok(Result.isFailure(task), JSON.stringify(text));
      else {
        assert.ok(Result.isSuccess(task), JSON.stringify(text));
        assert.equal(task.success, text);
      }
    }),
    RUNS,
  );
  fc.assert(fc.property(whitespace, (text) => assert.ok(Result.isFailure(taskOf(text)), JSON.stringify(text))), RUNS);
});
