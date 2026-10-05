// S6 and S7 (issue #46): every question the user is asked is presented the same way, numbered in one sequence for the
// run, whatever produced it; conversation.md records each under its number with the record's id beside it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { questionLines } from "../src/render.ts";
import type { PresentedQuestion } from "../src/question.ts";
import { contextText, detailsText, entryOf, finished, issue, para, plain, presentedQuestions, questionText, respond, runTask, scriptedContextReply, tempRepo, term, testLayer, questionOf, currentOf, readBack, readBlocks } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";
import type { Piece, TermsEntry } from "../src/schema.ts";

const noQuestions = { questions_for_user: [] };
const entry = (id: string) => entryOf({ id, context: "c", question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "A" });
const asking = (id: string, answered: string[]) => ({
  message_to_user: `Next: ${id}.`,
  current_question: currentOf({ id, context: `The context of ${id}.`, text: `question ${id}?`, terms: [], options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }),
  asked_ids: [...answered, id],
  answered_ids: answered,
  complete: false,
  summary: "",
});
const done = { message_to_user: "Done.", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1", "Q2"], answered_ids: ["Q1", "Q2"], complete: true, summary: "# Requirements\n\nA and B." };
const plannerQuestion = questionOf({ context: "Claude Code, the planning agent, writes the plan.", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] });

/** A run with two clarification questions, the summary's confirmation, a question of the plan writer and a pause. */
const scenario = () =>
  testLayer(tempRepo(), {
    // Q1, Q2, the confirmation, the plan writer's question, the pause on issue A raised again.
    answers: ["1", "2", "", "1", ""],
    steps: [
      { output: { questions: [entry("Q1"), entry("Q2")] } },
      { output: asking("Q1", []) },
      { output: asking("Q2", ["Q1"]) },
      { output: done },
      { output: { questions_for_user: [plannerQuestion] }, plan: "v1" },
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "rejected"]]) },
      { output: respond([["P1-R1-1", "rejected"]]) },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true, maxIdleRounds: 5 },
  });

test("S6: the questions are numbered in one sequence for the run, whatever produced them; the records keep their ids", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  const questions = presentedQuestions(probe.ui);
  assert.deepEqual(
    questions.map((q) => [q.number, q.origin.kind]),
    [
      [1, "clarification"],
      [2, "clarification"],
      [3, "confirmSummary"],
      [4, "planner"],
      [5, "pause"],
    ],
  );
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  for (const heading of ["### Question 1 (Q1)", "### Question 2 (Q2)", "### Question 3\n", "### Question 4\n", "### Question 5 (P1-R1-1)"]) assert.ok(conversation.includes(heading), heading);
  // The ids in the records and in the prompts to the agents are the records' own.
  assert.ok(!fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8").includes("Question 4"));
  assert.ok(probe.planner.prompts.every((p) => !/Question [0-9]/.test(p)));
});

test("S7: every ask is preceded by the presentation of its question, and every kind presents itself alike (issue #46)", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  // Between two asks there is a presentation: none is asked without its question in view.
  const order = probe.ui.order;
  order.forEach((step, i) => {
    if (step !== "ask") return;
    const since = order.slice(0, i).lastIndexOf("ask");
    assert.ok(order.slice(since + 1, i).some((s) => s.startsWith("presented")), `ask ${i} came without a presented question: ${order.join(", ")}`);
  });
  const questions = presentedQuestions(probe.ui);
  // S19: the plan writer's question reaches the user once, as its presented question; nothing else announces it.
  assert.equal(questions.filter((q) => q.origin.kind === "planner").length, 1);
  assert.ok(!probe.ui.said.some((line) => line.includes(piecesText(plannerQuestion.question))), "the terminal announced the question in its own way");
  const shape = (q: PresentedQuestion) => Object.keys(q).sort();
  for (const q of questions) {
    assert.deepEqual(shape(q), shape(questions[0]));
    const lines = questionLines(q).filter((l) => l !== "");
    assert.equal(lines[0], prompts.questionTitle(q.number));
    assert.ok(lines.includes(questionText(q).split("\n")[0]));
    assert.ok(contextText(q).trim() !== "", `question ${q.number} has no context`);
  }
});

test("S11: a pause reaches the user as prose: no line said and no question shown carries JSON (issue #19)", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  const pause = presentedQuestions(probe.ui).find((q) => q.origin.kind === "pause");
  assert.ok(pause !== undefined);
  assert.match(detailsText(pause), new RegExp(`^${prompts.pauseLead({ pause: "reraised", id: "P1-R1-1" })}`));
  assert.match(detailsText(pause), /Codex says: p\n\ne/);
  const shown = [...probe.ui.said, ...presentedQuestions(probe.ui).flatMap((q) => [contextText(q), detailsText(q), questionText(q), ...q.options.map((o) => piecesText(o.description))])];
  for (const text of shown) for (const forbidden of ["{\n", '"duplicate_of"', "duplicate_of:", "superseded", "\\n"]) assert.ok(!text.includes(forbidden), `${forbidden} in: ${text}`);
});

// S12 (decision Q1): every question the program composes is explained by a context call, which the user reads as an
// agent's paragraph; the program's fixed question and options stand as the program wrote them.
test("S12: a pause, the cycle limit and the unchanged pause are presented with the context call's paragraph and terms", async () => {
  const context = [{ kind: "paragraph" as const, pieces: [term("Codex", "c"), ...plain(", the reviewing agent, checks the plan that Claude Code, the planning agent, writes; this happens now, before the plan is carried out, so that the plan is right.")] }];
  const explanations = [{ id: "c", term: "Codex", explanation: "An AI agent that reviews the work." }];
  const pause = scenario();
  pause.probe.planner.contexts = [{ output: (prompt: string) => ({ ...scriptedContextReply(prompt), context, explanations }) }];
  await runTask(pause.layer);
  const paused = presentedQuestions(pause.probe.ui).find((q) => q.origin.kind === "pause");
  assert.deepEqual([paused?.context, paused?.explanations], [{ blocks: context, by: "agent" }, explanations]);
  assert.equal(paused && questionText(paused), prompts.pauseQuestion({ pause: "reraised", id: "P1-R1-1" }));
  // The context call was given the pause's facts, which the user also reads (S11).
  assert.ok(pause.probe.planner.contextPrompts[0].includes(JSON.stringify(paused?.details ?? "?")));

  const limit = testLayer(tempRepo(), {
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  await runTask(limit.layer);
  const [atLimit] = presentedQuestions(limit.probe.ui);
  assert.equal(atLimit.origin.kind, "limit");
  assert.equal(atLimit.context.by, "agent");
  assert.match(limit.probe.planner.contextPrompts[0], new RegExp(prompts.limitFacts("Planning phase 1", 1, [1]).replace(/[.()]/g, "\\$&")));

  const unchanged = testLayer(tempRepo(), {
    answers: [prompts.UNCHANGED_ANSWERS.proceed],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]) }, { output: respond([["P1-R1-1", "accepted"]]) }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(unchanged.layer);
  const [kept] = presentedQuestions(unchanged.probe.ui);
  assert.equal(kept.origin.kind, "unchanged");
  assert.equal(kept.context.by, "agent");
  assert.match(unchanged.probe.planner.contextPrompts[0], /did not change, also after Claude Code was told so/);
});

test("S12: the questions that do not need one make no context call: the clarification, the plan writer's, the summary's", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  // The one context call of the scenario is the pause's.
  assert.equal(probe.planner.contextPrompts.length, 1);
  const byKind = new Map(presentedQuestions(probe.ui).map((q) => [q.origin.kind, q.context]));
  // S18: an agreed question's context is the reviewed one of questions.json, not what the turn writes beside its id.
  assert.deepEqual(byKind.get("clarification"), { blocks: entry("Q2").context, by: "agent" });
  assert.deepEqual(byKind.get("planner"), { blocks: plannerQuestion.context, by: "agent" });
  assert.equal(byKind.get("confirmSummary")?.by, "program");
});

// S18: an agreed question is presented from the reviewed records alone: questions.json and terms.json.
test("S18: an agreed question is presented as reviewed: its context, text, proposed answers and reason, and the terms of terms.json", async () => {
  const zod = { id: "z", term: "zod", explanation: "A library that checks the shape of data." };
  const entryZod = { ...entry("Q1"), context: para("Claude Code checks the input of a tool with zod, a library, when the tool is called."), question: plain("Should zod be declared?"), reason: para("package.json does not list zod") };
  const divide = (ps: readonly Piece[]): readonly Piece[] => ps.flatMap((p) => p.text.split(/(zod)/).filter((t) => t !== "").map((t) => (t === "zod" ? term(t, "z") : { text: t, ref: "", code: false })));
  const divided: TermsEntry = { id: "Q1", explanations: [zod], context: entryZod.context.map((b) => (b.kind === "paragraph" ? { ...b, pieces: divide(b.pieces) } : b)), question: divide(entryZod.question), reason: entryZod.reason, proposed_answers: entryZod.proposed_answers };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [
      { output: { questions: [entryZod] } },
      // The turn names the agreed question and writes its own wording beside the id, which is not shown.
      { output: { ...asking("Q1", []), current_question: currentOf({ id: "Q1", context: "Other context.", text: "Other wording?", terms: [], options: [{ label: "X", description: "x" }] }) } },
      { output: { ...done, asked_ids: ["Q1"], answered_ids: ["Q1"] } },
      { output: noQuestions, plan: "v1" },
    ],
    terms: [{ output: { entries: [divided] } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui);
  assert.deepEqual(q.origin, { kind: "clarification", id: "Q1" });
  assert.deepEqual(q.context, { blocks: divided.context, by: "agent" });
  assert.deepEqual(q.question, divided.question);
  assert.deepEqual(q.options.map((o) => [piecesText(o.label), piecesText(o.description), "token" in o.answer ? o.answer.token : ""]), [
    ["A", prompts.defaultMarked("a"), "1"],
    ["B", "b", "2"],
  ]);
  assert.deepEqual(q.explanations, [zod]);
  assert.match(detailsText(q), /package\.json does not list zod/);
  // Every explanation shown with an agreed question is non-empty and referred to by a piece of what is shown.
  const refs = [...(q.context.blocks[0].kind === "paragraph" ? q.context.blocks[0].pieces : []), ...q.question].map((p) => p.ref);
  for (const t of q.explanations) {
    assert.ok(t.explanation.trim() !== "");
    assert.ok(refs.includes(t.id), t.term);
  }
});

// S18 (P1-R2-1 of the plan's review): an accepted requirements issue asked in the second interview is not in
// questions.json, so it is presented from the turn, validated, and keeps its issue id in the progress.
test("S18: an accepted requirements issue in the second interview is validated, presented from the turn, and keeps its id", async () => {
  const gap = (context: string) => ({ ...asking("G-R1-1", []), current_question: currentOf({ id: "G-R1-1", context, text: "Which port should the service listen on?", terms: [], options: [{ label: "8080", description: "the usual" }, { label: "80", description: "needs root" }] }), asked_ids: ["G-R1-1"] });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "", "1", ""],
    steps: [
      { output: { questions: [entry("Q1")] } },
      { output: asking("Q1", []) },
      { output: { ...done, asked_ids: ["Q1"], answered_ids: ["Q1"], summary: "# Requirements\n\nQ1: A" } },
      { output: respond([["G-R1-1", "accepted"]]) },
      { output: gap(" ") },
      { output: gap("The service, a web server, listens on a port for requests while it runs.") },
      { output: { ...done, asked_ids: ["G-R1-1"], answered_ids: ["G-R1-1"], summary: "# Requirements\n\nQ1: A; port 8080" } },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "The port is not decided.")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts.includes(prompts.questionRepairPrompt([{ where: "G-R1-1", problems: [{ kind: "blankContext", subject: "" }] }])));
  const gapQuestion = presentedQuestions(probe.ui).find((q) => q.origin.kind === "followUp");
  assert.deepEqual(gapQuestion?.origin, { kind: "followUp", id: "G-R1-1" });
  assert.equal(gapQuestion && contextText(gapQuestion), "The service, a web server, listens on a port for requests while it runs.");
  assert.deepEqual(gapQuestion?.options.map((o) => piecesText(o.label)), ["8080", "80"]);
  const turns = probe.ui.notified.flatMap((e) => (e._tag === "InterviewTurn" && e.heading === prompts.clarificationHeading("followUp") ? [e] : []));
  assert.deepEqual(turns.at(-1) && [turns.at(-1)?.answered, turns.at(-1)?.total], [1, 1]);
});

// S5 of the task of issue #36: a question of the plan writer reaches the user with its pieces and its explanations.
test("S5: a plan writer's question with a piece that refers to an explanation reaches QuestionPresented intact", async () => {
  const asked = {
    context: [{ kind: "paragraph" as const, pieces: [...plain("The service keeps its "), term("Orders", "o"), ...plain(" in a database.")] }],
    question: [...plain("Where should the "), term("orders", "o"), ...plain(" be kept?")],
    explanations: [{ id: "o", term: "order", explanation: "What a customer buys." }],
    options: [{ label: plain("SQLite"), description: [...plain("one file per "), term("order", "o")] }, { label: plain("PostgreSQL"), description: plain("a server") }],
  };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions_for_user: [asked] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "planner");
  assert.deepEqual(q.context.blocks, asked.context);
  assert.deepEqual(q.question, asked.question);
  assert.deepEqual(q.explanations, asked.explanations);
  assert.deepEqual(q.options.map((o) => [o.label, o.description]), asked.options.map((o) => [o.label, o.description]));
  // The terminal's block names the explanation by its term, not by the words of a piece.
  assert.ok(questionLines(q).some((l) => l.trim() === "order: What a customer buys."));
});

// S37 (the developer's decision of 4 Oct 2026): a plain piece carries no code. A plan writer's question whose plain piece
// holds an unclosed backtick, and another that ends in a backslash right before a code piece, is written to the terminal
// and to conversation.md so that only its code pieces read back as code.
test("S37: a plain piece's backtick and trailing backslash reach the terminal and conversation.md as characters", async () => {
  const code = (text: string): Piece => ({ text, ref: "", code: true });
  const asked = {
    context: [{ kind: "paragraph" as const, pieces: plain("Claude Code, the planning agent, needs a command.") }],
    question: [...plain("Should the step run `"), code("ls"), ...plain(" or C:\\"), code("dir"), ...plain(" first?")],
    explanations: [],
    options: [{ label: plain("The first"), description: plain("list the files") }, { label: plain("The second"), description: plain("list the directory") }],
  };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions_for_user: [asked] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "planner");
  const expected = "Should the step run \\``ls` or C:\\\\`dir` first?";
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const shown = [conversation.split("\n").find((l) => l.includes("Should the step run")) ?? "", questionLines(q).find((l) => l.includes("Should the step run")) ?? ""];
  for (const line of shown) {
    assert.ok(line.includes(expected), line);
    assert.deepEqual(readBack(line).code, ["ls", "dir"], line);
    assert.ok(readBack(line).rest.includes("Should the step run ` or C:\\ first?"), line);
  }
});

// Issue #94: an agreed question whose context begins with a list marker and whose question begins with four spaces
// reaches conversation.md as text: the context stays a paragraph inside its block quote, the question a paragraph.
test("issue #94: a plain piece that would open a block reaches conversation.md as text", async () => {
  const opening = { ...entry("Q1"), context: para("- not a list, the context of Q1."), question: plain("    not code, the question?") };
  const divided: TermsEntry = { id: "Q1", explanations: [], context: opening.context, question: opening.question, reason: opening.reason, proposed_answers: opening.proposed_answers };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [opening] } }, { output: asking("Q1", []) }, { output: { ...done, asked_ids: ["Q1"], answered_ids: ["Q1"] } }, { output: noQuestions, plan: "v1" }],
    terms: [{ output: { entries: [divided] } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const quoted = conversation.split("\n").find((l) => l.includes("not a list, the context of Q1.")) ?? "";
  assert.ok(quoted.startsWith("> "), quoted);
  assert.deepEqual(readBlocks(quoted.slice(2)), { types: ["paragraph"], text: "- not a list, the context of Q1." });
  const question = conversation.split("\n").find((l) => l.startsWith("**") && l.includes("not code, the question?")) ?? "";
  const back = readBlocks(question);
  assert.deepEqual(back.types, ["paragraph"], question);
  assert.ok(back.text.includes("    not code, the question?"), back.text);
});
