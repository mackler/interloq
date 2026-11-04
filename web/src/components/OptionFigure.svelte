<script lang="ts">
  // An option's picture on its card (issue #98, requirements Q1): drawn under the option's label and description, the
  // card's full width with its height following the picture's aspect ratio, shrinking with its card in a narrow window.
  // Its markup is shown only through sanitizeFigure of web/src/figure.ts, with a prefix unique to this instance, so that
  // the ids of several pictures on one page never meet. A screen reader reads the alt text; the picture's own text is
  // hidden from it. Where the sanitizer leaves nothing, the alt text is shown in its place.
  // Issue #247 (requirements Q1): the picture is its own control, a button named enlargePictureName of its alt text.
  // Hovering it, or a click, tap, Enter or Space on it, opens FigureView, the picture enlarged; it never chooses the
  // option, and it stays enabled while its card is disabled. Its state is afterViewEvent's of web/src/figureView.ts, whose
  // commands this component carries out. A button holds spans alone, phrasing content.
  import type { Figure } from "../../../src/figure.ts";
  import { enlargePictureName } from "../../../src/prompts.ts";
  import { sanitizeFigure } from "../figure.ts";
  import { afterViewEvent, CLOSED, HOVER_CLOSE_MS, HOVER_OPEN_MS, isOpen, type ViewEvent, type ViewState } from "../figureView.ts";
  import FigureView from "./FigureView.svelte";

  type Props = { figure: Figure };
  let { figure }: Props = $props();
  const prefix = $props.id();
  const markup = $derived(sanitizeFigure(figure.svg, prefix));

  let view: ViewState = $state(CLOSED);
  let button: HTMLButtonElement | undefined = $state();
  let shown: HTMLSpanElement | undefined = $state();
  let measured: number | null = $state(null);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const open = $derived(isOpen(view));

  const cancel = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = undefined;
  };
  const measure = () => {
    const r = shown?.getBoundingClientRect();
    measured = r !== undefined && r.width > 0 && r.height > 0 ? r.width / r.height : null;
  };
  const dispatch = (event: ViewEvent): void => {
    const wasOpen = isOpen(view);
    const step = afterViewEvent(view, event);
    if (!wasOpen && isOpen(step.state)) measure();
    view = step.state;
    for (const command of step.commands) {
      switch (command) {
        case "StartOpenTimer":
          clearTimeout(openTimer);
          openTimer = setTimeout(() => dispatch({ _tag: "OpenDue" }), HOVER_OPEN_MS);
          break;
        case "StartCloseTimer":
          clearTimeout(closeTimer);
          closeTimer = setTimeout(() => dispatch({ _tag: "CloseDue" }), HOVER_CLOSE_MS);
          break;
        case "CancelTimers":
          cancel();
          break;
        case "FocusView": // FigureView takes focus when its `pinned` becomes true
          break;
        case "ReturnFocus":
          button?.focus();
          break;
      }
    }
  };
  $effect(() => cancel);
  const activate = (e: MouseEvent) => {
    e.stopPropagation();
    dispatch({ _tag: "Activate" });
  };
</script>

<button
  type="button"
  class="figure"
  data-figure-enlarge
  aria-label={enlargePictureName(figure.alt)}
  aria-haspopup="dialog"
  aria-expanded={open}
  bind:this={button}
  onclick={activate}
  onmouseenter={() => dispatch({ _tag: "Enter", on: "picture" })}
  onmouseleave={() => dispatch({ _tag: "Leave", on: "picture" })}
>
  <span class="shown" role="img" aria-label={figure.alt} data-option-figure bind:this={shown}>
    {#if markup === ""}{figure.alt}{:else}<span class="drawing" aria-hidden="true">{@html markup}</span>{/if}
  </span>
</button>
{#if open && button !== undefined}
  <FigureView
    name={figure.alt}
    render={(p) => sanitizeFigure(figure.svg, p)}
    fallbackAspect={measured}
    anchor={button}
    pinned={view._tag === "Pinned"}
    onEnter={() => dispatch({ _tag: "Enter", on: "view" })}
    onLeave={() => dispatch({ _tag: "Leave", on: "view" })}
    onDismiss={(how) => dispatch({ _tag: "Dismiss", how })}
  />
{/if}

<style>
  .figure {
    display: block;
    width: 100%;
    max-width: 100%;
    margin: 0;
    margin-block-start: 0.5rem;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: inherit;
    border-radius: var(--m3-shape-small);
    cursor: zoom-in;
  }
  .figure:focus-visible { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  .shown, .drawing { display: block; }
  .shown :global(svg) { display: block; width: 100%; height: auto; max-width: 100%; }
</style>
