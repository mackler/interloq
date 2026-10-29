// Issue #159: the context call writes the labels of a disputed pause's options as outcomes, naming no agent; the program
// refuses a label naming one, with the validation repair turn, and falls back to its own outcome labels. The prompt's
// rule and the validation are exercised together here, and the scenarios below run the whole question.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import type { QuestionInvalid } from "../src/errors.ts";
import { askOffering, permissionDraft, positionOptions } from "../src/offer.ts";
import { piecesText, plainBlocks, plainOption, plainPieces } from "../src/pieces.ts";
import * as prompts from "../src/prompts.ts";
import { contextValidation } from "../src/questionContext.ts";
import type { QuestionOrigin } from "../src/question.ts";
import type { DecisionAnalysis, Entry, QuestionContext } from "../src/schema.ts";
import { Store, Ui } from "../src/services.ts";
import { issue, type PlanningStep, presentedQuestions, type Probe, respond, scriptedContextReply, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const positions = [{ label: prompts.REVIEWER_POSITION, description: "Drop step S2." }, { label: prompts.PLANNER_POSITION, description: "Step S2 is needed." }];
const requestOf = (origin: QuestionOrigin, question: string): prompts.ContextRequest => ({
  origin,
  decision: null,
  question: plainPieces(question),
  options: positionOptions("reraised", positions).map((o) => o.shown),
  details: [],
  explanations: [],
  facts: "",
  fallback: plainBlocks(prompts.fallbackContext(origin)),
  history: [],
});
const disputedOrigin: QuestionOrigin = { kind: "pause", heading: "Planning 1", pause: "reraised", id: "P1-R1-1" };
const disputed = requestOf(disputedOrigin, prompts.pauseQuestion({ pause: "reraised", id: "P1-R1-1" }));
const unexplainedOrigin: QuestionOrigin = { kind: "pause", heading: "Planning 1", pause: "unexplained", fileLabel: "plan.json", round: 1 };
const unexplained = requestOf(unexplainedOrigin, "plan.json changed. What do you want done with the change?");
const withLabels = (reply: QuestionContext, labels: readonly string[]): QuestionContext => ({
  ...reply,
  options: reply.options.map((o, i) => ({ ...o, label: plainPieces(labels[i]) })),
});

test("the context prompt of a disputed pause carries the outcome-label rule, and the validation refuses a label naming an agent", () => {
  const rule = prompts.outcomeLabelsRule();
  for (const name of prompts.AGENT_NAMES) assert.ok(rule.includes(name), name);
  assert.ok(prompts.contextPrompt("t", disputed).includes(rule));
  assert.ok(!prompts.contextPrompt("t", unexplained).includes(rule));
  const reply = scriptedContextReply(prompts.contextPrompt("t", disputed));
  const validate = contextValidation(disputed);
  const { reviewer, planner } = prompts.positionLabels("reraised");
  assert.ok(Result.isSuccess(validate(withLabels(reply, [reviewer, planner]))));
  const named = validate(withLabels(reply, [prompts.REVIEWER_POSITION, planner]));
  assert.ok(Result.isFailure(named));
  assert.equal(named.failure.error._tag, "QuestionInvalid");
  assert.deepEqual((named.failure.error as QuestionInvalid).questions, [{ where: "the question", problems: [{ kind: "agentInLabel", subject: prompts.REVIEWER_POSITION }] }]);
  const determinate = prompts.QUESTION_RULES.find((r) => r.id === "determinateOptions")?.rule ?? "";
  assert.notEqual(determinate, "");
  assert.ok(named.failure.repair.includes(determinate));
  // The check is for the disputed pauses alone.
  const other = scriptedContextReply(prompts.contextPrompt("t", unexplained));
  assert.ok(Result.isSuccess(contextValidation(unexplained)({ ...other, options: [plainOption("Ask Codex again", "x"), other.options[1]] })));
});

// ---- the scenarios (S4) ------------------------------------------------------------------------------------------

const noQuestions = { questions_for_user: [] };
const finishedExec = { status: "finished" as const, summary: "done", question: "", remainingWork: "", userInput: null, checks: [] };
const REVIEWS = [{ issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }];
const ACCEPT_LABEL = "Accept the review's point";
const LEAVE_LABEL = "Leave the plan as it is now";
const el = { text: "t", counterarguments: [] };
const entryOf = (id: string): Entry => ({ id, title: `title ${id}`, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
const twoColumns = (a: string, b: string): DecisionAnalysis => ({
  decision: "d",
  columns: [
    { kind: "argued", option: a, advantages: [entryOf("E1")], disadvantages: [] },
    { kind: "argued", option: b, advantages: [], disadvantages: [entryOf("E2")] },
  ],
  recommendation: { option: "", reason: "" },
});
/** Context replies: each the scripted faithful reply with the given labels, the later ones built from the first prompt. */
const relabeled = (...labelSets: (readonly string[])[]): PlanningStep[] => {
  let first: QuestionContext | null = null;
  return labelSets.map((labels) => ({
    output: (prompt: string) => {
      first ??= scriptedContextReply(prompt);
      return withLabels(first, labels);
    },
  }));
};
const runTaskWith = async (options: TestOptions) => {
  const t = testLayer(tempRepo(), options);
  const { run } = await import("../src/run.ts");
  return { ...t, finished: await Effect.runPromise(run("task").pipe(Effect.map((end) => (end._tag === "Finished" ? end.phases : 0)), Effect.provide(t.layer))) };
};
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const pauseQuestions = (probe: Probe) => presentedQuestions(probe.ui).filter((q) => q.origin.kind === "pause");
const escaped = (s: string) => s.replace(/[()]/g, "\\$&");

test("a context reply whose labels name an agent is repaired, and the answer is paired with its position", async () => {
  const { probe, finished } = await runTaskWith({
    answers: ["1"],
    contexts: relabeled([prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION], [ACCEPT_LABEL, LEAVE_LABEL]),
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: REVIEWS,
    execs: [finishedExec],
  });
  assert.equal(finished, 1);
  assert.equal(probe.planner.contextPrompts.length, 2, "one validation repair turn");
  assert.deepEqual(pauseQuestions(probe)[0].options.map((o) => piecesText(o.label)), [ACCEPT_LABEL, LEAVE_LABEL]);
  const invalid = path.join(probe.dir, "invalid-replies");
  assert.ok(fs.readdirSync(invalid).some((f) => read(invalid, f).includes(prompts.REVIEWER_POSITION)), "the refused reply is kept");
  assert.match(read(probe.dir, "user-decisions.md"), new RegExp(`Decision: ${escaped(prompts.REVIEWER_POSITION)}: `));
});

test("a typed label the context call wrote is recorded as its position (P1-R1-1)", async () => {
  const { probe } = await runTaskWith({
    config: { maxIdleRounds: 5 },
    answers: ["/decide", LEAVE_LABEL],
    contexts: relabeled([ACCEPT_LABEL, LEAVE_LABEL]),
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }, { output: twoColumns(ACCEPT_LABEL, LEAVE_LABEL) }, { output: respond([["P1-R1-1", "rejected"]]) }],
    reviews: REVIEWS,
    execs: [finishedExec],
  });
  assert.equal(JSON.parse(read(probe.dir, "decision-1/chosen.json")).option, prompts.PLANNER_POSITION);
  assert.match(read(probe.dir, "user-decisions.md"), new RegExp(`Decision: ${escaped(prompts.PLANNER_POSITION)}`));
});

test("a permission request keeps its matching: a rephrased Allow label typed is no Allow (P1-R2-1)", async () => {
  const allowShown = "Let Claude Code run the command";
  const draft = permissionDraft("Bash", { command: "ls" });
  const denyShown = piecesText(draft.options[1].shown.label);
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", allowShown],
    contexts: relabeled([allowShown, denyShown]),
    steps: [{ output: twoColumns(allowShown, denyShown) }],
    reviews: [{ issues: [] }],
  });
  const answer = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.decisionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(answer, allowShown, "not y, so Claude Code is denied as before");
  assert.equal(JSON.parse(read(probe.dir, "decision-1/chosen.json")).option, prompts.PERMISSION_DENY);
});

test("two refused context replies fall back to the program's outcome labels, and 2 records Claude Code's position", async () => {
  const { probe, finished } = await runTaskWith({
    config: { maxIdleRounds: 5 },
    answers: ["2"],
    contexts: relabeled([prompts.REVIEWER_POSITION, LEAVE_LABEL], ["Codex wins", "Claude wins"]),
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }, { output: respond([["P1-R1-1", "rejected"]]) }],
    reviews: REVIEWS,
    execs: [finishedExec],
  });
  assert.equal(finished, 1);
  const { reviewer, planner } = prompts.positionLabels("reraised");
  assert.deepEqual(pauseQuestions(probe)[0].options.map((o) => piecesText(o.label)), [reviewer, planner]);
  assert.match(read(probe.dir, "conversation.md"), /\*\*Context written by Interloq:\*\*/);
  assert.match(read(probe.dir, "user-decisions.md"), new RegExp(`Decision: ${escaped(prompts.PLANNER_POSITION)}`));
});
