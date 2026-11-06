import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { normalizeLabel, validateAnalysis } from "../src/analysis.ts";
import { AnalysisInvalid, haltMessage } from "../src/errors.ts";
import type { Argument, ArguedColumn, Column, DecisionAnalysis, Entry } from "../src/schema.ts";

/** The column as an argued one (a test fails on an unclear column). */
const argued = (column: Column): ArguedColumn => {
  if (column.kind !== "argued") throw new Error(`column ${column.option} is not argued`);
  return column;
};

// Decision support, plan step 2.3 (D9): what the schema cannot check.
const el = (text = "t", counterarguments: Entry["threshold"]["counterarguments"] = []) => ({ text, counterarguments });
const entry = (id: string, counter: Entry["threshold"]["counterarguments"] = []): Entry => ({
  id,
  title: `title ${id}`,
  comparative_condition: el("c", counter),
  starting_cause: el(),
  intermediate_steps: el(),
  threshold: el(),
  effect_on_persons: el(),
  reason_the_effect_matters: el(),
  extent: { per_person: el(), persons_affected: el(), likelihood: el(), timing: el() },
});
const arg = (id: string, equivalent_to = "", replies: Argument[] = []): Argument => ({ id, text: `But ${id}.`, equivalent_to, replies });
const options = [{ label: "A", description: "a" }, { label: "B", description: "b" }];
const analysis = (over: Partial<DecisionAnalysis> = {}): DecisionAnalysis => ({
  decision: "d",
  columns: [
    { kind: "argued", option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "", [arg("A3", "E2")])])])], disadvantages: [] },
    { kind: "argued", option: "B", advantages: [], disadvantages: [entry("E2")] },
  ],
  recommendation: { option: "", reason: "" },
  ...over,
});
const failure = (r: ReturnType<typeof validateAnalysis>): AnalysisInvalid => {
  assert.ok(Result.isFailure(r), "the analysis was accepted");
  return r.failure;
};

test("a valid analysis passes unchanged, with no notes", () => {
  const r = validateAnalysis(options, analysis());
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(r.success.analysis, analysis());
  assert.deepEqual(r.success.notes, []);
});

test("one column per option, in the question's order, with the option's label", () => {
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[0]] }))).columns, { expected: ["A", "B"], got: ["A"] });
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[1], analysis().columns[0]] }))).columns, { expected: ["A", "B"], got: ["B", "A"] });
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[0], { ...analysis().columns[1], option: "b" }] }))).columns, { expected: ["A", "B"], got: ["A", "b"] });
});

test("entry and argument ids are unique and non-empty across the representation", () => {
  const dup = analysis({ columns: [{ kind: "argued", option: "A", advantages: [entry("E1", [arg("E2")])], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [entry("E2")] }] });
  assert.deepEqual(failure(validateAnalysis(options, dup)).duplicateIds, ["E2"]);
  const empty = analysis({ columns: [{ kind: "argued", option: "A", advantages: [entry("")], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [entry("E2", [arg("")])] }] });
  assert.equal(failure(validateAnalysis(options, empty)).emptyIds, 2);
});

test("a reference to no entry is dropped with a note; a reference to an argument is no entry either", () => {
  const dangling = analysis({ columns: [{ kind: "argued", option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "E9")])])], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [entry("E2", [arg("A3", "A1")])] }] });
  const r = validateAnalysis(options, dangling);
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(r.success.notes, [{ kind: "reference", argument: "A2", named: "E9" }, { kind: "reference", argument: "A3", named: "A1" }]);
  assert.equal(argued(r.success.analysis.columns[0]).advantages[0].comparative_condition.counterarguments[0].replies[0].equivalent_to, "");
  assert.equal(argued(r.success.analysis.columns[1]).disadvantages[0].comparative_condition.counterarguments[0].equivalent_to, "");
});

test("a recommendation names one of the options or is empty", () => {
  assert.ok(Result.isSuccess(validateAnalysis(options, analysis({ recommendation: { option: "B", reason: "because" } }))));
  assert.deepEqual(failure(validateAnalysis(options, analysis({ recommendation: { option: "C", reason: "because" } }))).recommendation, { given: "C", matches: [] });
});

test("AnalysisInvalid is described for the user", () => {
  const error = new AnalysisInvalid({ columns: { expected: ["A", "B"], got: ["A"] }, duplicateIds: ["E2"], emptyIds: 1, recommendation: { given: "C", matches: [] }, blankUnclear: [] });
  const text = haltMessage(error) ?? "";
  assert.match(text, /^HALTED: the decision analysis is invalid: /);
  assert.match(text, /columns A, B expected, A given/);
  assert.match(text, /E2/);
  assert.match(text, /1 empty id/);
  assert.match(text, /recommends C, which is not an option/);
});

test("an ambiguous recommendation is described with the options it matches", () => {
  const error = new AnalysisInvalid({ columns: null, duplicateIds: [], emptyIds: 0, recommendation: { given: "Retry", matches: ["1. Retry", "2. Retry"] }, blankUnclear: [] });
  assert.match(haltMessage(error) ?? "", /recommends Retry, which matches more than one option: 1\. Retry, 2\. Retry/);
});

// Issue #37, change 3 (decisions Q4 and G-R1-1): labels compared tolerantly, rewritten to the exact label with a note.
const RUN_OPTIONS = [
  { label: "At the existing check, in place of the halt: after the cycle's pauses, decisions, follow-up clarification and log update.", description: "" },
  { label: "Immediately after Claude Code's response, before the other pauses and the follow-up clarification.", description: "" },
];
const withLabels = (labels: readonly string[], recommended: string): DecisionAnalysis => ({
  decision: "d",
  columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })),
  recommendation: { option: recommended, reason: recommended === "" ? "" : "because" },
});

test("normalizeLabel strips a leading <n>. or <n>) and normalizes whitespace", () => {
  assert.equal(normalizeLabel("1. Foo"), "Foo");
  assert.equal(normalizeLabel("  2)  Foo   bar "), "Foo bar");
  assert.equal(normalizeLabel("12.\tFoo\nbar"), "Foo bar");
  assert.equal(normalizeLabel("Foo 1. bar"), "Foo 1. bar");
});

test("the run of 28 Sep 2026: numbered labels are rewritten to the exact labels, with a note each", () => {
  const given = RUN_OPTIONS.map((o, i) => `${i + 1}. ${o.label}`);
  const r = validateAnalysis(RUN_OPTIONS, withLabels(given, given[0]));
  assert.ok(Result.isSuccess(r), JSON.stringify(Result.isFailure(r) ? r.failure : null));
  assert.deepEqual(r.success.analysis.columns.map((c) => c.option), RUN_OPTIONS.map((o) => o.label));
  assert.equal(r.success.analysis.recommendation.option, RUN_OPTIONS[0].label);
  assert.deepEqual(r.success.notes, [
    { kind: "label", given: given[0], exact: RUN_OPTIONS[0].label },
    { kind: "label", given: given[1], exact: RUN_OPTIONS[1].label },
    { kind: "label", given: given[0], exact: RUN_OPTIONS[0].label },
  ]);
});

test("whitespace differences are normalized too", () => {
  const r = validateAnalysis([{ label: "Foo bar" }, { label: "Baz" }], withLabels(["2)  Foo   bar", "Baz"], ""));
  assert.ok(Result.isSuccess(r));
  assert.equal(r.success.analysis.columns[0].option, "Foo bar");
});

test("an exact match comes first: a label that is exactly an option is kept, without a note", () => {
  const retry = [{ label: "1. Retry", description: "" }, { label: "2. Retry", description: "" }];
  const r = validateAnalysis(retry, withLabels(["1. Retry", "2. Retry"], "1. Retry"));
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(r.success.notes, []);
  assert.equal(r.success.analysis.recommendation.option, "1. Retry");
});

test("a recommendation that matches more than one option after normalization is invalid", () => {
  const retry = [{ label: "1. Retry", description: "" }, { label: "2. Retry", description: "" }];
  assert.deepEqual(failure(validateAnalysis(retry, withLabels(["1. Retry", "2. Retry"], "Retry"))).recommendation, { given: "Retry", matches: ["1. Retry", "2. Retry"] });
});

test("a column that matches its option only by another normalization is still invalid", () => {
  assert.deepEqual(failure(validateAnalysis(RUN_OPTIONS, withLabels(["1. Foo", RUN_OPTIONS[1].label], ""))).columns, { expected: RUN_OPTIONS.map((o) => o.label), got: ["1. Foo", RUN_OPTIONS[1].label] });
});

// Issue #35 (Q8): an unclear column states what is unclear; a blank statement is invalid (the validation repair turn).
test("an unclear column is valid with its statement and has no entries; a blank statement is invalid", () => {
  const unclear = (text: string): DecisionAnalysis => analysis({ columns: [analysis().columns[0], { kind: "unclear", option: "B", unclear: text }] });
  const r = validateAnalysis(options, { ...unclear("B could mean a copy or a cache."), columns: [{ kind: "argued", option: "A", advantages: [entry("E1")], disadvantages: [] }, { kind: "unclear", option: "B", unclear: "B could mean a copy or a cache." }] });
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(failure(validateAnalysis(options, { ...unclear(""), columns: [{ kind: "argued", option: "A", advantages: [entry("E1")], disadvantages: [] }, { kind: "unclear", option: "B", unclear: "  \n" }] })).blankUnclear, ["B"]);
});

// W1-R1-1: an option whose own label begins with an ordinal, given with the agent's ordinal in front of it.
test("every leading ordinal is dropped: \"1. 1. Retry\" is rewritten to the option \"1. Retry\", with a note", () => {
  assert.equal(normalizeLabel("1. 1. Retry"), "Retry");
  const retry = [{ label: "1. Retry" }, { label: "Skip" }];
  const r = validateAnalysis(retry, withLabels(["1. 1. Retry", "Skip"], "1. 1. Retry"));
  assert.ok(Result.isSuccess(r), JSON.stringify(Result.isFailure(r) ? r.failure : null));
  assert.equal(r.success.analysis.columns[0].option, "1. Retry");
  assert.equal(r.success.analysis.recommendation.option, "1. Retry");
  assert.deepEqual(r.success.notes, [{ kind: "label", given: "1. 1. Retry", exact: "1. Retry" }, { kind: "label", given: "1. 1. Retry", exact: "1. Retry" }]);
});
