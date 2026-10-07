<script lang="ts">
  // The current agent call and its last tool use, replaced by each event [visibility of system status]; while the program
  // waits to retry a call (issue #26, W1-R1-4), the indeterminate indicator beside it: busy, with no value and no estimate.
  // Issue #68: while the program waits for a usage limit whose end the agent's service stated, M3's determinate linear
  // indicator instead, with the fraction of the wait elapsed and the time remaining: the one place the end is known.
  import { LinearProgress } from "m3-svelte";
  import Indeterminate from "./Indeterminate.svelte";
  import { RETRY_WAITING_LABEL, USAGE_LIMIT_WAITING_LABEL, usageLimitRemaining } from "../../../src/prompts.ts";
  import { type LimitWait, limitWaitView } from "../state.ts";
  type Props = { text: string; busy?: boolean; wait?: LimitWait | null };
  let { text, busy = false, wait = null }: Props = $props();
  // The clock of the remaining time: the edge of the component, ticking once per second while a wait is shown.
  let now = $state(Date.now());
  $effect(() => {
    if (wait === null) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const view = $derived(wait === null ? null : limitWaitView(wait, now));
</script>

<div class="line">
  <p class="activity m3-font-body-small" aria-live="polite" data-activity>{text === "" ? "No agent is working." : text}</p>
  {#if view !== null}
    <div class="waiting" data-limit-wait><LinearProgress percent={view.percent} aria-label={USAGE_LIMIT_WAITING_LABEL} {...{ "aria-valuenow": Math.round(view.percent), "aria-valuemin": 0, "aria-valuemax": 100 }} /></div>
    <span class="remaining m3-font-body-small" data-remaining>{usageLimitRemaining(view.remainingMs)}</span>
  {:else if busy}<div class="waiting" data-waiting><Indeterminate label={RETRY_WAITING_LABEL} /></div>{/if}
</div>

<style>
  .line { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 1rem; }
  .activity { margin: 0; flex: 1 1 auto; min-width: 0; color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .waiting { flex: 0 0 6rem; }
  .remaining { flex: 0 0 auto; color: var(--m3c-on-surface-variant); white-space: nowrap; }
</style>
