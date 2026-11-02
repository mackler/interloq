<script lang="ts">
  // A vertical boundary of the run's grid (issue #204): the developer drags it, or focuses it and moves it with
  // ArrowLeft, ArrowRight, Home and End, as WAI-ARIA's window splitter is moved [user control and freedom; flexibility
  // and efficiency of use]. A drag previews the width live and commits it once, on release, as the live panel's handle
  // does. It fills its 0.75rem grid track, the pointer's target, and draws a thin line alone, so the page looks as it
  // did before. It asserts the boundary's position and nothing more.
  import { afterDrag, afterKey, type Bounds } from "../columnWidths.ts";

  type Props = { name: "rail" | "panels"; label: string; value: number; bounds: Bounds; valueText: string; unitPx: number; onPreview: (n: number | null) => void; onCommit: (n: number) => void };
  let { name, label, value, bounds, valueText, unitPx, onPreview, onCommit }: Props = $props();

  let drag: { start: number; startX: number } | null = null;
  let last: number | null = null;

  const onKey = (event: KeyboardEvent): void => {
    const next = afterKey(value, event.key, bounds);
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };
  const onDown = (event: PointerEvent): void => {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag = { start: value, startX: event.clientX };
    last = null;
  };
  const onMove = (event: PointerEvent): void => {
    if (drag === null) return;
    last = afterDrag(drag.start, drag.startX, event.clientX, unitPx, bounds);
    onPreview(last);
  };
  const onUp = (): void => {
    if (drag === null) return;
    const committed = last;
    drag = null;
    last = null;
    onPreview(null);
    if (committed !== null) onCommit(committed);
  };
</script>

<!-- A focusable separator is a widget in WAI-ARIA (a window splitter), which Svelte's check counts as non-interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="separator"
  role="separator"
  aria-orientation="vertical"
  tabindex="0"
  aria-label={label}
  aria-valuemin={bounds.min}
  aria-valuemax={bounds.max}
  aria-valuenow={value}
  aria-valuetext={valueText}
  data-column-resize={name}
  onkeydown={onKey}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
></div>

<style>
  .separator {
    position: relative;
    width: 100%;
    align-self: stretch;
    min-height: 0;
    cursor: col-resize;
    touch-action: none;
  }
  .separator::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(50% - 0.125rem);
    width: 0.25rem;
    border-radius: var(--m3-shape-full);
    background: var(--m3c-outline-variant);
  }
  .separator:focus-visible {
    outline: 2px solid var(--m3c-primary);
    outline-offset: 2px;
  }
</style>
