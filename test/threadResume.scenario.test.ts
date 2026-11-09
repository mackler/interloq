import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import type { RunRoot } from "../src/artifacts.ts";
import { exitCodeOf, program } from "../src/program.ts";
import { newThreadSentence, TRANSPORT_ANSWERS, reviewPartLine, threadResumeFailedLine, threadRestartLine } from "../src/prompts.ts";
import { subjectHeading } from "../src/render.ts";
import type { StoreShape } from "../src/services.ts";
import type { Asked, RunEvent } from "../src/protocol.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { makeWebUi } from "../src/webUi.ts";
import { emptyRun, foldEvent, type RunView } from "../web/src/state.ts";
import { fakeTrackerOf, finished, issue, respond, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

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
  const { store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [], failure: HALT }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 1);
  const text = conversation(probe.dir);
  assert.ok(text.includes("Codex review failed:"), "conversation.md lacks the halt's record");
  assert.equal(resumeLines(text), 1);
});

test("(d) a refused credential on a resumed turn halts with no new thread", async () => {
  const { store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: `${HALT} 401 Unauthorized` }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 1);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1]);
  assert.equal(resumeLines(conversation(probe.dir)), 0);
});

test("(e) a schema repair turn whose thread cannot be resumed: a new thread gets the round's first-round prompt, and its review is accepted", async () => {
  const { captured, store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], raw: "not json" }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  assert.ok(captured.root !== null);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 3]);
  assert.equal(probe.reviewer.prompts[2], probe.reviewer.prompts[0], "round 1's prompt is repeated");
  assert.ok(probe.reviewer.prompts[0]!.includes(captured.root!), "the first-round text is built from the run's root");
  const line = threadResumeFailedLine(subjectHeading({ plan: 1 }), 1, "scripted-thread-1", HALT);
  assert.ok(conversation(probe.dir).includes(line), "conversation.md lacks the line");
  assert.ok(probe.ui.said.includes(line), "the page was not told");
  assert.deepEqual(probe.ui.asked, []);
});

test("(f) the replaced thread's inputs are not counted: the next round continues the new thread", async () => {
  const { store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [], raw: "not json", inputTokens: 900_000 }, { issues: [], failure: HALT }, { issues: [issue("P1-R1-1")], inputTokens: 1_000 }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 2, 3]);
  const restart = threadRestartLine(subjectHeading({ plan: 1 }), 2, 900_000, 500_000);
  assert.ok(!conversation(probe.dir).includes(restart));
  assert.ok(!probe.ui.said.includes(restart));
});

test("(g) a replacement thread whose retry resumes and is refused is replaced again, each replacement said", async () => {
  const { captured, store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    config: fast,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [], fault: "stream disconnected" }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1, 2, 2, 3, 4]);
  assert.ok(probe.reviewer.prompts[4]!.startsWith(newThreadSentence(captured.root!, "issue-log.json", 2)));
  const text = conversation(probe.dir);
  assert.equal(resumeLines(text), 2);
  for (const thread of ["scripted-thread-1", "scripted-thread-2"]) {
    const line = threadResumeFailedLine(subjectHeading({ plan: 1 }), 2, thread, HALT);
    assert.ok(text.includes(line), `conversation.md lacks the line of ${thread}`);
    assert.ok(probe.ui.said.includes(line), `the page was not told of ${thread}`);
  }
  assert.deepEqual(probe.ui.asked, []);
});

/** Round 1 raises an issue; round 2's resume is refused, and each replacement's first turn loses its connection, its retry resuming and being refused (W1-R1-1). */
const repeatedRefusals = [
  { issues: [issue("P1-R1-1")] },
  { issues: [], failure: HALT },
  ...Array.from({ length: 3 }, () => [{ issues: [], fault: "stream disconnected" }, { issues: [], failure: HALT }]).flat(),
  { issues: [] },
  { issues: [] },
  { issues: [] },
];
const isTransportQuestion = (e: UiEvent): boolean => e._tag === "QuestionPresented" && e.question.origin.kind === "transport" && e.question.origin.agent === "codex";

test("(h) a fault and a refused resume on every replacement spend one transport budget and reach the exhaustion question; Stop ends the run 1", async () => {
  const { store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    config: { ...fast, maxTransportRetries: 1 },
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: repeatedRefusals,
    execs: [finished],
    answers: [{ beside: TRANSPORT_ANSWERS.stop }],
  });
  assert.equal(await runProgram(wiring, probe.project), 1);
  assert.ok(probe.ui.notified.some(isTransportQuestion), "no transport question was presented");
  assert.match(conversation(probe.dir), /Codex could not be reached/);
});

test("(i) a replacement that succeeds after a fault reports the recovery, so the page's retry state is cleared before the phase ends", async () => {
  const { store } = capturing();
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    config: fast,
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [], failure: HALT }, { issues: [], fault: "stream disconnected" }, { issues: [], failure: HALT }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runProgram(wiring, probe.project), 0);
  const events = probe.ui.notified;
  const retrying = events.findIndex((e) => e._tag === "TransportRetrying" && e.agent === "codex");
  assert.ok(retrying >= 0, "no retry");
  assert.ok(events.slice(retrying).some((e) => e._tag === "TransportRecovered" && e.agent === "codex"), "no TransportRecovered after the retry");
  const ended = events.findIndex((e, i) => i > retrying && e._tag === "PhaseEnded");
  assert.ok(ended > retrying);
  const views: RunView[] = [];
  events.slice(0, ended).reduce((run, event) => {
    const after = foldEvent(run, { time: "2026-11-09T00:00:00.000Z", event: { _tag: "Notified", event } });
    views.push(after);
    return after;
  }, emptyRun(1));
  assert.notEqual(views[retrying]!.retry, null, "the retry was not shown");
  assert.equal(views.at(-1)!.retry, null, "the retry is still shown just before the phase ends");
});

test("(j) Stop task while the exhaustion question is open ends the run 130, interrupted, cancels the question and leaves the page without it", async () => {
  const { store } = capturing();
  const events: RunEvent[] = [];
  const ui = await Effect.runPromise(makeWebUi((e) => Effect.sync(() => void events.push(e))));
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    store,
    ui,
    config: { ...fast, maxTransportRetries: 1 },
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: repeatedRefusals,
    execs: [finished],
  });
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project, "implementation"), wiring)));
  /** The Asked of the Codex transport question: the prompt published after its QuestionPresented. */
  const transportAsked = (): Asked | null => {
    const presented = events.findIndex((e) => e._tag === "Notified" && isTransportQuestion(e.event));
    if (presented < 0) return null;
    const asked = events.slice(presented).find((e): e is Asked => e._tag === "Asked");
    return asked ?? null;
  };
  const presented = async (): Promise<Asked | null> => {
    for (let k = 0; k < 200; k++) {
      const asked = transportAsked();
      if (asked !== null) return asked;
      if (fiber.pollUnsafe() !== undefined) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };
  const asked = await presented();
  if (asked === null) await Effect.runPromise(Fiber.interrupt(fiber));
  assert.ok(asked !== null, "the transport question was never presented");
  const reviewsBefore = probe.reviewer.prompts.length;
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(exitCodeOf(await Effect.runPromise(Fiber.await(fiber))), 130);
  assert.equal(probe.reviewer.prompts.length, reviewsBefore);
  assert.ok(conversation(probe.dir).includes("**Interrupted by the user.**"));
  const askedAt = events.indexOf(asked);
  const cancelledAt = events.findIndex((e, k) => k > askedAt && e._tag === "PromptCancelled" && e.prompt === asked.prompt);
  assert.ok(cancelledAt > askedAt, `no PromptCancelled of prompt ${asked.prompt} after its Asked: ${events.map((e) => e._tag).join(", ")}`);
  const view = events.reduce((run: RunView, event) => foldEvent(run, { time: "2026-11-09T00:00:00.000Z", event }), emptyRun(1));
  assert.equal(view.pending, null, "the page still shows the transport question pending");
});
