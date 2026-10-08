// The progress rail as a tree that collapses (issue #63): which of its nodes are open, and what a collapsed node carries
// of what it hides. Pure; the component renders it and sends the user's toggles as the run's shared state.
import { planStepLabel, stageHeading } from "../../src/prompts.ts";
import { choiceOf, type UiScope } from "../../src/uiState.ts";
import { bandKey, currentIndex, currentPlanStep, currentStepIndex, type planStepState, type RunView, type StepState, type ShownStage, type TimelineEntry, type TimelineStep } from "./state.ts";

/** The condition of a branch in one word, from the steps it hides: none started, some, or all finished. */
export type Condition = "notStarted" | "partial" | "completed";
/** The steps complete of the steps a branch hides; a branch without steps has none. */
export type StepTally = Readonly<{ done: number; total: number }>;
/** What a collapsed row carries: the label of the step that runs inside it, its condition and its tally. */
export type Collapsed = Readonly<{ running: string | null; condition: Condition | null; tally: StepTally | null }>;
/** A row with nothing beneath it (issue #110): its mark, its label and its time, and no control. */
export type Plain = Readonly<{ _tag: "Plain" }>;
/**
 * A row with something beneath it, whose mark is its disclosure control (issue #110): whether it is open, and whether it is
 * held open because something inside needs the user.
 */
export type Disclosure = Readonly<{ _tag: "Disclosure"; scope: UiScope; open: boolean; held: boolean; collapsed: Collapsed }>;
/** A node of the rail: a plain row, or a disclosure; a row without children cannot carry an open state. */
export type NodeView = Plain | Disclosure;
export const PLAIN: Plain = { _tag: "Plain" };
/** A phase of the rail with its node and its branches' nodes, keyed `step:<kind>` or `stage:<key>`. */
export type RailPhase = Readonly<{ entry: TimelineEntry; node: NodeView; branches: ReadonlyMap<string, NodeView> }>;
export type RailView = Readonly<{ phases: readonly RailPhase[] }>;

/** Whether a phase has something to disclose: its cycles, its steps, or its plan. */
export const phaseHasChildren = (entry: TimelineEntry): boolean => entry.groups.length > 0 || entry.steps.length > 0 || entry.plan !== null;
/** Whether a step of Gather Requirements has something to disclose: its cycles. */
export const stepHasChildren = (step: TimelineStep): boolean => step.groups.length > 0;
/** Whether a stage of the plan has something to disclose: its steps. */
export const stageHasChildren = (stage: ShownStage): boolean => stage.steps.length > 0;
// The rail's marks: text glyphs, not an icon set (docs/ui-review.md). Ahead and not reached are hollow, not reached muted
// by a translucent color (never an opacity; issue #109); skipped is a dash: the phase ended without needing the step.
/** The mark of a phase and of a step of Gather Requirements, by its state. */
export const MARK = { done: "✓", active: "●", stopped: "■", ahead: "○", notReached: "○", skipped: "–" } as const satisfies Record<StepState, string>;
/** The mark of a step of the plan, by its state. */
export const STEP_MARK = { done: "✓", current: "●", unfinished: "◐", pending: "○" } as const satisfies Record<ReturnType<typeof planStepState>, string>;
type StageMark = (typeof STEP_MARK)["pending" | "unfinished" | "done"];
/** A stage's leading glyph (issue #114), in its steps' vocabulary: not begun, begun and not finished, done. */
const STAGE_GLYPH: Record<Condition, StageMark> = { notStarted: STEP_MARK.pending, partial: STEP_MARK.unfinished, completed: STEP_MARK.done };
export const stageGlyph = (condition: Condition): StageMark => STAGE_GLYPH[condition];

/** The condition of `total` steps of which `started` began and `finished` ended; null without steps. */
export const conditionOf = (started: number, finished: number, total: number): Condition | null =>
  total === 0 ? null : started === 0 ? "notStarted" : finished === total ? "completed" : "partial";

/** Steps counted as begun and as finished, with their total: the one source of a branch's condition and tally. */
type Count = Readonly<{ started: number; finished: number; total: number }>;
const NONE: Count = { started: 0, finished: 0, total: 0 };
const add = (a: Count, b: Count): Count => ({ started: a.started + b.started, finished: a.finished + b.finished, total: a.total + b.total });
const collapsedOf = (count: Count, running: string | null): Collapsed => ({
  running,
  condition: conditionOf(count.started, count.finished, count.total),
  tally: count.total === 0 ? null : { done: count.finished, total: count.total },
});
/** A stage's plan steps: a step started, done or left unfinished has begun; a done one has finished. */
const stageCount = (stage: ShownStage): Count =>
  stage.steps.reduce((c, x) => add(c, { started: x.status === "pending" ? 0 : 1, finished: x.status === "done" ? 1 : 0, total: 1 }), NONE);
/** The condition of a stage's steps; null for a stage without steps. */
export const stageCondition = (stage: ShownStage): Condition | null => {
  const c = stageCount(stage);
  return conditionOf(c.started, c.finished, c.total);
};
/** Gather Requirements' steps: begun unless ahead or not reached; a skipped step is left out of the count. */
const gatherCount = (steps: readonly TimelineStep[]): Count =>
  steps.reduce((c, st) => (st.state === "skipped" ? c : add(c, { started: st.state === "ahead" || st.state === "notReached" ? 0 : 1, finished: st.state === "done" ? 1 : 0, total: 1 })), NONE);

/** A node: the user's choice where he made one, else the run's automatic opening; held open whatever he chose. */
const nodeOf = (run: RunView, scope: UiScope, auto: boolean, held: boolean, collapsed: Collapsed): Disclosure => {
  const choice = choiceOf(run.ui, scope);
  return { _tag: "Disclosure", scope, open: held || (choice === "untouched" ? auto : choice === "open"), held, collapsed };
};

/**
 * The index of the entry that needs the user: the one the run is in while a prompt waits; after a halt, the stopped one, or
 * the one the run was in when no phase was active (a halt while the question after an execution call waited; W1-R1-1).
 */
const needingIndex = (run: RunView): number => {
  if (run.pending !== null) return currentIndex(run.timeline);
  if (run.ended !== 1) return -1;
  const stopped = run.timeline.findIndex((e) => e.state === "stopped");
  return stopped >= 0 ? stopped : currentIndex(run.timeline);
};
/** The step of the plan the run is at in an entry: the current one, else the last reported running unless it is done. */
const stepAt = (entry: TimelineEntry): string | null => {
  if (entry.currentStep !== null) return entry.currentStep;
  const last = entry.lastStarted;
  if (last === null) return null;
  const step = (entry.plan?.stages ?? []).flatMap((st) => st.steps).find((x) => x.id === last);
  return step === undefined || step.status === "done" ? null : last;
};

/** The rail of a run: `executing`, an execution call runs; `busy`, an agent call runs. */
export const railView = (run: RunView, executing: boolean, busy: boolean): RailView => {
  const needing = needingIndex(run);
  return {
    phases: run.timeline.map((entry, index): RailPhase => {
      const phase = bandKey(entry.phase);
      const needs = index === needing;
      const current = busy ? currentPlanStep(entry, executing) : null;
      const at = needs ? stepAt(entry) : null;
      const stages = entry.plan?.stages ?? [];
      const runningIn = (stage: ShownStage) => stage.steps.find((x) => x.id === current);
      const stageNodes = stages.map((stage): readonly [string, NodeView] => {
        const step = runningIn(stage);
        const auto = stage.steps.some((x) => entry.acted.includes(x.id));
        const held = at !== null && stage.steps.some((x) => x.id === at);
        if (!stageHasChildren(stage)) return [`stage:${stage.key}`, PLAIN];
        return [`stage:${stage.key}`, nodeOf(run, { _tag: "RailBranch", phase, branch: `stage:${stage.key}` }, auto, held, collapsedOf(stageCount(stage), step === undefined ? null : planStepLabel(step.number, step.label)))];
      });
      const heldStep = needs ? currentStepIndex(entry.steps) : -1;
      const stepNodes = entry.steps.map((st, i): readonly [string, NodeView] => {
        if (!stepHasChildren(st)) return [`step:${st.kind}`, PLAIN];
        const auto = st.state !== "ahead" && st.state !== "notReached" && st.state !== "skipped";
        return [`step:${st.kind}`, nodeOf(run, { _tag: "RailBranch", phase, branch: `step:${st.kind}` }, auto, i === heldStep, collapsedOf(NONE, null))];
      });
      const runningStage = stages.find((stage) => runningIn(stage) !== undefined);
      const runningStep = runningStage === undefined ? undefined : runningIn(runningStage);
      const activeStep = busy ? entry.steps.find((st) => st.state === "active") : undefined;
      const running =
        runningStage !== undefined && runningStep !== undefined
          ? `${stageHeading(runningStage.number, runningStage.title)} — ${planStepLabel(runningStep.number, runningStep.label)}`
          : activeStep !== undefined
            ? activeStep.label
            : null;
      const count = stages.length > 0 ? stages.map(stageCount).reduce(add, NONE) : gatherCount(entry.steps);
      return {
        entry,
        node: phaseHasChildren(entry) ? nodeOf(run, { _tag: "RailPhase", phase }, entry.began !== null, needs, collapsedOf(count, running)) : PLAIN,
        branches: new Map([...stepNodes, ...stageNodes]),
      };
    }),
  };
};
