// Issue #185 (requirements "The ending of an abandoned run", Q1, G-R1-1): an implementation run whose question goes
// unanswered within the wait ends with 2: its work moved to the item's branch, the working branch returned to where the
// run began, the item's label set to refined, and conversation.md ending with the abandonment's record. Issue #243: a
// tracker step whose repeats are used up no longer asks and waits, its question beside further repeats (S14,
// test/trackerRetry.test.ts and test/program.test.ts), so neither the first read nor a send-back's tracker step is
// abandoned for want of an answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Option, Ref, Result } from "effect";
import { parkBranchOf } from "../src/park.ts";
import { type Conclusion, program } from "../src/program.ts";
import { durationText, PARK_UNCHECKED_SENTENCE } from "../src/prompts.ts";
import type { RunRoot } from "../src/artifacts.ts";
import type { ItemState } from "../src/tracker.ts";
import { finished, questionOf, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const stateOf = async (probe: WiringProbe): Promise<ItemState> => (await Effect.runPromise(probe.tracker!.items)).find((i) => i.id === scriptedItem.id)!.state;
const conversation = (probe: WiringProbe): string => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");

const runIt = async (options: TestOptions) => {
  const repo = tempRepo();
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
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
    execs: [{ status: "needs_input", summary: "s", question: "q", remainingWork: "r", userInput: null, checks: [], testFirst: [] }],
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
  assert.deepEqual(conclusion?.ending._tag === "Abandoned" ? conclusion.ending.label : null, { _tag: "SetRefined" });
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

// Work review 1 of issue #185 (W1-R1-4): the page says that the parking commit skipped the project's hooks.
test("a plan writer's question unanswered after an execution left files uncommitted: the page says the commit skipped the hooks", async () => {
  const question = questionOf({ context: "c", question: "Which retention?", terms: [], options: [] });
  const { code, probe, conclusion } = await runIt({
    answers: [{ noAnswer: true }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: { questions_for_user: [question] }, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execScripts: [{ uncommitted: true }],
    execs: [{ status: "needs_input", summary: "s", question: "q", remainingWork: "r", userInput: null, checks: [], testFirst: [] }],
  });
  assert.equal(code, 2);
  assert.equal(conclusion?.parked?._tag, "Parked");
  assert.ok(probe.ui.said.some((l) => l.includes(PARK_UNCHECKED_SENTENCE) && l.includes(branchOf(probe))), probe.ui.said.join("\n"));
});
