import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { controlled, tick } from "./stagesFake.ts";
import { Option, Result } from "effect";
import { countsFileOf, NO_REPORT, runStages, spawnStage, type Stage, type StageResult, type Stages, stageReport, summary, testStages, verdict } from "../scripts/test-all.ts";
import { commandReportText } from "../src/prompts.ts";
import { decodeCountsFile, encodeCountsFile } from "../src/testCounts.ts";

// Issue #75: npm test runs the stages that share nothing at once. Since the developer's decision of 19 Oct 2026 (the
// run of issue #179) it runs no end-to-end stage after them: those are `npm run test:e2e`, a step of their own in CI.

const names = testStages.parallel.map((s) => s.name);

test("property: verdict fails if and only if some stage failed, and names exactly the failed ones", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 6 }), (codes) => {
      const results = codes.map((code, i) => ({ stage: { name: `s${i}`, script: `s${i}`, report: NO_REPORT }, code, output: "", report: stageReport({ name: `s${i}`, script: `s${i}`, report: NO_REPORT }, code, null) }));
      const v = verdict(results);
      assert.equal(v.passed, codes.every((c) => c === 0));
      assert.deepEqual(v.failed, results.filter((r) => r.code !== 0).map((r) => r.stage.name));
    }),
  );
});

test("the five stages all start before any of them ends, nothing starts after them, and all passing gives code 0", async () => {
  const c = controlled();
  const outcome = runStages(testStages, c.start);
  await tick();
  assert.deepEqual([...c.started].sort(), [...names].sort());
  for (const n of names) await c.end(n, 0);
  assert.deepEqual([...c.started].sort(), [...names].sort(), "a stage started after the five");
  const done = await outcome;
  assert.equal(done.code, 0);
  assert.deepEqual(done.results.map((r) => r.stage.name).sort(), [...names].sort());
});

for (const failing of names) {
  test(`a failure of ${failing} lets the others run to their end, starts nothing after them, and gives code 1`, async () => {
    const c = controlled();
    const ended: string[] = [];
    const outcome = runStages(testStages, c.start, (r) => ended.push(r.stage.name));
    await tick();
    await c.end(failing, 1);
    for (const n of names.filter((n) => n !== failing)) await c.end(n, 0);
    const done = await outcome;
    assert.equal(done.code, 1);
    assert.deepEqual([...c.started].sort(), [...names].sort(), "a stage started after the five");
    assert.deepEqual([...ended].sort(), [...names].sort(), "a stage was not reported when it ended");
  });
}

test("npm test runs five stages at once and no end-to-end stage", () => {
  assert.equal(testStages.kind, "parallel");
  assert.deepEqual(testStages.parallel.map((s) => s.script), ["check", "test:unit", "test:cli", "test:web", "build"]);
  assert.ok(!testStages.parallel.some((s) => s.script === "test:e2e"), "npm test runs the end-to-end tests");
});

const two: Stages = { kind: "parallel", parallel: [{ name: "a", script: "a", report: NO_REPORT }, { name: "b", script: "b", report: NO_REPORT }] };

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
        const stage = (name: string): Stage => ({ name, script: name, report: NO_REPORT });
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
    start({ name: "ok", script: "console.log('out'); console.error('err')", report: NO_REPORT }),
    start({ name: "bad", script: "console.log('failing'); process.exit(3)", report: NO_REPORT }),
  ]);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  assert.equal(bad.code, 3);
  assert.match(bad.output, /failing/);
});

// Issue #39 (S5): each stage's counts, read from its runner's structured report, named in the summary and written to the
// counts file Interloq names.
const stageOf = (script: string): Stage => testStages.parallel.find((s) => s.script === script) ?? assert.fail(script);
const VITEST = JSON.stringify({ numPassedTests: 300, numFailedTests: 0, numPendingTests: 2, numTodoTests: 1, testResults: [] });

test("npm test's stages read the report of their runner, and check and build count nothing", () => {
  assert.deepEqual(testStages.parallel.map((s) => [s.script, s.report.kind]), [["check", "none"], ["test:unit", "nodeTest"], ["test:cli", "tap"], ["test:web", "vitest"], ["build", "none"]]);
});

test("stageReport: a build is uncounted, a counting stage with its report counted, and one without its report uncounted", () => {
  assert.deepEqual(stageReport(stageOf("build"), 0, null), { _tag: "Uncounted", name: "npm run build", outcome: "passed" });
  assert.deepEqual(stageReport(stageOf("check"), 2, "{}"), { _tag: "Uncounted", name: "npm run check", outcome: "failed" });
  assert.deepEqual(stageReport(stageOf("test:unit"), 1, JSON.stringify({ passed: 5, failed: 1, cancelled: 0, skipped: 0, todo: 2 })), {
    _tag: "Counted", name: "npm run test:unit", outcome: "failed", scope: "whole", counts: { passed: 5, failed: 1, skipped: 2 },
  });
  assert.deepEqual(stageReport(stageOf("test:web"), 0, null), { _tag: "Uncounted", name: "npm run test:web", outcome: "passed" });
  assert.deepEqual(stageReport(stageOf("test:cli"), 0, "not tap"), { _tag: "Uncounted", name: "npm run test:cli", outcome: "passed" });
});

test("the seam: a Vitest report's counts appear unchanged in the summary and in the counts file", async () => {
  const c = controlled();
  const outcome = runStages(testStages, c.start);
  await tick();
  for (const s of testStages.parallel) await c.end(s.name, 0, s.script === "test:web" ? VITEST : null);
  const done = await outcome;
  const web = { _tag: "Counted" as const, name: "npm run test:web", outcome: "passed" as const, scope: "whole" as const, counts: { passed: 300, failed: 0, skipped: 3 } };
  const text = summary("npm test", done);
  assert.ok(text.startsWith("npm test: every stage passed. "), text);
  for (const r of done.results) assert.ok(text.includes(commandReportText(r.report)), commandReportText(r.report));
  assert.ok(text.includes(commandReportText(web)));
  const file = Option.getOrThrow(countsFileOf(done.results));
  assert.deepEqual(Result.getOrThrow(decodeCountsFile(encodeCountsFile(file))).commands, done.results.map((r) => r.report));
  assert.deepEqual(file.commands.find((r) => r.name === "npm run test:web"), web);
});
