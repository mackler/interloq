// Issue #176 (requirements Q1, Q3): an implementation run is finished only when no file it changed is uncommitted. The
// check runs after the work review finds nothing left to correct, or after the whole suite passes where one is named;
// files it finds send the plan back for revision with their names, without limit, until they are committed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import { uncommittedLine } from "../src/prompts.ts";
import { fakeTrackerOf, finished, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const SUITE = "script/test --all";
const git = (repo: string, ...args: string[]): void => void execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
const writeIn = (repo: string, name: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), text);
};
const commitAll = (repo: string, message: string): void => {
  git(repo, "add", "-A", "--", ".", ":(exclude)plan-review");
  git(repo, "commit", "-qm", message);
};
const kinds = (notified: readonly { _tag: string }[]): string[] =>
  (notified.filter((e) => e._tag === "PhasesForeseen").at(-1) as unknown as { phases: { kind: string; n?: number }[] }).phases.map((p) => `${p.kind}${p.n ?? ""}`);
const two = { steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }], reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }], execs: [finished, finished] };
const one = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
const runOf = (wiring: Parameters<typeof program>[1], project: string) => Effect.runPromise(Effect.scoped(program(scriptedStart(project), wiring)));

test("(a) a file left uncommitted sends the plan back with its name; the run ends 0 once the next execution commits it", async () => {
  const repo = tempRepo();
  const tracker = fakeTrackerOf([scriptedItem]);
  const { wiring, probe } = testWiring(repo, { ...two, tracker, execScripts: [{ after: () => writeIn(repo, "b.txt", "b\n") }, { after: () => commitAll(repo, "b") }] });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(probe.planner.execPrompts.length, 2);
  const revision = probe.planner.prompts.find((p) => p.includes("changed by the run and not committed"));
  assert.ok(revision !== undefined && revision.includes("b.txt"), "no planning prompt names the uncommitted file");
  const line = uncommittedLine("Code review 1", ["b.txt"], null);
  assert.ok(probe.ui.said.some((l) => l.includes(line)), probe.ui.said.join("\n"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(line));
  assert.equal((await Effect.runPromise(tracker.items)).find((i) => i.id === scriptedItem.id)?.state, "implemented");
  assert.deepEqual(kinds(probe.ui.notified), ["planning1", "execution1", "work1", "planning2", "execution2", "work2"]);
});

test("(b) an execution that commits its file finishes after one iteration", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { ...one, execScripts: [{ after: () => (writeIn(repo, "b.txt", "b\n"), commitAll(repo, "b")) }] });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(probe.planner.execPrompts.length, 1);
});

test("(c) a file uncommitted before the run began and changed again is not counted", async () => {
  const repo = tempRepo();
  writeIn(repo, "a.txt", "dirty before the run\n");
  const { wiring, probe } = testWiring(repo, { ...one, execScripts: [{ after: () => writeIn(repo, "a.txt", "changed again by the run\n") }] });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(probe.planner.execPrompts.length, 1);
});

test("(d) with a suite: the check follows the suite's pass, and the suite runs again before the next check", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { ...two, config: { suiteCommand: SUITE }, execScripts: [{ after: () => writeIn(repo, "b.txt", "b\n") }, { after: () => commitAll(repo, "b") }] });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(probe.suite.runs.length, 2);
  const revision = probe.planner.prompts.find((p) => p.includes("changed by the run and not committed"));
  assert.ok(revision !== undefined && revision.includes(`\`${SUITE}\``), "the revision does not say the suite passed");
  assert.deepEqual(kinds(probe.ui.notified), ["planning1", "execution1", "work1", "suite1", "planning2", "execution2", "work2", "suite2"]);
});

test("(e) a file git ignores and does not track, and a file under ignorePaths, are not counted", async () => {
  const repo = tempRepo();
  writeIn(repo, ".gitignore", "*.log\n");
  commitAll(repo, "ignore");
  const { wiring, probe } = testWiring(repo, {
    ...one,
    config: { ignorePaths: ["scratch"] },
    execScripts: [{ after: () => (writeIn(repo, "out.log", "ignored\n"), writeIn(repo, "scratch/x.txt", "configured to ignore\n")) }],
  });
  assert.equal(await runOf(wiring, probe.project), 0);
  assert.equal(probe.planner.execPrompts.length, 1);
});

test("(f) Stop task during the revision an uncommitted file caused ends the run with 130", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, {
    steps: [{ output: noQuestions, plan: "v1" }, { hang: true }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    execScripts: [{ after: () => writeIn(repo, "b.txt", "b\n") }],
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  // The run may end before any revision (the failure this test exists to catch), so the wait races the run's end.
  const ended = await Promise.race([probe.planner.nextHang().then(() => false), Effect.runPromise(Fiber.await(fiber)).then(() => true)]);
  assert.equal(ended, false, "the run ended without revising the plan for the uncommitted file");
  assert.ok(probe.planner.prompts.at(-1)?.includes("b.txt"), "the hanging call is not the revision for the uncommitted file");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
});
