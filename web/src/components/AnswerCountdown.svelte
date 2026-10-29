<script lang="ts">
  // Issue #185: the wait of a question that counts down, with the time remaining and what its end does, and the button
  // that stops it for good [visibility of system status; user control and freedom]. The indicator is the Countdown the
  // status line shows for a usage-limit wait, a wait whose end the server knows, so it asserts nothing more.
  import { Button } from "m3-svelte";
  import type { Countdown as AnswerWait } from "../../../src/protocol.ts";
  import { answerCountdownLabel, limitCountdownLabel, remainingTime, WORKING_ON_IT } from "../../../src/prompts.ts";
  import Countdown from "./Countdown.svelte";
  type Props = { wait: AnswerWait; onHold: () => void };
  let { wait, onHold }: Props = $props();
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
  const remaining = $derived(remainingTime(Math.max(wait.untilMs - now, 0)));
  const label = $derived(wait.then === "abandon" ? answerCountdownLabel(remaining) : limitCountdownLabel(remaining));
</script>

<div class="answer-countdown" data-answer-countdown>
  <p class="label m3-font-body-small">{label}</p>
  <div class="row">
    <Countdown {wait} label={label} attr="data-answer-wait" />
    <Button variant="text" type="button" name="hold" onclick={onHold}>{WORKING_ON_IT}</Button>
  </div>
</div>

<style>
  .answer-countdown { display: flex; flex-direction: column; gap: 0.25rem; }
  .label { margin: 0; color: var(--m3c-on-surface-variant); }
  .row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
</style>
