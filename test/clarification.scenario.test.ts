// Issue #184 (S6, S7): the first interview presents each agreed question without waiting for Claude Code. Every answer is
// sent at once and Claude Code's replies are taken up when they arrive; the summary comes after every reply arrived and
// every follow-up was answered. The scenarios run a refinement over the scripted agents of test/helpers.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Exit } from "effect";
import * as prompts from "../src/prompts.ts";
import { TERMS_REQUEST } from "../src/input.ts";
import { USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { ack, steppingClock, followUpOf, type PlanningStep, presentedQuestions, questionEntry, type ScriptedUi, scriptedItem, summaryReply, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const q = (id: string, skip: S.SkipCondition | null = null): S.QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { default_answer: "A", skip_if: skip });
const SUMMARY = "# Requirements\n\nQ1, Q2, Q3: A.";

/** The ids of the questions the interview presented, in order (agreed questions and follow-ups). */
const presentedIds = (ui: ScriptedUi): string[] =>
  presentedQuestions(ui).flatMap((p) => (p.origin.kind === "clarification" || p.origin.kind === "followUp" ? [p.origin.id] : []));
/** Resolves once the interview has presented question `id`. */
const presented = (ui: () => ScriptedUi, id: string) => async (): Promise<void> => {
  while (!presentedIds(ui()).includes(id)) await new Promise((r) => setTimeout(r, 5));
};

/** Resolves once Claude Code's reply with this message has been applied. */
const replied = (ui: () => ScriptedUi, message: string) => async (): Promise<void> => {
  while (!ui().notified.some((e) => e._tag === "InterviewCounted") || !ui().notified.some((e) => e._tag === "InterviewTurn" && e.message === message)) await new Promise((r) => setTimeout(r, 5));
};

const scenario = (questions: readonly S.QuestionEntry[], options: TestOptions, terms: "unchecked" | "onRequest" = "unchecked", clock: Clock.Clock | null = null) => {
  const { layer, probe } = testLayer(tempRepo(), {
    ...options,
    steps: [{ output: { questions } }, ...(options.steps ?? [])],
    reviews: options.reviews ?? [{ issues: [] }, { issues: [] }],
  });
  const ui = () => probe.ui;
  const run = () => Effect.runPromiseExit(refinementRun("task", scriptedItem.id, terms).pipe(Effect.provide(layer), (e) => (clock === null ? e : Effect.provideService(e, Clock.Clock, clock))));
  const conversation = () => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  return { probe, ui, run, conversation };
};
const succeeded = (exit: Exit.Exit<unknown, unknown>) => assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "");
/** The index of the first clarification prompt that contains `text`. */
const promptIndex = (prompts: readonly string[], text: string) => prompts.findIndex((p) => p.includes(text));

const answered = (id: string, option: string) => `The user answers agreed question ${id} with the option ${JSON.stringify(option)}.`;
const OPENING = "Take part in an interview with the user.";
/** A test's late-bound Ui, so that a gate scripted before the layer exists can read it. */
const late = () => {
  let get: () => ScriptedUi = () => assert.fail("the Ui is not bound yet");
  return { ui: () => get(), bind: (u: () => ScriptedUi) => void (get = u) };
};
const timeout = { timeout: 20_000 };

test("1: the next agreed question is presented before Claude Code replies to the answer before it", timeout, async () => {
  const l = late();
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", "B"], replies: [{ output: ack(), gate: presented(l.ui, "Q2") }], closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2"]);
  const sent = s.probe.planner.clarificationPrompts;
  assert.ok(sent[0].startsWith(OPENING), sent[0]);
  assert.ok(promptIndex(sent, answered("Q1", "A")) > 0, "Q1's answer was not sent after the opening");
});

test("2: a follow-up that arrives while Q2 is shown is asked after Q2 and before Q3", timeout, async () => {
  const l = late();
  const replies: PlanningStep[] = [{ output: ack() }, { output: ack("Noted.", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }), gate: presented(l.ui, "Q2") }];
  // Q2 is answered only after the reply with the follow-up arrived while Q2 was on the page.
  const s = scenario([q("Q1"), q("Q2"), q("Q3")], { answers: ["A", { text: "A", when: replied(l.ui, "Noted.") }, "X", "A"], replies, closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2", "F1", "Q3"]);
  assert.match(s.conversation(), /\*\*Claude Code:\*\* Noted\./);
});

test("3: a follow-up in the closing reply is asked after the last agreed question, then the summary", timeout, async () => {
  const s = scenario([q("Q1")], { answers: ["A", "X"], closings: [{ output: ack("", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }) }, { output: summaryReply(SUMMARY) }] });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "F1"]);
  const sent = s.probe.planner.clarificationPrompts;
  const closings = sent.filter((p) => p.includes(prompts.LIST_DONE_SENTENCE));
  assert.equal(closings.length, 2);
  assert.match(fs.readFileSync(path.join(s.probe.dir, "requirements.md"), "utf8"), /Q1, Q2, Q3: A/);
});

test("4: the summary waits for a reply still outstanding, and for the follow-up it asks", timeout, async () => {
  const l = late();
  let answeredQ2 = false;
  const replies: PlanningStep[] = [{ output: ack() }, { output: ack("", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }), gate: async () => { while (!answeredQ2) await new Promise((r) => setTimeout(r, 5)); } }];
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", { text: "A", before: () => void (answeredQ2 = true) }, "X"], replies, closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2", "F1"]);
  const sent = s.probe.planner.clarificationPrompts;
  const followUpAnswer = promptIndex(sent, "The user answers follow-up question F1");
  assert.ok(followUpAnswer >= 0, sent.join("\n---\n"));
  assert.ok(promptIndex(sent, prompts.LIST_DONE_SENTENCE) > followUpAnswer, "a closing request was sent before the follow-up was answered");
});

test("5: a reply naming a question unnecessary is said and recorded, and the next question is still presented", timeout, async () => {
  const l = late();
  const replies: PlanningStep[] = [{ output: ack() }, { output: ack("", { unnecessary: [{ id: "Q1", reason: "the task settles it" }] }), gate: presented(l.ui, "Q2") }];
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", "A"], replies, closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  const line = prompts.unnecessaryLine("Q1", "the task settles it");
  assert.ok(s.probe.ui.said.includes(line), s.probe.ui.said.join("\n"));
  assert.ok(s.conversation().includes(line));
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2"]);
});

test("6: a chosen answer that meets Q2's skip condition: Q2 is never presented, and the note reaches Claude Code", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2", { question: "Q1", answer: "B" }), q("Q3")], { answers: ["B", "A"], closings: [{ output: summaryReply(`${SUMMARY} Skipped questions: Q2.`) }] });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q3"]);
  const note = prompts.skippedNote([{ id: "Q2", question: "Q1", answer: "B", cause: "answered" }]);
  assert.ok(s.probe.ui.said.includes(note));
  assert.ok(s.conversation().includes(note));
  assert.ok(s.probe.planner.clarificationPrompts.some((p) => p.includes(answered("Q1", "B")) && p.includes(note)));
});

test("7: answers given while a request is outstanding go together in the next request, in order", timeout, async () => {
  const l = late();
  const s = scenario([q("Q1"), q("Q2"), q("Q3")], { answers: ["A", "B", "A"], replies: [{ output: ack(), gate: presented(l.ui, "Q3") }], closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  const together = s.probe.planner.clarificationPrompts[1];
  assert.ok(together.includes(answered("Q1", "A")) && together.includes(answered("Q2", "B")), together);
  assert.ok(together.indexOf(answered("Q1", "A")) < together.indexOf(answered("Q2", "B")));
});

test("8: /done at Q1 presents no further agreed question and closes with the done instruction", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2")], { answers: ["/done"], closings: [{ output: summaryReply(SUMMARY) }] });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1"]);
  assert.ok(s.probe.planner.clarificationPrompts.some((p) => p.includes(prompts.interviewDonePrompt)));
});

test("9: after /done, a follow-up is asked and Q2 never is", timeout, async () => {
  const closings: PlanningStep[] = [{ output: ack("", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }) }, { output: summaryReply(SUMMARY) }];
  const s = scenario([q("Q1"), q("Q2")], { answers: ["/done", "X"], closings });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "F1"]);
  const sent = s.probe.planner.clarificationPrompts.filter((p) => p.includes(prompts.LIST_DONE_SENTENCE));
  assert.ok(sent[1].includes(prompts.interviewDonePrompt), sent[1]);
});

test("10: the count reaches the agreed questions not skipped", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2", { question: "Q1", answer: "B" }), q("Q3")], { answers: ["B", "A"], closings: [{ output: summaryReply(`${SUMMARY} Skipped questions: Q2.`) }] });
  succeeded(await s.run());
  const counts = s.probe.ui.notified.flatMap((e) => (e._tag === "InterviewCounted" ? [`${e.answered}/${e.total}`] : []));
  assert.deepEqual(counts, ["1/2", "2/2"]);
});

test("11: an interview that ends writes requirements.md with no prompt in between, and the requirements review runs", timeout, async () => {
  const s = scenario([q("Q1")], { answers: ["A"], closings: [{ output: summaryReply(SUMMARY) }] });
  succeeded(await s.run());
  assert.equal(fs.readFileSync(path.join(s.probe.dir, "requirements.md"), "utf8"), `${SUMMARY}\n`);
  assert.equal(s.probe.ui.asked.length, 1, s.probe.ui.asked.join("\n---\n"));
  const notified = s.probe.ui.notified;
  const summaryTurn = notified.findIndex((e) => e._tag === "InterviewTurn" && e.summary !== null);
  assert.ok(summaryTurn >= 0, "no turn carried the summary");
  assert.ok(!notified.slice(summaryTurn).some((e) => e._tag === "QuestionPresented"), "a question was presented after the summary");
  assert.equal(s.probe.reviewer.prompts.length, 2, "the requirements review did not run");
});

test("12: a halt of Claude Code's request ends the run while a question is pending", timeout, async () => {
  const l = late();
  const replies: PlanningStep[] = [{ output: ack() }, { sessionTooLong: "Prompt is too long", gate: presented(l.ui, "Q2") }];
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", { wait: true }], replies });
  l.bind(s.ui);
  const exit = await s.run();
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /ClaudeSessionTooLong/);
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2"]);
});

test("13: a terms request beside the interview's request: each call's start and end carry its own id, each ended once", timeout, async () => {
  let termsStarted = false;
  const { id, context, history, question, reason, proposed_answers } = q("Q1");
  const s = scenario(
    [q("Q1")],
    {
      answers: [TERMS_REQUEST, "A"],
      replies: [{ output: ack(), gate: async () => { while (!termsStarted) await new Promise((r) => setTimeout(r, 5)); } }],
      terms: [{ output: { entries: [{ id, context, history, question, reason, proposed_answers, explanations: [] }] }, onCall: () => void (termsStarted = true) }],
      closings: [{ output: summaryReply(SUMMARY) }],
    },
    "onRequest",
  );
  succeeded(await s.run());
  const events = s.probe.ui.notified.flatMap((e) => (e._tag === "AgentCallStarted" ? [`start ${e.purpose} ${e.callId}`] : e._tag === "AgentCallEnded" ? [`end ${e.callId}`] : []));
  const starts = events.filter((e) => e.startsWith("start")).map((e) => e.split(" ")[2]);
  assert.equal(new Set(starts).size, starts.length, events.join("\n"));
  for (const id of starts) assert.equal(events.filter((e) => e === `end ${id}`).length, 1, `${id} did not end exactly once`);
  assert.ok(events.some((e) => e.startsWith("start interview")) && events.some((e) => e.startsWith("start planning")), events.join("\n"));
});

// S7 (decision G-R1-1): a request whose first attempts fail goes on being tried every five minutes while agreed questions
// remain, with nothing asked; once none remains, the exhaustion question of today is asked.
const BACKGROUND_MS = USAGE_LIMIT_RETRY_SECONDS * 1000;
const FAULT: PlanningStep = { fault: "stream disconnected before completion" };
const fewRetries = { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 };
const until = (cond: () => boolean) => async (): Promise<void> => {
  while (!cond()) await new Promise((r) => setTimeout(r, 5));
};
const isTransportQuestion = (asked: string) => asked.includes(prompts.transportPrompt);

test("S7-1: the opening request is tried in the background while the questions are answered, and the queued answers follow", timeout, async () => {
  const l = late();
  let backgroundSleeps = 0;
  const { clock, sleeps } = steppingClock(Date.UTC(2026, 9, 19, 12), (ms) => (ms === BACKGROUND_MS && ++backgroundSleeps === 2 ? Effect.promise(presented(l.ui, "Q2")) : Effect.void));
  let planner: () => string[] = () => [];
  const replies: PlanningStep[] = [FAULT, FAULT, FAULT, { output: ack(), gate: presented(l.ui, "Q3") }];
  const s = scenario([q("Q1"), q("Q2"), q("Q3")], { answers: ["A", "B", { text: "A", when: until(() => planner().length >= 4) }], replies, closings: [{ output: summaryReply(SUMMARY) }], config: fewRetries }, "unchecked", clock);
  l.bind(s.ui);
  planner = () => s.probe.planner.clarificationPrompts;
  succeeded(await s.run());
  assert.deepEqual(sleeps.filter((ms) => ms === BACKGROUND_MS), [BACKGROUND_MS, BACKGROUND_MS]);
  for (const n of [1, 2]) {
    const line = prompts.backgroundRetryLine("claude", prompts.transportWhat("interview"), n, USAGE_LIMIT_RETRY_SECONDS);
    assert.ok(s.probe.ui.said.includes(line), `try ${n} not said`);
    assert.ok(s.conversation().includes(line), `try ${n} not recorded`);
  }
  assert.ok(!s.probe.ui.asked.some(isTransportQuestion), "a transport question was asked");
  const queued = s.probe.planner.clarificationPrompts[4];
  assert.ok(queued.includes(answered("Q1", "A")) && queued.indexOf(answered("Q1", "A")) < queued.indexOf(answered("Q2", "B")), queued);
});

/** Background sleeps that never end by themselves: only the developer's reaching the end of the list wakes them. */
/** The developer's last answer, held until the first background try was said, so that it comes while the request is in the background. */
const afterFirstTry = (ui: () => ScriptedUi, text: string) => ({ text, when: until(() => ui().said.includes(prompts.backgroundRetryLine("claude", prompts.transportWhat("interview"), 1, USAGE_LIMIT_RETRY_SECONDS))) });
const heldClock = () => steppingClock(Date.UTC(2026, 9, 19, 12), (ms) => (ms === BACKGROUND_MS ? Effect.never : Effect.void)).clock;

test("S7-2: once the list is used up with the connection still down, the question is asked; Stop ends the run with AgentUnreachable", timeout, async () => {
  const l = late();
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", afterFirstTry(l.ui, "B"), prompts.TRANSPORT_ANSWERS.stop], replies: [FAULT, FAULT, FAULT], config: fewRetries }, "unchecked", heldClock());
  l.bind(s.ui);
  const exit = await s.run();
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /AgentUnreachable/);
  assert.equal(s.probe.ui.asked.filter(isTransportQuestion).length, 1);
  assert.match(s.conversation(), /\*\*User:\*\* A[\s\S]*\*\*User:\*\* B/);
  assert.ok(!fs.existsSync(path.join(s.probe.dir, "requirements.md")));
});

test("S7-3: Retry again at that question runs a full set of attempts, and on success the interview goes on to the summary", timeout, async () => {
  const l = late();
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", afterFirstTry(l.ui, "B"), prompts.TRANSPORT_ANSWERS.retry], replies: [FAULT, FAULT, FAULT, FAULT, { output: ack() }], closings: [{ output: summaryReply(SUMMARY) }], config: fewRetries }, "unchecked", heldClock());
  l.bind(s.ui);
  const exit = await s.run();
  succeeded(exit);
  assert.equal(s.probe.ui.asked.filter(isTransportQuestion).length, 1);
  assert.ok(s.probe.ui.notified.some((e) => e._tag === "TransportRetrying" && e.attempt === 1));
  assert.ok(fs.existsSync(path.join(s.probe.dir, "requirements.md")));
});
