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
  import { Switch, TextFieldOutlined } from "m3-svelte";
  import { CHAIN_CUTOFF_LABEL, CHAIN_CUTOFF_SUPPORT, CHAIN_INVALID_RUNS, CHAIN_RUNS_LABEL, CHAIN_RUNS_SUPPORT, CHAIN_SWITCH_LABEL, chainCutoffResolved } from "../../../src/prompts.ts";
  import type { ChainFrameSettings } from "../../../src/protocol.ts";
  import type { ChainShown } from "../state.ts";
  import { acknowledged, effective, NO_IN_FLIGHT, sent } from "../chainPending.ts";
  import { cutoffAt } from "../cutoff.ts";
  import { fullTime } from "../time.ts";

  let { shown, onChange, now = () => new Date() }: { shown: ChainShown; onChange: (settings: ChainFrameSettings) => void; now?: () => Date } = $props();

  const pad = (n: number) => String(n).padStart(2, "0");
  const hourOf = (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  let runsText = $state("");
  let cutoffText = $state("");
  let runsInvalid = $state(false);
  // The frames this tab sent and the server has not acknowledged (W3-R1-1): every frame is composed from the last of
  // them, so two changes made before the server answers never undo each other.
  let inFlight = $state(NO_IN_FLIGHT);
  // The fields follow the server's settings whenever they change, from this tab or another. The effect tracks these three
  // deriveds alone, numbers, booleans or null, so an event that gives a new but equal `shown` leaves a draft and its
  // error alone (W1-R1-4): a derived notifies its dependents only when its value changes. The reconciliation reads
  // `shown` and `inFlight` untracked, so neither is a dependency and its own write of `inFlight` does not rerun it, and
  // it resets the drafts from the frames still in flight, so a committed change not yet acknowledged keeps its value
  // when an earlier change's acknowledgment arrives.
  const enabledNow = $derived(shown.settings.enabled);
  const runsLimit = $derived(shown.settings.limits.runs);
  const cutoffLimit = $derived(shown.settings.limits.cutoff);
  $effect(() => {
    void [enabledNow, runsLimit, cutoffLimit];
    untrack(() => {
      inFlight = acknowledged(inFlight, shown.settings);
      const e = effective(inFlight, shown.settings);
      runsText = e.runs === null ? "" : String(e.runs);
      cutoffText = e.cutoff === null ? "" : hourOf(Date.parse(e.cutoff));
      runsInvalid = false;
    });
  });

  // What the control shows and composes every frame from: the last frame it sent, else the server's settings.
  const shownNow = $derived(effective(inFlight, shown.settings));
  const send = (frame: ChainFrameSettings) => {
    inFlight = sent(inFlight, frame);
    onChange(frame);
  };
  const toggle = (enabled: boolean) => send({ ...shownNow, enabled });
  const commitRuns = () => {
    const text = runsText.trim();
    if (text === "") {
      // An empty field is valid and means no limit; the effect above does not rerun when the server's limit stays null,
      // so the error is cleared here (W2-R1-2).
      runsInvalid = false;
      return send({ ...shownNow, runs: null });
    }
    const n = /^[0-9]+$/u.test(text) ? Number(text) : Number.NaN;
    runsInvalid = !(Number.isSafeInteger(n) && n >= 1);
    if (!runsInvalid) send({ ...shownNow, runs: n });
  };
  const commitCutoff = () => {
    if (cutoffText.trim() === "") return send({ ...shownNow, cutoff: null });
    const resolved = cutoffAt(cutoffText, now());
    if (Result.isSuccess(resolved)) send({ ...shownNow, cutoff: new Date(resolved.success).toISOString() });
  };
  const onEnter = (commit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
</script>

<section class="chain" aria-label={CHAIN_SWITCH_LABEL}>
  <label class="switch m3-font-label-large"><Switch name="chain" checked={shownNow.enabled} onchange={(e: Event) => toggle((e.currentTarget as HTMLInputElement).checked)} />{CHAIN_SWITCH_LABEL}</label>
  <div class="fields">
    <div class="field">
      <TextFieldOutlined label={CHAIN_RUNS_LABEL} name="chain-runs" inputmode="numeric" error={runsInvalid} bind:value={runsText} onchange={commitRuns} onkeydown={onEnter(commitRuns)} />
      <p class="support m3-font-body-small" class:error={runsInvalid} role={runsInvalid ? "alert" : undefined}>{runsInvalid ? CHAIN_INVALID_RUNS : CHAIN_RUNS_SUPPORT}</p>
    </div>
    <div class="field">
      <TextFieldOutlined label={CHAIN_CUTOFF_LABEL} name="chain-cutoff" type="time" bind:value={cutoffText} onchange={commitCutoff} onkeydown={onEnter(commitCutoff)} />
      <p class="support m3-font-body-small">{shownNow.cutoff === null ? CHAIN_CUTOFF_SUPPORT : chainCutoffResolved(fullTime(shownNow.cutoff))}</p>
    </div>
  </div>
  <p class="status m3-font-body-medium" role="status">{shown.status}{#if shown.ended !== null}<br /><span class="ended">{shown.ended}</span>{/if}</p>
  {#if shown.runs.length > 0}
    <ol class="runs m3-font-body-small">
      {#each shown.runs as line, i (i)}<li>{line}</li>{/each}
    </ol>
  {/if}
</section>

<style>
  .chain { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem 1rem; border-radius: var(--m3-shape-medium, 12px); background: var(--m3c-surface-container-low); color: var(--m3c-on-surface); }
  .switch { display: flex; align-items: center; gap: 0.75rem; }
  .fields { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .field { display: flex; flex-direction: column; flex: 1 1 10rem; min-width: 0; }
  .support { margin: 0.25rem 1rem 0; color: var(--m3c-on-surface-variant); font-size: 0.75rem; }
  .support.error { color: var(--m3c-error); }
  .status { margin: 0; overflow-wrap: anywhere; }
  .ended { color: var(--m3c-on-surface-variant); }
  .runs { margin: 0; padding-left: 1.25rem; color: var(--m3c-on-surface-variant); overflow-wrap: anywhere; }
</style>
