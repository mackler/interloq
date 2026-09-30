// S17 (issue #36, decisions Q8 and "Decided 28 Sep 2026"): after the question review converges, a fresh Claude Code
// session writes the explanations of the agreed questions' terms, and Codex reviews them in a loop of their own,
// under behaviours 5, 6, 7 and 10, before the clarification begins. S6 of the task of issue #36 (decision Q1): that
// session divides each agreed question into pieces that refer to its explanations, its wording unchanged.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer, currentOf, entryOf, presentedQuestions } from "./helpers.ts";
import { Result } from "effect";
import fc from "fast-check";
import { blocksText, piecesText } from "../src/pieces.ts";
import type { Piece } from "../src/schema.ts";
import { termsValidation } from "../src/subjects.ts";

const noQuestions = { questions_for_user: [] };
const entry: S.QuestionEntry = entryOf({
  id: "Q1",
  context: "Claude Code, the coding agent, checks the input of a tool with Zod, a library, when the tool is called.",
  question: "Should zod be declared as a dependency?",
  reason: "package.json does not list it",
  proposed_answers: [{ label: "Declare it", description: "add zod to package.json" }, { label: "Leave it", description: "keep it the SDK's" }],
  default_answer: "Declare it",
});
const zod = { id: "z", term: "zod", explanation: "A library that checks that data has the shape a program expects." };
/** Pieces in which every "zod" or "Zod" refers to the explanation `z`, the words kept as they stand. */
const divide = (pieces: readonly Piece[]): readonly Piece[] =>
  pieces.flatMap((p) => p.text.split(/([Zz]od)/).filter((t) => t !== "").map((t) => (/^[Zz]od$/.test(t) ? { text: t, ref: "z", code: false } : { text: t, ref: "", code: false })));
const dividedEntry = (explanation = zod.explanation): S.TermsEntry => ({
  id: "Q1",
  explanations: [{ ...zod, explanation }],
  context: entry.context.map((b) => (b.kind === "paragraph" ? { ...b, pieces: divide(b.pieces) } : b)),
  question: divide(entry.question),
  reason: entry.reason,
  proposed_answers: entry.proposed_answers.map((a) => ({ label: a.label, description: divide(a.description) })),
});
const terms = (explanation = zod.explanation) => ({ entries: [dividedEntry(explanation)] });
const interviewTurns = [
  { output: { message_to_user: "", current_question: currentOf({ id: "Q1", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1"], answered_ids: [], complete: false, summary: "" } },
  { output: { message_to_user: "Done.", current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: ["Q1"], answered_ids: ["Q1"], complete: true, summary: "# Requirements\n\nQ1: declare it" } },
];
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");

test("the terms are written in a fresh session after the question review converges, reviewed, and recorded in terms.json", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: terms() }],
    // The question review, the requirements review, the plan review, the work review; the terms review converges.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "terms.json")), { version: 2, entries: terms().entries });
  assert.equal(probe.planner.termsPrompts[0], prompts.termsPrompt("task"));
  assert.ok(probe.planner.termsPrompts[0].includes(prompts.questionWritingRules()));
  assert.ok(probe.reviewer.prompts.some((p) => p === prompts.termsReviewPrompt(1)));
  assert.ok(prompts.termsReviewPrompt(1).includes(prompts.questionReviewCriteria()));
  assert.ok(fs.existsSync(path.join(probe.dir, "terms-review", "review-1.json")));
  assert.deepEqual(JSON.parse(read(probe.dir, "terms-log.json")), { version: 2, entries: [] });
  assert.match(read(probe.dir, "conversation.md"), /## Terms review, round 1/);
  // The fresh sessions: the terms' own (the question list's session is the run's).
  assert.ok(probe.planner.freshSessions >= 1);
});

test("an accepted issue about an explanation: the response returns the amended explanations, which are written", async () => {
  const amended = terms("A library that checks data against a declared shape and reports what does not fit.");
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: terms("A library.") }, { output: { ...respond([["T-R1-1", "accepted"]]), ...amended } }],
    termsReviews: [{ issues: [issue("T-R1-1", "The explanation of zod does not say what it does.")] }, { issues: [] }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "terms.json")).entries, amended.entries);
  const [logged] = await probe.loadLog("terms");
  assert.deepEqual([logged?.id, logged?.action], ["T-R1-1", "accepted"]);
  assert.equal(JSON.parse(read(probe.dir, "checkpoint.json")).subject === "terms-review" || fs.existsSync(path.join(probe.dir, "terms-review", "round-2.json")), true);
});

test("the explanations are validated: a changed wording, an unused explanation, or a question not in the list, gets the repair turn", async () => {
  const changed = { ...dividedEntry(), question: [...dividedEntry().question.slice(0, -1), { text: " now?", ref: "", code: false }], explanations: [zod, { id: "s", term: "SDK", explanation: "A kit." }] };
  const wrong = { entries: [{ ...dividedEntry(), id: "Q9" }, changed] };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: wrong }, { output: terms() }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(
    probe.planner.termsPrompts[1],
    prompts.questionRepairPrompt([
      { where: "Q9", problems: [{ kind: "unknownQuestion", subject: "Q9" }] },
      { where: "Q1", problems: [{ kind: "wordingChanged", subject: "question" }, { kind: "unusedExplanation", subject: "SDK" }] },
    ]),
  );
});

test("the terms review at its cycle limit: p proceeds to the clarification with the explanations as they are; 0 halts", async () => {
  const limited = (answer: string) =>
    testLayer(tempRepo(), {
      answers: [answer, "1", ""],
      steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
      terms: [{ output: terms("A library.") }, { output: { ...respond([["T-R1-1", "rejected"]]), ...terms("A library.") } }],
      termsReviews: [{ issues: [issue("T-R1-1", "The explanation says too little.")] }],
      reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
      execs: [finished],
      config: { questionPhase: true, maxRounds: 1 },
    });
  const proceeding = limited("p");
  await runTask(proceeding.layer);
  assert.match(read(proceeding.probe.dir, "conversation.md"), new RegExp(`\\*\\*User decision:\\*\\* ${prompts.PROCEED_TO_CLARIFICATION_WITH_TERMS} without convergence`));
  await runFails(limited("0").layer, "RoundLimitStop", /Terms review/);
});

test("an empty agreed list writes no terms and has no terms review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    steps: [{ output: { questions: [] } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(fs.existsSync(path.join(probe.dir, "terms-review")), false);
  assert.deepEqual(probe.planner.termsPrompts, []);
});

// S6 (decision Q1): the interview presents an agreed question from its divided entry: a plural or a capitalized word
// refers to its explanation as well as the exact one, which exact words could never do.
test("the interview presents the agreed question divided into pieces, every form of the word referring to its explanation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: terms() }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  const [q] = presentedQuestions(probe.ui);
  assert.deepEqual(q.explanations, [zod]);
  const refs = [...(q.context.blocks[0].kind === "paragraph" ? q.context.blocks[0].pieces : []), ...q.question].filter((p) => p.ref === "z").map((p) => p.text);
  assert.deepEqual(refs, ["Zod", "zod"]);
  assert.equal(piecesText(q.question), piecesText(entry.question), "the wording is the agreed one");
  assert.ok(prompts.termsPrompt("task").includes(prompts.KEEP_WORDING));
  assert.ok(prompts.termsRespondPrompt(1).includes(prompts.KEEP_WORDING));
});

test("the prompt that asks for the divided entries and termsValidation agree: an entry built as the prompt says passes", () => {
  const prompt = prompts.termsPrompt("task");
  for (const text of [prompts.QUESTION_TEXT_FORMAT, prompts.KEEP_WORDING]) assert.ok(prompt.includes(text));
  const validate = termsValidation<S.TermsWrite>([{ ...entry, default_answer: "Declare it" }]);
  assert.ok(Result.isSuccess(validate(terms())));
  // A moved block boundary is a changed wording, though every word is the same.
  const split = { ...dividedEntry(), context: [{ kind: "paragraph" as const, pieces: [{ text: "Claude Code, the coding agent,", ref: "", code: false }] }, { kind: "paragraph" as const, pieces: divide([{ text: " checks the input of a tool with Zod, a library, when the tool is called.", ref: "", code: false }]) }] };
  const moved = validate({ entries: [split] });
  assert.ok(Result.isFailure(moved));
  assert.deepEqual(moved.failure.error._tag, "QuestionInvalid");
  assert.equal(moved.failure.repair, prompts.questionRepairPrompt([{ where: "Q1", problems: [{ kind: "wordingChanged", subject: "context" }] }]));
});

test("property S6: any re-division of an agreed entry's words, with its refs resolving, is accepted; any changed word is not", () => {
  const validate = termsValidation<S.TermsWrite>([{ ...entry, default_answer: "Declare it" }]);
  const words = piecesText(entry.question);
  fc.assert(
    fc.property(fc.uniqueArray(fc.integer({ min: 1, max: words.length - 1 }), { maxLength: 6 }), fc.boolean(), (cuts, change) => {
      const at = [0, ...[...cuts].sort((a, b) => a - b), words.length];
      const pieces: Piece[] = at.slice(0, -1).map((a, i) => ({ text: words.slice(a, at[i + 1]), ref: i === 0 ? "z" : "", code: false }));
      const question = change ? [...pieces, { text: "!", ref: "", code: false }] : pieces;
      const result = validate({ entries: [{ ...dividedEntry(), question }] });
      return change ? Result.isFailure(result) : Result.isSuccess(result) && blocksText(entry.context).length > 0;
    }),
    { numRuns: 200 },
  );
});

test("S6: a second explanations reply that changes the wording halts with QuestionInvalid", async () => {
  const changed = { entries: [{ ...dividedEntry(), question: [{ text: "Should zod be added?", ref: "", code: false }], explanations: [] }] };
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: { questions: [entry] } }],
    terms: [{ output: changed }, { output: changed }],
    reviews: [{ issues: [] }],
    config: { questionPhase: true },
  });
  await runFails(layer, "QuestionInvalid", /Q1: the words or blocks of its field "question" differ from the agreed question/);
});

test("S6: the drafting conversation writes plain pieces only; a ref in the list gets the validation repair turn", async () => {
  const { questionListValidation } = await import("../src/subjects.ts");
  assert.match(prompts.questionListPrompt("task"), /Every piece is plain here: ref "" everywhere/);
  const withRef = { questions: [{ ...entry, question: [{ text: "Should ", ref: "", code: false }, { text: "zod", ref: "z", code: false }, { text: " be declared as a dependency?", ref: "", code: false }] }] };
  const result = questionListValidation<S.QuestionList>()(withRef);
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.repair, prompts.questionRepairPrompt([{ where: "Q1", problems: [{ kind: "unknownRef", subject: "z" }] }]));
  assert.ok(Result.isSuccess(questionListValidation<S.QuestionList>()({ questions: [entry] })));
});
