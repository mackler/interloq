<script lang="ts">
  // The progress of the run (decision Q3) [visibility of system status]: the phases in the order they occurred,
  // each done, active or stopped, the cycles of each review loop nested (one line each while the loop runs, one line
  // for the whole loop when it has ended; issue #14), the steps of Gather Requirements with the clarification's count
  // (issue #21), and a progress indicator while an agent works. Issue #6: the whole run, the phases ahead included, and
  // under the Implementation that carries it out the plan's stages and steps, each step's full text in a rich tooltip.
  // Issue #50: the indicator and the current call's time are on the step that runs (its mark becomes the circular
  // indicator), the phase keeps an indicator only while none of its steps runs, and each phase shows its own time.
  // Issue #63: the tree collapses. Each phase, step of Gather Requirements and stage of the plan is a disclosure whose
  // state is the run's shared state (`rail`, from web/src/rail.ts); a collapsed row carries the running step with the
  // circular indicator, its condition in one word and a determinate bar of steps complete [visibility of system status],
  // and hides the cycle lines [aesthetic and minimalist design]. The phase's indicator is the circular one on its mark;
  // no linear indeterminate bar remains.
  import { LinearProgress } from "m3-svelte";
  import { AGENT_WORKING_LABEL, clarificationProgress, RAIL_CONDITION_LABEL, RAIL_HELD_OPEN_LABEL, railToggleName, stepsCompleteLabel, cycleLine, loopSummary, NO_PHASE_YET, phaseElapsed, phaseTook, PLAN_LIST_LABEL, PLAN_STEP_STATE_LABEL, planStepLabel, PROGRESS_HEADING, runningFor, stageHeading, stepWorkingLabel, TIMELINE_STATE_LABEL } from "../../../src/prompts.ts";
  import { elapsedMs } from "../time.ts";
  import { bandKey, currentPlanStep, planStepState, type RoundGroup, type StepState, type TimelineEntry } from "../state.ts";
  import CircularIndeterminate from "./CircularIndeterminate.svelte";
  import StepTooltip from "./StepTooltip.svelte";
  import type { Collapsed, NodeView, RailView } from "../rail.ts";
  import type { UiScope } from "../../../src/uiState.ts";

  /**
   * `executing`: an execution call runs, so a started step of the plan is the current one (G-R1-2). `callStartedAt`: the
   * publication time of the current call's start, which the elapsed time is measured from (issue #42).
   */
  /** `rail`: which nodes are open and what a collapsed one carries; `onToggle`: the user opens or closes a node. */
  type Props = { timeline: readonly TimelineEntry[]; busy: boolean; executing?: boolean; callStartedAt?: string | null; rail: RailView; onToggle: (scope: UiScope, open: boolean) => void };
  let { timeline, busy, executing = false, callStartedAt = null, rail, onToggle }: Props = $props();
  const CLOSED: NodeView = { scope: { _tag: "RailPhase", phase: "" }, open: false, held: false, collapsed: { running: null, condition: null, tally: null } };
  const phaseNode = (i: number): NodeView => rail.phases[i]?.node ?? CLOSED;
  const branchNode = (i: number, key: string): NodeView => rail.phases[i]?.branches.get(key) ?? CLOSED;
  /** A unique id per node of this rail: aria-controls and aria-describedby name the node's body and its note. */
  const uid = $props.id();
  const idOf = (node: NodeView, part: string) => `${uid}-${part}-${JSON.stringify(node.scope).replace(/[^A-Za-z0-9]+/g, "-")}`;
  const toggle = (node: NodeView) => {
    if (!node.held) onToggle(node.scope, !node.open);
  };
  // The clock of the elapsed times: the edge of the component, ticking once per second while a phase is active (its
  // time runs whether or not a call runs) or a call runs.
  let now = $state(Date.now());
  const ticking = $derived(timeline.some((e) => e.state === "active") || (busy && callStartedAt !== null));
  $effect(() => {
    if (!ticking) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Text glyphs, not an icon set (docs/ui-review.md): ahead and not reached are hollow, not reached muted; skipped is a
  // dash: the phase ended without needing the step.
  const MARK: Record<StepState, string> = { done: "✓", active: "●", stopped: "■", ahead: "○", notReached: "○", skipped: "–" };
  const LABEL = TIMELINE_STATE_LABEL;
  const STEP_MARK: Record<ReturnType<typeof planStepState>, string> = { done: "✓", current: "●", unfinished: "◐", pending: "○" };
  /** The phase's own time: how long it took once ended, how long it has run while active, nothing before it began. */
  const phaseTime = (entry: TimelineEntry, at: number): string | null =>
    entry.began === null ? null : entry.ended !== null ? phaseTook(elapsedMs(entry.began, Date.parse(entry.ended))) : entry.state === "active" ? phaseElapsed(elapsedMs(entry.began, at)) : null;
  /** Whether a step of the entry runs, so that the step and not the phase carries the indicator. */
  const stepRuns = (entry: TimelineEntry): boolean => entry.steps.some((st) => st.state === "active") || currentPlanStep(entry, executing) !== null;
</script>

{#snippet toggleButton(node: NodeView, label: string, labelClass: string, attr: string)}
  <!-- A native button, so that Enter and Space open and close it [flexibility and efficiency of use]; held open, it is
       reachable and says why it does not close [error prevention]. -->
  <button
    type="button"
    class="rail-toggle"
    aria-expanded={node.open}
    aria-controls={node.open ? idOf(node, "body") : undefined}
    aria-disabled={node.held ? "true" : undefined}
    aria-describedby={node.held ? idOf(node, "held") : undefined}
    aria-label={railToggleName(label, node.open, node.collapsed.condition === null ? null : RAIL_CONDITION_LABEL[node.collapsed.condition], node.collapsed.running)}
    onclick={() => toggle(node)}
  >
    <span class="chevron" class:expanded={node.open} aria-hidden="true"></span>
    <span class={labelClass} {...{ [attr]: "" }}>{label}</span>
  </button>
  {#if node.held}<span class="visually-hidden" id={idOf(node, "held")}>{RAIL_HELD_OPEN_LABEL}</span>{/if}
{/snippet}

{#snippet collapsedRow(c: Collapsed)}
  {#if c.running !== null || c.condition !== null || c.tally !== null}
    <div class="collapsed" data-collapsed>
      {#if c.running !== null}
        <span class="m3-font-body-small running" data-running><span class="inline-mark"><CircularIndeterminate label={`${AGENT_WORKING_LABEL}: ${c.running}`} glyph="●" /></span><span>{c.running}</span>{@render elapsed()}</span>
      {/if}
      {#if c.condition !== null}<span class="m3-font-body-small condition" data-condition>{RAIL_CONDITION_LABEL[c.condition]}</span>{/if}
      {#if c.tally !== null}
        <div class="tally" data-tally><LinearProgress percent={(c.tally.done / c.tally.total) * 100} aria-label={stepsCompleteLabel(c.tally.done, c.tally.total)} {...{ "aria-valuenow": Math.round((c.tally.done / c.tally.total) * 100), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuetext": stepsCompleteLabel(c.tally.done, c.tally.total) }} /></div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet elapsed()}
  {#if callStartedAt !== null}<span class="m3-font-body-small elapsed" data-elapsed>{runningFor(elapsedMs(callStartedAt, now))}</span>{/if}
{/snippet}

{#snippet loops(groups: readonly RoundGroup[])}
  {#each groups as group, g (g)}
    <div class="group {group.done ? 'done' : ''}">
      {#if groups.length > 1}<span class="m3-font-label-medium">{group.heading}</span>{/if}
      <ul>
        {#if group.result === null}
          {#each group.rounds as r (r.round)}<li class="m3-font-body-small" data-cycle>{cycleLine(r.round, r.raised, r.counted)}</li>{/each}
        {:else}
          <li class="m3-font-body-small" data-summary>{loopSummary(group.rounds.length, group.corrections, group.result)}</li>
        {/if}
      </ul>
    </div>
  {/each}
{/snippet}

<nav class="rail" aria-label="Progress of the run">
  <h2 class="m3-font-title-small">{PROGRESS_HEADING}</h2>
  {#if timeline.length === 0}
    <p class="m3-font-body-small muted">{NO_PHASE_YET}</p>
  {/if}
  <ol>
    {#each timeline as entry, i (i)}
      {@const node = phaseNode(i)}
      {@const phaseBusy = entry.state === "active" && busy && !stepRuns(entry)}
      <li class="entry {entry.state}" data-state={entry.state} aria-current={entry.state === "active" ? "step" : undefined}>
        {#if phaseBusy}
          <span class="mark"><CircularIndeterminate label={stepWorkingLabel("phaseStep")} glyph={MARK[entry.state]} /></span>
        {:else}
          <span class="mark" aria-label={LABEL[entry.state]}>{MARK[entry.state]}</span>
        {/if}
        {@render toggleButton(node, entry.label, "m3-font-label-large", "data-label")}
        {#if phaseTime(entry, now) !== null}<span class="m3-font-body-small phase-time" data-phase-time>{phaseTime(entry, now)}</span>{/if}
        {#if phaseBusy}{@render elapsed()}{/if}
        {#if !node.open}
          {@render collapsedRow(node.collapsed)}
        {:else}
        <div class="body" id={idOf(node, "body")}>
        {@render loops(entry.groups)}
        {#if entry.steps.length > 0}
          <ol class="steps">
            {#each entry.steps as step, s (s)}
              {@const stepNode = branchNode(i, `step:${step.kind}`)}
              <li class="step {step.state}" data-step={step.state} aria-current={step.state === "active" ? "step" : undefined}>
                {#if step.state === "active" && busy}
                  <span class="mark"><CircularIndeterminate label={stepWorkingLabel("phaseStep")} glyph={MARK[step.state]} /></span>
                {:else}
                  <span class="mark" aria-label={LABEL[step.state]}>{MARK[step.state]}</span>
                {/if}
                {@render toggleButton(stepNode, step.label, "m3-font-label-medium", "data-step-label")}
                {#if step.state === "active" && busy}{@render elapsed()}{/if}
                {#if step.count !== null}<span class="m3-font-body-small count" data-count>{clarificationProgress(step.count.answered, step.count.total)}</span>{/if}
                {#if stepNode.open}<div class="body" id={idOf(stepNode, "body")}>{@render loops(step.groups)}</div>{/if}
              </li>
            {/each}
          </ol>
        {/if}
        {#if entry.plan !== null}
          <ol class="plan" aria-label={PLAN_LIST_LABEL}>
            {#each entry.plan.stages as stage (stage.key)}
              {@const stageNode = branchNode(i, `stage:${stage.key}`)}
              <li class="stage">
                {@render toggleButton(stageNode, stageHeading(stage.number, stage.title), "m3-font-label-medium", "data-stage")}
                {#if !stageNode.open}
                  {@render collapsedRow(stageNode.collapsed)}
                {:else}
                <ol id={idOf(stageNode, "body")}>
                  {#each stage.steps as step (step.id)}
                    {@const state = planStepState(entry, step, executing)}
                    <li class="plan-step {state}" data-plan-step={state} aria-current={state === "current" ? "step" : undefined}>
                      {#if state === "current" && busy}
                        <span class="mark"><CircularIndeterminate label={stepWorkingLabel("planStep")} glyph={STEP_MARK[state]} /></span>
                      {:else}
                        <span class="mark" aria-label={PLAN_STEP_STATE_LABEL[state]}>{STEP_MARK[state]}</span>
                      {/if}
                      <StepTooltip key={`${bandKey(entry.phase)}-${step.id}`} label={planStepLabel(step.number, step.label)} text={step.text} />
                      {#if state === "current" && busy}{@render elapsed()}{/if}
                    </li>
                  {/each}
                </ol>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
        </div>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .rail { padding: 1rem 0.75rem; overflow-y: auto; }
  h2 { margin: 0 0 0.75rem; color: var(--m3c-on-surface-variant); }
  ol, ul { list-style: none; margin: 0; padding: 0; }
  .entry { position: relative; padding: 0.5rem 0.5rem 0.5rem 1.75rem; border-radius: var(--m3-shape-medium); }
  .entry.active { background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .entry.done { color: var(--m3c-on-surface-variant); }
  .entry.stopped { color: var(--m3c-error); }
  .entry.ahead { color: var(--m3c-on-surface-variant); }
  .entry.notReached { color: var(--m3c-on-surface-variant); opacity: 0.6; }
  .plan { margin: 0.25rem 0 0; }
  .stage { margin-top: 0.25rem; }
  .plan-step { position: relative; padding: 0.125rem 0 0.125rem 1.5rem; }
  .plan-step .mark { left: 0.25rem; }
  .plan-step.done { opacity: 0.8; }
  .plan-step.current { font-weight: 600; }
  .mark { position: absolute; left: 0.5rem; }
  .steps { margin: 0.25rem 0 0; }
  .step { position: relative; padding: 0.25rem 0 0.25rem 1.5rem; }
  .step .mark { left: 0.25rem; }
  .step.done { opacity: 0.8; }
  .step.stopped { color: var(--m3c-error); }
  .step.skipped { color: var(--m3c-on-surface-variant); }
  .count { display: block; }
  .group { margin: 0.25rem 0 0 0.25rem; }
  .group.done { opacity: 0.8; }
  .muted { color: var(--m3c-on-surface-variant); }
  .entry > .elapsed { display: block; }
  /* Issue #63: the disclosure of a row, after the one of a decision's entry (issue #87): a native button with a chevron,
     a state layer of the on-surface color on hover (8 %), focus and press (10 %), a focus ring, the standard easing. */
  .rail-toggle { position: relative; display: inline-flex; align-items: baseline; gap: 0.375rem; max-width: 100%; margin: 0 0 0 -0.25rem; padding: 0.125rem 0.25rem; border: 0; border-radius: var(--m3-shape-small); background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; overflow: hidden; }
  .rail-toggle::before { content: ""; position: absolute; inset: 0; background: var(--m3c-on-surface); opacity: 0; transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1); pointer-events: none; }
  .rail-toggle:hover::before { opacity: 0.08; }
  .rail-toggle:focus-visible::before, .rail-toggle:active::before { opacity: 0.1; }
  .rail-toggle:focus-visible { outline: 3px solid var(--m3c-secondary); outline-offset: 2px; }
  .rail-toggle[aria-disabled="true"] { cursor: default; }
  .chevron { flex: none; width: 0.4rem; height: 0.4rem; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg) translateY(-0.1rem); transition: transform 200ms cubic-bezier(0.2, 0, 0, 1); }
  .chevron.expanded { transform: rotate(45deg) translateY(-0.1rem); }
  @media (prefers-reduced-motion: reduce) {
    .rail-toggle::before, .chevron { transition: none; }
  }
  .collapsed { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.25rem 0 0 0.75rem; }
  .running { display: flex; align-items: baseline; gap: 0.375rem; flex-wrap: wrap; }
  .inline-mark { display: inline-block; width: 1em; }
  .condition { color: var(--m3c-on-surface-variant); }
  .tally { max-width: 10rem; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .elapsed { color: var(--m3c-on-surface-variant); font-variant-numeric: tabular-nums; }
  .step > .elapsed, .plan-step > .elapsed { display: block; }
  .phase-time { display: block; color: var(--m3c-on-surface-variant); font-variant-numeric: tabular-nums; }
</style>
