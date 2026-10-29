<script lang="ts">
  // The dashboard's one status line (issue #22), the activity line moved and renamed: what is happening now, replaced by
  // each change [visibility of system status]. It asserts what is happening now and not how long it will take; only a
  // wait whose end the program knows carries M3's determinate linear indicator, counting it down with the time remaining:
  // the backoff before a retry (issues #26, #63) and a usage limit whose end the agent's service stated (issue #68).
  // Full, in a prominent type role and wrapping, since Interloq's lines carry paths and reasons the developer must read;
  // compact, one line ellipsized with its whole text as its title, under a question or the decision page, where the
  // column belongs to the question [aesthetic and minimalist design].
  import { DASHBOARD_INTERLOQ_LABEL, NO_AGENT_WORKING, RETRY_WAITING_LABEL, USAGE_LIMIT_WAITING_LABEL } from "../../../src/prompts.ts";
  import { type Countdown as Wait, type LimitWait, type Status, statusText } from "../state.ts";
  import Countdown from "./Countdown.svelte";
  type Props = { status: Status; retry?: Wait | null; wait?: LimitWait | null; compact?: boolean };
  let { status, retry = null, wait = null, compact = false }: Props = $props();
  const text = $derived(status._tag === "Idle" ? NO_AGENT_WORKING : statusText(status));
</script>

<div class="line" class:compact>
  {#if !compact}<span class="label m3-font-label-small">{DASHBOARD_INTERLOQ_LABEL}</span>{/if}
  <div class="row">
    <p class="status" class:compact aria-live="polite" data-status title={compact ? text : undefined}>{text}</p>
    {#if wait !== null}
      <Countdown {wait} label={USAGE_LIMIT_WAITING_LABEL} attr="data-limit-wait" />
    {:else if retry !== null}
      <Countdown wait={retry} label={RETRY_WAITING_LABEL} attr="data-retry-wait" />
    {/if}
  </div>
</div>

<style>
  .line { display: flex; flex-direction: column; gap: 0.125rem; }
  .line.compact { padding: 0.25rem 1rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; }
  .label { color: var(--m3c-on-surface-variant); font-size: 0.6875rem; line-height: 1rem; letter-spacing: 0.03125rem; font-weight: 500; }
  /* M3's title-medium, set here because the m3-font-* classes are absent from the build (as QuestionPane does). */
  .status { margin: 0; flex: 1 1 auto; min-width: 0; color: var(--m3c-on-surface); font-size: 1rem; line-height: 1.5rem; letter-spacing: 0.009375rem; font-weight: 500; white-space: pre-line; overflow-wrap: anywhere; }
  .status.compact { color: var(--m3c-on-surface-variant); font-size: 0.75rem; line-height: 1rem; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
