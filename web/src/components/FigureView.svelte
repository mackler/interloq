<script lang="ts">
  // The enlarged view of a picture (issue #247, requirements Q1): the picture at the largest size that fits the window
  // less FIGURE_VIEW_MARGIN at each edge, keeping its aspect ratio, named by its alt text. One reusable component, so that
  // issue #244's images can be shown in it. Hand-built after M3 rather than m3-svelte's Dialog, because a view opened by
  // hover must not be modal, trap focus or draw a scrim. It asserts only the picture and its alt text.
  // It lives in the document's body (as TermTooltip does, S44) and contains its clicks, pointer presses and keys, so that
  // nothing done in it reaches a choosing card: nothing in it answers.
  import { Button } from "m3-svelte";
  import { CLOSE_PICTURE } from "../../../src/prompts.ts";
  import { aspectOf, enlargedSize, roomOf, viewBoxOf, type DismissHow, type Room } from "../figureView.ts";

  type Props = {
    name: string;
    render: (prefix: string) => string;
    fallbackAspect: number | null;
    anchor: HTMLElement;
    onEnter: () => void;
    onLeave: () => void;
    onDismiss: (how: DismissHow) => void;
    pinned: boolean;
  };
  let { name, render, fallbackAspect, anchor, onEnter, onLeave, onDismiss, pinned }: Props = $props();
  const prefix = $props.id();
  const markup = $derived(render(prefix));

  const portal = (node: HTMLElement) => {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  };
  const contain = (e: Event) => e.stopPropagation();
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss("escape");
    }
  };

  let root: HTMLDivElement | undefined = $state();
  let drawing: HTMLSpanElement | undefined = $state();
  let stated: number | null = $state(null);
  let windowRoom: Room = $state({ width: window.innerWidth, height: window.innerHeight });
  const size = $derived(enlargedSize(stated ?? fallbackAspect, roomOf(windowRoom)));

  // The edge: the view's own copy of the drawing is given a viewBox, so that the drawing scales with its viewport whatever
  // size the SVG states; the card's copy is never touched.
  $effect(() => {
    void markup;
    const svg = drawing?.querySelector("svg");
    if (svg === null || svg === undefined) return;
    const [viewBox, width, height] = [svg.getAttribute("viewBox"), svg.getAttribute("width"), svg.getAttribute("height")];
    let aspect = aspectOf(viewBox, width, height);
    const derived = viewBoxOf(viewBox, width, height);
    if (derived !== null) svg.setAttribute("viewBox", derived);
    else if (aspectOf(viewBox, null, null) === null && typeof (svg as SVGGraphicsElement).getBBox === "function") {
      const box = (svg as SVGGraphicsElement).getBBox();
      if (box.width > 0 && box.height > 0) {
        svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
        aspect ??= box.width / box.height;
      }
    }
    stated = aspect;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    if (!svg.hasAttribute("preserveAspectRatio")) svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  });

  $effect(() => {
    const resize = () => (windowRoom = { width: window.innerWidth, height: window.innerHeight });
    const outside = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && (root?.contains(t) || anchor.contains(t))) return;
      onDismiss("outside");
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss("escape");
    };
    window.addEventListener("resize", resize);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  });

  // Focus follows `pinned` alone: the close control takes it exactly when the view becomes pinned, at mount or later.
  let wasPinned = false;
  $effect(() => {
    const now = pinned;
    if (now && !wasPinned) root?.querySelector<HTMLElement>('button[name="close-picture"]')?.focus();
    wasPinned = now;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="dialog"
  aria-modal="false"
  aria-label={name}
  data-figure-view
  tabindex="-1"
  class="view"
  bind:this={root}
  use:portal
  onclick={contain}
  onpointerdown={contain}
  onkeydown={onKey}
  onmouseenter={onEnter}
  onmouseleave={onLeave}
>
  <div class="header">
    <Button variant="text" type="button" name="close-picture" onclick={() => onDismiss("close")}>{CLOSE_PICTURE}</Button>
  </div>
  <span class="picture" role="img" aria-label={name} data-figure-view-picture style={`width:${size.width}px;height:${size.height}px`}>
    {#if markup === ""}{name}{:else}<span class="drawing" aria-hidden="true" bind:this={drawing}>{@html markup}</span>{/if}
  </span>
</div>

<style>
  /* After M3: a surface container, elevation level 3, extra-large shape, and a visible focus ring. */
  .view {
    position: fixed;
    z-index: 20;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    padding: 8px;
    display: flex;
    flex-direction: column;
    background: var(--m3c-surface-container-high);
    color: var(--m3c-on-surface);
    box-shadow: var(--m3-elevation-3);
    border-radius: var(--m3-shape-extra-large);
    cursor: default;
  }
  .view:focus-visible { outline: 2px solid var(--m3c-secondary); }
  .header { display: flex; justify-content: flex-end; align-items: center; height: 40px; }
  .picture { display: block; }
  .drawing { display: block; width: 100%; height: 100%; }
  .drawing :global(svg) { display: block; width: 100%; height: 100%; }
</style>
