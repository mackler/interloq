// Issue #147 (S2): every parked branch name built from an item id and a run's root is one git accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { Result } from "effect";
import fc from "fast-check";
import { parkBranchOf } from "../src/park.ts";
import { runRootOf } from "../src/artifacts.ts";
import { itemIdOf } from "../src/tracker.ts";

const arbItem = fc.string({ minLength: 1, maxLength: 30, unit: "binary" }).filter((s) => s.trim() !== "");
const arbTime = fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z"), noInvalidDate: true });
const nameOf = (item: string, time: Date) => parkBranchOf(Result.getOrThrow(itemIdOf(item)), runRootOf("implementation", item, time.toISOString()));

test("the constructor accepts every name built from an item id and a run's root", () => {
  fc.assert(fc.property(arbItem, arbTime, (item, time) => assert.equal(Result.isSuccess(nameOf(item, time)), true)), { numRuns: 300, seed: 20261020 });
});

test("git check-ref-format accepts a sample of the names", () => {
  const sample = fc.sample(fc.tuple(arbItem, arbTime), { numRuns: 25, seed: 20261020 });
  for (const [item, time] of sample) {
    const name = Result.getOrThrow(nameOf(item, time));
    assert.equal(execFileSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" }).trim(), name);
  }
});
