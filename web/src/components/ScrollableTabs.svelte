<script lang="ts">
  // M3's scrollable secondary tabs, written by hand after the guidelines (issue #202, requirements Q1). m3-svelte's Tabs
  // cannot shrink or scroll, so a row of them overflows a narrow window, and both its Tabs and VariableTabs draw the
  // selected tab's indicator only for the first five tabs. Here the row scrolls sideways inside itself, every tab keeps
  // its whole name on one line, the indicator is an element inside the selected tab, and the selected tab is scrolled
  // into view (tabScrollLeft, which moves the row alone and never the page). The DOM keeps m3-svelte's shape (a radio,
  // then its label holding a span), which the end-to-end fixtures find tabs by.
  import { tabScrollLeft } from "../tabRow.ts";

  let { tab = $bindable(), items }: { tab: string; items: readonly { name: string; value: string }[] } = $props();
  const name = $props.id();
  let row: HTMLDivElement | undefined = $state();

  $effect(() => {
    const selected = tab;
    void items.length;
    if (row === undefined) return;
    const label = row.querySelector<HTMLElement>(`label[data-value="${CSS.escape(selected)}"]`);
    if (label === null) return;
    const left = tabScrollLeft({ left: row.scrollLeft, width: row.clientWidth }, { left: label.offsetLeft, width: label.offsetWidth }, row.scrollWidth);
    if (left !== row.scrollLeft) row.scrollLeft = left;
  });
</script>

<div class="row" bind:this={row}>
  {#each items as item (item.value)}
    {@const id = name + item.value}
    <input type="radio" {name} {id} value={item.value} bind:group={tab} />
    <label for={id} class="m3-layer" data-value={item.value}>
      <span>{item.name}</span>
      {#if item.value === tab}
        <span class="indicator" aria-hidden="true"></span>
      {/if}
    </label>
  {/each}
</div>

<style>
  .row {
    position: relative;
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
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
    flex: 1 0 auto;
    min-width: 5rem;
    height: 3rem;
    padding: 0 1rem;
    white-space: nowrap;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--m3c-on-surface-variant);
    user-select: none;
    cursor: pointer;
  }
  label > span:not(.indicator) {
    font-family: var(--m3-font);
    font-size: 0.875rem;
    line-height: 1.25rem;
    font-weight: 500;
    letter-spacing: 0.00625rem;
  }
  @media (hover: hover) {
    label:hover {
      color: var(--m3c-on-surface);
    }
  }
  input:focus-visible + label,
  input:checked + label {
    color: var(--m3c-on-surface);
  }
  input:focus-visible + label {
    outline: 2px solid var(--m3c-secondary);
    outline-offset: -2px;
  }
  .indicator {
    position: absolute;
    inset: auto 0 0 0;
    height: 0.125rem;
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
