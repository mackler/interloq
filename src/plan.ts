// The plan as data (issue #6, decisions Q1, F1, F2, G-R1-1, G-R1-2): its validation beyond its schema, the statuses
// carried from one version to the next by id, what execution records of the steps, and the rendered plan.md. Pure: no
// I/O, no Effect services.

import { Result } from "effect";
import { PlanInvalid, UnknownStep } from "./errors.ts";
import { stageHeading } from "./prompts.ts";
import { renderPlanRenumbered } from "./render.ts";
import type { Plan, RecordedPlan, RecordedStep, StepStatus } from "./schema.ts";

const stepsOf = <S>(plan: Readonly<{ stages: readonly Readonly<{ steps: readonly S[] }>[] }>): readonly S[] => plan.stages.flatMap((s) => s.steps);
const duplicates = (ids: readonly string[]): string[] => [...new Set(ids.filter((id, i) => id !== "" && ids.indexOf(id) !== i))];

/**
 * The reply checked against the previous version (G-R1-1): ids non-empty and unique across the plan; every step the
 * previous version records as done still present by id, with its label and text unchanged. Statuses carry over by id,
 * a new id starts pending. Numbers are display only: numbers that are not 1…n in order are renumbered by position, with
 * a note.
 */
export const validatePlan = (previous: RecordedPlan | null, reply: Plan): Result.Result<Readonly<{ value: RecordedPlan; notes: readonly string[] }>, PlanInvalid> => {
  const replied = stepsOf(reply);
  const ids = replied.map((s) => s.id);
  const byId = new Map(replied.map((s) => [s.id, s]));
  const done = previous === null ? [] : stepsOf(previous).filter((s) => s.status === "done");
  const problems = {
    duplicateIds: duplicates(ids),
    emptyIds: ids.filter((id) => id === "").length,
    removedDone: done.filter((s) => !byId.has(s.id)).map((s) => s.id),
    changedDone: done.filter((s) => byId.has(s.id) && (byId.get(s.id)?.label !== s.label || byId.get(s.id)?.text !== s.text)).map((s) => s.id),
  };
  if (problems.duplicateIds.length > 0 || problems.emptyIds > 0 || problems.removedDone.length > 0 || problems.changedDone.length > 0) return Result.fail(new PlanInvalid(problems));
  const recordedStatus = new Map<string, StepStatus>(previous === null ? [] : stepsOf(previous).map((s) => [s.id, s.status]));
  const inOrder = reply.stages.every((stage, i) => stage.number === i + 1 && stage.steps.every((st, j) => st.number === j + 1));
  const value: RecordedPlan = {
    stages: reply.stages.map((stage, i) => ({
      number: i + 1,
      title: stage.title,
      steps: stage.steps.map((st, j) => ({ id: st.id, number: j + 1, label: st.label, text: st.text, status: recordedStatus.get(st.id) ?? "pending" })),
    })),
  };
  return Result.succeed({ value, notes: inOrder ? [] : [renderPlanRenumbered()] });
};

const withStatuses = (plan: RecordedPlan, f: (step: RecordedStep) => StepStatus): RecordedPlan => ({
  stages: plan.stages.map((stage) => ({ ...stage, steps: stage.steps.map((st) => ({ ...st, status: f(st) })) })),
});

/** A report of report_step recorded by id (Q2); an id that is not in the plan changes nothing (Q3). */
export const recordStep = (plan: RecordedPlan, id: string, status: "started" | "done"): Result.Result<RecordedPlan, UnknownStep> =>
  stepsOf(plan).some((s) => s.id === id) ? Result.succeed(withStatuses(plan, (st) => (st.id === id ? status : st.status))) : Result.fail(new UnknownStep({ id }));

/** The plan when an execution call has ended: every started step is unfinished (G-R1-2). */
export const endExecution = (plan: RecordedPlan): RecordedPlan => withStatuses(plan, (st) => (st.status === "started" ? "unfinished" : st.status));

/** The steps still to do: pending and unfinished (an unfinished step counts as remaining, G-R1-2). */
export const remainingSteps = (plan: RecordedPlan): readonly RecordedStep[] => stepsOf(plan).filter((s) => s.status === "pending" || s.status === "unfinished");

/** The steps recorded as done and those left unfinished, each in plan order (issue #157); none for no plan. */
export type StepRecords = Readonly<{ done: readonly RecordedStep[]; unfinished: readonly RecordedStep[] }>;
export const stepRecordsOf = (plan: RecordedPlan | null): StepRecords => {
  const steps = plan === null ? [] : stepsOf(plan);
  return { done: steps.filter((s) => s.status === "done"), unfinished: steps.filter((s) => s.status === "unfinished") };
};

/** The plan as the agent returns it: without the statuses. */
export const stripStatuses = (plan: RecordedPlan): Plan => ({
  stages: plan.stages.map((stage) => ({ ...stage, steps: stage.steps.map(({ status: _status, ...st }) => st) })),
});

/** The marker of a status in plan.md. */
export const STATUS_MARKER: Record<StepStatus, string> = { pending: " ", started: "~", done: "x", unfinished: "!" };
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/**
 * plan-review/plan.md, rendered from plan.json for the developer to read (F2): a heading per stage, then per step its
 * number, marker, label and id on one line, and its text below, every line indented by three spaces.
 */
export const renderPlanMarkdown = (plan: RecordedPlan): string => {
  const step = (st: RecordedStep): string => {
    const head = `${st.number}. [${STATUS_MARKER[st.status]}] ${oneLine(st.label)} (${st.id})`;
    return st.text === "" ? `${head}\n` : `${head}\n\n${st.text.split("\n").map((line) => `   ${line}`).join("\n")}\n`;
  };
  const stage = (s: RecordedPlan["stages"][number]): string => `## ${stageHeading(s.number, oneLine(s.title))}\n\n${s.steps.map(step).join("\n")}`;
  return `# Plan\n\nMarkers: [x] done, [~] started, [!] unfinished, [ ] pending. plan.json is the plan; this file is rendered from it.\n\n${plan.stages.map(stage).join("\n")}`;
};
