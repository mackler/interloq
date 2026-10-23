// Issue #183: each agent's statement of a disputed point's effect on the work, as the program holds it (src/workEffect.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import * as S from "../src/schema.ts";
import { changesNothing, workEffectOf } from "../src/workEffect.ts";

const RUNS = { numRuns: 200, seed: 20261023 };
const NONE: S.WorkEffect = { kind: "none" };
const differs = (difference: string): S.WorkEffect => ({ kind: "differs", difference: difference as S.EffectText });

test("workEffectOf: none, and a difference with a character other than whitespace, kept unchanged; a blank one refused", () => {
  assert.deepEqual(workEffectOf({ kind: "none" }), Result.succeed(NONE));
  assert.deepEqual(workEffectOf({ kind: "differs", difference: " the README stays unwrapped " }), Result.succeed(differs(" the README stays unwrapped ")));
  for (const blank of ["", " ", "\t", "\n "]) assert.deepEqual(workEffectOf({ kind: "differs", difference: blank }), Result.fail("blank"));
});

test("property: workEffectOf succeeds exactly when the reply is none or its difference has a character other than whitespace", () => {
  const reply: fc.Arbitrary<S.WorkEffectReply> = fc.oneof(fc.constant({ kind: "none" as const }), fc.string().map((difference) => ({ kind: "differs" as const, difference })));
  fc.assert(
    fc.property(reply, (r) => {
      const result = workEffectOf(r);
      const valid = r.kind === "none" || /\S/u.test(r.difference);
      assert.equal(Result.isSuccess(result), valid);
      if (Result.isSuccess(result)) assert.deepEqual(result.success, r);
    }),
    RUNS,
  );
});

test("changesNothing: true exactly when both agents state none", () => {
  assert.equal(changesNothing({ reviewer: NONE, planner: NONE }), true);
  assert.equal(changesNothing({ reviewer: differs("x"), planner: NONE }), false);
  assert.equal(changesNothing({ reviewer: NONE, planner: differs("x") }), false);
  assert.equal(changesNothing({ reviewer: differs("x"), planner: differs("y") }), false);
});
