import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { platformLayer } from "../src/platform.ts";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { diffSections } from "../src/lateFindings.ts";
import { makeStore } from "../src/store.ts";
import { fakeTrackerOf, finished, issue, respond, runTask, scriptedItem, scriptedStart, TEST_ROOT, tempRepo, testLayer, testWiring } from "./helpers.ts";

// Issue #252: a code review collects every finding before it leaves for planning (requirements Q1), and later code
// reviews know what changed.

const noQuestions = { questions_for_user: [] };
const planWrite = (plan: string) => ({ output: noQuestions, plan });
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const workLog = (dir: string) => (JSON.parse(read(dir, "work-review-log.json")).entries as { id: string; action: string; source: string }[]).filter((e) => e.source === "review");
const workPrompts = (prompts: readonly string[], k: number): readonly string[] => prompts.filter((p) => p.includes(`work-review-${k}/changes.diff`) && p.includes(prompts_REVIEW_PART));
const prompts_REVIEW_PART = prompts.REVIEW_PART_MARKER;

test("S4 (a): an accepted finding is followed by further cycles, and the review leaves after the cycle with no counted issue, with every finding", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, { output: respond([["W1-R2-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R2-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(workPrompts(probe.reviewer.prompts, 1).length, 3, "code review 1 ran three cycles");
  assert.ok(fs.existsSync(path.join(probe.dir, "work-review-1/round-3.json")));
  const revision = probe.planner.prompts[3]!;
  assert.match(revision, /Work review 1 ended after cycle 3/);
  for (const n of [1, 3]) assert.ok(revision.includes(`work-review-1/round-${n}.json`), `round ${n}`);
  assert.ok(revision.includes("work-review-log.json"));
  assert.deepEqual(workLog(probe.dir).map((e) => [e.id, e.action]), [["W1-R1-1", "accepted"], ["W1-R2-1", "accepted"]]);
  assert.ok(read(probe.dir, "conversation.md").includes(prompts.collectedLeaveLine("Work review 1", 3)));
});

test("S4 (b): a clarification raised again under its id keeps the review going; with nothing accepted it ends in agreement", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "clarification_requested"]]) }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(workPrompts(probe.reviewer.prompts, 1).length, 3, "code review 1 ran three cycles");
  assert.ok(!read(probe.dir, "conversation.md").includes(prompts.collectedLeaveLine("Work review 1", 3)));
});

// S7: the work subject's parts come from plan.json, and code review k is given the change since code review k−1.
const appendTo = (repo: string, text: string) => () => fs.appendFileSync(path.join(repo, "a.txt"), text);
const twoSteps = {
  stages: [{ number: 1, title: "the work", steps: [{ id: "S1", number: 1, label: "First", text: "Write test/first.test.ts." }, { id: "S2", number: 2, label: "Second", text: "Write test/second.test.ts." }] }],
};
const withThird = { stages: [...twoSteps.stages, { number: 2, title: "the fix", steps: [{ id: "S3", number: 1, label: "Fix", text: "Correct it." }] }] };

test("S7 (c): code review 2 is given the change since code review 1 as well as the cumulative diff", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    execScripts: [{ after: appendTo(repo, "first execution\n") }, { after: appendTo(repo, "second execution\n") }],
  });
  assert.equal(await runTask(layer), 2);
  const review2 = probe.reviewer.prompts.find((p) => p.includes("work-review-2/changes.diff"))!;
  assert.ok(review2.includes(prompts.sincePreviousText(TEST_ROOT, 2, { review: 1 })), review2);
  assert.ok(review2.includes("work-review-2/since-previous.diff") && review2.includes("code review 1"));
  const since = read(probe.dir, "work-review-2/since-previous.diff");
  assert.match(since, /\+second execution/);
  assert.doesNotMatch(since, /\+first execution/);
  const cumulative = read(probe.dir, "work-review-2/changes.diff");
  assert.match(cumulative, /\+first execution/);
  assert.match(cumulative, /\+second execution/);
  assert.ok(!fs.existsSync(path.join(probe.dir, "work-review-1/since-previous.diff")));
});

test("S7 (d): a code review with two completed steps sends three requests a cycle, and leaves after the cycle that raises nothing, with every finding", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { ...noQuestions, plan: twoSteps } }, { output: respond([["W1-R1-S1-1", "accepted"]]) }, { output: { ...noQuestions, plan: withThird } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    partReviews: { "step-S1": [{ issues: [{ ...issue("W1-R1-S1-1"), location: "S1" }] }] },
    execs: [finished, finished],
    execScripts: [{ reports: [["S1", "started"], ["S1", "done"], ["S2", "started"], ["S2", "done"]] }, { reports: [["S3", "started"], ["S3", "done"]] }],
  });
  assert.equal(await runTask(layer), 2);
  const review1 = probe.reviewer.partPrompts.filter((p) => p.includes("work-review-1/changes.diff"));
  assert.equal(review1.length, 4, "two step parts in each of two cycles");
  assert.equal(workPrompts(probe.reviewer.prompts, 1).length, 2, "one whole-work request in each cycle");
  assert.ok(review1.some((p) => p.startsWith(prompts.reviewPartLine({ _tag: "Step", id: "S2", label: "", text: "" })) && p.includes("Write test/second.test.ts.")));
  assert.deepEqual(workLog(probe.dir).map((e) => [e.id, e.action]), [["W1-R1-S1-1", "accepted"]]);
  assert.ok(read(probe.dir, "conversation.md").includes(prompts.collectedLeaveLine("Work review 1", 2)));
});

test("S7 (e): an execution that stopped with no step done is still reviewed by the whole-work request", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { ...noQuestions, plan: twoSteps } }, { output: { ...noQuestions, plan: twoSteps } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [{ status: "blocked", summary: "partial", question: "It fails.", remainingWork: "everything", userInput: null, checks: [], testFirst: [] }, finished],
  });
  await runTask(layer);
  assert.equal(workPrompts(probe.reviewer.prompts, 1).length, 1);
  assert.deepEqual(probe.reviewer.partPrompts.filter((p) => p.includes("work-review-1/")), []);
});

// S9: the late-findings line, read from the run's records and said and written at an implementation run's end.
const commitFile = (repo: string, name: string, text: string) => () => {
  fs.appendFileSync(path.join(repo, name), text);
  execFileSync("git", ["-C", repo, "add", "--", name]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name, "--", name]);
};
const runProgram = (wiring: Parameters<typeof program>[1], project: string, mode: "implementation" | "refinement" = "implementation") => Effect.runPromise(Effect.scoped(program(scriptedStart(project, mode), wiring)));
const at = (id: string, location: string) => ({ ...issue(id), location });

test("S9 (f): a finding of code review 2 in a file unchanged since code review 1 is counted late at the run's end", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2"), { output: respond([["W2-R1-1", "accepted"]]) }, planWrite("v3")],
    reviews: [{ issues: [] }, { issues: [at("W1-R1-1", "b.txt")] }, { issues: [] }, { issues: [] }, { issues: [at("W2-R1-1", "b.txt:1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished, finished],
    execScripts: [{ after: commitFile(repo, "b.txt", "b\n") }, { after: commitFile(repo, "a.txt", "a2\n") }, {}],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  const line = prompts.lateFindingsLine(1, 2);
  const text = read(probe.dir, "conversation.md");
  assert.ok(text.includes(line), text.slice(-1500));
  assert.ok(probe.ui.said.includes(line));
  assert.ok(probe.ui.said.indexOf(line) < probe.ui.said.findIndex((l) => l.startsWith("Usage:")), "before the run's last lines");
  const one = diffSections(read(probe.dir, "work-review-1/changes.diff"));
  const two = diffSections(read(probe.dir, "work-review-2/changes.diff"));
  assert.notEqual(two.get("a.txt"), one.get("a.txt"));
  assert.match(two.get("a.txt") ?? "", /^\+a2$/mu, "execution 2 changed a.txt itself");
  assert.equal(two.get("b.txt"), one.get("b.txt"));
});

test("S9 (g): a run halted after one code review writes the line before its halt record, which still ends conversation.md", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [], touchProject: true }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 1);
  const text = read(probe.dir, "conversation.md");
  const line = prompts.lateFindingsLine(0, 1);
  assert.ok(text.includes(line), text.slice(-1500));
  assert.ok(text.trimEnd().endsWith(text.slice(text.lastIndexOf("**Halted (exit code 1):**")).trimEnd()));
  assert.ok(text.indexOf(line) < text.lastIndexOf("**Halted (exit code 1):**"));
});

test("S9 (h): a refinement run writes no such line", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }], tracker: fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]), mode: "refinement" });
  assert.equal(await runProgram(wiring, probe.project, "refinement"), 0);
  assert.ok(!read(probe.dir, "conversation.md").includes("Code-review findings in code an earlier code review"));
});

test("S9 (i): a clean code review counts as a record, and a minor finding of a later review in a file it read is late", async () => {
  const repo = tempRepo();
  const minor = { ...at("W2-R1-1", "b.txt"), severity: "minor" as const };
  const { wiring, probe } = testWiring(repo, {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [planWrite("v1"), planWrite("v2"), planWrite("v3"), planWrite("v4")],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [minor] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished, finished],
    execScripts: [{ after: commitFile(repo, "b.txt", "b\n") }, {}, {}],
    suite: [{ _tag: "Failed", reason: { kind: "exit", code: 1 }, output: "not ok\n", ms: 10 }, { _tag: "Failed", reason: { kind: "exit", code: 1 }, output: "not ok\n", ms: 10 }],
    config: { suiteCommand: "script/test --all", countMinor: false },
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  const records = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* makeStore(probe.project, probe.dir.slice(probe.dir.indexOf("runs/")) as never, [])).codeReviewRecords(); }).pipe(Effect.provide(platformLayer)));
  assert.deepEqual(records.map((r) => [r.review, r.findings.map((f) => f.id)]), [[1, []], [2, ["W2-R1-1"]], [3, []]]);
  assert.ok(read(probe.dir, "conversation.md").includes(prompts.lateFindingsLine(1, 1)));
});

test("S12 (j): Stop task during planning phase 2 writes the line before the interruption's record, which still ends conversation.md", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, { hang: true }],
    reviews: [{ issues: [] }, { issues: [at("W1-R1-1", "b.txt")] }, { issues: [] }],
    execs: [finished],
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  const ended = await Promise.race([probe.planner.nextHang().then(() => false), Effect.runPromise(Fiber.await(fiber)).then(() => true)]);
  assert.equal(ended, false, "the run ended before planning phase 2");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  const text = read(probe.dir, "conversation.md");
  const line = prompts.lateFindingsLine(0, 1);
  const record = "**Interrupted by the user.**";
  assert.ok(text.includes(line), text.slice(-1500));
  assert.ok(probe.ui.said.includes(line));
  assert.ok(text.indexOf(line) < text.lastIndexOf(record));
  assert.equal(text.slice(text.lastIndexOf(record) + record.length).trim(), "", "the interruption's record ends conversation.md");
});
