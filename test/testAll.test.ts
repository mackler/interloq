import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { runStages, spawnStage, type Stage, type StageResult, type Stages, testStages, verdict } from "../scripts/test-all.ts";

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
const names = testStages.parallel.map((s) => s.name);
const finalStage: Stage = testStages.kind === "thenFinal" ? testStages.final : assert.fail("npm test has no final stage");

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
  const outcome = runStages(testStages, c.start);
  await tick();
  assert.deepEqual([...c.started].sort(), [...names].sort());
  for (const n of names) await c.end(n, 0);
  await c.end(finalStage.name, 0);
  assert.equal((await outcome).code, 0);
});

test("the end-to-end tests do not start while the build or any other stage runs, and start when all passed", async () => {
  const c = controlled();
  const outcome = runStages(testStages, c.start);
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
    const outcome = runStages(testStages, c.start, (r) => ended.push(r.stage.name));
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
  const outcome = runStages(testStages, c.start);
  await tick();
  for (const n of names) await c.end(n, 0);
  await c.end(finalStage.name, 2);
  assert.equal((await outcome).code, 1);
});

test("npm test passes exactly the stages it passed before issue #105: five at once, then the end-to-end tests", () => {
  assert.equal(testStages.kind, "thenFinal");
  assert.deepEqual(testStages.parallel.map((s) => s.script), ["check", "test:unit", "test:cli", "test:web", "build"]);
  assert.equal(finalStage.script, "test:e2e");
});

const two: Stages = { kind: "parallel", parallel: [{ name: "a", script: "a" }, { name: "b", script: "b" }] };

for (const [codeA, expected] of [[0, 0], [1, 1]] as const) {
  test(`a run without a final stage starts both stages at once, nothing after them, and gives code ${expected}`, async () => {
    const c = controlled();
    const outcome = runStages(two, c.start);
    await tick();
    assert.deepEqual([...c.started].sort(), ["a", "b"]);
    await c.end("a", codeA);
    await c.end("b", 0);
    const done = await outcome;
    assert.deepEqual([...c.started].sort(), ["a", "b"], "a stage started after the parallel ones");
    assert.equal(done.code, expected);
  });
}

test("property: every parallel stage starts before any ends, each stage that ran is reported once, the final stage runs if and only if all passed, and the code is 1 if and only if a stage that ran failed", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 6 }),
      fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
      async (codes, finalCode) => {
        const stage = (name: string): Stage => ({ name, script: name });
        const parallel = codes.map((_, i) => stage(`p${i}`));
        const nonEmpty: readonly [Stage, ...Stage[]] = [parallel[0] ?? stage("p0"), ...parallel.slice(1)];
        const stages: Stages =
          finalCode === undefined ? { kind: "parallel", parallel: nonEmpty } : { kind: "thenFinal", parallel: nonEmpty, final: stage("final") };
        const c = controlled();
        const reported: string[] = [];
        const outcome = runStages(stages, c.start, (r) => reported.push(r.stage.name));
        await tick();
        assert.deepEqual([...c.started].sort(), parallel.map((s) => s.name).sort());
        for (const [i, code] of codes.entries()) await c.end(`p${i}`, code);
        const allPassed = codes.every((x) => x === 0);
        const finalRuns = finalCode !== undefined && allPassed;
        assert.equal(c.started.includes("final"), finalRuns);
        if (finalRuns) await c.end("final", finalCode);
        const done = await outcome;
        const ran = finalRuns ? [...codes, finalCode] : codes;
        assert.deepEqual([...reported].sort(), [...parallel.map((s) => s.name), ...(finalRuns ? ["final"] : [])].sort());
        assert.equal(done.code, ran.some((x) => x !== 0) ? 1 : 0);
      },
    ),
    { numRuns: 100 },
  );
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
