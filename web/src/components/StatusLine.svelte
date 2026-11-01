<script lang="ts">
  // The dashboard's one status line (issue #22), the activity line moved and renamed: what is happening now, replaced by
  // each change [visibility of system status]. It asserts what is happening now and not how long it will take; only a
  // wait whose end the program knows carries M3's determinate linear indicator, counting it down with the time remaining:
  // the backoff before a retry (issues #26, #63) and a usage limit whose end the agent's service stated (issue #68).
  // Full, in a prominent type role and wrapping, since Interloq's lines carry paths and reasons the developer must read;
  // compact, one line ellipsized with its whole text as its title, under a question or the decision page, where the
  // column belongs to the question [aesthetic and minimalist design].
  // Issue #215: beside the countdown, while it runs, the text button "Try again now" ends the wait whose countdown it
  // shows [user control and freedom]. It asserts only that the wait ends and the request is made again, never that a
  // limit has lifted or that a connection is back. It follows the countdown's interval, not the wait's presence in the
  // view, and is disabled once pressed for that wait, since the page sends one frame per wait.
  import { Button } from "m3-svelte";
  import { DASHBOARD_INTERLOQ_LABEL, END_WAIT_LABEL, NO_AGENT_WORKING, RETRY_WAITING_LABEL, USAGE_LIMIT_WAITING_LABEL } from "../../../src/prompts.ts";
  import { countdownView, type EndableWait, type LimitWait, type Status, statusText } from "../state.ts";
  import Countdown from "./Countdown.svelte";
  type Props = { status: Status; retry?: EndableWait | null; wait?: LimitWait | null; compact?: boolean; onEndWait?: (wait: number) => void; endWaitSent?: (wait: number) => boolean };
  let { status, retry = null, wait = null, compact = false, onEndWait = () => {}, endWaitSent = () => false }: Props = $props();
  const text = $derived(status._tag === "Idle" ? NO_AGENT_WORKING : statusText(status));
  /** The wait whose countdown the line shows: the usage limit's first, else the retry's. */
  const shown = $derived<EndableWait | null>(wait ?? retry);
  let now = $state(Date.now());
  $effect(() => {
    if (shown === null) return;
    const until = shown.untilMs;
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), 1000);
    const end = setTimeout(() => (now = Math.max(Date.now(), until)), Math.max(until - Date.now(), 0));
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
  });
  const endable = $derived(shown !== null && countdownView(shown, now) !== null ? shown : null);
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
    {#if endable !== null}
      <span class="end-wait"><Button variant="text" type="button" name="end-wait" disabled={endWaitSent(endable.waitId)} onclick={() => onEndWait(endable.waitId)}>{END_WAIT_LABEL}</Button></span>
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
  .end-wait { flex: 0 0 auto; }
</style>
