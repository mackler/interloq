// Issue #133, decision Q1 (S4): the history an agent writes reaches the question the user is shown (QuestionPresented)
// and conversation.md, under a heading of its own after the context; a question whose context call falls back has none.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { asksNothing, turnDraft } from "../src/conversation.ts";
import { withContext } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import { writeContext } from "../src/questionContext.ts";
import { renderQuestionRecord } from "../src/render.ts";
import { normalizeTurn } from "../src/schemaNormalize.ts";
import type * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import { currentOf, entryOf, finished, para, plain, presentedQuestions, questionOf, runRefinement, runTask, scriptedContextReply, tempRepo, testLayer } from "./helpers.ts";
import { permissionDraft } from "../src/offer.ts";

const HISTORY = "You decided on 9 Oct 2026 to keep the service on one machine.";
const noQuestions = { questions_for_user: [] };
const agreed: S.QuestionEntry = { ...entryOf({ id: "Q1", context: "The service, a web server, keeps its data in a database.", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }], default_answer: "SQLite" }), history: para(HISTORY) };
const divided: S.TermsEntry = { id: "Q1", explanations: [], context: agreed.context, history: agreed.history, question: agreed.question, reason: agreed.reason, proposed_answers: agreed.proposed_answers };
const askQ1 = { message_to_user: "", current_question: currentOf({ id: "Q1", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1"], answered_ids: [], complete: false, summary: "" };
const done = { message_to_user: "Done.", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1"], answered_ids: ["Q1"], complete: true, summary: "# Requirements\n\nSQLite." };
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");

test("an agreed question presents the history of its terms.json entry, and conversation.md records it under History after the context", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [agreed] } }, { output: askQ1 }, { output: done }],
    terms: [{ output: { entries: [divided] } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "clarification");
  assert.deepEqual(q.history, para(HISTORY));
  const record = conversation(probe.dir);
  const heading = `**${prompts.QUESTION_HISTORY_HEADING}**`;
  assert.equal(prompts.QUESTION_HISTORY_HEADING, "History");
  const at = record.indexOf(heading);
  assert.ok(at > record.indexOf("> The service, a web server"), record);
  assert.ok(record.slice(at).startsWith(`${heading}\n\n> ${HISTORY}`), record.slice(at, at + 200));
});

test("renderQuestionRecord writes the history as a block quote under History after the context, and nothing when it is empty", () => {
  const draft = turnDraft(normalizeTurn({ ...askQ1, current_question: { id: "F1", context: para("The service listens on a port."), history: para(HISTORY), text: plain("Which port do you want?"), explanations: [], options: [] } }), { questions: [], terms: [] });
  const presented = { number: 1, origin: draft.origin, context: draft.context, history: draft.history, explanations: [], question: draft.question, options: [], attached: null, decision: null };
  const record = renderQuestionRecord(presented);
  assert.ok(record.includes(`> The service listens on a port.\n\n**History**\n\n> ${HISTORY}\n\n`), record);
  assert.ok(!renderQuestionRecord({ ...presented, history: [] }).includes("**History**"));
});

test("a follow-up question carries its current_question's history, and a turn whose only text is a history asks something", () => {
  const current = { id: "", context: [], history: para(HISTORY), text: [], explanations: [], options: [] };
  assert.equal(asksNothing(current), false);
  const draft = turnDraft(normalizeTurn({ ...askQ1, current_question: { ...current, id: "F1", context: para("c"), text: plain("Which?") } }), { questions: [], terms: [] });
  assert.equal(draft.origin.kind, "followUp");
  assert.deepEqual(draft.history, para(HISTORY));
});

test("a question the program composes gets the context call's history; the fallback has none and is the program's", async () => {
  const draft = permissionDraft("Bash", { command: "npm install zod" });
  const request = { origin: draft.origin, decision: null, question: draft.question, options: draft.options.map((o) => o.shown), details: [], explanations: draft.explanations, facts: "f" };
  const reply = (prompt: string) => ({ ...scriptedContextReply(prompt), history: para(HISTORY) });
  const write = (contexts: S.QuestionContext[] | "fail") => {
    const { layer } = testLayer(tempRepo(), { contexts: contexts === "fail" ? [{ output: { context: 1 } }, { output: { context: 1 } }] : contexts.map((c) => ({ output: c })) });
    return Effect.runPromise(Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      return yield* writeContext("the task", request);
    }).pipe(Effect.provide(layer)));
  };
  const written = await write([reply(`${prompts.CONTEXT_REQUEST_HEADING}${JSON.stringify({ question: request.question, options: request.options, details: [], explanations: request.explanations })}`)]);
  assert.deepEqual(written.history, para(HISTORY));
  assert.deepEqual(withContext(draft, written).history, para(HISTORY));
  const fallback = await write("fail");
  assert.equal(fallback.context.by, "program");
  assert.deepEqual(fallback.history, []);
  assert.deepEqual(withContext(draft, fallback).history, []);
});

test("a plan writer's question carries its history to the page", async () => {
  const asked = { ...questionOf({ context: "Claude Code, the planning agent, writes the plan.", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] }), history: para(HISTORY) };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions_for_user: [asked] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "planner");
  assert.deepEqual(q.history, para(HISTORY));
  assert.ok(conversation(probe.dir).includes(`**History**\n\n> ${HISTORY}`));
});
