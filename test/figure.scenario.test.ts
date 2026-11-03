// Issue #98: an option's picture travels from the agent's reply to the question the user is shown, unchanged and in its
// option's position; a bad picture gets the validation repair turn; a call that rephrases or divides a question keeps it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import * as prompts from "../src/prompts.ts";
import { contextValidation, writeContext } from "../src/questionContext.ts";
import type { FigureReply, QuestionContext, TermsEntry } from "../src/schema.ts";
import { Store } from "../src/services.ts";
import { termsValidation } from "../src/subjects.ts";
import { askedInPlanReview, entryOf, finished, opt, para, plain, presentedQuestions, questionOf, runRefinement, runTask, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const NARROW: FigureReply = { svg: '<svg viewBox="0 0 400 300"><rect width="400" height="60"/></svg>', alt: "A band 60 pixels high across the top." };
const WIDE: FigureReply = { svg: '<svg viewBox="0 0 400 300"><rect width="400" height="240"/></svg>', alt: "A band 240 pixels high across the top." };
const noQuestions = { questions_for_user: [] };
const visual = (figures: readonly (FigureReply | null)[]) =>
  questionOf({ context: "The decision page divides a window 800 pixels high among its regions.", question: "Which division do you want?", terms: [], options: figures.map((figure, i) => ({ label: `Division ${i + 1}`, description: `It gives the columns ${i === 0 ? "less" : "more"} room.`, figure })) });

test("a plan writer's question whose options carry figures is presented with the same figures, in order", async () => {
  const { layer, probe } = testLayer(tempRepo(), askedInPlanReview({
    answers: ["1"],
    steps: [{ output: { questions_for_user: [visual([NARROW, WIDE])] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }));
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "planner");
  assert.deepEqual(q!.options.map((o) => o.figure), [NARROW, WIDE]);
});

test("a picture with a blank alt text gets one validation repair turn citing the figure clause, and the repaired question is presented", async () => {
  const bad = visual([{ ...NARROW, alt: " " }, WIDE]);
  const good = visual([NARROW, WIDE]);
  const opts = askedInPlanReview({ answers: ["1"], steps: [{ output: { questions_for_user: [bad] }, plan: "v1" }, { output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const steps = opts.steps!;
  const respondBad = steps[1]!;
  const respondGood = { ...respondBad, output: { ...(respondBad.output as object), questions_for_user: [good] } };
  const run = testLayer(tempRepo(), { ...opts, steps: [steps[0]!, respondBad, respondGood, ...steps.slice(2)] });
  await runTask(run.layer);
  const clause = prompts.QUESTION_FORMAT.find((c) => c.id === "figure")!.text;
  assert.ok(run.probe.planner.prompts.some((p) => p.includes(clause) && p.includes(prompts.questionProblemText({ kind: "figureAltBlank", subject: "option 1" }))), "the repair prompt names the problem and cites the clause");
  const [q] = presentedQuestions(run.probe.ui).filter((x) => x.origin.kind === "planner");
  assert.deepEqual(q!.options.map((o) => o.figure), [NARROW, WIDE]);
});

test("a context call that adds a picture where the program's option had none gets figureChanged and the repair turn", async () => {
  const origin = { kind: "permission", tool: "Bash", input: "ls" } as const;
  const request: prompts.ContextRequest = { origin, decision: null, question: plain("Do you want Claude Code to run the command?"), options: [opt("Allow", "It runs."), opt("Deny", "It does not.")], details: [], explanations: [], facts: "f", fallback: para("The program's context."), history: [] };
  const reply: QuestionContext = { context: para("Claude Code, the coding agent, wants to run a command now."), history: [], question: request.question, options: request.options, details: [], explanations: [] };
  const added: QuestionContext = { ...reply, options: [{ ...reply.options[0]!, figure: NARROW }, reply.options[1]!] };
  assert.ok(Result.isSuccess(contextValidation(request)(reply)));
  const refused = contextValidation(request)(added);
  assert.ok(Result.isFailure(refused));
  const { layer, probe } = testLayer(tempRepo(), { contexts: [{ output: added }, { output: reply }] });
  const written = await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
    return yield* writeContext("the task", request);
  }).pipe(Effect.provide(layer)));
  assert.equal(probe.planner.contextPrompts.length, 2);
  assert.equal(probe.planner.contextPrompts[1], prompts.questionRepairPrompt([{ where: "the question", problems: [{ kind: "figureChanged", subject: "option 1" }] }]));
  assert.ok(probe.planner.contextPrompts[0]!.includes(prompts.KEEP_FIGURES));
  assert.deepEqual(written.options?.map((o) => o.figure), [null, null]);
});

const visualEntry = (id: string) => {
  const e = entryOf({ id, context: "The decision page divides a window 800 pixels high.", question: "Which division do you want?", reason: "r", proposed_answers: [{ label: "Narrow", description: "n" }, { label: "Wide", description: "w" }], default_answer: "Narrow" });
  return { ...e, proposed_answers: [{ ...e.proposed_answers[0]!, figure: NARROW }, { ...e.proposed_answers[1]!, figure: WIDE }] };
};

test("a terms entry that changes an agreed question's picture is refused with figureChanged", () => {
  const agreed = visualEntry("Q1");
  const entry: TermsEntry = { id: "Q1", explanations: [], context: agreed.context, history: agreed.history, question: agreed.question, reason: agreed.reason, proposed_answers: agreed.proposed_answers };
  const validate = termsValidation<{ entries: readonly TermsEntry[] }>([agreed]);
  assert.ok(Result.isSuccess(validate({ entries: [entry] })));
  const changed = { ...entry, proposed_answers: [{ ...entry.proposed_answers[0]!, figure: WIDE }, entry.proposed_answers[1]!] };
  const refused = validate({ entries: [changed] });
  assert.ok(Result.isFailure(refused));
  assert.match(JSON.stringify(refused.failure), /figureChanged/u);
});

test("an agreed question is presented with the pictures of questions.json and terms.json", async () => {
  const agreed = visualEntry("Q1");
  const entry: TermsEntry = { id: "Q1", explanations: [], context: agreed.context, history: agreed.history, question: agreed.question, reason: agreed.reason, proposed_answers: agreed.proposed_answers };
  for (const terms of [[], [{ output: { entries: [entry] } }]]) {
    const { layer, probe } = testLayer(tempRepo(), { answers: ["1"], steps: [{ output: { questions: [agreed] } }], terms, closings: [{ output: summaryReply("# Requirements\n\nNarrow.") }], reviews: [{ issues: [] }, { issues: [] }] });
    await runRefinement(layer);
    const [q] = presentedQuestions(probe.ui).filter((x) => x.origin.kind === "clarification");
    assert.deepEqual(q!.options.map((o) => o.figure), [NARROW, WIDE], `terms ${terms.length}`);
  }
});

// Issue #98 (S7): the seam between the record's link and the file the Store writes. Every link in conversation.md,
// joined to the run's records directory, names a file that holds that picture's markup.
const linkedFiles = (dir: string): readonly string[] =>
  [...fs.readFileSync(path.join(dir, "conversation.md"), "utf8").matchAll(/\]\((figures\/[0-9a-f]{64}\.svg)\)/gu)].map((m) => m[1]!);
const assertLinksResolve = (dir: string, expected: readonly FigureReply[]) => {
  const links = linkedFiles(dir);
  assert.ok(links.length > 0, "conversation.md links a picture");
  for (const link of links) assert.ok(fs.existsSync(path.join(dir, link)), `${link} exists`);
  for (const f of expected) assert.ok(links.some((l) => fs.readFileSync(path.join(dir, l), "utf8") === f.svg), `a link holds ${f.alt}`);
};

test("a planner question's pictures are written to the files conversation.md links, and the next Codex review does not halt", async () => {
  const { layer, probe } = testLayer(tempRepo(), askedInPlanReview({
    answers: ["1"],
    steps: [{ output: { questions_for_user: [visual([NARROW, WIDE])] }, plan: "v1" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }));
  await runTask(layer);
  assertLinksResolve(probe.dir, [NARROW, WIDE]);
});

test("the agreed question list and the terms link pictures whose files exist", async () => {
  const agreed = visualEntry("Q1");
  const entry: TermsEntry = { id: "Q1", explanations: [], context: agreed.context, history: agreed.history, question: agreed.question, reason: agreed.reason, proposed_answers: agreed.proposed_answers };
  const { layer, probe } = testLayer(tempRepo(), { answers: ["1"], steps: [{ output: { questions: [agreed] } }], terms: [{ output: { entries: [entry] } }], closings: [{ output: summaryReply("# Requirements\n\nNarrow.") }], reviews: [{ issues: [] }, { issues: [] }] });
  await runRefinement(layer);
  const text = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const section = (heading: string) => text.slice(text.indexOf(heading), text.indexOf("\n## ", text.indexOf(heading) + 1));
  for (const heading of ["## Agreed question list", "## Explanations of terms proposed by Claude Code"]) {
    const links = [...section(heading).matchAll(/\]\((figures\/[0-9a-f]{64}\.svg)\)/gu)].map((m) => m[1]!);
    assert.equal(links.length, 2, heading);
    for (const link of links) assert.ok(fs.existsSync(path.join(probe.dir, link)), `${heading}: ${link}`);
  }
  assertLinksResolve(probe.dir, [NARROW, WIDE]);
});
