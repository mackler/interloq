// Issue #44 (S1): the ending's schema, its exit code and its alert, over every ending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import fc from "fast-check";
import { EndingSchema, endingAlerts, endsAtItsEnd, exitCodeOfEnding } from "../src/ending.ts";
import { arbConcluded, arbEnding } from "./endingArbitraries.ts";
import { ABANDONED_EXIT_CODE } from "../src/prompts.ts";

const runs = { numRuns: 300, seed: 20261103 };

test("every ending survives an encode and a decode through its schema", () => {
  const encode = Schema.encodeSync(EndingSchema);
  const decode = Schema.decodeUnknownSync(EndingSchema);
  fc.assert(fc.property(arbEnding, (e) => assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(e)))), JSON.parse(JSON.stringify(e)))), runs);
});

test("the exit code is 0 exactly for a completed run and a send-back, and the code of behavior 11 otherwise", () => {
  const expected = { Completed: 0, SentBack: 0, Halted: 1, Interrupted: 130, Abandoned: ABANDONED_EXIT_CODE };
  fc.assert(fc.property(arbConcluded, (e) => assert.equal(exitCodeOfEnding(e), expected[e._tag])), runs);
});

test("an ending alerts exactly when it is halted or abandoned", () => {
  fc.assert(fc.property(arbEnding, (e) => assert.equal(endingAlerts(e), e._tag === "Halted" || e._tag === "Abandoned")), runs);
});

test("a run reaches its end exactly when it completed or was sent back", () => {
  fc.assert(fc.property(arbEnding, (e) => assert.equal(endsAtItsEnd(e), e._tag === "Completed" || e._tag === "SentBack")), runs);
});
