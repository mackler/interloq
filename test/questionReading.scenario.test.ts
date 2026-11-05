// Issue #166 (requirements Q2): once the question review ends with no counted issue and the list is not empty, Codex
// reads each agreed question's last sentence on its own, in a review loop of its own (question-reading/, ids H-R<n>-<i>),
// before the agreed list is recorded and the terms are written. Not after a review left by the round limit's proceed
// choice, and not for an empty list.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import { entryOf, issue, respond, runDirOf, runRefinement, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const entryWith = (question: string): S.QuestionEntry =>
  entryOf({ id: "Q1", context: "A context.", question, reason: "it is open", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "A" });
const UNREADABLE = "What do you want to make Interloq try again?";
const READABLE = "What event should cause Interloq to try again to prepare a question?";
const closings = [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }];

test("(a) the reading raises an issue against Q1's last sentence, Claude Code amends it, and the agreed list carries the amendment", async () => {
  const dir = tempRepo();
  const { layer, probe } = testLayer(dir, {
    answers: ["1"],
    steps: [{ output: { questions: [entryWith(UNREADABLE)] } }, { output: { ...respond([["H-R1-1", "accepted"]]), questions: [entryWith(READABLE)] } }],
    closings,
    reviews: [{ issues: [] }, { issues: [] }],
    readings: [{ issues: [issue("H-R1-1", "the last sentence reads as asking what to make")] }, { issues: [] }],
  });
  await runRefinement(layer, "task", "onRequest");
  const records = runDirOf(dir);
  assert.equal(probe.reviewer.readingPrompts.length, 2);
  for (const file of ["question-reading/review-1.json", "question-reading/round-1.json", "question-reading-log.json"]) assert.ok(fs.existsSync(path.join(records, file)), file);
  const log = JSON.parse(fs.readFileSync(path.join(records, "question-reading-log.json"), "utf8")) as { entries: { id: string }[] };
  assert.ok(log.entries.some((e) => e.id === "H-R1-1"));
  const conversation = fs.readFileSync(path.join(records, "conversation.md"), "utf8");
  assert.match(conversation, /Question reading/);
  const agreed = conversation.slice(conversation.indexOf("## Agreed question list"));
  assert.ok(agreed.includes(READABLE) && !agreed.includes(UNREADABLE), agreed.slice(0, 400));
  assert.ok(conversation.indexOf("Question reading") < conversation.indexOf("## Agreed question list"));
});

test("(b) a reading that raises nothing: one reading turn, the list unchanged", async () => {
  const dir = tempRepo();
  const { layer, probe } = testLayer(dir, { answers: ["1"], steps: [{ output: { questions: [entryWith(READABLE)] } }], closings, reviews: [{ issues: [] }, { issues: [] }] });
  await runRefinement(layer, "task", "onRequest");
  assert.equal(probe.reviewer.readingPrompts.length, 1);
  assert.equal(probe.reviewer.prompts.length, 2);
});

test("(c) a question review left by the proceed choice at its round limit: no reading", async () => {
  const dir = tempRepo();
  const { layer, probe } = testLayer(dir, {
    answers: ["p", "1"],
    steps: [{ output: { questions: [entryWith(READABLE)] } }, { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [entryWith(READABLE)] } }],
    closings,
    reviews: [{ issues: [issue("Q-R1-1")] }, { issues: [] }],
    config: { maxRounds: 1 },
  });
  await runRefinement(layer, "task", "onRequest");
  assert.equal(probe.reviewer.readingPrompts.length, 0);
});

test("(d) an empty agreed list: no reading", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] });
  await runRefinement(layer, "task", "checked");
  assert.equal(probe.reviewer.readingPrompts.length, 0);
});
