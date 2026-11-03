<script lang="ts">
  // Issue #139: M3's primary tabs, written by hand after the guidelines and m3-svelte's own (nav/Tabs.svelte), because
  // m3-svelte's Tabs takes a name and an icon alone, so it cannot hold the running indicator or an alert's color. Each
  // tab shows its run's mark (web/src/notify.ts): the running indicator (CircularIndeterminate, whose glyph shows under
  // reduced motion), a usage-limit pause with when it ends, the waiting mark, or an unseen end, halted drawn as the alert
  // in the error color. The label's text is exactly `markedTabName`, and the radio's accessible name carries the state's
  // words. The DOM keeps m3-svelte's shape (a container `.m3-container.primary`, a radio, then its label), which the
  // end-to-end fixtures find tabs by; the selected tab's indicator is an element inside its label, as in ScrollableTabs.
  import CircularIndeterminate from "./CircularIndeterminate.svelte";
  import { type Mark, markGlyph, markStateText } from "../notify.ts";
  import { limitPauseText, RUNNING_MARK } from "../../../src/prompts.ts";

  let { tab = $bindable(), items }: { tab: string; items: readonly { value: string; name: string; mark: Mark }[] } = $props();
  const group = $props.id();
  const accessibleName = (item: { name: string; mark: Mark }): string => {
    const words = markStateText(item.mark);
    return words === null ? item.name : `${item.name}: ${words}`;
  };
</script>

<div class="m3-container primary" style:--items={items.length}>
  {#each items as item (item.value)}
    {@const id = group + item.value}
    {@const mark = item.mark}
    <input type="radio" name={group} {id} value={item.value} bind:group={tab} aria-label={accessibleName(item)} />
    <label for={id} class="m3-layer" data-value={item.value} data-mark={mark._tag}>{#if mark._tag === "Running"}<span class="mark"><CircularIndeterminate label={markStateText(mark) ?? ""} glyph={RUNNING_MARK} /></span> <span class="name">{item.name}</span>{:else if mark._tag === "Clear"}<span class="name">{item.name}</span>{:else}<span class="mark" class:alert={mark._tag === "Ended" && mark.code !== 0} aria-hidden="true">{markGlyph(mark)}</span> <span class="name">{item.name}</span>{#if mark._tag === "LimitPaused"}{" "}<span class="when">{limitPauseText(mark.pause.fromMs, mark.pause.untilMs, mark.pause.known)}</span>{/if}{/if}{#if item.value === tab}<span class="indicator" aria-hidden="true"></span>{/if}</label>
  {/each}
</div>

<style>
  .m3-container {
    position: relative;
    display: flex;
    background-color: var(--m3c-surface);
    box-shadow: inset 0 -1px var(--m3c-surface-container-highest);
  }
  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  label {
    position: relative;
    flex: 1 0;
    height: 3rem;
    min-width: 5rem;
    padding: 0 1rem;
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    overflow: hidden;
    color: var(--m3c-on-surface-variant);
    user-select: none;
    cursor: pointer;
    transition: color var(--m3-easing-fast);
  }
  label > span:not(.indicator) {
    font-family: var(--m3-font);
    font-size: 0.875rem;
    line-height: 1.25rem;
    font-weight: 500;
    letter-spacing: 0.00625rem;
  }
  .mark,
  .name {
    flex: none;
    white-space: nowrap;
  }
  .mark {
    display: inline-flex;
    align-items: center;
  }
  /* Issue #139: halted is the one alert, in the error color and bold, so it never reads as one of the four reports. */
  .mark.alert {
    color: var(--m3c-error);
    font-weight: 700;
  }
  .when {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (hover: hover) {
    label:hover {
      color: var(--m3c-on-surface);
    }
  }
  input:focus-visible + label,
  input:active + label {
    color: var(--m3c-on-surface);
  }
  input:checked + label {
    color: var(--m3c-primary);
  }
  input:focus-visible + label {
    outline: 2px solid var(--m3c-secondary);
    outline-offset: -2px;
  }
  .indicator {
    position: absolute;
    bottom: 0;
    left: 50%;
    width: 3rem;
    height: 0.1875rem;
    translate: -50% 0;
    border-radius: 0.1875rem 0.1875rem 0 0;
    background-color: var(--m3c-primary);
    pointer-events: none;
    print-color-adjust: exact;
  }
  @media screen and (forced-colors: active) {
    .indicator {
      background-color: selecteditem;
    }
  }
</style>
