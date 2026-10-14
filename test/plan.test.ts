import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { endExecution, recordStep, remainingSteps, renderPlanMarkdown, stepRecordsOf, stripStatuses, validatePlan } from "../src/plan.ts";
import { haltMessage } from "../src/errors.ts";
import type { Plan, RecordedPlan, StepStatus } from "../src/schema.ts";

// Issue #6 (G-R1-1, G-R1-2, Q3): the plan's validation beyond its schema, the statuses carried by id, and what the
// program records of the steps during execution.

const step = (id: string, number: number, label = `label ${id}`, text = `text of ${id}`) => ({ id, number, label, text });
const reply = (...stages: (readonly ReturnType<typeof step>[])[]): Plan => ({ stages: stages.map((steps, i) => ({ number: i + 1, title: `stage ${i + 1}`, steps })) });
const recorded = (plan: Plan, statuses: Record<string, StepStatus> = {}): RecordedPlan => ({
  stages: plan.stages.map((s) => ({ ...s, steps: s.steps.map((st) => ({ ...st, status: statuses[st.id] ?? "pending" })) })),
});
const ok = (previous: RecordedPlan | null, plan: Plan) => {
  const r = validatePlan(previous, plan);
  assert.ok(Result.isSuccess(r), Result.isFailure(r) ? haltMessage(r.failure) ?? "" : "");
  return r.success;
};
const fails = (previous: RecordedPlan | null, plan: Plan) => {
  const r = validatePlan(previous, plan);
  assert.ok(Result.isFailure(r), "the plan was accepted");
  return r.failure;
};
const statuses = (plan: RecordedPlan) => Object.fromEntries(plan.stages.flatMap((s) => s.steps.map((st) => [st.id, st.status])));

test("a first plan is recorded with every step pending", () => {
  const { value, notes } = ok(null, reply([step("S1", 1), step("S2", 2)], [step("S3", 1)]));
  assert.deepEqual(statuses(value), { S1: "pending", S2: "pending", S3: "pending" });
  assert.deepEqual(notes, []);
});

test("an empty or repeated id is rejected, across stages", () => {
  const e = fails(null, reply([step("S1", 1), step("", 2)], [step("S1", 1)]));
  assert.deepEqual([e.duplicateIds, e.emptyIds], [["S1"], 1]);
});

test("statuses carry over by id; an inserted step does not inherit a status", () => {
  const previous = recorded(reply([step("S1", 1), step("S2", 2), step("S3", 3)]), { S1: "done", S2: "unfinished", S3: "started" });
  const { value } = ok(previous, reply([step("S1", 1), step("S9", 2), step("S2", 3)], [step("S3", 1)]));
  assert.deepEqual(statuses(value), { S1: "done", S9: "pending", S2: "unfinished", S3: "started" });
});

test("a revision that removes a done step or changes its label or text is rejected; other steps may change", () => {
  const previous = recorded(reply([step("S1", 1), step("S2", 2), step("S3", 3)]), { S1: "done", S2: "done" });
  const e = fails(previous, reply([step("S2", 1, "another label"), step("S3", 2, "anything", "anything")]));
  assert.deepEqual([e.removedDone, e.changedDone], [["S1"], ["S2"]]);
  assert.deepEqual(fails(previous, reply([step("S1", 1), step("S2", 2, "label S2", "new text")])).changedDone, ["S2"]);
  // A done step may move to another stage: its number and stage are display only.
  ok(previous, reply([step("S3", 1, "x", "y")], [step("S1", 1), step("S2", 2)]));
});

test("numbers that are not 1…n in order are renumbered by position, with a note", () => {
  const { value, notes } = ok(null, { stages: [{ number: 3, title: "a", steps: [step("S1", 4), step("S2", 4)] }, { number: 3, title: "b", steps: [step("S3", 1)] }] });
  assert.deepEqual(value.stages.map((s) => [s.number, s.steps.map((st) => st.number)]), [[1, [1, 2]], [2, [1]]]);
  assert.equal(notes.length, 1);
});

test("the invalid plan's message names every offending id and what was wrong", () => {
  const previous = recorded(reply([step("S1", 1), step("S2", 2)]), { S1: "done", S2: "done" });
  const message = haltMessage(fails(previous, reply([step("S2", 1, "changed"), step("S4", 2), step("S4", 3)]))) ?? "";
  assert.match(message, /S4/);
  assert.match(message, /S1/);
  assert.match(message, /S2/);
});

test("recordStep records a report by id; an unknown id changes nothing", () => {
  const plan = recorded(reply([step("S1", 1), step("S2", 2)]));
  const started = recordStep(plan, "S2", "started");
  assert.ok(Result.isSuccess(started));
  assert.deepEqual(statuses(started.success), { S1: "pending", S2: "started" });
  const done = recordStep(started.success, "S2", "done");
  assert.ok(Result.isSuccess(done));
  assert.deepEqual(statuses(done.success), { S1: "pending", S2: "done" });
  const unknown = recordStep(plan, "S7", "started");
  assert.ok(Result.isFailure(unknown));
  assert.equal(unknown.failure.id, "S7");
});

test("endExecution turns every started step unfinished; remainingSteps are the pending and unfinished ones", () => {
  const plan = recorded(reply([step("S1", 1), step("S2", 2), step("S3", 3), step("S4", 4)]), { S1: "done", S2: "started", S3: "unfinished" });
  const ended = endExecution(plan);
  assert.deepEqual(statuses(ended), { S1: "done", S2: "unfinished", S3: "unfinished", S4: "pending" });
  assert.deepEqual(remainingSteps(ended).map((s) => s.id), ["S2", "S3", "S4"]);
  assert.deepEqual(endExecution(ended), ended);
});

test("stripStatuses gives the reply the agent would return", () => {
  const plan = reply([step("S1", 1)]);
  assert.deepEqual(stripStatuses(recorded(plan, { S1: "done" })), plan);
});

test("the rendered plan has the stages as headings and a marker per status", () => {
  const plan = recorded(reply([step("S1", 1, "First", "Line one.\n\nLine **two**.")], [step("S2", 1)]), { S1: "done" });
  const md = renderPlanMarkdown(plan);
  assert.match(md, /^## Stage 1: stage 1$/m);
  assert.match(md, /^1\. \[x\] First \(S1\)$/m);
  assert.match(md, /^ {3}Line \*\*two\*\*\.$/m);
  assert.match(md, /^1\. \[ \] label S2 \(S2\)$/m);
});

// Issue #157: the steps a stop after a process ending states.
test("stepRecordsOf gives the done and the unfinished steps in plan order, and none for no plan", () => {
  const plan = recorded(reply([step("S1", 1), step("S2", 2)], [step("S3", 1), step("S4", 2)]), { S1: "done", S2: "unfinished", S3: "done", S4: "started" });
  const records = stepRecordsOf(plan);
  assert.deepEqual(records.done.map((s) => s.id), ["S1", "S3"]);
  assert.deepEqual(records.unfinished.map((s) => s.id), ["S2"]);
  assert.deepEqual(stepRecordsOf(endExecution(plan)).unfinished.map((s) => s.id), ["S2", "S4"]);
  assert.deepEqual(stepRecordsOf(null), { done: [], unfinished: [] });
});
