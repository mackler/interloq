<script lang="ts">
  // A step of the plan and its full text (issue #6): a hand-built M3 rich tooltip, since m3-svelte has none. It opens on
  // hover and on keyboard focus, a click or tap keeps it open, Escape or leaving closes it. The tooltip may take focus so
  // that a long text scrolls by keyboard as well; it has a size limit and its own scrolling, and is placed inside the
  // viewport. The text is the agent's Markdown, rendered and sanitized by web/src/markdown.ts, never raw HTML.
  import { render } from "../markdown.ts";
  import { TOOLTIP_GRACE_MS } from "../time.ts";

  type Props = { key: string; label: string; text: string };
  let { key, label, text }: Props = $props();
  let open = $state(false);
  let pinned = $state(false);
  let wrapper: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  let tip: HTMLDivElement | undefined = $state();
  let place = $state("");
  const tipId = $derived(`step-tip-${key}`);
  // W1-R1-1: leaving the anchor closes the tooltip only after a grace delay, so the pointer can cross the gap into it.
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const stay = () => {
    if (leaving !== null) clearTimeout(leaving);
    leaving = null;
  };
  const close = () => {
    stay();
    open = false;
    pinned = false;
  };
  const leave = () => {
    stay();
    if (!pinned) leaving = setTimeout(() => ((leaving = null), (open = false)), TOOLTIP_GRACE_MS);
  };
  // The timer is the component's edge: cleared when the component is destroyed.
  $effect(() => stay);
  const MARGIN = 8;
  const MAX_HEIGHT = 256;
  // The edge of the component: measured in the browser when the tooltip opens.
  $effect(() => {
    if (!open || tip === undefined || button === undefined) return;
    const r = button.getBoundingClientRect();
    const width = Math.min(tip.offsetWidth, window.innerWidth - 2 * MARGIN);
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - r.bottom - 2 * MARGIN;
    const above = r.top - 2 * MARGIN;
    const down = below >= Math.min(tip.scrollHeight, MAX_HEIGHT) || below >= above;
    const height = Math.max(4 * MARGIN, Math.min(MAX_HEIGHT, down ? below : above));
    place = `left:${left}px;${down ? `top:${r.bottom + MARGIN / 2}px` : `bottom:${window.innerHeight - r.top + MARGIN / 2}px`};max-height:${height}px`;
  });
</script>

<span
  class="anchor"
  bind:this={wrapper}
  role="presentation"
  onmouseleave={leave}
  onkeydown={(e) => {
    if (e.key === "Escape") close();
  }}
  onfocusout={(e) => {
    if (wrapper !== undefined && !wrapper.contains(e.relatedTarget as Node | null)) close();
  }}
>
  <button
    type="button"
    class="step-label m3-font-label-medium"
    bind:this={button}
    data-plan-step-label
    aria-describedby={open ? tipId : undefined}
    onfocus={() => (open = true)}
    onmouseenter={() => {
      stay();
      open = true;
    }}
    onclick={() => {
      pinned = !pinned;
      open = pinned;
    }}>{label}</button
  >
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div role="tooltip" id={tipId} class="tooltip markdown m3-font-body-medium" style={place} tabindex="0" bind:this={tip} onmouseenter={stay}>{@html render(text)}</div>
  {/if}
</span>

<style>
  .anchor { display: inline; }
  .step-label { all: unset; cursor: default; border-radius: var(--m3-shape-extra-small, 4px); }
  .step-label:focus-visible { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  /* M3 rich tooltip: surface container, on-surface-variant text, elevation level 2, medium shape. */
  .tooltip {
    position: fixed;
    z-index: 10;
    /* The height placed above is the whole box's, padding included (issue #120: the 48 px of the tabs moved a step near
       the window's bottom, where a content-box tooltip ran 24 px past the room it was given). */
    box-sizing: border-box;
    width: max-content;
    max-width: min(20rem, calc(100vw - 16px));
    max-height: 16rem;
    overflow: auto;
    padding: 0.75rem 1rem;
    background: var(--m3c-surface-container);
    color: var(--m3c-on-surface-variant);
    box-shadow: var(--m3-elevation-2);
    border-radius: var(--m3-shape-medium);
  }
  .tooltip:focus-visible { outline: 2px solid var(--m3c-secondary); }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
  .markdown :global(pre) { overflow-x: auto; }
</style>
