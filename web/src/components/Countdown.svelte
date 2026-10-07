<script lang="ts">
  // Issues #63 and #68: M3's determinate linear indicator over a wait whose start and end the program knows (a retry's
  // backoff, a usage limit's reset), with the time remaining beside it [visibility of system status]. It shows the
  // fraction of the wait elapsed, and nothing once the wait has ended: the clock ticks once per second and once more at
  // the wait's end, so the indicator goes at that instant and never asserts a wait that is over.
  import { LinearProgress } from "m3-svelte";
  import { remainingTime } from "../../../src/prompts.ts";
  import { type Countdown, countdownView } from "../state.ts";
  type Props = { wait: Countdown; label: string; attr: string };
  let { wait, label, attr }: Props = $props();
  let now = $state(Date.now());
  $effect(() => {
    const until = wait.untilMs;
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), 1000);
    const end = setTimeout(() => (now = Math.max(Date.now(), until)), Math.max(until - Date.now(), 0));
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
  });
  const view = $derived(countdownView(wait, now));
</script>

{#if view !== null}
  <div class="waiting" {...{ [attr]: "" }}><LinearProgress percent={view.percent} aria-label={label} {...{ "aria-valuenow": Math.round(view.percent), "aria-valuemin": 0, "aria-valuemax": 100 }} /></div>
  <span class="remaining m3-font-body-small" data-remaining>{remainingTime(view.remainingMs)}</span>
{/if}

<style>
  .waiting { flex: 0 0 6rem; }
  .remaining { flex: 0 0 auto; color: var(--m3c-on-surface-variant); white-space: nowrap; }
</style>
