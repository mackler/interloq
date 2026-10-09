// S3 of the task of issue #36: validateQuestion checks a question's text as data: every ref names an explanation, every
// explanation is referred to, none blank, no ref on a literal value, and the mechanical part of QUESTION_RULES; the
// repair prompt cites the rule or format clause it found broken, from the same arrays the writing prompts are rendered
// from (rules for changes: a prompt and its validation together). Nothing reads Markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { decodeRunError, haltMessage } from "../src/errors.ts";
import { piecesMarkdown, piecesText } from "../src/pieces.ts";
import * as prompts from "../src/prompts.ts";
import { type Piece, type Question, questionProblems, sensesOf, type SuppliedRef, validateQuestion, validateQuestions } from "../src/question.ts";
import type { Block, Explanation } from "../src/schema.ts";
import { opt, para, plain, readBack, readBlocks, term , TEST_ROOT } from "./helpers.ts";

const zod: Explanation = { id: "t1", term: "zod", senses: ["A library that checks that data has the expected shape."] };
const good: Question = {
  context: [
    {
      kind: "paragraph",
      pieces: [...plain("Interloq, the orchestrator, runs Claude Code, a coding agent, when a phase begins; "), term("Zod", "t1"), ...plain(", a validation library, checks what it returns.")],
    },
  ],
  question: [...plain("The input of a tool is described with "), term("zod", "t1"), ...plain(". Should it be declared as a dependency?")],
  explanations: [zod],
  options: [
    { label: plain("Declare it"), description: [...plain("Add "), term("zod", "t1"), ...plain(" to package.json.")] },
    opt("Leave it", "Keep it as a dependency of the SDK only."),
  ],
};
const kinds = (q: Question, supplied: readonly SuppliedRef[] = []) => questionProblems(q, supplied).map((p) => p.kind);

test("a question that keeps every mechanical rule passes, a plural and a capitalized word referring to one explanation", () => {
  assert.deepEqual(questionProblems(good), []);
  assert.ok(Result.isSuccess(validateQuestion(good)));
  const plural: Question = { ...good, question: [...plain("Which "), term("Execution calls", "e"), ...plain(" may resume an "), term("execution call", "e"), ...plain("?")], explanations: [...good.explanations, { id: "e", term: "execution call", senses: ["The part of the run in which Claude Code carries out the plan."] }] };
  assert.deepEqual(questionProblems(plural), []);
});

test("an empty context, a question that does not end with its interrogative sentence, and a bare number are found", () => {
  assert.deepEqual(kinds({ ...good, context: para("  ") }), ["blankContext"]);
  assert.deepEqual(kinds({ ...good, context: [] }), ["blankContext"]);
  assert.deepEqual(kinds({ ...good, question: [term("zod", "t1"), ...plain(" is used. It is used by the SDK.")] }), ["notLast"]);
  assert.deepEqual(kinds({ ...good, context: [...good.context, ...para("See #53.")] }), ["bareNumber"]);
  assert.deepEqual(questionProblems({ ...good, options: [...good.options, opt("Later (#14, #6)")] }).map((p) => p.subject), ["#14", "#6"]);
});

test("a number with its kind before it is not bare, in a list too", () => {
  for (const text of ["Issue #6 says so.", "Issues #6, #33 and #28 say so.", "As issues #14 or #6 say."]) assert.deepEqual(kinds({ ...good, context: [...good.context, ...para(text)] }), [], text);
});

// W1-R1-2 (S23): a literal value is shown exactly and is no bare number; the check reads the plain pieces alone.
test("bareNumber reads plain pieces only: a code piece is no bare number, and it separates the words around it", () => {
  const code = (text: string): Piece => ({ text, ref: "", code: true });
  assert.deepEqual(kinds({ ...good, options: [...good.options, { label: [code("#123456")], description: [] }] }), []);
  assert.deepEqual(kinds({ ...good, context: [...good.context, { kind: "paragraph", pieces: [...plain("The color "), code("#53")] }] }), []);
  assert.deepEqual(kinds({ ...good, question: [...plain("Keep "), code("#53"), ...plain("?")] }), []);
  assert.deepEqual(kinds({ ...good, context: [...good.context, ...para("Also see #53.")] }), ["bareNumber"]);
  // P2-R1-3: a code piece between the kind and the number separates them.
  assert.deepEqual(questionProblems({ ...good, context: [...good.context, { kind: "paragraph", pieces: [...plain("Issue "), code("x"), ...plain("#53")] }] }).map((p) => [p.kind, p.subject]), [["bareNumber", "#53"]]);
  // The details' plain pieces are read too; a code block is not.
  assert.deepEqual(kinds({ ...good, details: para("As in #53.") }), ["bareNumber"]);
  assert.deepEqual(kinds({ ...good, details: [{ kind: "code", text: "#53" }] }), []);
});

test("property: prepending or appending a code piece of any text to a sequence of pieces never adds bareNumber", () => {
  const code = (text: string): Piece => ({ text, ref: "", code: true });
  fc.assert(
    fc.property(fc.string({ maxLength: 12 }), fc.boolean(), fc.constantFrom("question", "label", "description", "paragraph", "item"), (text, before, where) => {
      const add = (ps: readonly Piece[]): readonly Piece[] => (before ? [code(text), ...ps] : [...ps, code(text)]);
      const q: Question =
        where === "question"
          ? { ...good, question: before ? add(good.question) : [code(text), ...good.question] }
          : where === "label"
            ? { ...good, options: [{ ...good.options[0], label: add(good.options[0].label) }, good.options[1]] }
            : where === "description"
              ? { ...good, options: [{ ...good.options[0], description: add(good.options[0].description) }, good.options[1]] }
              : where === "paragraph"
                ? { ...good, context: [{ kind: "paragraph", pieces: add((good.context[0] as { pieces: readonly Piece[] }).pieces) }] }
                : { ...good, context: [...good.context, { kind: "list", items: [{ level: 0, pieces: add(plain("an item")) }] }] };
      return questionProblems(q).every((p) => p.kind !== "bareNumber");
    }),
    { numRuns: 300 },
  );
});

test("the data clauses: dangling and unused refs, duplicate ids, blank terms, explanations and referring pieces", () => {
  assert.deepEqual(kinds({ ...good, question: [...plain("Is "), term("zod", "t2"), ...plain(" needed?")] }), ["unknownRef"]);
  assert.deepEqual(kinds({ ...good, explanations: [...good.explanations, { id: "t9", term: "SDK", senses: ["A kit."] }] }), ["unusedExplanation"]);
  assert.deepEqual(kinds({ ...good, explanations: [...good.explanations, { ...zod }] }), ["duplicateExplanation"]);
  assert.deepEqual(kinds({ ...good, explanations: [{ ...zod, term: " " }] }), ["blankTerm"]);
  assert.deepEqual(kinds({ ...good, explanations: [{ ...zod, senses: ["  "] }] }), ["blankSense"]);
  assert.deepEqual(kinds({ ...good, question: [term(" ", "t1"), ...good.question] }), ["blankTermPiece"]);
});

test("a ref in any part counts: the details, a list item and an option's label", () => {
  const onlyIn = (q: Question) => kinds({ ...q, explanations: [zod] });
  const bare: Question = { ...good, context: para("Interloq asks this."), question: plain("Should it be declared?"), options: [opt("A"), opt("B")] };
  assert.deepEqual(onlyIn(bare), ["unusedExplanation"]);
  assert.deepEqual(onlyIn({ ...bare, details: [{ kind: "list", items: [{ level: 1, pieces: [term("zod", "t1")] }] }] }), []);
  assert.deepEqual(onlyIn({ ...bare, options: [{ label: [term("zod", "t1")], description: [] }, opt("B")] }), []);
});

test("a literal value never refers to an explanation, except a code piece the program supplied with its ref", () => {
  const code: Piece = { text: "max_tokens", ref: "t1", code: true };
  const withCode: Question = { ...good, details: [{ kind: "list", items: [{ level: 0, pieces: [...plain("The setting "), code] }] }] };
  assert.deepEqual(kinds(withCode), ["refOnCode"]);
  assert.deepEqual(kinds(withCode, [{ part: "details", piece: code }]), []);
  assert.deepEqual(kinds(withCode, [{ part: "details", piece: { ...code, ref: "t2" } }]), ["refOnCode"], "the supplied piece is keyed by its words and its ref");
  // P5-R1-1: in its own part only, and as many times as it was supplied there.
  assert.deepEqual(kinds(withCode, [{ part: "question", piece: code }]), ["refOnCode"], "supplied in another part");
  const twice: Question = { ...withCode, details: [{ kind: "list", items: [{ level: 0, pieces: [...plain("The setting "), code, ...plain(": "), code] }] }] };
  assert.deepEqual(kinds(twice, [{ part: "details", piece: code }]), ["refOnCode"], "copied beside the supplied occurrence");
  assert.deepEqual(kinds(twice, [{ part: "details", piece: code }, { part: "details", piece: code }]), []);
});

test("every problem kind names a rule or clause, and the repair prompt cites its text verbatim", () => {
  const textOf = (id: string) =>
    prompts.QUESTION_RULES.find((r) => r.id === id)?.rule ??
    prompts.QUESTION_FORMAT.find((c) => c.id === id)?.text ??
    ({ keepWording: prompts.KEEP_WORDING, keepLiterals: prompts.KEEP_LITERALS, keepOptions: prompts.KEEP_OPTIONS, keepSuppliedRefs: prompts.KEEP_SUPPLIED_REFS } as Record<string, string>)[id];
  for (const kind of prompts.QUESTION_PROBLEM_KINDS) {
    const rule = textOf(prompts.QUESTION_PROBLEM_RULE[kind]);
    assert.ok(rule !== undefined && rule !== "", kind);
    const repair = prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [{ kind, subject: "zod" }] }]);
    assert.ok(repair.includes(rule), kind);
    assert.ok(repair.includes(prompts.questionProblemText({ kind, subject: "zod" })), kind);
  }
});

test("validateQuestions names each failing question and fails with QuestionInvalid, which decodes and halts", () => {
  const result = validateQuestions([
    { where: "questions_for_user 1", question: good },
    { where: "questions_for_user 2", question: { ...good, explanations: [{ ...zod, senses: [""] }] } },
  ]);
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure.questions, [{ where: "questions_for_user 2", problems: [{ kind: "blankSense", subject: 'sense 1 of the term "zod"' }] }]);
  assert.equal(decodeRunError({ ...result.failure })?._tag, "QuestionInvalid");
  assert.match(haltMessage(result.failure) ?? "", /^HALTED: a question for the user is invalid: questions_for_user 2: sense 1 of the term "zod" is empty\./);
});

test("questionsValidation passes a reply whose questions keep the rules, and fails another with the repair prompt of its problems", async () => {
  const { questionsValidation } = await import("../src/review.ts");
  const validate = questionsValidation((qs: readonly Question[]) => qs.map((question, i) => ({ where: `questions_for_user ${i + 1}`, question })));
  const ok = validate([good]);
  assert.ok(Result.isSuccess(ok));
  assert.deepEqual(ok.success, { value: [good], notes: [] });
  const bad = validate([{ ...good, context: [] }]);
  assert.ok(Result.isFailure(bad));
  assert.equal(bad.failure.error._tag, "QuestionInvalid");
  assert.equal(bad.failure.repair, prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [{ kind: "blankContext", subject: "" }] }]));
});

// S4: the format is one statement; the prompt that states it and the validation that checks its data clauses agree.
test("S4: a question written exactly as QUESTION_TEXT_FORMAT describes it passes, and each data clause's violation is rejected", () => {
  for (const clause of prompts.QUESTION_FORMAT) assert.ok(prompts.QUESTION_TEXT_FORMAT.includes(clause.text), clause.id);
  // The format's own example: a plural and a capitalized form, two pieces that refer to one explanation.
  assert.ok(prompts.QUESTION_TEXT_FORMAT.includes('"execution calls" and "Execution call" are two pieces that refer to one explanation'));
  const violations: Readonly<Record<string, Question>> = {
    refPiece: { ...good, question: [...good.question.slice(0, -1), term("", "t1"), ...good.question.slice(-1)] },
    explanations: { ...good, explanations: [...good.explanations, { id: "t2", term: "SDK", senses: ["A kit."] }] },
    code: { ...good, context: [...good.context, { kind: "paragraph", pieces: [{ text: "npm", ref: "t1", code: true }] }] },
  };
  for (const [id, q] of Object.entries(violations)) {
    const found = questionProblems(q).map((p) => prompts.QUESTION_PROBLEM_RULE[p.kind]);
    assert.ok(found.includes(id), `${id}: ${found.join(", ")}`);
  }
});

test("S4: the prose clauses reach the writers and the reviewers from the one constant", () => {
  for (const clause of prompts.QUESTION_FORMAT.filter((c) => c.kind === "prose")) {
    assert.ok(prompts.QUESTION_TEXT_FORMAT.includes(clause.text), clause.id);
    assert.ok(prompts.questionReviewCriteria().includes(clause.criterion), clause.id);
    assert.ok(prompts.QUESTION_OPTIONS_RULE.includes(clause.text), clause.id);
  }
  for (const clause of prompts.QUESTION_FORMAT.filter((c) => c.kind === "data")) assert.equal(clause.criterion, "", `${clause.id} is checked by the program, not asked of the reviewer`);
});

// S37 (the developer's decision of 4 Oct 2026): the clause that tells the writers a plain piece carries no code, the
// criterion the reviewers apply, and the writing of a plain piece in conversation.md agree.
test("S37: a plain piece carries emphasis and links only: the writers, the reviewers and piecesMarkdown agree", () => {
  const inline = prompts.QUESTION_FORMAT.find((c) => c.id === "inline");
  assert.ok(inline !== undefined);
  for (const words of ["emphasis and links only, never code", "shown as a backtick character", "its own code piece"]) assert.ok(inline.text.includes(words), words);
  assert.ok(inline.criterion.includes("rather than as its own code piece"), inline.criterion);
  for (const writer of [prompts.QUESTION_TEXT_FORMAT, prompts.QUESTION_OPTIONS_RULE, prompts.questionListPrompt("t")]) assert.ok(writer.includes(inline.text));
  assert.ok(prompts.questionReviewCriteria().includes(inline.criterion));
  for (const clause of prompts.QUESTION_FORMAT) assert.ok(!/inline code/i.test(`${clause.text} ${clause.criterion}`), clause.id);
  // What the clause tells the writer is what the program does with the reply: a value between backticks in a plain
  // piece is not code, the same value as a code piece is.
  assert.deepEqual(readBack(piecesMarkdown(plain("run `npm test` now"))).code, []);
  assert.deepEqual(readBack(piecesMarkdown([...plain("run "), { text: "npm test", ref: "", code: true }, ...plain(" now")])).code, ["npm test"]);
});

// Issue #94: a plain piece never opens a block. The clause that tells the writers so names every opener of
// PLAIN_BLOCK_OPENERS, the reviewers' criterion names the blocks, and piecesMarkdown writes a plain piece beginning with
// each opener as one paragraph of exactly its text.
test("issue #94: a plain piece never opens a block: the writers, the reviewers and piecesMarkdown agree", () => {
  const inline = prompts.QUESTION_FORMAT.find((c) => c.id === "inline");
  assert.ok(inline !== undefined);
  assert.ok(inline.text.includes("A plain piece never opens a block"), inline.text);
  for (const opener of prompts.PLAIN_BLOCK_OPENERS) assert.ok(inline.text.includes(prompts.blockOpenerName(opener)), JSON.stringify(opener));
  assert.match(inline.criterion, /relies on Markdown that opens a heading, a list, a quotation or a code block/);
  for (const opener of prompts.PLAIN_BLOCK_OPENERS) {
    const text = `${opener} x`;
    assert.deepEqual(readBlocks(piecesMarkdown(plain(text))), { types: ["paragraph"], text }, JSON.stringify(opener));
  }
});

// ---- properties (issue #66) ----------------------------------------------------------------------------------------

const word = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() !== "" && !s.includes("#"));
const arbPiece = (refs: readonly string[]): fc.Arbitrary<Piece> =>
  fc.oneof(
    word.map((text) => ({ text, ref: "", code: false })),
    word.map((text) => ({ text, ref: "", code: true })),
    ...(refs.length === 0 ? [] : [fc.tuple(word, fc.constantFrom(...refs)).map(([text, ref]) => ({ text, ref, code: false }))]),
  );
const arbBlock = (refs: readonly string[]): fc.Arbitrary<Block> =>
  fc.oneof(
    fc.array(arbPiece(refs), { minLength: 1, maxLength: 4 }).map((pieces) => ({ kind: "paragraph" as const, pieces })),
    fc.array(fc.record({ level: fc.nat(3), pieces: fc.array(arbPiece(refs), { maxLength: 3 }) }), { maxLength: 3 }).map((items) => ({ kind: "list" as const, items })),
    word.map((text) => ({ kind: "code" as const, text })),
  );
/** A question whose refs all resolve, every explanation used, nothing blank: the valid half of the data clauses. */
const arbValid: fc.Arbitrary<Question> = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { maxLength: 4 }).chain((ids) =>
  fc.record({
    context: fc.tuple(word, fc.array(arbBlock(ids), { maxLength: 3 })).map(([w, rest]) => [{ kind: "paragraph" as const, pieces: [{ text: w, ref: "", code: false }] }, ...rest]),
    question: fc.array(arbPiece(ids), { maxLength: 4 }).map((ps) => [...ps, ...ids.map((ref) => ({ text: `w${ref}`, ref, code: false })), { text: "?", ref: "", code: false }]),
    // Issue #112: one to three senses per explanation, so that the properties over valid questions cover several senses.
    explanations: fc.constant(ids.map((id) => ({ id, term: `term ${id}`, senses: Array.from({ length: 1 + (id.charCodeAt(0) % 3) }, (_, k) => `explains ${id}, sense ${k + 1}`) }))),
    options: fc.array(fc.record({ label: fc.array(arbPiece(ids), { maxLength: 2 }), description: fc.array(arbPiece(ids), { maxLength: 2 }) }), { maxLength: 3 }),
  }),
);
const REFERENCE_KINDS = ["unknownRef", "unusedExplanation", "duplicateExplanation", "blankTerm", "blankExplanation", "blankTermPiece", "refOnCode"];

test("property: the validation is total, and a question keeping the data clauses has no reference problem", () => {
  fc.assert(
    fc.property(arbValid, (q) => questionProblems(q).every((p) => !REFERENCE_KINDS.includes(p.kind))),
    { numRuns: 200 },
  );
});

test("property: removing a referred explanation always yields unknownRef; adding an unused one always yields unusedExplanation", () => {
  fc.assert(
    fc.property(arbValid, (q) => {
      const removed = q.explanations.length === 0 || questionProblems({ ...q, explanations: q.explanations.slice(1) }).some((p) => p.kind === "unknownRef" && p.subject === q.explanations[0].id);
      const added = questionProblems({ ...q, explanations: [...q.explanations, { id: "unused", term: "x", senses: ["y"] }] }).some((p) => p.kind === "unusedExplanation" && p.subject === "x");
      return removed && added;
    }),
    { numRuns: 200 },
  );
});

test("property: re-dividing a question's plain pieces keeps its words and its problems", () => {
  const split = (ps: readonly Piece[]): readonly Piece[] => ps.flatMap((p) => (p.ref === "" && !p.code && p.text.length > 1 ? [{ ...p, text: p.text.slice(0, 1) }, { ...p, text: p.text.slice(1) }] : [p]));
  fc.assert(
    fc.property(arbValid, (q) => {
      const again = { ...q, question: split(q.question) };
      return piecesText(again.question) === piecesText(q.question) && JSON.stringify(questionProblems(again)) === JSON.stringify(questionProblems(q));
    }),
    { numRuns: 200 },
  );
});

// ---- the relayed question (S8; behavior 4) -------------------------------------------------------------------------

test("S8: executePrompt states the relayed shape with the rules, and parseRelayedQuestion reads its own example", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true).includes(prompts.RELAYED_SHAPE));
  assert.ok(prompts.executePrompt(TEST_ROOT, "t", true).includes(prompts.questionWritingRules()));
  assert.ok(prompts.RELAYED_SHAPE.includes(prompts.relayedQuestionText(prompts.RELAYED_EXAMPLE)), "the prompt's example is the composer's");
  const options = prompts.RELAYED_EXAMPLE.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
  assert.deepEqual(parseRelayedQuestion(prompts.relayedQuestionText(prompts.RELAYED_EXAMPLE), options), prompts.RELAYED_EXAMPLE);
  const parts = { context: good.context as readonly Block[], question: good.question, explanations: good.explanations, options: good.options };
  const toolOptions = good.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
  assert.deepEqual(parseRelayedQuestion(prompts.relayedQuestionText(parts), toolOptions), parts);
  assert.deepEqual(parseRelayedQuestion(`\n  ${prompts.relayedQuestionText(parts)}\n`, toolOptions), parts, "surrounding whitespace is allowed");
});

test("S8: a relayed text that is not the shape, breaks a rule, or has other options than the tool's is not read as one", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  const parts = { context: good.context as readonly Block[], question: good.question, explanations: good.explanations, options: good.options };
  const toolOptions = good.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
  assert.equal(parseRelayedQuestion(piecesText(good.question), toolOptions), null, "plain text");
  assert.equal(parseRelayedQuestion(`Context.\n\n${prompts.TERMS_HEADING}\nzod: a library\n\nShould it?`, toolOptions), null, "the former Terms block");
  assert.equal(parseRelayedQuestion(prompts.relayedQuestionText({ ...parts, explanations: [] }), toolOptions), null, "a dangling ref");
  assert.equal(parseRelayedQuestion(prompts.relayedQuestionText(parts), [toolOptions[1], toolOptions[0]]), null, "the options reordered");
  assert.equal(parseRelayedQuestion(prompts.relayedQuestionText(parts), toolOptions.slice(0, 1)), null, "another count of options");
  assert.equal(parseRelayedQuestion(prompts.relayedQuestionText({ ...parts, options: [opt("Declare zod", "Add zod to package.json."), parts.options[1]] }), toolOptions), null, "a label with other words");
});

test("property S8: any valid question encoded as the shape parses back to itself; any string returns without throwing", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  fc.assert(
    fc.property(arbValid, (q) => {
      const parts = { context: q.context as readonly Block[], question: q.question, explanations: q.explanations, options: q.options };
      const toolOptions = q.options.map((o) => ({ label: piecesText(o.label), description: piecesText(o.description) }));
      const parsed = parseRelayedQuestion(prompts.relayedQuestionText(parts), toolOptions);
      return questionProblems(q).length > 0 ? parsed === null : JSON.stringify(parsed) === JSON.stringify(parts);
    }),
    { numRuns: 200 },
  );
  fc.assert(fc.property(fc.string(), (text) => parseRelayedQuestion(text, []) === null || typeof parseRelayedQuestion(text, []) === "object"), { numRuns: 200 });
});

// ---- the senses of an explanation (issue #112) ----------------------------------------------------------------------

test("issue #112: an explanation with no sense or a blank sense is refused, two non-blank senses are accepted", () => {
  assert.deepEqual(kinds({ ...good, explanations: [{ ...zod, senses: [] }] }), ["noSense"]);
  assert.deepEqual(questionProblems({ ...good, explanations: [{ ...zod, senses: ["A library.", " "] }] }), [{ kind: "blankSense", subject: 'sense 2 of the term "zod"' }]);
  assert.deepEqual(kinds({ ...good, explanations: [{ ...zod, senses: ["A library that checks data.", "The library the Agent SDK takes a tool's input in."] }] }), []);
  assert.deepEqual(sensesOf([]), Result.fail([{ kind: "noSense" }]));
  assert.deepEqual(sensesOf(["a", "", "b", "\t"]), Result.fail([{ kind: "blankSense", position: 2 }, { kind: "blankSense", position: 4 }]));
  assert.ok(Result.isSuccess(sensesOf(["a", "b"])));
});

const blankText = fc.constantFrom("", " ", "\t", "  \n ");
const nonBlankText = fc.string({ minLength: 1, maxLength: 12 }).filter((t) => t.trim() !== "");

test("property (issue #112): every list of senses that is empty or holds a blank entry is refused, by sensesOf and by questionProblems", () => {
  fc.assert(
    fc.property(fc.array(fc.oneof(nonBlankText, blankText), { maxLength: 5 }).filter((senses) => senses.length === 0 || senses.some((t) => t.trim() === "")), (senses) => {
      const problems = kinds({ ...good, explanations: [{ ...zod, senses }] });
      return Result.isFailure(sensesOf(senses)) && problems.length > 0 && problems.every((k) => k === "noSense" || k === "blankSense");
    }),
    { numRuns: 200 },
  );
});

test("property (issue #112): every non-empty list of non-blank senses is accepted, in its order", () => {
  fc.assert(
    fc.property(fc.array(nonBlankText, { minLength: 1, maxLength: 5 }), (senses) => {
      const built = sensesOf(senses);
      return Result.isSuccess(built) && JSON.stringify(built.success) === JSON.stringify(senses) && kinds({ ...good, explanations: [{ ...zod, senses }] }).length === 0;
    }),
    { numRuns: 200 },
  );
});

test("property (issue #112): with a single sense the checks are those of one explanation text before the change", () => {
  // The rule before issue #112, written from it: a blank text was the one problem of an explanation's text.
  const before = (text: string): readonly string[] => (text.trim() === "" ? ["blank"] : []);
  fc.assert(
    fc.property(arbValid.filter((q) => q.explanations.length > 0), fc.oneof(nonBlankText, blankText), (q, text) => {
      const [first, ...rest] = q.explanations;
      const one = kinds({ ...q, explanations: [{ ...first, senses: [text] }, ...rest] });
      const others = kinds({ ...q, explanations: [{ ...first, senses: ["a sense"] }, ...rest] });
      return JSON.stringify(one.filter((k) => k !== "blankSense")) === JSON.stringify(others) && JSON.stringify(one.filter((k) => k === "blankSense").map(() => "blank")) === JSON.stringify(before(text));
    }),
    { numRuns: 200 },
  );
});
