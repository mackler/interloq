// Issue #185 (requirements "The ending of an abandoned run", Q1, G-R1-1): an implementation run whose question goes
// unanswered within the wait ends with 2: its work moved to the item's branch, the working branch returned to where the
// run began, the item's label set to refined, and conversation.md ending with the abandonment's record. At the first
// read nothing is committed and no label set; a send-back's unanswered tracker step sets no label.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Option, Ref, Result } from "effect";
import { TrackerUnreachable } from "../src/errors.ts";
import { parkBranchOf } from "../src/park.ts";
import { type Conclusion, program } from "../src/program.ts";
import { abandonAfterSendBackLine, durationText } from "../src/prompts.ts";
import type { RunRoot } from "../src/artifacts.ts";
import type { ItemState } from "../src/tracker.ts";
import { fakeTrackerOf, finished, notRefined, questionOf, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const quickTracker = { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const stateOf = async (probe: WiringProbe): Promise<ItemState> => (await Effect.runPromise(probe.tracker!.items)).find((i) => i.id === scriptedItem.id)!.state;
const conversation = (probe: WiringProbe): string => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");

const runIt = async (options: TestOptions) => {
  const repo = tempRepo();
  const start = git(repo, "rev-parse", "HEAD");
  const { wiring, probe } = testWiring(repo, options);
  const concluded = Effect.runSync(Ref.make(Option.none<Conclusion>()));
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring, undefined, undefined, undefined, concluded)));
  return { code, probe, repo, start, conclusion: Option.getOrNull(Effect.runSync(Ref.get(concluded))) };
};
const branchOf = (probe: WiringProbe) => Result.getOrThrow(parkBranchOf(scriptedItem.id, `runs/${path.basename(probe.dir)}` as RunRoot));

test("a plan writer's question unanswered after an execution committed: 2, the work on its branch, the working branch reset, the label refined", async () => {
  const question = questionOf({ context: "c", question: "Which retention?", terms: [], options: [] });
  const { code, probe, repo, start, conclusion } = await runIt({
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: { questions_for_user: [question] }, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "s", question: "q", remainingWork: "r", userInput: null, checks: [] }],
  });
  assert.equal(code, 2);
  const branch = branchOf(probe);
  assert.notEqual(git(repo, "rev-parse", `refs/heads/${branch}`), start);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.equal(await stateOf(probe), "refined");
  const record = conversation(probe);
  assert.ok(record.includes(branch), record.slice(-1500));
  const last = record.slice(record.lastIndexOf("**Abandoned (exit code 2):**"));
  assert.ok(last.length > 0 && last.includes("Which retention?") && last.includes(durationText(120_000)), record.slice(-800));
  assert.match(last, /question \d+/);
  assert.deepEqual(conclusion?.abandoned, { _tag: "SetRefined" });
  assert.equal(conclusion?.parked?._tag, "Parked");
  assert.ok(probe.ui.said.some((l) => l.startsWith("\nNO ANSWER: ")));
});

test("a permission request during the execution that goes unanswered abandons the run the same way", async () => {
  const { code, probe, repo, start } = await runIt({
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execScripts: [{ permission: { tool: "Bash", input: { command: "ls" } } }],
    execs: [finished],
  });
  assert.equal(code, 2);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.equal(await stateOf(probe), "refined");
});

test("the first read's question unanswered: 2, nothing committed, the label still refined, a records directory with the record", async () => {
  const tracker = fakeTrackerOf([scriptedItem]);
  for (let i = 0; i < 2; i++) Effect.runSync(tracker.failNext("read", new TrackerUnreachable({ tracker: "fake", message: "down", status: null })));
  const { code, probe, repo, start, conclusion } = await runIt({ tracker, config: quickTracker, answers: [{ noAnswer: true }] });
  assert.equal(code, 2);
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.equal(await stateOf(probe), "refined");
  const dirs = fs.readdirSync(path.join(repo, "plan-review", "runs"));
  assert.equal(dirs.length, 1);
  const record = fs.readFileSync(path.join(repo, "plan-review", "runs", dirs[0]!, "conversation.md"), "utf8");
  assert.ok(record.includes("retry") && record.includes("**Abandoned (exit code 2):**"), record);
  // No conclusion: the run manager's chain records it as the label unchanged.
  assert.equal(conclusion, null);
});

{
  test("a send-back whose label step goes unanswered, with nothing to park, ends with 2 and sets no label refined", async () => {
    const tracker = fakeTrackerOf([scriptedItem]);
    for (let i = 0; i < 2; i++) Effect.runSync(tracker.failNext("setState", new TrackerUnreachable({ tracker: "fake", message: "down", status: null }), "unrefined"));
    const { code, probe, conclusion } = await runIt({
      tracker,
      config: quickTracker,
      answers: [{ noAnswer: true }],
      steps: [{ output: notRefined("The retention period.") }],
      reviews: [{ issues: [] }],
    });
    assert.equal(code, 2);
    assert.equal(await stateOf(probe), "implementing");
    assert.deepEqual(conclusion?.abandoned, { _tag: "SendBackUnfinished", step: "label" });
    const park = conclusion?.parked ?? null;
    assert.ok(conversation(probe).includes(abandonAfterSendBackLine(scriptedItem.id, park?._tag === "Parked" ? park.branch : null, "label")));
  });
}
