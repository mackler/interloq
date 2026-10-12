// Issue #133, decision Q1 (S2): a question's history is blocks of pieces like its context, so every mechanical check of
// the question covers it, the terms keep its wording, and the three validation adapters (the question list, the terms
// and the interview turn) hold it to the rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { turnValidation } from "../src/conversation.ts";
import { type Piece, type Question, partsOf, questionProblems, suppliedOf } from "../src/question.ts";
import type * as S from "../src/schema.ts";
import { questionListValidation, termsValidation } from "../src/subjects.ts";
import { opt, para, plain, questionEntry, term } from "./helpers.ts";

const code = (text: string, ref = ""): Piece => ({ text, ref, code: true });
const zod = { id: "z", term: "zod", senses: ["A library that checks that data has the expected shape."] };
const good: Question = {
  context: [{ kind: "paragraph", pieces: [...plain("Claude Code, the coding agent, checks a tool's input with "), term("zod", "z"), ...plain(".")] }],
  history: para("You decided on 9 Oct 2026 to keep the library out of package.json."),
  question: plain("Should the library be declared as a dependency?"),
  explanations: [zod],
  options: [opt("Declare it", "Add it to package.json."), opt("Leave it", "Keep it the SDK's.")],
};
const kinds = (q: Question) => questionProblems(q).map((p) => p.kind);
const withHistory = (pieces: readonly Piece[]): Question => ({ ...good, history: [{ kind: "paragraph", pieces }] });

test("a problem in the history is reported as in the context: an unknown ref, a ref on code, a multi-line code piece, adjacent code pieces, a bare number", () => {
  assert.deepEqual(kinds(good), []);
  assert.deepEqual(kinds(withHistory([...plain("You chose "), term("this", "missing"), ...plain(".")])), ["unknownRef"]);
  assert.deepEqual(kinds(withHistory([...plain("You ran "), code("npm ci", "z"), ...plain(".")])), ["refOnCode"]);
  assert.deepEqual(kinds(withHistory([...plain("You ran "), code("a\nb"), ...plain(".")])), ["multiLineCode"]);
  assert.deepEqual(kinds(withHistory([...plain("You ran "), code("npm"), code("ci"), ...plain(".")])), ["adjacentCode"]);
  assert.deepEqual(kinds(withHistory(plain("See #53."))), ["bareNumber"]);
  assert.deepEqual(kinds({ ...good, history: [{ kind: "list", items: [{ level: 0, pieces: plain("Later (#14).") }] }] }), ["bareNumber"]);
});

test("an explanation referred to only from the history is used, and an empty history is no problem", () => {
  const onlyHistory: Question = { ...good, context: para("Claude Code, the coding agent, checks a tool's input."), history: [{ kind: "paragraph", pieces: [...plain("You chose "), term("zod", "z"), ...plain(" on 9 Oct 2026.")] }] };
  assert.deepEqual(kinds(onlyHistory), []);
  assert.deepEqual(kinds({ ...good, history: [] }), []);
  assert.deepEqual(kinds({ ...good, history: para("  ") }), []);
});

test("a supplied reference in the history is supplied in the part history, and stands only there", () => {
  const withCodeRef = withHistory([...plain("You set "), code("overwrite", "z"), ...plain(".")]);
  assert.ok(partsOf(withCodeRef).some((p) => p.part === "history"));
  const supplied = suppliedOf(withCodeRef);
  assert.deepEqual(supplied.map((s) => s.part), ["history"]);
  assert.deepEqual(questionProblems(withCodeRef, supplied), []);
  // The same reference supplied for the context does not allow it in the history.
  assert.deepEqual(questionProblems(withCodeRef, supplied.map((s) => ({ ...s, part: "context" }))).map((p) => p.kind), ["refOnCode"]);
});

const sentence = fc.stringMatching(/^[A-Za-z][a-z ]{0,20}\.$/u);
test("property: moving a paragraph block from the context to the history adds no problem while the context stays non-blank", () => {
  fc.assert(
    fc.property(fc.array(sentence, { minLength: 2, maxLength: 5 }), fc.nat(), (texts, at) => {
      const context = para(...texts);
      const q: Question = { ...good, context: [...good.context, ...context], history: [] };
      const i = at % context.length;
      const moved: Question = { ...q, context: q.context.filter((_, k) => k !== i + good.context.length), history: [context[i]] };
      return questionProblems(moved).length <= questionProblems(q).length && questionProblems(moved).every((p) => questionProblems(q).some((r) => r.kind === p.kind));
    }),
    { numRuns: 100 },
  );
});

// ---- the three adapters ------------------------------------------------------------------------------------------------

const entry: S.QuestionEntry = { ...questionEntry("Q1", "Should the library be declared as a dependency?", [["Declare it", "add it"], ["Leave it", "keep it"]], { context: "Claude Code, the coding agent, checks a tool's input with zod.", reason: "package.json does not list it" }), history: para("You decided on 9 Oct 2026 to keep zod out.") };

test("questionListValidation rejects an entry whose only defect is in its history", () => {
  assert.ok(Result.isSuccess(questionListValidation<S.QuestionList>()({ questions: [entry] })));
  const failed = questionListValidation<S.QuestionList>()({ questions: [{ ...entry, history: para("See #53.") }] });
  assert.ok(Result.isFailure(failed));
  assert.ok(failed.failure.error._tag === "QuestionInvalid" && failed.failure.error.questions.some((q) => q.problems.some((p) => p.kind === "bareNumber")));
});

const divide = (pieces: readonly Piece[]): readonly Piece[] =>
  pieces.flatMap((p) => p.text.split(/(zod)/).filter((t) => t !== "").map((t) => (t === "zod" ? term(t, "z") : { text: t, ref: "", code: false })));
const dividedOf = (e: S.QuestionEntry): S.TermsEntry => ({
  id: e.id,
  explanations: [zod],
  context: e.context.map((b) => (b.kind === "paragraph" ? { ...b, pieces: divide(b.pieces) } : b)),
  history: e.history.map((b) => (b.kind === "paragraph" ? { ...b, pieces: divide(b.pieces) } : b)),
  question: e.question,
  reason: e.reason,
  proposed_answers: e.proposed_answers,
});

test("termsValidation keeps the history's wording: a re-division passes, other words or blocks are wordingChanged, a defect is found", () => {
  const validate = termsValidation<S.TermsWrite>([entry]);
  assert.ok(Result.isSuccess(validate({ entries: [dividedOf(entry)] })));
  const words = validate({ entries: [{ ...dividedOf(entry), history: para("You decided on 10 Oct 2026 to keep zod out.") }] });
  assert.ok(Result.isFailure(words));
  assert.ok(words.failure.error._tag === "QuestionInvalid" && words.failure.error.questions[0].problems.some((p) => p.kind === "wordingChanged" && p.subject === "history"));
  const blocks = validate({ entries: [{ ...dividedOf(entry), history: [{ kind: "list", items: [{ level: 0, pieces: plain("You decided on 9 Oct 2026 to keep zod out.") }] }] }] });
  assert.ok(Result.isFailure(blocks));
  const withDefect = { ...entry, history: [{ kind: "paragraph" as const, pieces: [...plain("You ran "), code("a\nb"), ...plain(".")] }] };
  const defect = termsValidation<S.TermsWrite>([withDefect])({ entries: [{ ...dividedOf(withDefect), explanations: [], context: withDefect.context, history: withDefect.history }] });
  assert.ok(Result.isFailure(defect));
  assert.ok(defect.failure.error._tag === "QuestionInvalid" && defect.failure.error.questions[0].problems.some((p) => p.kind === "multiLineCode"));
});

const current = (history: readonly S.Block[], context = para("The service, a web server, listens on a port.")): S.InterviewTurn["current_question"] => ({
  id: "F1",
  context,
  history,
  text: plain("Which port do you want?"),
  explanations: [],
  options: [],
});
const turnOf = (c: S.InterviewTurn["current_question"]): S.InterviewTurn => ({ message_to_user: "m", current_question: c, asked_ids: ["F1"], answered_ids: [], complete: false, summary: "" });

test("turnValidation rejects a current question whose only defect is in its history, and counts an explanation the history alone uses", () => {
  assert.ok(Result.isSuccess(turnValidation([], null)(turnOf(current([])))));
  const failed = turnValidation([], null)(turnOf(current(para("See #53."))));
  assert.ok(Result.isFailure(failed));
  const used = { ...current([{ kind: "paragraph", pieces: [...plain("You chose "), term("port 80", "p"), ...plain(" before.")] }]), explanations: [{ id: "p", term: "port 80", senses: ["The usual port of a web server."] }] };
  assert.ok(Result.isSuccess(turnValidation([], null)(turnOf(used))));
});

// ---- S3: the prompts ask for the history apart, and Codex's criteria check the split ----------------------------------

test("QUESTION_RULES: historyApart right after contextBearsOnChoice, its rule and criterion in the writers' and the reviewers' texts", async () => {
  const prompts = await import("../src/prompts.ts");
  const ids = prompts.QUESTION_RULES.map((r) => r.id);
  assert.equal(ids.indexOf("historyApart"), ids.indexOf("contextBearsOnChoice") + 1);
  const rule = prompts.QUESTION_RULES.find((r) => r.id === "historyApart");
  assert.ok(rule !== undefined);
  assert.match(rule.rule, /history \(the field `history`\)/);
  assert.match(rule.rule, /earlier decisions with their dates/);
  assert.match(rule.rule, /empty when there is none/);
  assert.match(rule.rule, /[Nn]either repeats the other/);
  assert.match(rule.rule, /applies to the context, not to the history/);
  assert.match(rule.criterion, /history .*in the context/);
  assert.match(rule.criterion, /background .*in the history/);
  assert.match(rule.criterion, /repeats the other/);
  assert.ok(prompts.questionWritingRules().includes(rule.rule));
  assert.ok(prompts.questionReviewCriteria().includes(rule.criterion));
  assert.match(prompts.QUESTION_FORMAT.find((c) => c.id === "blocks")?.text ?? "", /^Write a context, a history \(and any details\) as a list of blocks/);
});

test("the seam: RELAYED_SHAPE names the history, and its example, with a history, decodes as a RelayedQuestion and passes validateQuestion", async () => {
  const prompts = await import("../src/prompts.ts");
  const { RelayedQuestion, validateQuestion, parseRelayedQuestion } = await import("../src/question.ts");
  const { Schema } = await import("effect");
  const { piecesText } = await import("../src/pieces.ts");
  assert.match(prompts.RELAYED_SHAPE, /with the fields context, history, question, explanations and options/);
  assert.ok(prompts.RELAYED_EXAMPLE.history.length > 0);
  const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RelayedQuestion))(prompts.relayedQuestionText(prompts.RELAYED_EXAMPLE));
  assert.ok(Result.isSuccess(validateQuestion(decoded)));
  const options = prompts.RELAYED_EXAMPLE.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
  assert.deepEqual(parseRelayedQuestion(prompts.relayedQuestionText(prompts.RELAYED_EXAMPLE), options)?.history, prompts.RELAYED_EXAMPLE.history);
});

test("every prompt that asks an agent for a question asks for its history beside its context", async () => {
  const prompts = await import("../src/prompts.ts");
  const { TEST_ROOT } = await import("./helpers.ts");
  const request = { origin: { kind: "relayed" as const }, decision: null, question: plain("Which?"), options: [], details: [], explanations: [], facts: "" };
  const asking: Record<string, string> = {
    questionList: prompts.questionListPrompt("task"),
    terms: prompts.termsPrompt(TEST_ROOT, "task"),
    interview: prompts.interviewOpenPrompt(TEST_ROOT),
    plannerQuestions: prompts.QUESTION_OPTIONS_RULE,
    relayed: prompts.RELAYED_SHAPE,
    context: prompts.contextPrompt("task", request),
  };
  for (const [name, text] of Object.entries(asking)) assert.match(text, /\bhistory\b/, name);
  assert.match(prompts.questionListPrompt("task"), /history: what happened before that led to the question/);
  assert.match(prompts.QUESTION_OPTIONS_RULE, /has a context, a history, a question, explanations and options/);
  assert.match(prompts.termsPrompt(TEST_ROOT, "task"), /its context, history, question, reason and proposed_answers/);
  assert.match(prompts.interviewOpenPrompt(TEST_ROOT), /give its context, its history, its text/);
  const context = prompts.contextPrompt("task", request);
  assert.match(context, /Return in history /);
  assert.match(context, /history may be empty/);
});
