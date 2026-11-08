import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import type { RunRoot } from "../src/artifacts.ts";
import { program } from "../src/program.ts";
import { newThreadSentence, reviewPartLine, threadResumeFailedLine, threadRestartLine } from "../src/prompts.ts";
import { subjectHeading } from "../src/render.ts";
import type { StoreShape } from "../src/services.ts";
import { fakeTrackerOf, finished, issue, respond, runTask, scriptedItem, scriptedStart, TEST_ROOT, tempRepo, testLayer, testWiring } from "./helpers.ts";

// Issue #262: a Codex review thread the CLI cannot resume is replaced by a new thread, and the review goes on.
const HALT = "Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: list_turns is not supported yet (code -32601)";
const noQuestions = { questions_for_user: [] };
const conversation = (dir: string): string => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const runProgram = (wiring: Parameters<typeof program>[1], project: string) => Effect.runPromise(Effect.scoped(program(scriptedStart(project, "implementation"), wiring)));
/** The run's root, read from the store the run opens (program allocates it from the clock). */
const capturing = () => {
  const captured: { root: RunRoot | null } = { root: null };
  const store = (s: StoreShape): StoreShape => {
    captured.root = s.root;
    return s;
  };
  return { captured, store };
};
const resumeLines = (text: string): number => text.split("could not resume thread").length - 1;
const fast = { transportRetryDelaySeconds: 0.01 };

test("(a) the plan review: a round whose thread cannot be resumed is repeated on a new thread with the new-thread prompt, and the run ends 0", async () => {
  const { captured, store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 3]);
  assert.ok(probe.reviewer.prompts[2]!.startsWith(newThreadSentence(captured.root!, "issue-log.json", 2)), probe.reviewer.prompts[2]!.slice(0, 200));
  const line = threadResumeFailedLine(subjectHeading({ plan: 1 }), 2, "scripted-thread-1", HALT);
  assert.ok(conversation(probe.dir).includes(line), "conversation.md lacks the line");
  assert.ok(probe.ui.said.includes(line), "the page was not told");
  assert.deepEqual(probe.ui.asked, []);
});

const oneStep = { stages: [{ number: 1, title: "the work", steps: [{ id: "S1", number: 1, label: "First", text: "Write test/first.test.ts." }] }] };
test("(b) a code review's step part whose thread cannot be resumed gets a new thread for that part alone, and the run ends 0", async () => {
  const { captured, store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: { ...noQuestions, plan: oneStep } }, { output: respond([["W1-R1-S1-1", "accepted"]]) }, { output: { ...noQuestions, plan: oneStep } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    partReviews: { "step-S1": [{ issues: [{ ...issue("W1-R1-S1-1"), location: "S1" }] }, { issues: [], failure: HALT }, { issues: [] }] },
    execs: [finished, finished],
    execScripts: [{ reports: [["S1", "started"], ["S1", "done"]] }, {}],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  const step = { _tag: "Step", id: "S1", label: "", text: "" } as const;
  const repeated = probe.reviewer.partPrompts[2]!;
  assert.ok(repeated.startsWith(reviewPartLine(step)), repeated.slice(0, 300));
  assert.ok(repeated.includes(newThreadSentence(captured.root!, "work-review-log.json", 2)), repeated.slice(0, 400));
  const text = conversation(probe.dir);
  const said = probe.ui.said.find((l) => l.includes("could not resume thread"));
  assert.ok(said !== undefined && said.includes(" (step S1): ") && said.includes("scripted-thread-"), said);
  assert.ok(text.includes(said!));
  assert.deepEqual(probe.ui.asked, []);
});

test("(c) a new thread's first turn that fails with the resume text halts: it resumed nothing", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [], failure: HALT }],
    execs: [finished],
  });
  await assert.rejects(runTask(layer), (e: unknown) => (e as { _tag: string })._tag === "CodexCallFailed");
  assert.equal(resumeLines(conversation(probe.dir)), 1);
});

test("(d) a refused credential on a resumed turn halts with no new thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: `${HALT} 401 Unauthorized` }],
    execs: [finished],
  });
  await assert.rejects(runTask(layer), (e: unknown) => (e as { _tag: string })._tag === "CodexCallFailed");
  assert.deepEqual(probe.reviewer.callPhases, [1, 1]);
  assert.equal(resumeLines(conversation(probe.dir)), 0);
});

test("(e) a schema repair turn whose thread cannot be resumed: a new thread gets the round's first-round prompt, and its review is accepted", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], raw: "not json" }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 3]);
  assert.equal(probe.reviewer.prompts[2], probe.reviewer.prompts[0], "round 1's prompt is repeated");
  assert.ok(conversation(probe.dir).includes(threadResumeFailedLine(subjectHeading({ plan: 1 }), 1, "scripted-thread-1", HALT)));
  assert.deepEqual(probe.ui.asked, []);
});

test("(f) the replaced thread's inputs are not counted: the next round continues the new thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [], raw: "not json", inputTokens: 900_000 }, { issues: [], failure: HALT }, { issues: [issue("P1-R1-1")], inputTokens: 1_000 }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 2, 3]);
  assert.ok(!conversation(probe.dir).includes(threadRestartLine(subjectHeading({ plan: 1 }), 2, 900_000, 500_000)));
});

test("(g) a replacement thread whose retry resumes and is refused is replaced again, each replacement said", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    config: fast,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [], fault: "stream disconnected" }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 2, 3, 4]);
  assert.ok(probe.reviewer.prompts[4]!.startsWith(newThreadSentence(TEST_ROOT, "issue-log.json", 2)));
  const text = conversation(probe.dir);
  assert.equal(resumeLines(text), 2);
  assert.ok(text.includes(threadResumeFailedLine(subjectHeading({ plan: 1 }), 2, "scripted-thread-1", HALT)));
  assert.ok(text.includes(threadResumeFailedLine(subjectHeading({ plan: 1 }), 2, "scripted-thread-2", HALT)));
  assert.deepEqual(probe.ui.asked, []);
});
