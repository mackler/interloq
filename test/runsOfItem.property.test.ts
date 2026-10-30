import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { implementationRootsOf, itemInRoot, type RunRoot, RUNS_DIR, runRootOf, suffixedRoot } from "../src/artifacts.ts";

// Issue #180: the run directories of one item's implementation runs, recognized by the one naming rule runRootOf
// uses (itemInRoot), with the store's clash suffix, newest first.

const RUNS = { numRuns: 200, seed: 20261019 };
const nameOf = (root: RunRoot): string => root.slice(RUNS_DIR.length + 1);
const arbItem = fc.string({ minLength: 1, maxLength: 50 });
const arbInstant = fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2090, 0, 1) }).map((ms) => new Date(ms).toISOString());
const OWN = runRootOf("implementation", "own", "2099-01-01T00:00:00.000Z");

test("every implementation root of the item, suffixed or not, is recognized, newest first", () => {
  fc.assert(
    fc.property(arbItem, fc.uniqueArray(fc.tuple(arbInstant, fc.integer({ min: 1, max: 4 })), { selector: ([t, k]) => `${t}/${k}`, maxLength: 8 }), (item, runs) => {
      const roots = runs.map(([t, k]) => suffixedRoot(runRootOf("implementation", item, t), k));
      const shuffled = [...roots].reverse();
      const got = implementationRootsOf(shuffled.map(nameOf), item, OWN);
      const expected = [...runs].sort(([ta, ka], [tb, kb]) => (ta === tb ? kb - ka : ta < tb ? 1 : -1)).map(([t, k]) => suffixedRoot(runRootOf("implementation", item, t), k));
      assert.deepEqual(got, expected);
    }),
    RUNS,
  );
});

test("a refinement root, another item's root and the run's own root are left out", () => {
  fc.assert(
    fc.property(arbItem, arbItem, arbInstant, (item, other, t) => {
      fc.pre(itemInRoot(item) !== itemInRoot(other));
      const own = runRootOf("implementation", item, t);
      const names = [runRootOf("refinement", item, t), runRootOf("implementation", other, t), own, suffixedRoot(runRootOf("implementation", other, t), 2)].map(nameOf);
      assert.deepEqual(implementationRootsOf(names, item, own), []);
    }),
    RUNS,
  );
});

test("items 1, 10 and 1-2 side by side, with names that are no run's", () => {
  const t1 = "2026-10-16T09:00:00.000Z";
  const t2 = "2026-10-17T09:00:00.000Z";
  const names = [
    runRootOf("implementation", "1", t1),
    runRootOf("implementation", "10", t2),
    runRootOf("implementation", "1-2", t2),
    suffixedRoot(runRootOf("implementation", "1", t1), 2),
    runRootOf("implementation", "1", t2),
    runRootOf("refinement", "1", t2),
    "runs/config.json",
    "runs/2026-10-17T09-00-00-000Z-implementation-1-x",
  ].map((name) => (name.startsWith(`${RUNS_DIR}/`) ? nameOf(name as RunRoot) : name));
  assert.deepEqual(implementationRootsOf(names, "1", OWN), [runRootOf("implementation", "1", t2), suffixedRoot(runRootOf("implementation", "1", t1), 2), runRootOf("implementation", "1", t1)]);
  assert.deepEqual(implementationRootsOf(names, "1-2", OWN), [runRootOf("implementation", "1-2", t2)]);
  assert.equal(itemInRoot("1-2"), "1_2");
});

// Issue #131: a preparation's records directory, runs/<start time>-preparation-<item>, is never an implementation root.
test("a preparation's root has its own form and is never among the item's implementation roots", () => {
  fc.assert(
    fc.property(arbItem, arbInstant, fc.integer({ min: 1, max: 4 }), (item, t, k) => {
      const root = runRootOf("preparation", item, t);
      assert.equal(root, `${RUNS_DIR}/${t.replace(/[:.]/g, "-")}-preparation-${itemInRoot(item)}`);
      assert.deepEqual(implementationRootsOf([nameOf(suffixedRoot(root, k))], item, OWN), []);
    }),
    RUNS,
  );
});
