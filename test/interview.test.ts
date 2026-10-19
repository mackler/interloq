import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { ack, questionEntry, questionText, summaryReply, tempRepo, testLayer, presentedQuestions, TEST_ROOT, runRefinement, refinementFails, type ScriptedAnswer, type TestOptions } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";

// Step 4.6 (finding 8; Q4): the interview matches on turn variants, and the question list is normalised.
type QuestionEntry = typeof S.QuestionEntry.Type;
const q = (id: string, defaultAnswer = "A"): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", default_answer: defaultAnswer });
/** Issue #184: the first interview's request carrying Claude Code's answer to agreed question `id`. */
const answered = (id: string, option: string) => `The user answers agreed question ${id} with the option ${JSON.stringify(option)}.`;
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

test("a turn that is complete with a blank summary continues the conversation instead of proposing a summary", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "more", ""],
    steps: [{ output: { questions: [q("Q1")] } }],
    // Issue #184: the closing reply is complete with a blank summary; the developer replies to its message.
    closings: [{ output: ack("Anything to add?", { complete: true, summary: "  " }) }, { output: summaryReply("# Requirements\n\nNone.", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.ok(probe.ui.asked.some((p) => p.startsWith("You >")), "the blank summary was not treated as a continuing turn");
  assert.equal(probe.planner.clarificationPrompts.filter((p) => p.includes(prompts.LIST_DONE_SENTENCE)).length, 2, "no second closing request followed the reply");
  assert.ok(probe.ui.said.includes("Gather Requirements: Claude Code formulates the question list ..."), probe.ui.said.join("\n"));
  assert.match(read(probe.dir, "requirements.md"), /None\./);
  assert.doesNotMatch(read(probe.dir, "conversation.md"), /Summary proposed by Claude Code:\n\n\s*\n/);
});

test("duplicate question ids halt with QuestionListInvalid before any review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { questions: [q("Q1"), q("Q1")] } }],
  });
  await refinementFails(layer, "QuestionListInvalid", /Q1/);
  assert.equal(probe.reviewer.prompts.length, 0);
});

test("a default answer that names no proposed answer is recorded as null, with a note in the conversation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", ""],
    steps: [{ output: { questions: [q("Q1", "C")] } }],
    closings: [{ output: summaryReply("# Requirements\n\nQ1: A", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  const file = JSON.parse(read(probe.dir, "questions.json"));
  assert.equal(file.questions[0].default_answer, null);
  assert.match(read(probe.dir, "conversation.md"), /default answer.*Q1.*C/i);
});

// Plan step 1.5: the question phase is a phase of the progress display, and each interview turn is an event
// emitted before the lines said for that turn, which stay unchanged.
test("the question phase notifies its beginning and end and every interview turn before its lines", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "more", ""],
    steps: [{ output: { questions: [q("Q1")] } }],
    // Issue #184: a closing reply with a message and no summary, then the summary.
    closings: [{ output: ack("Anything to add?") }, { output: summaryReply("# Requirements\n\nNone.", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  // Issue #6: the run's shape is notified first, then the question phase begins.
  const tags = probe.ui.notified.map((e) => e._tag);
  assert.deepEqual(tags.slice(0, 2), ["PhasesForeseen", "PhaseBegan"]);
  assert.deepEqual(probe.ui.notified[1], { _tag: "PhaseBegan", phase: { kind: "questions" } });
  const turns = probe.ui.notified.filter((e) => e._tag === "InterviewTurn");
  assert.deepEqual(turns, [
    { _tag: "InterviewTurn", heading: prompts.clarificationHeading("clarification"), message: "Anything to add?", summary: null, answered: 1, total: 1 },
    { _tag: "InterviewTurn", heading: prompts.clarificationHeading("clarification"), message: "Done.", summary: "# Requirements\n\nNone.", answered: 1, total: 1 },
  ]);
  // Issue #21: the clarification counts the agreed questions.
  assert.deepEqual(probe.ui.notified.find((e) => e._tag === "InterviewOpened"), { _tag: "InterviewOpened", heading: prompts.clarificationHeading("clarification"), stage: "clarification", total: 1 });
  assert.ok(probe.ui.notified.some((e) => e._tag === "PhaseEnded" && e.phase.kind === "questions"));
  // Issue #120: a refinement run is the question phase alone; nothing begins after it ends.
  assert.equal(tags.lastIndexOf("PhaseBegan"), 1, "a phase began after the question phase");
  // The line said for a turn is unchanged; S7: the summary is shown in the context of the question that confirms it.
  assert.ok(probe.ui.said.includes("\nAnything to add?\n"));
  const confirm = presentedQuestions(probe.ui).find((q) => q.origin.kind === "confirmSummary");
  assert.deepEqual(confirm?.attached?.blocks, [{ kind: "document", markdown: "# Requirements\n\nNone." }]);
  assert.equal(confirm === undefined ? null : questionText(confirm), prompts.CONFIRM_SUMMARY_QUESTION);
});

// Finding 8 of docs/gui-review.md: the interview's opening help is a structured event, rendered per interface.
test("the interview's opening is an InterviewOpened event, not a say", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", ""],
    steps: [{ output: { questions: [q("Q1")] } }],
    closings: [{ output: summaryReply("# Requirements\n\nNone.", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.ok(probe.ui.notified.some((e) => e._tag === "InterviewOpened"), "no InterviewOpened event");
  assert.ok(!probe.ui.said.some((line) => line.includes('"""')), "a multiline convention was said");
});

// Decision support, plan step 3.5, and S18: an agreed question is presented from questions.json, its proposed answers its
// options, which carry the offer; the decision is in the requirements phase, and the chosen answer goes on to Claude Code.
const db: QuestionEntry = questionEntry(
  "Q1",
  "Which database should the service use?",
  [["PostgreSQL", "already in the container"], ["SQLite", "no server needed"], ["Both, chosen by configuration", "either, by a setting"]],
  { context: "The service keeps its data in a database, which Interloq, the orchestrator, starts with the service.", reason: "the schema depends on it", default_answer: "PostgreSQL" },
);
const dbQuestion = piecesText(db.question);
const labels = db.proposed_answers.map((a) => piecesText(a.label));
const el = { text: "t", counterarguments: [] };
const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
const decided = (answers: string[], replies: TestOptions["replies"] = []) =>
  testLayer(tempRepo(), {
    answers,
    steps: [{ output: { questions: [db] } }, { output: analysis }],
    replies,
    closings: [{ output: summaryReply("# Requirements\n\nQ1: SQLite", "Done.") }],
    // The question review, the analysis's review, the requirements review.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  });

test("an agreed question with proposed answers offers Help me decide; after the analysis the number is the answer", async () => {
  const { layer, probe } = decided(["/decide", "2", ""]);
  await runRefinement(layer);
  // Issue #133: the offer on the first ask alone; the question asked beside its analysis carries none.
  const asks = probe.ui.asked.filter((p) => p.endsWith("You > "));
  assert.ok(asks[0].startsWith(prompts.OFFER_LINE));
  assert.ok(asks.slice(1).every((p) => !p.startsWith(prompts.OFFER_LINE)));
  const question = JSON.parse(read(probe.dir, "decision-1/question.json"));
  assert.deepEqual(question.phase, { kind: "questions" });
  assert.deepEqual(question.options.map((o: { label: string }) => o.label), labels);
  assert.equal(JSON.parse(read(probe.dir, "decision-1/chosen.json")).option, labels[1]);
  // Issue #184: the answer reaches Claude Code as the option the number chose.
  assert.ok(probe.planner.clarificationPrompts.some((p) => p.includes(answered("Q1", labels[1]))), probe.planner.clarificationPrompts.join("\n---\n"));
});

// W1-R1-1: a blank reply after the analysis is not the choice; the answer that follows is.
test("an agreed question answered /decide, blank, 2 records option 2", async () => {
  const { layer, probe } = decided(["/decide", "", "2", ""]);
  await runRefinement(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/chosen.json")), { version: 2, decision: 1, answer: "2", option: labels[1] });
});

// W2-R1-2: an option chosen by its label is recorded as that option; the columns are the bare labels.
test("an agreed question answered /decide, then a label, records that option; the question's options are the bare labels", async () => {
  const { layer, probe } = decided(["/decide", "SQLite", ""]);
  await runRefinement(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/question.json")).options.map((o: { label: string }) => o.label), labels);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/chosen.json")), { version: 2, decision: 1, answer: "SQLite", option: "SQLite" });
});

// Issue #35 (Q5, Q6) and S18: the decision's question is the agreed question as it was reviewed; Claude Code's message,
// which arrives in the reply to the opening request while the question is shown (issue #184), is not the question.
test("Help me decide on an agreed question names the question as reviewed, not Claude Code's message", async () => {
  const { layer, probe } = decided(["/decide", "2", ""], [{ output: ack("Q3 recorded: changed flag.") }]);
  await runRefinement(layer);
  assert.equal(JSON.parse(read(probe.dir, "decision-1/question.json")).question, dbQuestion);
  const analyzed = probe.ui.notified.find((e) => e._tag === "DecisionAnalyzed");
  assert.equal(analyzed?._tag === "DecisionAnalyzed" ? analyzed.question : null, dbQuestion);
  const analysisPrompt = probe.planner.prompts.find((p) => p.includes("The decision: "));
  assert.match(analysisPrompt ?? "", new RegExp(`The decision: ${dbQuestion.replace(/[?]/g, "\\?")}\n`));
  // The user still reads Claude's message in the interview.
  assert.ok(probe.ui.said.some((line) => line.includes("Q3 recorded")), probe.ui.said.join("\n"));
});

// Issue #184: a closing reply that neither proposes the summary nor asks a follow-up is the only reply question of the
// first interview.
test("a closing reply without a summary or a follow-up asks for the user's reply, its message the context, with no option and no offer", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "more text", ""],
    steps: [{ output: { questions: [db] } }],
    closings: [{ output: ack("Tell me about the deployment.") }, { output: summaryReply("# R", "Done.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  const reply = presentedQuestions(probe.ui).find((p) => p.origin.kind === "reply");
  assert.ok(reply !== undefined, "no reply question was presented");
  assert.deepEqual([reply.origin, reply.context, questionText(reply), reply.options], [{ kind: "reply" }, { blocks: [{ kind: "document", markdown: "Tell me about the deployment." }], by: "agent" }, prompts.REPLY_QUESTION, []]);
  const index = presentedQuestions(probe.ui).indexOf(reply);
  assert.ok(!probe.ui.asked[index].startsWith(prompts.OFFER_LINE));
});

// Issue #99 (S4): a question whose premise the user denied is not asked. The program records the user's choice for each
// agreed question, skips the questions that the choice removes, says so to the user, to Claude Code and in
// conversation.md, counts over the questions that remain, and holds the summary to it with the validation repair turn.
const premised = (): readonly QuestionEntry[] => [q("Q1"), { ...q("Q2"), skip_if: { question: "Q1", answer: "A" } }];
const SUMMARY = "# Requirements\n\nQ1: A\n\n## Skipped questions\n\nQ2: not asked, since Q1 was answered A.";
const skipped = [{ id: "Q2", question: "Q1", answer: "A", cause: "answered" as const }];
const presentedIds = (probe: { ui: Parameters<typeof presentedQuestions>[0] }) => presentedQuestions(probe.ui).flatMap((p) => (p.origin.kind === "clarification" ? [p.origin.id] : []));

/**
 * A premised scenario whose answer to Q1 waits until the opening request was sent, so that the requests are, in order,
 * the opening, the answer and the closing; a repair turn of the closing reply then takes the third of `replies`.
 */
const premisedScenario = (answer: string, closing: unknown, repairs: readonly unknown[], extraAnswers: readonly ScriptedAnswer[] = []) => {
  const opened = async (): Promise<void> => {
    while (built.probe.planner.clarificationPrompts.length < 1) await new Promise((r) => setTimeout(r, 5));
  };
  const built = testLayer(tempRepo(), {
    answers: [{ text: answer, when: opened }, ...extraAnswers, ""],
    steps: [{ output: { questions: premised() } }],
    replies: [{ output: ack() }, { output: ack() }, ...repairs.map((output) => ({ output }))],
    closings: [{ output: closing }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  return built;
};

test("a question whose premise the user denied is skipped, recorded and not counted, and the interview completes without /done", async () => {
  const { layer, probe } = premisedScenario("1", summaryReply(SUMMARY, "Complete."), []);
  await runRefinement(layer);
  assert.deepEqual(presentedIds(probe), ["Q1"]);
  const note = prompts.skippedNote(skipped, []);
  assert.ok(note.includes("Q2") && note.includes("Q1") && note.includes('"A"'), note);
  assert.ok(probe.planner.clarificationPrompts.some((p) => p.includes(answered("Q1", "A")) && p.includes(note)), probe.planner.clarificationPrompts.join("\n---\n"));
  assert.ok(read(probe.dir, "conversation.md").includes(`**Note:** ${note}`));
  assert.ok(probe.ui.said.some((line) => line.includes(note)));
  const counts = probe.ui.notified.flatMap((e) => (e._tag === "InterviewCounted" ? [`${e.answered} of ${e.total}`] : []));
  assert.deepEqual(counts, ["1 of 1"]);
  assert.match(read(probe.dir, "requirements.md"), /Skipped questions/);
});

// Issue #184: Interloq presents the agreed questions itself, so a question whose premise was denied, or one before its
// premise, can no longer be asked; the summary that omits a skipped question still gets the repair turn, and a second
// such summary halts.
test("a skipped question is never presented, and a summary that omits it twice halts with InterviewTurnInvalid", async () => {
  const omitting = summaryReply("# Requirements\n\nQ1: A", "Complete.");
  const { layer, probe } = premisedScenario("1", omitting, [omitting]);
  await refinementFails(layer, "InterviewTurnInvalid", /Q2/);
  assert.deepEqual(presentedIds(probe), ["Q1"]);
  assert.ok(probe.planner.clarificationPrompts.includes(prompts.clarificationReplyRepairPrompt([{ kind: "summaryOmits", ids: ["Q2"] }])));
  assert.ok(prompts.clarificationReplyRepairPrompt([{ kind: "summaryOmits", ids: ["Q2"] }]).includes("Q2"));
});

test("a summary that omits a skipped question gets the repair turn, and the repaired summary is confirmed", async () => {
  const { layer, probe } = premisedScenario("1", summaryReply("# Requirements\n\nQ1: A", "Complete."), [summaryReply(SUMMARY, "Complete.")]);
  await runRefinement(layer);
  assert.ok(probe.planner.clarificationPrompts.includes(prompts.clarificationReplyRepairPrompt([{ kind: "summaryOmits", ids: ["Q2"] }])));
  assert.match(read(probe.dir, "requirements.md"), /Skipped questions/);
});

test("a free-text answer to the premise question skips nothing: the dependent question is asked", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["it depends", "1", ""],
    steps: [{ output: { questions: premised() } }],
    closings: [{ output: summaryReply("# Requirements\n\nQ1: it depends\nQ2: A", "Complete.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.deepEqual(presentedIds(probe), ["Q1", "Q2"]);
  assert.ok(!read(probe.dir, "conversation.md").includes("not asked"));
});

test("the interview's prompts exclude the skipped questions from completion and coverage", () => {
  assert.match(prompts.interviewOpenPrompt(TEST_ROOT), /Cover every agreed question except those the program reports skipped/);
  assert.match(prompts.interviewOpenPrompt(TEST_ROOT), /complete: true only when every agreed question has been answered or the program has reported it skipped/);
  assert.match(prompts.interviewDonePrompt, /skipped/);
  assert.match(prompts.requirementsReviewPrompt(TEST_ROOT, 1, "continued"), /Skipped questions/);
  assert.match(prompts.interviewGapsPrompt(TEST_ROOT, "r.json", ["G-R1-1"]), /premise the user denied/);
});

// W1-R1-1: a summary that names Q20 does not name the skipped Q2; it gets the repair turn.
test("a summary naming a longer id that contains a skipped question's id gets the repair turn", async () => {
  const { layer, probe } = premisedScenario("1", summaryReply("# Requirements\n\nQ1: A\nQ20: answered.", "Complete."), [summaryReply(SUMMARY, "Complete.")]);
  await runRefinement(layer);
  assert.ok(probe.planner.clarificationPrompts.includes(prompts.clarificationReplyRepairPrompt([{ kind: "summaryOmits", ids: ["Q2"] }])));
  assert.match(read(probe.dir, "requirements.md"), /Skipped questions/);
});
