import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkStages } from "../scripts/check.ts";
import { runStages } from "../scripts/test-all.ts";
import { controlled, tick } from "./stagesFake.ts";

// Issue #105: npm run check runs its three type checks together, and a failure of one does not stop the others.

/** The `check` script before issue #105, which the pre-commit hook ran: the three checks in sequence. */
const CHECK_BEFORE = "tsc --noEmit && tsc --noEmit -p web && svelte-check --tsconfig web/tsconfig.json --fail-on-warnings";

const names = checkStages.parallel.map((s) => s.name);

test("the three checks all start before any of them ends, and nothing starts after them", async () => {
  const c = controlled();
  const outcome = runStages(checkStages, c.start);
  await tick();
  assert.equal(c.started.length, 3);
  assert.deepEqual([...c.started].sort(), [...names].sort());
  for (const n of names) await c.end(n, 0);
  const done = await outcome;
  assert.equal(c.started.length, 3, "a stage started after the three checks");
  assert.equal(done.code, 0);
});

for (const failing of ["check:program", "check:web", "check:svelte"]) {
  test(`a failure of ${failing} lets the other two run to their end, reports all three, and gives code 1`, async () => {
    const c = controlled();
    const ended: string[] = [];
    const outcome = runStages(checkStages, c.start, (r) => ended.push(r.stage.name));
    await tick();
    await c.end(failing, 1);
    for (const n of names.filter((n) => n !== failing)) await c.end(n, 0);
    const done = await outcome;
    assert.equal(done.code, 1);
    assert.deepEqual([...ended].sort(), ["check:program", "check:svelte", "check:web"]);
  });
}

test("the seam: the runner spawns the three commands the check script ran in sequence before, and the hook still runs check", () => {
  const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.deepEqual(
    checkStages.parallel.map((s) => scripts[s.script]),
    CHECK_BEFORE.split(" && "),
  );
  assert.equal(checkStages.kind, "parallel");
  assert.equal(scripts["check"], "node scripts/check.ts");
  assert.match(readFileSync(".githooks/pre-commit", "utf8").trimEnd(), /exec npm run --silent check$/);
});
