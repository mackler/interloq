// Issue #166: a question that writes a substitute for one of Interloq's own words is refused (questionProblems'
// programWord), and the repair prompt cites the rule programWords, whose text carries the table (programWordsText).
// The prompt and the check are exercised together, as the repository requires.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { decodeRunError } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { type Question, questionProblems, validateQuestion } from "../src/question.ts";
import { PROGRAM_WORDS, programWordsText } from "../src/vocabulary.ts";
import { opt, para, plain } from "./helpers.ts";

const questionWith = (sentence: string, description = "It moves the item."): Question => ({
  history: [],
  context: para("Interloq, the orchestrator, sets an item's label when its run ends."),
  question: plain(sentence),
  explanations: [],
  options: [opt("Keep the label", description), opt("Change the label", "It changes the label.")],
});

const entries = PROGRAM_WORDS.flatMap((w) => w.substitutes.map((s) => ({ s, names: w.names })));

test("every substitute is refused with programWord, its entry's name accepted, and the same word as code accepted", () => {
  for (const { s, names } of entries) {
    const inQuestion = validateQuestion(questionWith(`Where do you want an item that is ${s} to go?`));
    assert.ok(Result.isFailure(inQuestion), s);
    const problems = inQuestion.failure.questions[0].problems;
    assert.deepEqual(problems, [{ kind: "programWord", subject: s, instead: names }]);
    assert.deepEqual(questionProblems(questionWith("Where do you want the item to go?", `The item stays ${s}.`)).map((p) => p.kind), ["programWord"]);
    for (const name of names) assert.ok(Result.isSuccess(validateQuestion(questionWith(`Where do you want an item that is ${name} to go?`))), name);
    const asCode: Question = { ...questionWith("Where do you want the item to go?"), question: [...plain("Which command runs "), { text: `npm run ${s}`, ref: "", code: true }, ...plain(" here?")] };
    assert.deepEqual(questionProblems(asCode), [], `code ${s}`);
    const repair = prompts.questionRepairPrompt(inQuestion.failure.questions);
    assert.ok(repair.includes(JSON.stringify(s)), s);
    for (const name of names) assert.ok(repair.includes(name));
    const rule = prompts.QUESTION_RULES.find((r) => r.id === "programWords");
    assert.ok(rule !== undefined);
    assert.ok(rule.rule.includes(programWordsText()));
    assert.ok(repair.includes(rule.rule));
  }
});

test("a substitute in an explanation's term or sense is refused too", () => {
  const q: Question = {
    ...questionWith("Where do you want the item to go?"),
    question: [...plain("Where do you want the "), { text: "item", ref: "t", code: false }, ...plain(" to go?")],
    explanations: [{ id: "t", term: "item", senses: ["Something Interloq has built."] }],
  };
  assert.deepEqual(questionProblems(q).map((p) => p.kind), ["programWord"]);
});

test("a halt naming a programWord problem decodes from its record", () => {
  const q = validateQuestion(questionWith("Where do you want a built item to go?"));
  assert.ok(Result.isFailure(q));
  const decoded = decodeRunError(JSON.parse(JSON.stringify(q.failure)));
  assert.deepEqual(decoded, { ...q.failure });
});

const plainWord = fc.stringMatching(/^[a-z]{1,8}$/).filter((w) => !/build|built/.test(w));
const sentence = fc.array(plainWord, { minLength: 1, maxLength: 5 }).map((ws) => ws.join(" "));

test("a question of plain words has no programWord problem, and a substitute inserted in any part gives exactly one", () => {
  fc.assert(
    fc.property(sentence, sentence, fc.constantFrom(...entries), fc.integer({ min: 0, max: 2 }), (words, other, { s }, where) => {
      const base = questionWith(`${words}?`, other);
      assert.deepEqual(questionProblems(base).filter((p) => p.kind === "programWord"), []);
      const withSub: Question =
        where === 0 ? questionWith(`${words} ${s}?`, other) : where === 1 ? questionWith(`${words}?`, `${other} ${s}`) : { ...base, context: para(`${words} ${s}.`) };
      const found = questionProblems(withSub).filter((p) => p.kind === "programWord");
      assert.equal(found.length, 1);
      assert.equal(found[0].subject, s);
    }),
  );
});
