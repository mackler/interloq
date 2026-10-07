import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { decisionLoop } from "../src/decision.ts";
import { askOffering, limitOptions, numberedOptions, type OfferedOption, permissionOptions, type QuestionDraft } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { withOffer } from "../src/prompts.ts";
import type { RunError } from "../src/errors.ts";
import type { ArguedColumn, Column, DecisionAnalysis, Entry } from "../src/schema.ts";
import { Decider, type DecisionQuestion, type Services, Store, Ui } from "../src/services.ts";
import { issue, opt, para, plain, questionEntry, respond, tempRepo, term, testLayer, type TestOptions, presentedQuestions, presentedSubjects, userQuestion, questionOf } from "./helpers.ts";
import { piecesText } from "../src/pieces.ts";

/** The column as an argued one (a test fails on an unclear column). */
const argued = (column: Column): ArguedColumn => {
  if (column.kind !== "argued") throw new Error(`column ${column.option} is not argued`);
  return column;
};

// Decision support, plan step 2.5: the decision loop over the scripted agents.
const FORMAT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
const question: DecisionQuestion = { phase: { kind: "planning", n: 1 }, label: "Planning", question: "Which database?", options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] };
const el = (text = "t", counterarguments: Entry["threshold"]["counterarguments"] = []) => ({ text, counterarguments });
const entry = (id: string, title = `title ${id}`, counter: Entry["threshold"]["counterarguments"] = []): Entry => ({
  id,
  title,
  comparative_condition: el("c", counter),
  starting_cause: el(),
  intermediate_steps: el(),
  threshold: el(),
  effect_on_persons: el(),
  reason_the_effect_matters: el(),
  extent: { per_person: el(), persons_affected: el(), likelihood: el(), timing: el() },
});
const analysis = (title = "first"): DecisionAnalysis => ({
  decision: "Which database?",
  columns: [
    { kind: "argued", option: "SQLite", advantages: [entry("E1", title)], disadvantages: [] },
    { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [entry("E2")] },
  ],
  recommendation: { option: "", reason: "" },
});
const decisionResponse = (dispositions: Parameters<typeof respond>[0], a: DecisionAnalysis) => ({ ...respond(dispositions), analysis: a });

const setUp = async (options: TestOptions) => {
  const repo = tempRepo();
  const t = testLayer(repo, options);
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  return t;
};
const loop = (layer: Layer.Layer<Services>) => decisionLoop(FORMAT, "the task", question).pipe(Effect.provide(layer));
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const fails = async (layer: Layer.Layer<Services>, tag: RunError["_tag"]): Promise<RunError> => {
  const exit = await Effect.runPromiseExit(loop(layer));
  assert.ok(Exit.isFailure(exit), "the decision loop succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `not a typed failure: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  return error.value;
};

test("a decision that converges in round 1 writes its records and its checkpoint names the enclosing phase", async () => {
  const { layer, probe } = await setUp({ steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.decision, end.result], [1, "converged"]);
  assert.deepEqual(end.analysis, analysis());
  assert.deepEqual(json(probe.dir, "decision-1/question.json"), { version: 2, decision: 1, ...question });
  assert.deepEqual(json(probe.dir, "decision-1/cc-0.json"), analysis());
  assert.deepEqual(json(probe.dir, "decision-1/analysis.json"), { version: 2, analysis: analysis() });
  assert.deepEqual(json(probe.dir, "decision-1/review-1.json"), { issues: [] });
  assert.equal(json(probe.dir, "decision-1/round-1.json").kind, "no_response");
  const checkpoint = json(probe.dir, "checkpoint.json");
  assert.deepEqual([checkpoint.subject, checkpoint.phase, checkpoint.round, checkpoint.stage], ["decision-1", 1, 1, "reviewed"]);
  // The analysis call carries the format and runs in a fresh session (Q3); the review carries the format.
  assert.ok(probe.planner.prompts[0].includes(FORMAT));
  assert.equal(probe.planner.freshSessions, 1);
  assert.ok(probe.reviewer.prompts[0].includes(FORMAT));
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /## Decision 1\n\nWhich database\?\n\n1\. SQLite — a file\n2\. PostgreSQL — a server/);
});

test("an accepted issue rewrites analysis.json, the log holds D1 ids with the enclosing phase, and round 2 converges", async () => {
  const { layer, probe } = await setUp({
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis("second")) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.result, argued(end.analysis.columns[0]).advantages[0].title], ["converged", "second"]);
  assert.equal(argued(json(probe.dir, "decision-1/analysis.json").analysis.columns[0]).advantages[0].title, "second");
  assert.deepEqual((await probe.loadLog({ decision: 1 })).map((e) => [e.id, e.phase, e.action]), [["D1-R1-1", 1, "accepted"]]);
  assert.match(probe.reviewer.prompts[1], /D1-R2-1/);
});

// Issue #30 (S11, f): a decision's analysis gets the corrective turn too; its reply is validated as an analysis.
test("an accepted issue with analysis.json unchanged gets a corrective turn in the decision's session", async () => {
  const { layer, probe } = await setUp({
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis()) }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis("second")) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.equal(end.result, "converged");
  assert.match(probe.planner.prompts[2] ?? "", /analysis\.json did not change during your response/);
  assert.equal(argued(json(probe.dir, "decision-1/analysis.json").analysis.columns[0]).advantages[0].title, "second");
  assert.ok(fs.existsSync(path.join(probe.dir, "decision-1", "cc-1-corrective-1.json")));
});

test("a disputed issue pauses as in behavior 7", async () => {
  const { layer, probe } = await setUp({
    // The decision on the raised-again issue, then no decision at the idle pause of two cycles without an amendment.
    answers: ["keep it", ""],
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.equal(end.result, "converged");
  assert.ok(presentedSubjects(probe.ui).some((a) => /issue D1-R1-1, raised again/.test(a)), presentedSubjects(probe.ui).join("\n"));
  assert.deepEqual((await probe.loadLog({ decision: 1 })).filter((e) => e.source === "user").map((e) => [e.id, e.rationale]), [["D1-R1-1", "keep it"]]);
});

test("0 at the cycle limit halts with RoundLimitStop; p proceeds to the choice", async () => {
  const rejected = { steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }], reviews: [{ issues: [issue("D1-R1-1")] }], config: { maxRounds: 1 } };
  await fails((await setUp({ ...rejected, answers: ["0"] })).layer, "RoundLimitStop");
  const proceeding = await setUp({ ...rejected, answers: ["p"] });
  assert.equal((await Effect.runPromise(loop(proceeding.layer))).result, "proceed");
  // S5: the proceed choice is an option of the presented question, described in the subject's words.
  const limit = proceeding.probe.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" && e.question.origin.kind === "limit" ? [e.question] : []));
  assert.ok(limit.some((q) => q.options.some((o) => /proceeds to your choice with the analysis as it is/i.test(piecesText(o.description)))));
});

test("an invalid analysis gets one repair turn; a second invalid reply halts", async () => {
  const repaired = await setUp({ steps: [{ output: { columns: 1 } }, { output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal((await Effect.runPromise(loop(repaired.layer))).result, "converged");
  assert.equal(repaired.probe.planner.prompts.length, 2);
  await fails((await setUp({ steps: [{ output: { columns: 1 } }, { output: { columns: 2 } }] })).layer, "AgentReplyInvalid");
});

test("a change of the project during the analysis call halts with ProjectChanged (behavior 3)", async () => {
  await fails((await setUp({ steps: [{ output: analysis(), touchProject: true }] })).layer, "ProjectChanged");
});

test("the initial analysis is validated (P1-R2-1): a missing column halts before any Codex turn; a dangling reference is dropped with a note", async () => {
  const oneColumn = { ...analysis(), columns: [analysis().columns[0]] };
  // Issue #37: the second invalid analysis halts, after the validation repair turn.
  const halted = await setUp({ steps: [{ output: oneColumn }, { output: oneColumn }] });
  await fails(halted.layer, "AnalysisInvalid");
  assert.equal(halted.probe.planner.prompts.length, 2);
  assert.equal(halted.probe.reviewer.prompts.length, 0);

  const dangling: DecisionAnalysis = { ...analysis(), columns: [{ kind: "argued", option: "SQLite", advantages: [entry("E1", "t", [{ id: "A1", text: "But x.", equivalent_to: "E9", replies: [] }])], disadvantages: [] }, analysis().columns[1]] };
  const noted = await setUp({ steps: [{ output: dangling }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(noted.layer));
  assert.equal(end.result, "converged");
  assert.equal(argued(json(noted.probe.dir, "decision-1/analysis.json").analysis.columns[0]).advantages[0].comparative_condition.counterarguments[0].equivalent_to, "");
  assert.match(fs.readFileSync(path.join(noted.probe.dir, "conversation.md"), "utf8"), /\*\*Reference dropped:\*\* argument A1 names E9, which is no entry of the analysis/);
});

// Decision support, plan step 3.3 (D3): the Decider runs a loop over the run's services, bound to a phase.
test("the Decider of a phase runs a decision loop recorded in that phase", async () => {
  const { layer, probe } = await setUp({ steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const decider = (yield* Decider).at({ kind: "work", n: 2 }, "Work review 2");
    return yield* decider.decide({ question: question.question, options: question.options });
  }).pipe(Effect.provide(layer)));
  assert.deepEqual([outcome.decision, outcome.result], [1, "converged"]);
  assert.deepEqual(json(probe.dir, "decision-1/question.json").phase, { kind: "work", n: 2 });
  assert.equal(json(probe.dir, "checkpoint.json").phase, 2);
});

// Decision support, plan step 3.4 (D2, P1-R1-3, P1-R1-4): the ask that carries the offer.
const offered = numberedOptions(question.options);
/** A question as askOffering takes it (S7): a relayed question with the given text and options. */
const draftOf = (q: Readonly<{ question: string; options: readonly OfferedOption[] }>): QuestionDraft => ({ origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain(q.question), options: q.options, decision: null });
const offering = (layer: Layer.Layer<Services>, q: Readonly<{ question: string; options: readonly OfferedOption[] }>, prompt = "Pick > ") =>
  Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), prompt, draftOf(q));
  }).pipe(Effect.provide(layer)));
/** How often the question was presented: first, and again after an analysis or a rejected answer. */
const presentations = (probe: { ui: { notified: { _tag: string }[] } }) => probe.ui.notified.filter((e) => e._tag === "QuestionPresented").length;
const analyzed = (probe: { ui: { notified: { _tag: string }[] } }) => probe.ui.notified.filter((e) => e._tag === "DecisionAnalyzed");

test("/decide runs a decision, shows it, restores the presentation and asks again; the answer is recorded as the chosen option", async () => {
  const { layer, probe } = await setUp({ answers: ["/decide", "2"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal(await offering(layer, { question: question.question, options: offered }), "2");
  assert.deepEqual(probe.ui.asked, [withOffer("Pick > "), withOffer("Pick > ")]);
  assert.equal(presentations(probe), 2, "presented first, and again before the reask, once");
  const shown = analyzed(probe);
  assert.equal(shown.length, 1);
  const { presented, ...rest } = shown[0] as Extract<UiEvent, { _tag: "DecisionAnalyzed" }>;
  assert.deepEqual(rest, { _tag: "DecisionAnalyzed", decision: 1, question: question.question, options: question.options, analysis: analysis() });
  // S22: the analysis is shown beside the question as the user was shown it.
  assert.equal(piecesText(presented.question), question.question);
  assert.equal(presented.number, 1);
  assert.deepEqual(json(probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*User choice\*\* after decision 1: 2 \(PostgreSQL\)/);
});

test("free text after an analysis is recorded without an option; q stops and records no choice", async () => {
  const free = await setUp({ answers: ["/decide", "neither, use files"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal(await offering(free.layer, { question: question.question, options: offered }), "neither, use files");
  assert.deepEqual(json(free.probe.dir, "decision-1/chosen.json").option, null);
  const quit = await setUp({ answers: ["/decide", "q"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), "Pick > ", draftOf({ question: question.question, options: offered }));
  }).pipe(Effect.provide(quit.layer)));
  assert.ok(Exit.isFailure(exit));
  assert.ok(!fs.existsSync(path.join(quit.probe.dir, "decision-1/chosen.json")));
});

test("a question with fewer than two options carries no offer and records nothing", async () => {
  const { layer, probe } = await setUp({ answers: ["/decide"] });
  assert.equal(await offering(layer, { question: "q", options: offered.slice(0, 1) }), "/decide");
  assert.deepEqual(probe.ui.asked, ["Pick > "]);
  assert.equal(probe.planner.prompts.length, 0);
});

test("a permission request maps y to Allow and anything else to Deny", async () => {
  const q = { question: "Claude Code requests permission: Bash rm -rf build", options: permissionOptions };
  const permissionAnalysis = { ...analysis(), columns: [{ ...analysis().columns[0], option: prompts.PERMISSION_ALLOW }, { ...analysis().columns[1], option: prompts.PERMISSION_DENY }] };
  const allow = await setUp({ answers: ["/decide", "y"], steps: [{ output: permissionAnalysis }], reviews: [{ issues: [] }] });
  assert.equal(await offering(allow.layer, q), "y");
  assert.equal(json(allow.probe.dir, "decision-1/chosen.json").option, prompts.PERMISSION_ALLOW);
  const deny = await setUp({ answers: ["/decide", "n"], steps: [{ output: permissionAnalysis }], reviews: [{ issues: [] }] });
  assert.equal(await offering(deny.layer, q), "n");
  assert.equal(json(deny.probe.dir, "decision-1/chosen.json").option, prompts.PERMISSION_DENY);
});

test("the cycle limit maps a number to more cycles, p to Proceed where offered, and 0 to Stop", async () => {
  const options = limitOptions("proceed to planning");
  assert.deepEqual(options.map((o) => o.label), [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
  const chosen = (answer: string) => options.find((o) => o.matches(answer))?.label;
  assert.deepEqual(["2", "p", "0", "x"].map(chosen), [prompts.LIMIT_MORE, prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_STOP]);
  const noProceed = limitOptions(null);
  assert.deepEqual(noProceed.map((o) => o.label), [prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
  assert.equal(noProceed.find((o) => o.matches("p"))?.label, prompts.LIMIT_STOP);
  // Numbered options match their number or their label.
  assert.deepEqual(["1", "PostgreSQL", "3", "sqlite"].map((a) => offered.find((o) => o.matches(a))?.label), ["SQLite", "PostgreSQL", undefined, undefined]);
});

// Decision support, plan step 3.5: the offer at a review pause, at the plan writer's question and at the cycle limit,
// in a whole run over the scripted agents.
const noQuestions = { questions_for_user: [] };
const finishedExec = { status: "finished" as const, summary: "done", question: "", remainingWork: "", userInput: null };
const twoColumns = (a: string, b: string): DecisionAnalysis => ({ ...analysis(), decision: "d", columns: [{ ...analysis().columns[0], option: a }, { ...analysis().columns[1], option: b }] });
const runTaskWith = async (options: TestOptions) => {
  const t = testLayer(tempRepo(), options);
  const { run } = await import("../src/run.ts");
  return { ...t, finished: await Effect.runPromise(run("task").pipe(Effect.provide(t.layer))) };
};

test("a disputed pause offers Help me decide; the analysis runs in the phase, and the chosen position is the decision", async () => {
  const { probe } = await runTaskWith({
    answers: ["/decide", "1"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "rejected"]]) },
      { output: twoColumns(prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION) },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finishedExec],
  });
  // The pause is presented, asked with the offer, presented again after the analysis and asked again.
  assert.equal(presentedSubjects(probe.ui).filter((a) => a.includes("raised again")).length, 2);
  assert.deepEqual(probe.ui.asked.slice(0, 2), [prompts.withOffer(prompts.decisionPrompt), prompts.withOffer(prompts.decisionPrompt)]);
  // S5: the options are presented with the question, each with the number that chooses it.
  const presented = probe.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" && e.question.origin.kind === "pause" ? [e.question] : []));
  assert.ok(presented.length > 0);
  assert.deepEqual(presented[0].options[0], { label: plain(prompts.REVIEWER_POSITION), description: plain("p e"), answer: { token: "1" } });
  assert.deepEqual(json(probe.dir, "decision-1/question.json").phase, { kind: "planning", n: 1 });
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, prompts.REVIEWER_POSITION);
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), new RegExp(`Decision: ${prompts.REVIEWER_POSITION.replace(/[()]/g, "\\$&")}: p e`));
});

test("a decision inside a decision: a pause of decision 1 opens decision 2 in the same phase and returns to decision 1", async () => {
  const { probe } = await runTaskWith({
    // The plan writer's question offers the options; decision 1's review disputes an issue twice; its pause is decided
    // with decision 2; then the plan writer's question is answered.
    // "" is no decision at decision 1's idle pause (two cycles without an amendment).
    answers: ["/decide", "/decide", "2", "", "1"],
    steps: [
      { output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: question.options })] }, plan: "v1" },
      { output: analysis() },
      { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) },
      { output: twoColumns(prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION) },
      { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) },
      { output: noQuestions },
    ],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finishedExec],
  });
  assert.deepEqual(json(probe.dir, "decision-2/question.json").phase, { kind: "planning", n: 1 });
  assert.equal(json(probe.dir, "decision-2/chosen.json").option, prompts.PLANNER_POSITION);
  assert.equal(json(probe.dir, "decision-1/chosen.json").option, "SQLite");
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /Subject: question from Claude Code: Which database\?\nDecision: SQLite: a file/);
});

test("at the cycle limit Help me decide is offered, and a number afterwards adds cycles", async () => {
  const threeColumns: DecisionAnalysis = { ...analysis(), columns: [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE].map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })) };
  const { probe, finished } = await runTaskWith({
    config: { maxRounds: 1 },
    answers: ["/decide", "1"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }, { output: threeColumns }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finishedExec],
  });
  assert.equal(finished, 1);
  assert.ok(probe.ui.asked[0].startsWith(prompts.OFFER_LINE));
  assert.deepEqual(json(probe.dir, "decision-1/question.json").options.map((o: { label: string }) => o.label), [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
  assert.deepEqual(json(probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "1", option: prompts.LIMIT_MORE });
});

// W1-R1-1: an answer the caller rejects is not recorded; the question is asked again.
test("with a predicate, a rejected answer is asked again and not recorded; without one, an empty answer is the choice", async () => {
  const notEmpty = (a: string) => a !== "";
  const retried = await setUp({ answers: ["/decide", "", "2"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const answer = await Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), "Pick > ", draftOf({ question: question.question, options: offered }), notEmpty);
  }).pipe(Effect.provide(retried.layer)));
  assert.equal(answer, "2");
  assert.deepEqual(json(retried.probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
  assert.equal(presentations(retried.probe), 3, "presented first, again after the analysis, and after the rejected answer");
  const empty = await setUp({ answers: ["/decide", ""], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal(await offering(empty.layer, { question: question.question, options: offered }), "");
  assert.deepEqual(json(empty.probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "", option: null });
});

// W3-R1-1: the page learns that a reply was rejected, so that it keeps the analysis for the question asked again.
test("askOffering notifies AnswerRejected once per rejected answer, never for an accepted one, and never without a predicate", async () => {
  const rejectedCount = (probe: { ui: { notified: { _tag: string }[] } }) => probe.ui.notified.filter((e) => e._tag === "AnswerRejected").length;
  const withPredicate = await setUp({ answers: ["/decide", "", "2"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  await Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), "Pick > ", draftOf({ question: question.question, options: offered }), (a) => a !== "");
  }).pipe(Effect.provide(withPredicate.layer)));
  assert.equal(rejectedCount(withPredicate.probe), 1);
  const fewOptions = await setUp({ answers: ["", "x"] });
  await Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), "Pick > ", draftOf({ question: "q", options: offered.slice(0, 1) }), (a) => a !== "");
  }).pipe(Effect.provide(fewOptions.layer)));
  assert.equal(rejectedCount(fewOptions.probe), 1);
  const without = await setUp({ answers: ["/decide", ""], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  await offering(without.layer, { question: question.question, options: offered });
  assert.equal(rejectedCount(without.probe), 0);
});

// Issue #37, decision Q1: an analysis that fails the validation beyond its schema gets one repair turn in the same
// session, whose prompt lists the exact labels, on each of the three paths that yield an analysis.
const misnamed = (): DecisionAnalysis => ({ ...analysis(), columns: [{ ...analysis().columns[0], option: "1. MySQL" }, analysis().columns[1]] });
const repairListsLabels = (prompt: string) => {
  for (const [i, o] of question.options.entries()) assert.ok(prompt.includes(prompts.optionLine(i, o)), prompt);
};

test("the first analysis with a column that names no option gets the validation repair turn, and the loop converges", async () => {
  const { layer, probe } = await setUp({ steps: [{ output: misnamed() }, { output: analysis() }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.result, end.analysis], ["converged", analysis()]);
  assert.equal(probe.planner.prompts.length, 2);
  repairListsLabels(probe.planner.prompts[1]);
  assert.equal(probe.planner.freshSessions, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(probe.dir, "invalid-replies", "claude-1.json"), "utf8")), misnamed());
});

test("a review response with an invalid analysis gets the validation repair turn", async () => {
  const { layer, probe } = await setUp({
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "accepted"]], misnamed()) }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis("second")) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.result, argued(end.analysis.columns[0]).advantages[0].title], ["converged", "second"]);
  repairListsLabels(probe.planner.prompts[2]);
  assert.deepEqual((await probe.loadLog({ decision: 1 })).map((e) => [e.id, e.action]), [["D1-R1-1", "accepted"]]);
});

test("the application of the user's decisions with an invalid analysis gets the validation repair turn", async () => {
  const withQuestion = { ...decisionResponse([["D1-R1-1", "accepted"]], analysis("second")), questions_for_user: [userQuestion("Which one?")] };
  const { layer, probe } = await setUp({
    answers: ["the first"],
    steps: [{ output: analysis() }, { output: withQuestion }, { output: { analysis: misnamed() } }, { output: { analysis: analysis("third") } }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.result, argued(end.analysis.columns[0]).advantages[0].title], ["converged", "third"]);
  assert.match(probe.planner.prompts[2], /user-decisions\.md/);
  repairListsLabels(probe.planner.prompts[3]);
});

test("a numbered label that matches its option after normalization is accepted without a repair turn, with a note", async () => {
  const numbered: DecisionAnalysis = { ...analysis(), columns: [{ ...analysis().columns[0], option: "1. SQLite" }, analysis().columns[1]], recommendation: { option: "2) PostgreSQL", reason: "r" } };
  const { layer, probe } = await setUp({ steps: [{ output: numbered }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.analysis.columns.map((c) => c.option), end.analysis.recommendation.option], [["SQLite", "PostgreSQL"], "PostgreSQL"]);
  assert.equal(probe.planner.prompts.length, 1);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.match(conversation, /\*\*Option label corrected:\*\* the analysis named "1\. SQLite", which the program read as the option "SQLite"/);
  assert.match(conversation, /named "2\) PostgreSQL"/);
});

// W1-R1-1: a label with the agent's ordinal in front of an option's own ordinal is corrected, not repaired.
test("an analysis naming \"1. 1. Retry\" for the option \"1. Retry\" converges without a repair turn, with a note", async () => {
  const retryQuestion: DecisionQuestion = { ...question, options: [{ label: "1. Retry", description: "" }, { label: "Skip", description: "" }] };
  const given: DecisionAnalysis = { ...analysis(), columns: [{ ...argued(analysis().columns[0]), option: "1. 1. Retry" }, { ...argued(analysis().columns[1]), option: "Skip" }], recommendation: { option: "1. 1. Retry", reason: "r" } };
  const { layer, probe } = await setUp({ steps: [{ output: given }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(decisionLoop(FORMAT, "the task", retryQuestion).pipe(Effect.provide(layer)));
  assert.equal(end.result, "converged");
  assert.equal(probe.planner.prompts.length, 1);
  const saved = json(probe.dir, "decision-1/analysis.json").analysis;
  assert.deepEqual([saved.columns[0].option, saved.recommendation.option], ["1. Retry", "1. Retry"]);
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Option label corrected:\*\* the analysis named "1\. 1\. Retry", which the program read as the option "1\. Retry"/);
});

// W1-R1-3: a validation repair for a duplicate id keeps an analysis that recommends no option.
test("a repair of a duplicate id permits no recommendation, and the repaired analysis keeps none", async () => {
  const duplicate: DecisionAnalysis = { ...analysis(), columns: [argued(analysis().columns[0]), { ...argued(analysis().columns[1]), disadvantages: [entry("E1")] }] };
  const { layer, probe } = await setUp({ steps: [{ output: duplicate }, { output: analysis() }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(layer));
  assert.equal(end.result, "converged");
  assert.match(probe.planner.prompts[1], /To recommend no option, leave the recommendation's option and reason empty\./);
  assert.equal(json(probe.dir, "decision-1/analysis.json").analysis.recommendation.option, "");
});

// W1-R1-2: a decision's prompt names its phase as the phase lines and the rail do, by the count of its kind in the run.
test("a decision names its phase by the run's count: Planning in a run of one iteration, Planning 2 once a second is foreseen", async () => {
  const { run } = await import("../src/run.ts");
  const { countOfKind, foreseenPhases, phaseName } = await import("../src/uiEvents.ts");
  const { finished } = await import("./helpers.ts");
  const noQuestions = { questions_for_user: [] };
  const asking = { questions_for_user: [userQuestion(question.question, question.options.map((o) => [o.label, o.description] as const))] };
  const expected = (iterations: number, n: number) => `The run is in ${phaseName({ kind: "planning", n }, countOfKind(foreseenPhases(false, iterations), "planning"))}.`;
  const analysisPrompt = (prompts: readonly string[]) => prompts.find((p) => p.includes(prompts_.DECISION_FORMAT_AUTHORITY)) ?? "";
  const prompts_ = prompts;

  const one = testLayer(tempRepo(), {
    answers: ["/decide", "1"],
    steps: [{ output: asking, plan: "v1" }, { output: analysis() }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await Effect.runPromise(run("task").pipe(Effect.provide(one.layer)));
  assert.ok(analysisPrompt(one.probe.planner.prompts).includes(expected(1, 1)), analysisPrompt(one.probe.planner.prompts).slice(-600));

  const stopped = { status: "needs_input" as const, summary: "s", question: "A or B?", remainingWork: "w", userInput: "B" };
  const two = testLayer(tempRepo(), {
    answers: ["/decide", "1"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: asking }, { output: analysis() }, { output: noQuestions }],
    // Plan review 1, work review 1, the decision's review, plan review 2, work review 2.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stopped, finished],
  });
  await Effect.runPromise(run("task").pipe(Effect.provide(two.layer)));
  assert.ok(analysisPrompt(two.probe.planner.prompts).includes(expected(2, 2)), analysisPrompt(two.probe.planner.prompts).slice(-600));
});

// S20 (issue #57): a question Claude Code raises inside decision k (an option it cannot argue from) is presented as
// belonging to decision k, with the reason it is asked, and still offers Help me decide (behavior 13 unchanged).
test("a question raised inside a decision says that it belongs to that decision and why, and keeps the offer", async () => {
  const unclear = userQuestion("Option 2 does not say what the agent is told about the order of the steps. Which is meant?", [["Any order", "the agent is told it may work the steps in any order"], ["In order", "the agent is told to work the steps in their order"]], { context: para("Claude Code, the planning agent, is working out the arguments for the options of Decision 1 now, for your choice.") });
  const withQuestion = { ...decisionResponse([["D1-R1-1", "accepted"]], analysis("second")), questions_for_user: [unclear] };
  const { layer, probe } = await setUp({
    answers: ["1"],
    steps: [{ output: analysis() }, { output: withQuestion }, { output: { analysis: analysis("third") } }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  await Effect.runPromise(loop(layer));
  const inside = probe.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : [])).find((q) => piecesText(q.question) === piecesText(unclear.question));
  assert.ok(inside !== undefined);
  assert.equal(inside.decision, 1);
  assert.deepEqual(inside.origin, { kind: "planner", heading: "Decision 1" });
  assert.match(prompts.originLine(inside.origin, inside.decision), /belongs to Decision 1, the analysis you asked for/);
  assert.match(prompts.originLine(inside.origin, inside.decision), /cannot work out the arguments for and against an option whose meaning is undetermined/);
  assert.ok(probe.ui.asked[0].startsWith(prompts.OFFER_LINE), "the question inside the decision lost the offer");
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /belongs to Decision 1/);
});

// S21 (Q4, issue #57): while an analysis is prepared, the user reads one plain status, not the review loop's cycle lines.
test("a decision loop says one plain status per check of its analysis, not the cycle lines; conversation.md keeps the record", async () => {
  const { layer, probe } = await setUp({
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis("second")) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  await Effect.runPromise(decisionLoop(FORMAT, "the task", question, 7).pipe(Effect.provide(layer)));
  const progress = probe.ui.notified.flatMap((e) => (e._tag === "AnalysisProgress" ? [[e.decision, e.question, e.check]] : []));
  assert.deepEqual(progress, [[1, 7, 0], [1, 7, 1], [1, 7, 2]]);
  assert.deepEqual(probe.ui.said.filter((l) => l.includes("analysis")), [0, 1, 2].map((n) => prompts.analysisProgressLine(1, 7, n)));
  assert.ok(!probe.ui.said.some((l) => /cycle \d|Issues: \d|Codex review|Claude Code response/.test(l)), probe.ui.said.join("\n"));
  assert.match(prompts.analysisProgressLine(1, 7, 2), /Question 7.*check 2 so far/);
  assert.doesNotMatch(prompts.analysisProgressLine(1, 7, 2), /cycle|round/);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  assert.match(conversation, /## Decision 1, round 1/);
});

// S37 (W1-R1-5): Help me decide gives the analysis the question as the user was shown it: its context, terms and details.
const analysisPromptOf = (prompts_: readonly string[]) => prompts_.find((p) => p.includes(prompts.DECISION_FORMAT_AUTHORITY)) ?? "";
const decideOn = async (draft: QuestionDraft) => {
  const { layer, probe } = await setUp({ answers: ["/decide", "1"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  await Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), prompts.decisionPrompt, draft);
  }).pipe(Effect.provide(layer)));
  return { prompt: analysisPromptOf(probe.planner.prompts), probe };
};

test("a relayed question in the shape gives the analysis its context paragraph and its terms", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  const text = prompts.relayedQuestionText({
    context: [{ kind: "paragraph", pieces: [...plain("The "), term("service", "s"), ...plain(" keeps its data in a database, which Interloq, the orchestrator, starts with it.")] }],
    question: plain("Which database should the service use?"),
    explanations: [{ id: "s", term: "service", explanation: "The program this task builds." }],
    options: question.options.map((o) => opt(o.label, o.description)),
  });
  const parsed = parseRelayedQuestion(text, question.options);
  assert.ok(parsed !== null);
  const { prompt, probe } = await decideOn({ origin: { kind: "relayed" }, context: { blocks: parsed.context, by: "agent" }, explanations: parsed.explanations, question: parsed.question, options: offered, decision: null });
  assert.ok(prompt.includes("The service keeps its data in a database"), prompt.slice(-1500));
  assert.ok(prompt.includes("service: The program this task builds."));
  const { shown: _shown, ...recorded } = json(probe.dir, "decision-1/question.json");
  assert.deepEqual(Object.keys(recorded).sort(), ["decision", "label", "options", "phase", "question", "version"]);
});

test("an agreed question gives the analysis its reviewed context, reason and terms; a pause its details", async () => {
  const { turnDraft } = await import("../src/conversation.ts");
  const { normalizeTurn } = await import("../src/schemaNormalize.ts");
  const agreed = questionEntry("Q1", "Which database?", question.options.map((o) => [o.label, o.description] as const), { context: "The service stores orders in a database.", reason: "the schema depends on it", default_answer: "SQLite" });
  const turn = normalizeTurn({ message_to_user: "", current_question: { id: "Q1", context: [], text: [], explanations: [], options: [] }, asked_ids: ["Q1"], answered_ids: [], complete: false, summary: "" });
  const divided = { ...agreed, explanations: [{ id: "o", term: "orders", explanation: "What customers buy." }], context: [{ kind: "paragraph" as const, pieces: [...plain("The service stores "), term("orders", "o"), ...plain(" in a database.")] }] };
  const draft = turnDraft(turn, { questions: [agreed], terms: [divided] });
  const { prompt } = await decideOn(draft);
  for (const part of ["The service stores orders in a database.", "the schema depends on it", "orders: What customers buy."]) assert.ok(prompt.includes(part), part);
  const { decisionDraft } = await import("../src/review.ts");
  const facts = { pause: "reraised" as const, id: "P1-R1-1", history: [], issue: { id: "P1-R1-1", severity: "major" as const, location: "S1", problem: "The migration is missing.", evidence: "S1 never migrates." } };
  const pause = await decideOn({ ...decisionDraft("Planning phase 1", { kind: "pause", facts }, question.options, null), explain: undefined });
  assert.ok(pause.prompt.includes("Codex says: The migration is missing."), pause.prompt.slice(-1500));
});

// S10 of the task of issue #36: the context call may rephrase a question the program composed (G-R1-1); Help me decide
// then analyzes the question as the user was shown it, and the answer is still chosen and recorded by the program's own
// option, paired by position.
test("S10: after a context call rephrases a permission question, the analysis argues about the shown wording; the choice is the program's", async () => {
  const { permissionDraft } = await import("../src/offer.ts");
  const { scriptedContextReply } = await import("./helpers.ts");
  const shownLabels = ["Let it run the command", "Stop it from running the command"];
  const rephrase = (prompt: string) => ({
    ...scriptedContextReply(prompt),
    question: plain("Do you want Claude Code to run the command shown above?"),
    options: [opt(shownLabels[0], "The listing is made."), opt(shownLabels[1], "Nothing is listed.")],
  });
  const twoShown: DecisionAnalysis = { ...analysis(), columns: shownLabels.map((option, i) => ({ kind: "argued" as const, option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })) };
  const { layer, probe } = await setUp({ answers: ["/decide", "y"], contexts: [{ output: rephrase }], steps: [{ output: twoShown }], reviews: [{ issues: [] }] });
  const answer = await Effect.runPromise(
    Effect.gen(function* () {
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, permissionDraft("Bash", { command: "ls" }));
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(answer, "y");
  const prompt = analysisPromptOf(probe.planner.prompts);
  assert.match(prompt, /The decision: Do you want Claude Code to run the command shown above\?\n/);
  for (const label of shownLabels) assert.ok(prompt.includes(JSON.stringify(label)), label);
  assert.deepEqual(json(probe.dir, "decision-1/question.json").options.map((o: { label: string }) => o.label), shownLabels);
  assert.deepEqual(json(probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "y", option: prompts.PERMISSION_ALLOW });
  const analyzed = probe.ui.notified.find((e) => e._tag === "DecisionAnalyzed");
  assert.deepEqual(analyzed?._tag === "DecisionAnalyzed" ? analyzed.presented.question : null, plain("Do you want Claude Code to run the command shown above?"));
});
