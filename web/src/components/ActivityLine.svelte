<script lang="ts">
  // The current agent call and its last tool use, replaced by each event [visibility of system status]. While the program
  // waits through a wait whose end it knows, M3's determinate linear indicator counts it down, with the time remaining:
  // the backoff before a retry (issue #26; issue #63 replaced its indeterminate indicator, since the program sleeps for
  // exactly the wait it announced) and a usage limit whose end the agent's service stated (issue #68). One component,
  // Countdown, for both.
  import { RETRY_WAITING_LABEL, USAGE_LIMIT_WAITING_LABEL } from "../../../src/prompts.ts";
  import type { Countdown as Wait, LimitWait } from "../state.ts";
  import Countdown from "./Countdown.svelte";
  type Props = { text: string; retry?: Wait | null; wait?: LimitWait | null };
  let { text, retry = null, wait = null }: Props = $props();
</script>

<div class="line">
  <p class="activity m3-font-body-small" aria-live="polite" data-activity>{text === "" ? "No agent is working." : text}</p>
  {#if wait !== null}
    <Countdown {wait} label={USAGE_LIMIT_WAITING_LABEL} attr="data-limit-wait" />
  {:else if retry !== null}
    <Countdown wait={retry} label={RETRY_WAITING_LABEL} attr="data-retry-wait" />
  {/if}
</div>

<style>
  .line { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 1rem; }
  .activity { margin: 0; flex: 1 1 auto; min-width: 0; color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
