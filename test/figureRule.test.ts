// Issue #98: the rule that a question about a visual specification carries a picture per option, the format clause of
// a figure, the bound clause that keeps it, and the validation of a figure's data, written and tested together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIGURE_SVG_LIMIT_BYTES } from "../src/figure.ts";
import { piecesText } from "../src/pieces.ts";
import * as prompts from "../src/prompts.ts";
import { parseRelayedQuestion, type Question, questionProblems } from "../src/question.ts";

const plain = (text: string) => [{ text, ref: "", code: false }];
const SVG = '<svg viewBox="0 0 4 3"><rect width="4" height="1"/></svg>';
const question = (figures: readonly ({ svg: string; alt: string } | null)[]): Question => ({
  context: [{ kind: "paragraph", pieces: plain("The decision page stacks its regions in a window 800 pixels high.") }],
  history: [],
  question: plain("Which division do you want?"),
  explanations: [],
  options: figures.map((figure, i) => ({ label: plain(`Division ${i + 1}`), description: plain("It gives the columns more room."), figure })),
});

test("pictureForVisual's rule reaches the writers and its criterion the reviewers, from one entry", () => {
  const entry = prompts.QUESTION_RULES.find((r) => r.id === "pictureForVisual");
  assert.ok(entry, "the rule exists");
  assert.ok(prompts.questionWritingRules().includes(entry.rule));
  assert.ok(prompts.questionReviewCriteria().includes(entry.criterion));
  for (const words of ["figure", "visual", "proportions", "layout", "differs visually"]) assert.ok(entry.rule.includes(words), words);
  const ids = prompts.QUESTION_RULES.map((r) => r.id);
  assert.equal(ids.indexOf("pictureForVisual"), ids.indexOf("readerConsequence") + 1);
});

test("the figure clause is in the format the writers read, and KEEP_FIGURES is a bound clause", () => {
  const clause = prompts.QUESTION_FORMAT.find((c) => c.id === "figure");
  assert.ok(clause && clause.kind === "data");
  assert.ok(prompts.QUESTION_TEXT_FORMAT.includes(clause.text));
  for (const words of ["svg", "alt", "viewBox", "64 KiB", "script", "foreignObject"]) assert.ok(clause.text.includes(words), words);
  assert.match(prompts.KEEP_FIGURES, /figure/u);
});

test("a figure's problems are named by option and cite the figure clause in the repair prompt", () => {
  assert.deepEqual(questionProblems(question([{ svg: SVG, alt: "A wide band" }, null])), []);
  assert.deepEqual(questionProblems(question([{ svg: SVG, alt: " " }, null])), [{ kind: "figureAltBlank", subject: "option 1" }]);
  assert.deepEqual(questionProblems(question([null, { svg: "<div></div>", alt: "x" }])), [{ kind: "figureNotSvg", subject: "option 2" }]);
  const big = `<svg>${"x".repeat(FIGURE_SVG_LIMIT_BYTES)}</svg>`;
  const tooLarge = questionProblems(question([{ svg: big, alt: "x" }]));
  assert.deepEqual(tooLarge.map((p) => [p.kind, p.subject]), [["figureTooLarge", "option 1"]]);
  assert.match(prompts.questionProblemText(tooLarge[0]!), new RegExp(`${big.length}.*${FIGURE_SVG_LIMIT_BYTES}`, "u"));
  const clause = prompts.QUESTION_FORMAT.find((c) => c.id === "figure")!.text;
  for (const problem of [{ kind: "figureAltBlank", subject: "option 1" }, { kind: "figureTooLarge", subject: "option 1", bytes: 70_000 }, { kind: "figureNotSvg", subject: "option 1" }] as const) {
    assert.ok(prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [problem] }]).includes(clause), problem.kind);
  }
  assert.ok(prompts.questionRepairPrompt([{ where: "Q1", problems: [{ kind: "figureChanged", subject: "option 1" }] }]).includes(prompts.KEEP_FIGURES));
});

test("RELAYED_EXAMPLE parses as a relayed question, each option with no picture, and RELAYED_SHAPE names figure", () => {
  const options = prompts.RELAYED_EXAMPLE.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
  const parsed = parseRelayedQuestion(JSON.stringify(prompts.RELAYED_EXAMPLE), options);
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed!.options.map((o) => o.figure), [null, null]);
  assert.match(prompts.RELAYED_SHAPE, /\bfigure\b/u);
});

test("the prompts that list an option's fields name its figure", () => {
  assert.match(prompts.TERMS_ENTRY_FIELDS, /figure/u);
});

// Work review 3 of issue #98 (W3-R1-1), plan review 4 (P4-R1-1): every writer prompt that states the question format
// itself carries the figure clause. questionListPrompt composes its format from clauses; every other prompt is selected
// here by its containing QUESTION_TEXT_FORMAT whole, so no hand-kept list decides which are covered. Continuation
// prompts state no format and inherit it from their session's opening prompt.
test("every prompt that states the question format carries the figure clause", async () => {
  const { TEST_ROOT, EARLIER_ROOT } = await import("./helpers.ts");
  const { NO_STEP_CHECKS } = await import("../src/schema.ts");
  const clause = prompts.QUESTION_FORMAT.find((c) => c.id === "figure")!.text;
  assert.ok(prompts.questionListPrompt("t").includes(clause), "questionListPrompt lacks the figure clause");
  const request = { origin: { kind: "relayed" as const }, decision: null, question: plain("Which?"), options: [], details: [], explanations: [], facts: "", fallback: [], history: [] };
  const candidates: Readonly<Record<string, string>> = {
    QUESTION_OPTIONS_RULE: prompts.QUESTION_OPTIONS_RULE,
    RELAYED_SHAPE: prompts.RELAYED_SHAPE,
    initialPlanPrompt: prompts.initialPlanPrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS),
    earlierPlanPrompt: prompts.earlierPlanPrompt(TEST_ROOT, "t", true, EARLIER_ROOT, NO_STEP_CHECKS),
    planRespondPrompt: prompts.planRespondPrompt(TEST_ROOT, 1, 1, NO_STEP_CHECKS),
    questionApplyDecisionsPrompt: prompts.questionApplyDecisionsPrompt(TEST_ROOT),
    interviewOpenPrompt: prompts.interviewOpenPrompt(TEST_ROOT),
    interviewGapsPrompt: prompts.interviewGapsPrompt(TEST_ROOT, "r.json", [{ id: "G-R1-1", kind: "unresolved" }]),
    clarificationOpenPrompt: prompts.clarificationOpenPrompt(TEST_ROOT),
    termsPrompt: prompts.termsPrompt(TEST_ROOT, "t"),
    termsOnRequestPrompt: prompts.termsOnRequestPrompt(TEST_ROOT, "t", "Q1"),
    executePrompt: prompts.executePrompt(TEST_ROOT, "t", true, NO_STEP_CHECKS),
    contextPrompt: prompts.contextPrompt("t", request),
  };
  const stating = Object.entries(candidates).filter(([, text]) => text.includes(prompts.QUESTION_TEXT_FORMAT));
  assert.ok(stating.length >= 4, `only ${stating.map(([n]) => n).join(", ")} state the format`);
  for (const [name, text] of stating) assert.ok(text.includes(clause), name);
});
