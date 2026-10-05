import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { finalStage, parallelStages, runStages, spawnStage, type Stage, type StageResult, verdict } from "../scripts/test-all.ts";

// Issue #75: npm test runs the stages that share nothing at once, and the end-to-end tests only after all of them passed.

/** A fake process boundary whose stages end only when the test ends them. */
const controlled = () => {
  const started: string[] = [];
  const pending = new Map<string, (code: number) => void>();
  const start = (stage: Stage): Promise<StageResult> =>
    new Promise((resolve) => {
      started.push(stage.name);
      pending.set(stage.name, (code) => resolve({ stage, code, output: `${stage.name} output` }));
    });
  const end = async (name: string, code: number) => {
    const resolve = pending.get(name);
    assert.ok(resolve !== undefined, `${name} was not started`);
    pending.delete(name);
    resolve(code);
    await new Promise((r) => setImmediate(r));
  };
  return { started, start, end };
};
const tick = () => new Promise((r) => setImmediate(r));
const names = parallelStages.map((s) => s.name);

test("property: verdict fails if and only if some stage failed, and names exactly the failed ones", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 6 }), (codes) => {
      const results = codes.map((code, i) => ({ stage: { name: `s${i}`, script: `s${i}` }, code, output: "" }));
      const v = verdict(results);
      assert.equal(v.passed, codes.every((c) => c === 0));
      assert.deepEqual(v.failed, results.filter((r) => r.code !== 0).map((r) => r.stage.name));
    }),
  );
});

test("the five stages that share nothing all start before any of them ends", async () => {
  const c = controlled();
  const outcome = runStages(c.start);
  await tick();
  assert.deepEqual([...c.started].sort(), [...names].sort());
  for (const n of names) await c.end(n, 0);
  await c.end(finalStage.name, 0);
  assert.equal((await outcome).code, 0);
});

test("the end-to-end tests do not start while the build or any other stage runs, and start when all passed", async () => {
  const c = controlled();
  const outcome = runStages(c.start);
  await tick();
  for (const n of names.filter((n) => n !== "build")) await c.end(n, 0);
  assert.ok(!c.started.includes(finalStage.name), "the end-to-end tests started before the build ended");
  await c.end("build", 0);
  assert.ok(c.started.includes(finalStage.name), "the end-to-end tests did not start after every stage passed");
  await c.end(finalStage.name, 0);
  const done = await outcome;
  assert.equal(done.code, 0);
  assert.deepEqual(done.results.map((r) => r.stage.name).sort(), [...names, finalStage.name].sort());
});

for (const failing of names) {
  test(`a failure of ${failing} lets the others run to their end, keeps the end-to-end tests from starting, and gives code 1`, async () => {
    const c = controlled();
    const ended: string[] = [];
    const outcome = runStages(c.start, (r) => ended.push(r.stage.name));
    await tick();
    await c.end(failing, 1);
    for (const n of names.filter((n) => n !== failing)) await c.end(n, 0);
    const done = await outcome;
    assert.equal(done.code, 1);
    assert.ok(!c.started.includes(finalStage.name), "the end-to-end tests started after a failure");
    assert.deepEqual([...ended].sort(), [...names].sort(), "a stage was not reported when it ended");
  });
}

test("every parallel stage passing and the end-to-end tests failing gives code 1", async () => {
  const c = controlled();
  const outcome = runStages(c.start);
  await tick();
  for (const n of names) await c.end(n, 0);
  await c.end(finalStage.name, 2);
  assert.equal((await outcome).code, 1);
});

test("spawnStage collects a real child process's exit code and output", async () => {
  const start = spawnStage(process.execPath, (s) => ["-e", s.script]);
  const [ok, bad] = await Promise.all([
    start({ name: "ok", script: "console.log('out'); console.error('err')" }),
    start({ name: "bad", script: "console.log('failing'); process.exit(3)" }),
  ]);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  assert.equal(bad.code, 3);
  assert.match(bad.output, /failing/);
});
