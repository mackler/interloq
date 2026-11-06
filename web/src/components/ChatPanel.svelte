<script lang="ts">
  // A chat panel. New messages scroll into view unless the user has scrolled up, when a chip offers to jump to
  // them [user control and freedom: the scrolling is not taken from the user; visibility of system status].
  import { Chip } from "m3-svelte";
  import { tick, untrack } from "svelte";
  import MessageView from "./Message.svelte";
  import { phaseBandLabel } from "../../../src/prompts.ts";
  import { bandsOf, type Message } from "../state.ts";
  import { clockTime, fullTime } from "../time.ts";


  // `visible` (P3-R1-1): a panel hidden by the compact layout stays mounted with display: none, where its list has no
  // height. While hidden it neither scrolls nor reads scroll events; shown again, it goes to its end if it was
  // following, and otherwise keeps the user's place, with the chip counting what arrived meanwhile.
  type Props = { title: string; messages: readonly Message[]; empty: string; visible?: boolean };
  let { title, messages, empty, visible = true }: Props = $props();
  // Issue #15: each phase is a band behind its messages, one subtle tone per kind of phase, so that every execution phase
  // looks alike and a planning phase between two of them stands apart; a small label opens the band with the phase's
  // name and the time it began [visibility of system status: where a phase begins, and when; aesthetic and minimalist
  // design: a tone and a quiet label rather than a message of their own]. Issue #23: the tones and the label's color
  // come from web/src/theme.css, one pair of variables per kind of phase, each band's color distinct from every other
  // kind's, the panel and the two bubbles in both schemes; the label still names the phase, so color is not the only signal.
  const groups = $derived(bandsOf(messages));
  let list = $state<HTMLElement | null>(null);
  let following = $state(true);
  let unseen = $state(0);
  let seen = 0;

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  const toBottom = () => {
    if (list !== null) list.scrollTop = list.scrollHeight;
    following = true;
    unseen = 0;
  };
  $effect(() => {
    const count = messages.length;
    if (count < seen) seen = 0;
    const shown = untrack(() => visible);
    if (following) {
      if (shown) queueMicrotask(toBottom);
    } else unseen += count - seen;
    seen = count;
  });
  $effect(() => {
    if (visible && untrack(() => following)) void tick().then(toBottom);
  });
</script>

<section class="panel" aria-label={title}>
  <h2 class="m3-font-title-small">{title}</h2>
  <div class="list" bind:this={list} onscroll={() => { if (list !== null && visible) { following = atBottom(list); if (following) unseen = 0; } }} aria-live="polite">
    {#if messages.length === 0}<p class="empty m3-font-body-medium">{empty}</p>{/if}
    {#each groups as group (group.band?.key ?? "")}
      {#if group.band === null}
        {#each group.messages as message (message.key)}<MessageView {message} />{/each}
      {:else}
        <div class="band band-{group.band.kind}">
          <p class="phase-label m3-font-label-small" title={fullTime(group.band.began)}>{phaseBandLabel(group.band.name, clockTime(group.band.began))}</p>
          {#each group.messages as message (message.key)}<MessageView {message} />{/each}
        </div>
      {/if}
    {/each}
  </div>
  {#if !following && unseen > 0}
    <div class="jump"><Chip variant="assist" elevated onclick={toBottom}>{unseen} new message{unseen === 1 ? "" : "s"}</Chip></div>
  {/if}
</section>

<style>
  .panel { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--m3c-surface-container-lowest); border-radius: var(--m3-shape-large); }
  h2 { margin: 0; padding: 0.75rem 1rem; color: var(--m3c-on-surface-variant); border-bottom: 1px solid var(--m3c-outline-variant); }
  .list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; padding: 0.75rem; }
  .empty { color: var(--m3c-on-surface-variant); margin: auto; }
  /* A band is a full-width column like the list, so that each message's align-self keeps its side (P1-R1-1). */
  .band { display: flex; flex-direction: column; align-self: stretch; padding: 0.25rem 0.5rem 0.5rem; margin: 0.25rem 0; border-radius: var(--m3-shape-medium); }
  /* Issue #23: each kind of phase takes its band color and its label color from web/src/theme.css. */
  .band-update { background: var(--band-update); }
  .band-update > .phase-label { color: var(--on-band-update); }
  .band-questions { background: var(--band-questions); }
  .band-questions > .phase-label { color: var(--on-band-questions); }
  .band-planning { background: var(--band-planning); }
  .band-planning > .phase-label { color: var(--on-band-planning); }
  .band-execution { background: var(--band-execution); }
  .band-execution > .phase-label { color: var(--on-band-execution); }
  .band-work { background: var(--band-work); }
  .band-work > .phase-label { color: var(--on-band-work); }
  .band-suite { background: var(--band-suite); }
  .band-suite > .phase-label { color: var(--on-band-suite); }
  .phase-label { margin: 0.25rem 0.25rem 0.125rem; }
  .jump { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); }
</style>
