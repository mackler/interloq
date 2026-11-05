import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import * as K from "../src/keptCorrections.ts";
import { keptCorrectionsRepairPrompt } from "../src/prompts.ts";
import type { IssueId, LogEntry } from "../src/schema.ts";
import type * as S from "../src/schema.ts";

const id = (s: string) => s as IssueId;
const review = (i: string, action: "accepted" | "partially_accepted" | "rejected", kept: string[], extra: Partial<LogEntry> = {}): LogEntry =>
  ({ id: id(i), phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action, rationale: "r", duplicate_of: null, reverses: null, superseded: false, file_change: null, task_dispute: false, work_effects: null, kept_passages: kept, ...extra }) as LogEntry;
const self = (i: string, kept: string[]): LogEntry => ({ id: id(i), phase: 1, round: 2, source: "self_correction", problem: "p", action: "plan_error", rationale: "r", superseded: false, file_change: null, kept_passages: kept });
const disp = (i: string, action: "accepted" | "partially_accepted" | "rejected", reverses: string | null = null) => ({ id: id(i), action, reverses: reverses === null ? null : id(reverses) });
const base: K.KeptCorrectionsInput = { baseline: [], restatable: new Set(), dispositions: [], entries: [], texts: [] };
const kinds = (input: K.KeptCorrectionsInput) => K.keptCorrectionProblems(input).map((p) => [p.kind, p.id, p.passage]);

test("the baseline: current entries of the loop's phase with passages, review and self-correction alike", () => {
  const log = [review("A", "accepted", ["retry twice"]), review("B", "accepted", []), review("C", "accepted", ["gone"], { superseded: true }), review("D", "accepted", ["other phase"], { phase: 2 }), self("E", ["kept on"])];
  assert.deepEqual(K.keptBaselineOf(log, 1), [{ id: "A", passages: ["retry twice"] }, { id: "E", passages: ["kept on"] }]);
  assert.deepEqual([...K.restatable(log, 1)].sort(), ["A", "B", "E"]);
  assert.deepEqual([...K.restatable([review("R", "rejected", [])], 1)], []);
});

test("every problem kind, sorted by kind then id", () => {
  assert.deepEqual(kinds({ ...base, dispositions: [disp("B", "accepted"), disp("A", "partially_accepted")] }), [["entryMissing", "A", ""], ["entryMissing", "B", ""]]);
  assert.deepEqual(kinds({ ...base, dispositions: [disp("A", "accepted")], entries: [{ id: "A", passages: [] }, { id: "A", passages: [] }] }), [["entryDuplicate", "A", ""]]);
  assert.deepEqual(kinds({ ...base, dispositions: [disp("A", "rejected")], entries: [{ id: "A", passages: [] }] }), [["entryNotAccepted", "A", ""]]);
  assert.deepEqual(kinds({ ...base, dispositions: [disp("A", "accepted")], entries: [{ id: "A", passages: ["  "] }] }), [["passageBlank", "A", ""]]);
  assert.deepEqual(kinds({ ...base, dispositions: [disp("A", "accepted")], entries: [{ id: "A", passages: ["absent"] }], texts: ["present"] }), [["passageNotInReply", "A", "absent"]]);
  assert.deepEqual(kinds({ ...base, baseline: [{ id: "A", passages: ["retry twice", "kept"] }], texts: ["kept here"] }), [["correctionMissing", "A", "retry twice"]]);
  assert.deepEqual(kinds({ ...base, baseline: [{ id: "Z", passages: ["x"] }], dispositions: [disp("B", "accepted")] }), [["entryMissing", "B", ""], ["correctionMissing", "Z", "x"]]);
});

test("a validated reversal and a restatement exempt a dropped passage; a reverses of null does not", () => {
  const baseline = [{ id: "A", passages: ["retry twice"] }];
  assert.deepEqual(kinds({ ...base, baseline, dispositions: [disp("B", "rejected", "A")], texts: ["no"] }), []);
  assert.deepEqual(kinds({ ...base, baseline, restatable: new Set(["A"]), entries: [{ id: "A", passages: ["make two retry attempts"] }], texts: ["we make two retry attempts"] }), []);
  // validateRound leaves a self-reference as null, and only a non-null reverses pauses (P1-R1-2).
  assert.deepEqual(kinds({ ...base, baseline, dispositions: [disp("A", "rejected", null)], texts: ["no"] }), [["correctionMissing", "A", "retry twice"]]);
  // A restatement whose passage is not in the reply is reported as such.
  assert.deepEqual(kinds({ ...base, baseline, restatable: new Set(["A"]), entries: [{ id: "A", passages: ["missing"] }], texts: ["no"] }), [["passageNotInReply", "A", "missing"]]);
  // An id re-raised and rejected may restate the correction it already carries.
  assert.deepEqual(kinds({ ...base, baseline, restatable: new Set(["A"]), dispositions: [disp("A", "rejected")], entries: [{ id: "A", passages: ["retry twice"] }], texts: ["retry  twice"] }), []);
  // An empty list of passages is valid: a correction that only removed text.
  assert.deepEqual(kinds({ ...base, dispositions: [disp("A", "accepted")], entries: [{ id: "A", passages: [] }] }), []);
});

test("a passage reflowed in its whitespace stands; one across two fields does not", () => {
  assert.equal(K.occursInTexts("retry   twice\nthen stop", ["We retry twice then  stop."]), true);
  assert.equal(K.occursInTexts("retry twice then stop", ["We retry twice", "then stop."]), false);
});

const pieces = (text: string): S.Piece[] => [{ text, ref: "", code: false }];
const para = (text: string): S.Block[] => [{ kind: "paragraph", pieces: pieces(text) }];
const option = (label: string, description: string) => ({ label: pieces(label), description: pieces(description), figure: null });

test("each subject's texts carry its fields", () => {
  const plan: S.Plan = { stages: [{ number: 1, title: "Stage one", steps: [{ id: "S1", number: 1, label: "Step label", text: "The step retries twice." }] }] };
  assert.equal(K.occursInTexts("retries twice", K.planTexts(plan)), true);
  assert.equal(K.occursInTexts("Stage one", K.planTexts(plan)), true);
  const question: S.QuestionEntry = { id: "Q1", context: para("The cache lives in memory."), history: [], question: pieces("Which store?"), reason: para("r"), proposed_answers: [option("Disk", "d")], default_answer: "Disk", skip_if: null };
  assert.equal(K.occursInTexts("cache lives in memory", K.questionListTexts([question])), true);
  const term: S.TermsEntry = { id: "Q1", explanations: [{ id: "t1", term: "cache", senses: ["a copy kept close at hand"] }], context: [], history: [], question: pieces("Which store?"), reason: [], proposed_answers: [] };
  assert.equal(K.occursInTexts("a copy kept close", K.termsTexts([term])), true);
  const el = (text: string, counterarguments: S.Argument[] = []) => ({ text, counterarguments });
  const entry = { id: "E1", title: "Faster", comparative_condition: el("c"), starting_cause: el("s", [{ id: "a1", text: "counter", equivalent_to: "", replies: [{ id: "a2", text: "a nested defense", equivalent_to: "", replies: [] }] }]), intermediate_steps: el("i"), threshold: el("t"), effect_on_persons: el("e"), reason_the_effect_matters: el("r"), extent: { per_person: el("p"), persons_affected: el("pa"), likelihood: el("l"), timing: el("ti") } };
  const analysis: S.DecisionAnalysis = { decision: "d", columns: [{ kind: "argued", option: "A", advantages: [entry], disadvantages: [] }, { kind: "unclear", option: "B", unclear: "B could mean two things" }], recommendation: { option: "A", reason: "because it is faster" } };
  for (const passage of ["a nested defense", "B could mean two things", "because it is faster", "Faster", "ti"]) assert.equal(K.occursInTexts(passage, K.analysisTexts(analysis)), true, passage);
});

test("the validation fails with CorrectionDropped and the repair prompt of its problems", () => {
  const validation = K.keptCorrectionsValidation<{ text: string }>({ baseline: [{ id: "A", passages: ["retry twice"] }], restatable: new Set(), dispositionsOf: () => [] }, (r) => [r.text], () => []);
  const failed = validation({ text: "nothing" });
  assert.ok(Result.isFailure(failed));
  assert.equal(failed.failure.error._tag, "CorrectionDropped");
  assert.equal(failed.failure.repair, keptCorrectionsRepairPrompt([{ kind: "correctionMissing", id: "A", passage: "retry twice" }]));
  assert.ok(Result.isSuccess(validation({ text: "we retry twice" })));
});
