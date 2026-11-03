<script lang="ts">
  // Issue #147: the Implementation tab's control of the mode that starts the next refined item when a run ends. M3's
  // switch and two optional outlined text fields, both empty by default; under the cutoff the moment it resolved to in
  // the browser's time [visibility of system status: a cutoff set on an earlier day is never an unexplained idleness];
  // the status, why the last chain ended, and the chain's runs with any parked branch. The switch turns on with both
  // fields empty and never refuses an empty form (requirements Q2); a field is sent when it is committed (change or
  // Enter), and a runs field that is not a positive whole number shows its error and sends nothing [error prevention].
  // Nothing asks a confirmation (behavior 1), and nothing names a cost (Q2).
  import { Result } from "effect";
  import { untrack } from "svelte";
  import { Button, ConnectedButtons, Switch, TextFieldOutlined } from "m3-svelte";
  import { CHAIN_SOURCES, type ChainQueue, type QueueChange } from "../../../src/chainQueue.ts";
  import { CHAIN_SOURCE_LABEL, CHAIN_SOURCE_TEXTS, QUEUE_BACKLOG_NOTE, QUEUE_EMPTY, QUEUE_HEADING, CHAIN_CUTOFF_LABEL, CHAIN_CUTOFF_SUPPORT, CHAIN_INVALID_RUNS, CHAIN_RUNS_LABEL, CHAIN_RUNS_SUPPORT, CHAIN_SWITCH_LABEL, chainCutoffResolved } from "../../../src/prompts.ts";
  import type { ChainFrameSettings } from "../../../src/protocol.ts";
  import type { ChainShown } from "../state.ts";
  import { cutoffAt } from "../cutoff.ts";
  import Disclosure from "./Disclosure.svelte";
  import { fullTime } from "../time.ts";

  // Issue #196: `queue`, the queue the page shows (the server's with this page's pending edits), and `onQueueEdit`, which
  // sends a change of it. The choice of source is M3's connected buttons, two named, mutually exclusive choices
  // [recognition rather than recall], explicit and never inferred from the queue's emptiness; the queue itself is shown
  // read-only here, at the rail's width, and edited in the list view's QueueEditor.
  let {
    shown,
    onChange,
    now = () => new Date(),
    queue = null,
    onQueueEdit = () => undefined,
    runsOpen = false,
    onRunsToggle = () => undefined,
  }: {
    shown: ChainShown;
    onChange: (settings: ChainFrameSettings) => void;
    now?: () => Date;
    queue?: ChainQueue | null;
    onQueueEdit?: (change: QueueChange) => void;
    /** Issue #229: whether the runs line is open, held by the page so that it survives this control's remounts. */
    runsOpen?: boolean;
    onRunsToggle?: (open: boolean) => void;
  } = $props();
  const uid = $props.id();
  const runsListId = `${uid}-runs`;

  const pad = (n: number) => String(n).padStart(2, "0");
  const hourOf = (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  let runsText = $state("");
  let cutoffText = $state("");
  let runsInvalid = $state(false);
  // The fields follow the server's settings whenever they change, from this tab or another. The effect tracks these three
  // deriveds alone, numbers, booleans or null, so an event that gives a new but equal `shown` leaves a draft and its
  // error alone (W1-R1-4): a derived notifies its dependents only when its value changes. It resets the drafts from
  // `shown.effective`, read untracked: the frames not yet acknowledged, which the page holds (the work review of 21 Oct
  // 2026, W1-R1-1), else the server's settings, so a committed change keeps its value when an earlier change's
  // acknowledgment arrives, and a remounted control (a tab switch, a move to the rail's column) shows it at once. It
  // tracks the server's settings rather than `effective`, which changes with every frame this tab sends and would
  // overwrite a draft in the other field.
  const enabledNow = $derived(shown.settings.enabled);
  const runsLimit = $derived(shown.settings.limits.runs);
  const cutoffLimit = $derived(shown.settings.limits.cutoff);
  const runsFrom = (e: ChainFrameSettings) => {
    runsText = e.runs === null ? "" : String(e.runs);
    runsInvalid = false;
  };
  const cutoffFrom = (e: ChainFrameSettings) => {
    cutoffText = e.cutoff === null ? "" : hourOf(Date.parse(e.cutoff));
  };
  $effect(() => {
    void [enabledNow, runsLimit, cutoffLimit];
    untrack(() => {
      runsFrom(shown.effective);
      cutoffFrom(shown.effective);
    });
  });
  // A reset the effect above cannot see, since the server's settings stayed equal: a frame the failed page handed back,
  // or one a server restart dropped. Only the fields the page names are reset, so a draft in the other is kept. The
  // version seen at mount is not a reset: the effect above has just set every field.
  const resets = $derived(shown.reset.version);
  let seenReset = untrack(() => shown.reset.version);
  $effect(() => {
    const version = resets;
    untrack(() => {
      if (version === seenReset) return;
      seenReset = version;
      for (const field of shown.reset.fields) (field === "runs" ? runsFrom : cutoffFrom)(shown.effective);
    });
  });

  // Every frame is composed from `shown.effective`, the last frame not yet acknowledged, else the server's settings.
  const toggle = (enabled: boolean) => onChange({ ...shown.effective, enabled });
  const commitRuns = () => {
    const text = runsText.trim();
    if (text === "") {
      // An empty field is valid and means no limit; the effect above does not rerun when the server's limit stays null,
      // so the error is cleared here (W2-R1-2).
      runsInvalid = false;
      return onChange({ ...shown.effective, runs: null });
    }
    const n = /^[0-9]+$/u.test(text) ? Number(text) : Number.NaN;
    runsInvalid = !(Number.isSafeInteger(n) && n >= 1);
    if (!runsInvalid) onChange({ ...shown.effective, runs: n });
  };
  const commitCutoff = () => {
    if (cutoffText.trim() === "") return onChange({ ...shown.effective, cutoff: null });
    const resolved = cutoffAt(cutoffText, now());
    if (Result.isSuccess(resolved)) onChange({ ...shown.effective, cutoff: new Date(resolved.success).toISOString() });
  };
  const onEnter = (commit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
</script>

<section class="chain" aria-label={CHAIN_SWITCH_LABEL}>
  <label class="switch m3-font-label-large"><Switch name="chain" checked={shown.effective.enabled} onchange={(e: Event) => toggle((e.currentTarget as HTMLInputElement).checked)} />{CHAIN_SWITCH_LABEL}</label>
  <div class="fields">
    <div class="field">
      <TextFieldOutlined label={CHAIN_RUNS_LABEL} name="chain-runs" inputmode="numeric" error={runsInvalid} bind:value={runsText} onchange={commitRuns} onkeydown={onEnter(commitRuns)} />
      <p class="support m3-font-body-small" class:error={runsInvalid} role={runsInvalid ? "alert" : undefined}>{runsInvalid ? CHAIN_INVALID_RUNS : CHAIN_RUNS_SUPPORT}</p>
    </div>
    <div class="field">
      <TextFieldOutlined label={CHAIN_CUTOFF_LABEL} name="chain-cutoff" type="time" bind:value={cutoffText} onchange={commitCutoff} onkeydown={onEnter(commitCutoff)} />
      <p class="support m3-font-body-small">{shown.effective.cutoff === null ? CHAIN_CUTOFF_SUPPORT : chainCutoffResolved(fullTime(shown.effective.cutoff))}</p>
    </div>
  </div>
  {#if queue !== null}
    <div class="source">
      <span class="m3-font-label-large">{CHAIN_SOURCE_LABEL}</span>
      <ConnectedButtons role="radiogroup" aria-label={CHAIN_SOURCE_LABEL}>
        {#each CHAIN_SOURCES as value (value)}
          <Button variant="tonal" label>
            <input type="radio" name="chain-source" {value} checked={queue.source === value} onchange={() => onQueueEdit({ _tag: "Source", source: value })} />
            {CHAIN_SOURCE_TEXTS[value]}
          </Button>
        {/each}
      </ConnectedButtons>
    </div>
    {#if queue.source === "queue"}
      {#if queue.entries.length === 0}
        <p class="queue-empty m3-font-body-small">{QUEUE_EMPTY}</p>
      {:else}
        <ol class="queue m3-font-body-small" aria-label={QUEUE_HEADING}>
          {#each queue.entries as entry (entry.item)}<li data-queued={entry.item}>#{entry.item} {entry.title}</li>{/each}
        </ol>
      {/if}
    {:else if queue.entries.length > 0}
      <p class="queue-empty m3-font-body-small">{QUEUE_BACKLOG_NOTE}</p>
    {/if}
  {/if}
  <p class="status m3-font-body-medium" role="status">{shown.status}{#if shown.ended !== null}<br /><span class="ended">{shown.ended}</span>{/if}</p>
  <!-- Issue #229: the chain's runs are one line, which opens to the list as it was shown before, so that a long chain
       never pushes the progress rail down. -->
  {#if shown.runsLine !== null}
    <div class="runs-line" data-chain-runs>
      <Disclosure expanded={runsOpen} controls={runsListId} onToggle={onRunsToggle}>
        {#snippet title()}<span class="m3-font-label-large">{shown.runsLine}</span>{/snippet}
        <ol class="runs m3-font-body-small" id={runsListId}>
          {#each shown.runs as line, i (i)}<li>{line}</li>{/each}
        </ol>
      </Disclosure>
    </div>
  {/if}
</section>

<style>
  .chain { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem 1rem; border-radius: var(--m3-shape-medium, 12px); background: var(--m3c-surface-container-low); color: var(--m3c-on-surface); }
  .switch { display: flex; align-items: center; gap: 0.75rem; }
  .fields { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .field { display: flex; flex-direction: column; flex: 1 1 10rem; min-width: 0; }
  /* Issue #203: m3-svelte's outlined field sets min-width: 15rem on its own root, which held inside the wrapper and drew
     the field past the rail's column; its width yields to the column, its label, supporting text and error unchanged. */
  .field > :global(.m3-container) { min-width: 0; }
  .support { margin: 0.25rem 1rem 0; color: var(--m3c-on-surface-variant); font-size: 0.75rem; }
  .support.error { color: var(--m3c-error); }
  .status { margin: 0; overflow-wrap: anywhere; }
  .ended { color: var(--m3c-on-surface-variant); }
  .source { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  /* The two choices share the rail's 14rem column: each label wraps rather than drawing past it. */
  .source :global(.m3-container > *) { min-width: 0; white-space: normal; height: auto; min-height: 2.5rem; }
  .queue { margin: 0; padding-left: 1.25rem; overflow-wrap: anywhere; }
  .queue-empty { margin: 0; color: var(--m3c-on-surface-variant); overflow-wrap: anywhere; }
  .runs-line { min-width: 0; overflow-wrap: anywhere; }
  .runs { margin: 0; padding-left: 1.25rem; color: var(--m3c-on-surface-variant); overflow-wrap: anywhere; }
</style>
