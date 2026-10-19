// Issue #184 (S6, S7): the first interview presents each agreed question without waiting for Claude Code. Every answer is
// sent at once and Claude Code's replies are taken up when they arrive; the summary comes after every reply arrived and
// every follow-up was answered. The scenarios run a refinement over the scripted agents of test/helpers.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import * as prompts from "../src/prompts.ts";
import { TERMS_REQUEST } from "../src/input.ts";
import { refinementRun } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { ack, followUpOf, type PlanningStep, presentedQuestions, questionEntry, type ScriptedUi, scriptedItem, summaryReply, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

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

const scenario = (questions: readonly S.QuestionEntry[], options: TestOptions, terms: "unchecked" | "onRequest" = "unchecked") => {
  const { layer, probe } = testLayer(tempRepo(), {
    ...options,
    steps: [{ output: { questions } }, ...(options.steps ?? [])],
    reviews: options.reviews ?? [{ issues: [] }, { issues: [] }],
  });
  const ui = () => probe.ui;
  const run = () => Effect.runPromiseExit(refinementRun("task", scriptedItem.id, terms).pipe(Effect.provide(layer)));
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
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", "B", ""], replies: [{ output: ack(), gate: presented(l.ui, "Q2") }], closings: [{ output: summaryReply(SUMMARY) }] });
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
  const s = scenario([q("Q1"), q("Q2"), q("Q3")], { answers: ["A", { text: "A", when: replied(l.ui, "Noted.") }, "X", "A", ""], replies, closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2", "F1", "Q3"]);
  assert.match(s.conversation(), /\*\*Claude Code:\*\* Noted\./);
});

test("3: a follow-up in the closing reply is asked after the last agreed question, then the summary", timeout, async () => {
  const s = scenario([q("Q1")], { answers: ["A", "X", ""], closings: [{ output: ack("", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }) }, { output: summaryReply(SUMMARY) }] });
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
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", { text: "A", before: () => void (answeredQ2 = true) }, "X", ""], replies, closings: [{ output: summaryReply(SUMMARY) }] });
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
  const s = scenario([q("Q1"), q("Q2")], { answers: ["A", "A", ""], replies, closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  const line = prompts.unnecessaryLine("Q1", "the task settles it");
  assert.ok(s.probe.ui.said.includes(line), s.probe.ui.said.join("\n"));
  assert.ok(s.conversation().includes(line));
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q2"]);
});

test("6: a chosen answer that meets Q2's skip condition: Q2 is never presented, and the note reaches Claude Code", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2", { question: "Q1", answer: "B" }), q("Q3")], { answers: ["B", "A", ""], closings: [{ output: summaryReply(`${SUMMARY} Skipped questions: Q2.`) }] });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "Q3"]);
  const note = prompts.skippedNote([{ id: "Q2", question: "Q1", answer: "B", cause: "answered" }], []);
  assert.ok(s.probe.ui.said.includes(note));
  assert.ok(s.conversation().includes(note));
  assert.ok(s.probe.planner.clarificationPrompts.some((p) => p.includes(answered("Q1", "B")) && p.includes(note)));
});

test("7: answers given while a request is outstanding go together in the next request, in order", timeout, async () => {
  const l = late();
  const s = scenario([q("Q1"), q("Q2"), q("Q3")], { answers: ["A", "B", "A", ""], replies: [{ output: ack(), gate: presented(l.ui, "Q3") }], closings: [{ output: summaryReply(SUMMARY) }] });
  l.bind(s.ui);
  succeeded(await s.run());
  const together = s.probe.planner.clarificationPrompts[1];
  assert.ok(together.includes(answered("Q1", "A")) && together.includes(answered("Q2", "B")), together);
  assert.ok(together.indexOf(answered("Q1", "A")) < together.indexOf(answered("Q2", "B")));
});

test("8: /done at Q1 presents no further agreed question and closes with the done instruction", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2")], { answers: ["/done", ""], closings: [{ output: summaryReply(SUMMARY) }] });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1"]);
  assert.ok(s.probe.planner.clarificationPrompts.some((p) => p.includes(prompts.interviewDonePrompt)));
});

test("9: after /done, a follow-up is asked and Q2 never is, also after a summary not confirmed", timeout, async () => {
  const closings: PlanningStep[] = [{ output: ack("", { follow_ups: [followUpOf("F1", "Which kind?", ["X", "Y"])] }) }, { output: summaryReply(SUMMARY) }, { output: summaryReply(`${SUMMARY}\n\nRevised.`) }];
  const s = scenario([q("Q1"), q("Q2")], { answers: ["/done", "X", "not quite", ""], closings });
  succeeded(await s.run());
  assert.deepEqual(presentedIds(s.probe.ui), ["Q1", "F1"]);
  const sent = s.probe.planner.clarificationPrompts.filter((p) => p.includes(prompts.LIST_DONE_SENTENCE));
  assert.ok(sent[1].includes(prompts.interviewDonePrompt), sent[1]);
  assert.ok(sent[2].includes("not quite") && sent[2].includes("ended the interview"), sent[2]);
});

test("10: the count reaches the agreed questions not skipped", timeout, async () => {
  const s = scenario([q("Q1"), q("Q2", { question: "Q1", answer: "B" }), q("Q3")], { answers: ["B", "A", ""], closings: [{ output: summaryReply(`${SUMMARY} Skipped questions: Q2.`) }] });
  succeeded(await s.run());
  const counts = s.probe.ui.notified.flatMap((e) => (e._tag === "InterviewCounted" ? [`${e.answered}/${e.total}`] : []));
  assert.deepEqual(counts, ["1/2", "2/2"]);
});

test("11: after the summary is confirmed, requirements.md is written and the requirements review runs; the run ends", timeout, async () => {
  const s = scenario([q("Q1")], { answers: ["A", ""], closings: [{ output: summaryReply(SUMMARY) }] });
  succeeded(await s.run());
  assert.equal(fs.readFileSync(path.join(s.probe.dir, "requirements.md"), "utf8"), `${SUMMARY}\n`);
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
      answers: [TERMS_REQUEST, "A", ""],
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
