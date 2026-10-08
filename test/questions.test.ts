import * as prompts from "../src/prompts.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import { finished, issue, opt, para, plain, questionEntry, respond, runFails, runTask, tempRepo, term, testLayer, presentedQuestions, presentedSubjects } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";

type QuestionEntry = typeof S.QuestionEntry.Type;
type InterviewTurn = typeof S.InterviewTurn.Type;

const noQuestions = { questions_for_user: [] };
const q = (id: string): QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", reason: "the codebase does not determine it", default_answer: "A" });
const none = { id: "", context: [], text: [], explanations: [], options: [] };
const turn = (message: string, answered: string[], summary = ""): InterviewTurn => ({
  message_to_user: message,
  current_question: none,
  asked_ids: answered,
  answered_ids: answered,
  complete: summary !== "",
  summary,
});
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const withQuestions = { questionPhase: true };

test("question list is amended in review, the interview runs, the summary is confirmed, and planning follows", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "B, because of X", ""],
    steps: [
      { output: { questions: [q("Q1")] } },                                              // question list
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } }, // Codex: Q2 is missing
      { output: turn("Q1: A or B?", []) },                                                // interview
      { output: turn("Q2: A or B?", ["Q1"]) },
      { output: turn("Complete.", ["Q1", "Q2"], "# Requirements\n\nQ1: A\nQ2: B because of X") },
      { output: noQuestions, plan: "v1" },                                                // initial plan
    ],
    reviews: [{ issues: [issue("Q-R1-1", "Q2 is missing")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);

  const questions = JSON.parse(read(probe.dir, "questions.json"));
  assert.equal(questions.version, 2);
  assert.equal(questions.task, "task");
  assert.deepEqual(questions.questions.map((x: QuestionEntry) => x.id), ["Q1", "Q2"]);
  assert.match(read(probe.dir, "requirements.md"), /Q2: B because of X/);
  assert.equal((await probe.loadLog("questions"))[0].action, "accepted");
  assert.equal(probe.reviewer.phases, 5); // question review, terms review (S17), requirements review, plan review, work review
  assert.ok(probe.planner.prompts.some((p) => p.includes("User: B, because of X")));
  assert.match(probe.planner.prompts.at(-1) ?? "", /requirements\.md contains the user's confirmed answers/);
  const conversation = read(probe.dir, "conversation.md");
  assert.match(conversation, /## Agreed question list/);
  assert.match(conversation, /\*\*User:\*\* B, because of X/);
  assert.match(conversation, /### Confirmed summary/);
});

// Issue #83 (the developer's instruction of 4 Oct 2026): an empty agreed list is no reason to pause. Nothing is asked;
// requirements.md is written, the phase ends with "no conversation", and planning begins.
test("an empty agreed list asks nothing: requirements.md is written, the phase ends with no conversation, planning begins", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [],
    steps: [{ output: { questions: [] } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.deepEqual(probe.ui.asked, [], "a prompt was asked");
  assert.deepEqual(presentedQuestions(probe.ui), [], "a question was presented");
  assert.match(read(probe.dir, "requirements.md"), /No question was needed/);
  assert.doesNotMatch(read(probe.dir, "requirements.md"), /the user added no information/);
  const tags = probe.ui.notified.map((e) => e._tag);
  const ended = probe.ui.notified.findIndex((e) => e._tag === "PhaseEnded" && e.phase.kind === "questions");
  assert.deepEqual(probe.ui.notified[ended], { _tag: "PhaseEnded", phase: { kind: "questions" }, result: "no conversation" });
  assert.ok(tags.indexOf("InterviewOpened") === -1, "an interview was opened");
  assert.ok(probe.ui.notified.slice(ended).some((e) => e._tag === "PhaseBegan" && e.phase.kind === "planning"), "planning did not begin after the question phase");
  assert.match(probe.planner.prompts[1], /Produce an implementation plan/);
  assert.equal(probe.reviewer.phases, 3); // question, plan and work review: no requirements review without a conversation
});

test("an unconfirmed summary continues the conversation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "Q1 is B, not A", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: turn("Corrected.", ["Q1"], "Q1: B") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: B\n");
  assert.ok(probe.planner.prompts.some((p) => p.startsWith("The user does not confirm the summary")));
});

test("a gap that Claude Code accepts produces a second interview and a revised requirements file", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "", "retries: 3", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: respond([["G-R1-1", "accepted"]]) },                      // requirements review response
      { output: turn("How many retries?", []) },                          // second interview
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 3") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  assert.match(read(probe.dir, "conversation.md"), /## Interview\n[\s\S]*## Second interview\n/);
  assert.equal((await probe.loadLog("requirements"))[0].id, "G-R1-1");
  // Issue #31 (G-R1-1): the requirements' change is measured from the response through the second interview.
  const [gap] = await probe.loadLog("requirements");
  assert.deepEqual(gap !== undefined && "file_change" in gap ? gap.file_change : undefined, { changed: true, added: 1, removed: 0 });
  // The user reads "User Decisions" and "More user decisions" (issue #113); conversation.md keeps its record headings.
  const headings = probe.ui.notified.flatMap((e) => (e._tag === "InterviewOpened" || e._tag === "InterviewTurn" ? [e.heading] : []));
  assert.deepEqual([...new Set(headings)], [prompts.clarificationHeading("clarification"), prompts.clarificationHeading("followUp")]);
  // Issue #21 (Q6, Q7): each clarification opens with its total, the agreed questions or the accepted gaps, and each
  // turn carries the count of answered questions against the total so far.
  const counted = probe.ui.notified.flatMap((e) => (e._tag === "InterviewOpened" ? [`opened ${e.stage} ${e.total}`] : e._tag === "InterviewTurn" ? [`${e.answered} of ${e.total}`] : []));
  assert.deepEqual(counted, ["opened clarification 1", "0 of 1", "1 of 1", "opened followUp 1", "0 of 1", "1 of 1"]);
});

// Issue #30 (G-R1-1): the requirements go straight to the pause, without a corrective turn; its Retry is another interview.
test("a gap accepted but the confirmed summary unchanged: the pause, and Retry holds another interview", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "", "no change", "", "r", "retries: 3", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: respond([["G-R1-1", "accepted"]]) },
      { output: turn("How many retries?", []) },
      { output: turn("Complete.", ["G-R1-1"], "Q1: A") }, // the summary confirmed unchanged
      { output: turn("How many retries, then?", []) }, // Retry: another interview
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 3") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  assert.ok(probe.ui.asked.some((p) => p.endsWith(prompts.unchangedPrompt)), "the pause was not asked");
  assert.equal(probe.planner.prompts.some((p) => /did not change during your response/.test(p)), false, "a corrective turn was taken");
});

test("/done ends the interview early", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/done", ""],
    steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", []) }, { output: turn("Ended.", [], "Open points: Q1 -> default A") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts.some((p) => p.startsWith("The user ends the interview now")));
  assert.match(read(probe.dir, "requirements.md"), /default A/);
});

// Issue #21 (Q6): a follow-up question raises the total; Claude reports it in asked_ids with an id of its own.
test("a follow-up asked during the clarification raises its total", async () => {
  const withFollowUp = (message: string, asked: string[], answered: string[], summary = ""): InterviewTurn => ({ message_to_user: message, current_question: none, asked_ids: asked, answered_ids: answered, complete: summary !== "", summary });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "3", ""],
    steps: [
      { output: { questions: [q("Q1"), q("Q2")] } },
      { output: withFollowUp("Q1?", ["Q1"], []) },
      { output: withFollowUp("How many retries? (a follow-up)", ["Q1", "F1"], ["Q1"]) },
      { output: withFollowUp("Complete.", ["Q1", "F1", "Q2"], ["Q1", "F1"], "Q1: A\nRetries: 3\nQ2: default") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  const counts = probe.ui.notified.flatMap((e) => (e._tag === "InterviewTurn" ? [`${e.answered} of ${e.total}`] : []));
  assert.deepEqual(counts, ["0 of 2", "1 of 3", "2 of 3"]);
});

// S15 (issues #34, #58, #59): the question list is held to the rules inside behaviour 10's validation budget, at the
// first call, at a response to a review and at the application of the user's decisions; a second failure halts.
const blank = (id: string): QuestionEntry => ({ ...q(id), context: para(" ") });
test("a question list whose entry breaks a rule gets the validation repair turn at the first call; a second failure halts", async () => {
  const repaired = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [
      { output: { questions: [blank("Q1")] } },
      { output: { questions: [q("Q1")] } },
      { output: { ...turn("Q1?", []), current_question: { ...none, id: "Q1", text: plain("question Q1?") } } },
      { output: turn("Done.", ["Q1"], "# Requirements\n\nQ1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(repaired.layer);
  assert.equal(repaired.probe.planner.prompts[1], prompts.questionRepairPrompt([{ where: "Q1", problems: [{ kind: "blankContext", subject: "" }] }]));
  const halted = testLayer(tempRepo(), { steps: [{ output: { questions: [blank("Q1")] } }, { output: { questions: [blank("Q1")] } }], config: withQuestions });
  await runFails(halted.layer, "QuestionInvalid", /Q1: the context paragraph is empty/);
});

test("a response to the question review whose list breaks a rule gets the validation repair turn", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), { ...q("Q2"), question: plain("Which one? It matters.") }] } },
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } },
      { output: turn("Done.", ["Q1", "Q2"], "# Requirements\n\nA") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [issue("Q-R1-1", "Q2 is missing")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(probe.planner.prompts[2], prompts.questionRepairPrompt([{ where: "Q2", problems: [{ kind: "notLast", subject: "" }] }]));
  assert.deepEqual(JSON.parse(read(probe.dir, "questions.json")).questions.map((x: QuestionEntry) => piecesText(x.question)), ["question Q1?", "question Q2?"]);
});

// S16 (Q12): a question of the plan writer and an interview question outside questions.json are held to the rules, with
// behaviour 10's validation repair turn and no Codex review; an agreed question and a turn that asks nothing are not.
test("a plan writer's question that breaks a rule gets the validation repair turn; a second failure halts", async () => {
  const bad = { context: para("c"), question: plain("Which database? Say."), explanations: [], options: [] };
  const good = { context: para("c"), question: plain("Which database?"), explanations: [], options: [] };
  const repaired = testLayer(tempRepo(), {
    answers: ["SQLite"],
    steps: [{ output: { questions_for_user: [bad] }, plan: "v1" }, { output: { questions_for_user: [good] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(repaired.layer);
  assert.equal(repaired.probe.planner.prompts[1], prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [{ kind: "notLast", subject: "" }] }]));
  const halted = testLayer(tempRepo(), { steps: [{ output: { questions_for_user: [bad] }, plan: "v1" }, { output: { questions_for_user: [bad] }, plan: "v1" }] });
  await runFails(halted.layer, "QuestionInvalid", /questions_for_user 1/);
});

test("an interview question outside questions.json is validated, an agreed one and a turn that asks nothing are not", async () => {
  const followUp = (context: string) => ({ ...turn("A follow-up.", ["Q1"]), current_question: { ...none, id: "F1", context: para(context), text: plain("Which port?") }, asked_ids: ["Q1", "F1"] });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "8080", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...turn("", []), current_question: { ...none, id: "Q1" }, asked_ids: ["Q1"] } },
      { output: followUp(" ") },
      { output: followUp("The service listens on a port.") },
      { output: turn("Done.", ["Q1", "F1"], "# Requirements\n\nQ1: A; F1: 8080") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  const repair = prompts.questionRepairPrompt([{ where: "F1", problems: [{ kind: "blankContext", subject: "" }] }]);
  assert.equal(probe.planner.prompts.filter((p) => p === repair).length, 1, "the follow-up got one repair turn, the agreed question none");
});

// S35 (W1-R1-3): only a turn that asks nothing skips the validation of its question.
test("turnValidation: a turn with a blank id that asks a question is validated; one that asks nothing is not", async () => {
  const { turnValidation, asksNothing } = await import("../src/conversation.ts");
  const { Result } = await import("effect");
  const base = turn("m", []);
  const asking = { ...base, current_question: { ...none, text: [term("Choose one", "o"), ...plain(".")], explanations: [{ id: "o", term: "one", senses: [""] }] } };
  const failed = turnValidation([], null)(asking);
  assert.ok(Result.isFailure(failed));
  assert.equal(failed.failure.repair, prompts.questionRepairPrompt([{ where: "the current question", problems: [{ kind: "blankContext", subject: "" }, { kind: "notLast", subject: "" }, { kind: "blankExplanation", subject: "one" }] }]));
  assert.ok(Result.isSuccess(turnValidation([], null)(base)));
  assert.ok(Result.isSuccess(turnValidation(["Q1"], null)({ ...base, current_question: { ...none, id: "Q1" } })));
  // The seam: turnDraft presents as a reply exactly the turns asksNothing names.
  const { turnDraft } = await import("../src/conversation.ts");
  const { normalizeTurn } = await import("../src/schemaNormalize.ts");
  for (const t of [base, asking, { ...base, current_question: { ...base.current_question, options: [opt("A", "a")] } }]) {
    assert.equal(turnDraft(normalizeTurn(t), { questions: [], terms: [] }).origin.kind === "reply", asksNothing(t.current_question), JSON.stringify(t.current_question));
  }
});

test("a turn with a blank id asking an invalid question gets the repair turn; a second one halts with QuestionInvalid", async () => {
  const bad = { ...turn("m", []), current_question: { ...none, text: [term("Choose one", "o"), ...plain(".")], explanations: [{ id: "o", term: "one", senses: [""] }] } };
  const halted = testLayer(tempRepo(), { steps: [{ output: { questions: [q("Q1")] } }, { output: bad }, { output: bad }], reviews: [{ issues: [] }], answers: [], config: withQuestions });
  await runFails(halted.layer, "QuestionInvalid", /the current question/);
});

// S7 of the task of issue #36: a follow-up question is pieces; a piece that refers to no explanation gets the repair turn.
test("S7: a follow-up with a dangling ref gets the validation repair turn, and the repaired one is presented with its pieces", async () => {
  const dangling = { ...none, id: "F1", context: para("The service, a web server, listens on a port."), text: [...plain("Which "), term("port", "p"), ...plain("?")] };
  const repaired = { ...dangling, explanations: [{ id: "p", term: "port", senses: ["The number a program listens on for connections."] }] };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["8080", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...turn("A follow-up.", []), current_question: dangling, asked_ids: ["F1"] } },
      { output: { ...turn("A follow-up.", []), current_question: repaired, asked_ids: ["F1"] } },
      { output: turn("Done.", ["F1"], "# Requirements\n\nF1: 8080") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts.includes(prompts.questionRepairPrompt([{ where: "F1", problems: [{ kind: "unknownRef", subject: "p" }] }])));
  const followUp = presentedQuestions(probe.ui).find((q) => q.origin.kind === "followUp");
  assert.deepEqual(followUp?.question, repaired.text);
  assert.deepEqual(followUp?.explanations, repaired.explanations);
});

// Issues #59, #91, #92 and #93 (5 Oct 2026): the seven rules reach the agent that writes the question list and the plan,
// and their criteria the reviewer of the question list, in a run of the question phase.
test("the seven rules of 5 Oct 2026 reach the writers of the question list and the plan, and their criteria the review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1: A or B?", []) }, { output: turn("Complete.", ["Q1"], "# Requirements\n\nQ1: A") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  const ids = ["contextBearsOnChoice", "askOutcome", "readerConsequence", "statedWarrant", "developmentFacts", "readerInstructions", "namedActor"];
  const rules = ids.map((id) => prompts.QUESTION_RULES.find((r) => r.id === id));
  assert.ok(rules.every((r) => r !== undefined), "a rule is missing");
  const listPrompt = probe.planner.prompts[0];
  const planPrompt = probe.planner.prompts.at(-1) ?? "";
  assert.match(planPrompt, /Produce an implementation plan/);
  const reviewPrompt = probe.reviewer.prompts[0];
  for (const r of rules) {
    assert.ok(listPrompt.includes(r!.rule), r!.id);
    assert.ok(planPrompt.includes(r!.rule), r!.id);
    assert.ok(reviewPrompt.includes(r!.criterion), r!.id);
  }
});

// Issue #99 (S3): an entry's skip condition is described in the question list's prompt and checked by the program, with
// the validation repair turn of behaviour 10; the list is recorded in an order in which a question follows its premise.
const dependent = (id: string, question: string, answer: string): QuestionEntry => ({ ...q(id), skip_if: { question, answer } });
const skipConditionRun = (first: readonly QuestionEntry[], second: readonly QuestionEntry[]) =>
  testLayer(tempRepo(), {
    answers: ["1", "1", ""],
    steps: [
      { output: { questions: first } },
      { output: { questions: second } },
      { output: { ...turn("Q1?", []), current_question: { ...none, id: "Q1" } } },
      { output: { ...turn("Q2?", ["Q1"]), current_question: { ...none, id: "Q2" } } },
      { output: turn("Done.", ["Q1", "Q2"], "# Requirements\n\nQ1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });

test("a skip condition naming an unknown question, an unknown answer or forming a cycle gets the validation repair turn", async () => {
  const cases: readonly (readonly [readonly QuestionEntry[], import("../src/premises.ts").SkipProblem])[] = [
    [[q("Q1"), dependent("Q2", "Q9", "A")], { kind: "unknownQuestion", id: "Q2", names: "Q9" }],
    [[q("Q1"), dependent("Q2", "Q1", "Maybe")], { kind: "unknownAnswer", id: "Q2", question: "Q1", answer: "Maybe" }],
    [[dependent("Q1", "Q2", "B"), dependent("Q2", "Q1", "B")], { kind: "cycle", ids: ["Q1", "Q2"] }],
  ];
  for (const [list, problem] of cases) {
    const { layer, probe } = skipConditionRun(list, [q("Q1"), dependent("Q2", "Q1", "B")]);
    await runTask(layer);
    assert.equal(probe.planner.prompts[1], prompts.skipConditionRepairPrompt([problem]), problem.kind);
    assert.ok(probe.planner.prompts[1].includes(prompts.skipConditionProblemLine(problem)));
    assert.deepEqual(JSON.parse(read(probe.dir, "questions.json")).questions.map((x: QuestionEntry) => x.skip_if), [null, { question: "Q1", answer: "B" }]);
  }
  const halted = testLayer(tempRepo(), { steps: [{ output: { questions: [q("Q1"), dependent("Q2", "Q9", "A")] } }, { output: { questions: [q("Q1"), dependent("Q2", "Q9", "A")] } }], config: withQuestions });
  await runFails(halted.layer, "SkipConditionInvalid", /Q2/);
});

test("a skip condition is checked at a response to the review and at the application of the user's decisions", async () => {
  const { questionSubject } = await import("../src/subjects.ts");
  const subject = questionSubject("task");
  const wrong = { ...respond([]), questions: [q("Q1"), dependent("Q2", "Q9", "A")] };
  const responded = subject.respond.validate!(wrong);
  assert.ok(responded._tag === "Failure");
  assert.equal(responded.failure.repair, prompts.skipConditionRepairPrompt([{ kind: "unknownQuestion", id: "Q2", names: "Q9" }]));
  const applied = subject.applyDecisions.validate!({ questions: wrong.questions });
  assert.ok(applied._tag === "Failure");
  assert.equal(applied.failure.error._tag, "SkipConditionInvalid");
});

test("a dependent question listed before its premise is recorded after it, and conversation.md names its condition", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "1", ""],
    steps: [
      { output: { questions: [dependent("Q2", "Q1", "B"), q("Q1")] } },
      { output: { ...turn("Q1?", []), current_question: { ...none, id: "Q1" } } },
      { output: { ...turn("Q2?", ["Q1"]), current_question: { ...none, id: "Q2" } } },
      { output: turn("Done.", ["Q1", "Q2"], "# Requirements\n\nQ1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "questions.json")).questions.map((x: QuestionEntry) => x.id), ["Q1", "Q2"]);
  assert.ok(read(probe.dir, "conversation.md").includes(prompts.skipIfLine({ question: "Q1", answer: "B" })));
});

test("the description of skip_if in the question list's prompt states each requirement the program checks", () => {
  const listPrompt = prompts.questionListPrompt("task");
  assert.ok(listPrompt.includes(prompts.SKIP_IF_FIELD));
  const problems: readonly import("../src/premises.ts").SkipProblem[] = [
    { kind: "unknownQuestion", id: "Q2", names: "Q9" },
    { kind: "selfReference", id: "Q2" },
    { kind: "unknownAnswer", id: "Q2", question: "Q1", answer: "Maybe" },
    { kind: "cycle", ids: ["Q1", "Q2"] },
  ];
  for (const p of problems) {
    const clause = prompts.SKIP_IF_CLAUSES[p.kind];
    assert.ok(clause.length > 0, p.kind);
    assert.ok(prompts.SKIP_IF_FIELD.includes(clause), p.kind);
    assert.ok(prompts.skipConditionProblemLine(p).includes(clause), p.kind);
  }
  assert.ok(prompts.skipConditionRepairPrompt(problems).includes(prompts.SKIP_IF_FIELD));
});

// Issue #112: a disputed issue of the question list concerns how a question to the user is worded. It is not put to
// the user: the issue raised again after a partial acceptance (the pause of 7 Oct 2026) goes to Claude Code's response,
// conversation.md records it, and the review goes on to agree.
test("issue #112: an issue of the question list raised again after a partial acceptance is not put to the user", async () => {
  const amended = questionEntry("Q1", "question Q1, amended?", [["A", "a"], ["B", "b"]], { context: "c", reason: "the codebase does not determine it", default_answer: "A" });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...respond([["Q-R1-1", "partially_accepted"]]), questions: [amended] } },
      { output: { ...respond([["Q-R1-1", "rejected"]]), questions: [amended] } },
      { output: turn("Q1: A or B?", []) },
      { output: turn("Complete.", ["Q1"], "# Requirements\n\nQ1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [issue("Q-R1-1", "a word needs explaining")] }, { issues: [issue("Q-R1-1", "a word still needs explaining")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.ok(presentedQuestions(probe.ui).every((x) => x.origin.kind !== "pause"), JSON.stringify(presentedSubjects(probe.ui)));
  const conversation = read(probe.dir, "conversation.md");
  assert.match(conversation, new RegExp(`\\*\\*${prompts.WORDING_DISPUTE_HEADING}\\*\\* Question review: issue Q-R1-1, raised again`));
  assert.ok(probe.ui.said.some((line) => /issue Q-R1-1, raised again/.test(line)));
  assert.ok(!(await probe.loadLog("questions")).some((e) => e.action === "decided_by_user"));
  assert.ok(probe.reviewer.prompts.some((p) => p === prompts.questionReviewPrompt(3)));
});
