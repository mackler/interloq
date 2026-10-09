import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Result } from "effect";
import { validateAnalysis } from "../src/analysis.ts";
import * as prompts from "../src/prompts.ts";
import type { DecisionAnalysis, Entry } from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

// Issue #37: the prompt that tells Claude Code which option labels to return and the validation that checks them are
// exercised together. The labels are taken from the prompt as Claude Code reads them, never from a literal of the test.
const FORMAT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
const el = () => ({ text: "t", counterarguments: [] });
const entry = (id: string): Entry => ({
  id,
  title: `title ${id}`,
  comparative_condition: el(),
  starting_cause: el(),
  intermediate_steps: el(),
  threshold: el(),
  effect_on_persons: el(),
  reason_the_effect_matters: el(),
  extent: { per_person: el(), persons_affected: el(), likelihood: el(), timing: el() },
});
/** The labels of the option lines of a prompt, by the documented form: the number, a colon, the label as a JSON string. */
export const labelsInPrompt = (text: string): readonly string[] =>
  text.split("\n").flatMap((line) => {
    const match = /^(\d+): ("(?:[^"\\]|\\.)*")/.exec(line);
    return match === null ? [] : [JSON.parse(match[2]) as string];
  });
const analysisWith = (labels: readonly string[], recommended: string): DecisionAnalysis => ({
  decision: "d",
  columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })),
  recommendation: { option: recommended, reason: recommended === "" ? "" : "because" },
});
export const OPTION_SETS: readonly (readonly Readonly<{ label: string; description: string }>[])[] = [
  [{ label: "SQLite", description: "one file" }, { label: "PostgreSQL", description: "a server" }],
  [{ label: "At the existing check, in place of the halt: after the cycle's pauses.", description: "" }, { label: "Immediately after Claude Code's response.", description: "d" }],
  [{ label: "1. Retry", description: "" }, { label: "2. Retry", description: "" }],
  [{ label: 'Say "yes" — or no', description: "a \"quoted\" description" }, { label: "Version 2) trailing  ", description: "" }, { label: "3", description: "" }],
];

test("the option labels the analysis prompt presents are the labels the validation accepts, exactly", () => {
  for (const options of OPTION_SETS) {
    const text = prompts.decisionAnalysisPrompt(TEST_ROOT, FORMAT, { phase: { kind: "questions" }, label: "Gather Requirements", question: "Which?", options }, { task: "t", requirements: null, plan: null });
    const labels = labelsInPrompt(text);
    assert.deepEqual(labels.length, options.length, text.slice(-2000));
    for (const recommended of ["", ...labels]) {
      const r = validateAnalysis(options, analysisWith(labels, recommended));
      assert.ok(Result.isSuccess(r), JSON.stringify(labels));
      assert.deepEqual(r.success.notes, []);
    }
  }
  // The prompt tells Claude Code to use the quoted text without its number.
  assert.match(prompts.decisionAnalysisPrompt(TEST_ROOT, FORMAT, { phase: { kind: "questions" }, label: "Gather Requirements", question: "Which?", options: OPTION_SETS[0] }, { task: "t", requirements: null, plan: null }), /the text inside the quotation marks[^\n]*without the number/);
});

// The validation repair turn (decision Q1): the labels its prompt presents are the labels the validation accepts.
test("the option labels the analysis repair prompt presents are the labels the validation accepts, exactly", () => {
  for (const options of OPTION_SETS) {
    const wrong = analysisWith(options.map((o) => `x ${o.label}`), "nothing");
    const invalid = validateAnalysis(options, wrong);
    assert.ok(Result.isFailure(invalid));
    const text = prompts.analysisRepairPrompt(invalid.failure, options);
    const labels = labelsInPrompt(text);
    assert.deepEqual(labels.length, options.length, text);
    const r = validateAnalysis(options, analysisWith(labels, labels[0]));
    assert.ok(Result.isSuccess(r), JSON.stringify(labels));
    assert.deepEqual(r.success.notes, []);
    // It says what was wrong: the columns given, and the recommendation.
    assert.ok(text.includes(JSON.stringify(wrong.columns[0].option)), text);
    assert.ok(text.includes('"nothing"'), text);
  }
});

test("the analysis repair prompt names duplicate and empty ids, an ambiguous recommendation, and asks for the complete output", () => {
  const options = OPTION_SETS[2];
  const text = prompts.analysisRepairPrompt({ columns: null, duplicateIds: ["E2"], emptyIds: 1, recommendation: { given: "Retry", matches: ["1. Retry", "2. Retry"] }, blankUnclear: [] }, options);
  assert.match(text, /E2/);
  assert.match(text, /1 empty id/);
  assert.match(text, /more than one option/);
  assert.match(text, /Return the complete output again/);
  assert.match(text, /Do not modify any file/);
});

test("the analysis repair prompt names an unclear column without its statement", () => {
  const text = prompts.analysisRepairPrompt({ columns: null, duplicateIds: [], emptyIds: 0, recommendation: null, blankUnclear: ["SQLite"] }, OPTION_SETS[0]);
  assert.match(text, /"SQLite" is marked unclear but does not state what is unclear/);
});

// W1-R1-3: a repair for an unrelated defect keeps the choice to recommend no option, as ANALYSIS_FIELDS and the
// validation allow it.
test("the analysis repair prompt permits recommending no option, and such an analysis validates", () => {
  for (const options of OPTION_SETS) {
    const text = prompts.analysisRepairPrompt({ columns: null, duplicateIds: ["E1"], emptyIds: 0, recommendation: null, blankUnclear: [] }, options);
    assert.match(text, /To recommend no option, leave the recommendation's option and reason empty\./);
    assert.doesNotMatch(text, /and the option of a recommendation must be/);
    const r = validateAnalysis(options, analysisWith(labelsInPrompt(text), ""));
    assert.ok(Result.isSuccess(r));
    assert.deepEqual(r.success.notes, []);
  }
});
