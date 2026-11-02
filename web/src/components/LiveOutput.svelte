<script lang="ts">
  // The live panel (issue #49): what the running processes of the run print, as it arrives over this tab's connection
  // [visibility of system status]. Issue #221: it has a terminal's look, green on black, the one such surface on the
  // page, which is what keeps its text from being read as Interloq's own status; the processes running are icons named
  // in words, never sentences; it keeps the last 1,000 lines and scrolls through them, following new output while it is
  // at its end and staying put while the developer has scrolled up; it cuts nothing, a process's whole name standing on
  // the line that begins it and its later lines carrying its tag; and the full panel's upper edge is a separator the
  // developer drags or moves with the arrow keys. Every text goes through Svelte's text interpolation, never {@html}
  // and never the Markdown renderer, and a color is set from integers alone, so nothing a process prints becomes markup.
  // The compact dashboard mounts it only while a process runs (issue #200, requirements Q2), with no handle.
  import { LIVE_OUTPUT_EMPTY, LIVE_OUTPUT_NAME, LIVE_OUTPUT_RESIZE_LABEL, LIVE_PROCESSES_NAME, panelHeightText } from "../../../src/prompts.ts";
  import { followsEnd, type LivePanel, PROCESS_MARK, panelView } from "../livePanel.ts";
  import { afterDrag, afterKey, LINE_REM, linePx, MAX_PANEL_LINES, maxPanelLines, MIN_PANEL_LINES, shownLines } from "../panelHeight.ts";
  import { cssColor, PALETTE_16, TERMINAL_BACKGROUND, TERMINAL_DIM, TERMINAL_FOREGROUND } from "../terminalColor.ts";

  type Resize = Readonly<{ available: number | null; onLines: (n: number) => void }>;
  type Props = { panel: LivePanel; lines: number; resize?: Resize; compact?: boolean };
  let { panel, lines, resize, compact = false }: Props = $props();
  const view = $derived(panelView(panel));

  const rootFontSize = (): string => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).fontSize);
  const rootPx = linePx(rootFontSize()) / LINE_REM;

  let sectionHeight = $state(0);
  let screenHeight = $state(0);
  let screen = $state<HTMLDivElement | undefined>(undefined);
  let section = $state<HTMLElement | undefined>(undefined);
  // The heights, measured where the browser can observe them (jsdom cannot, as DecisionView's measurement allows).
  $effect(() => {
    const [sec, scr] = [section, screen];
    if (sec === undefined || scr === undefined || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      sectionHeight = sec.clientHeight;
      screenHeight = scr.clientHeight;
      // A screen resized while it follows its end (the column shrinking or growing) stays at its end.
      if (following) scr.scrollTop = scr.scrollHeight;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(sec);
    observer.observe(scr);
    measure();
    return () => observer.disconnect();
  });
  /** The height while a drag is in progress, null otherwise; committed on release. */
  let dragLines = $state<number | null>(null);
  let drag: { startLines: number; startY: number; line: number } | null = null;

  const chromePx = $derived(sectionHeight - screenHeight + rootPx);
  const max = $derived(resize === undefined ? MAX_PANEL_LINES : maxPanelLines(resize.available, chromePx, rootPx));
  const shown = $derived(resize === undefined ? lines : shownLines(dragLines ?? lines, max));

  const onKey = (event: KeyboardEvent): void => {
    const next = afterKey(shown, event.key, max);
    if (next === null || resize === undefined) return;
    event.preventDefault();
    resize.onLines(next);
  };
  const onDown = (event: PointerEvent): void => {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    drag = { startLines: shown, startY: event.clientY, line: linePx(rootFontSize()) };
  };
  const onMove = (event: PointerEvent): void => {
    if (drag !== null) dragLines = afterDrag(drag.startLines, drag.startY, event.clientY, drag.line, max);
  };
  const onUp = (): void => {
    const committed = dragLines;
    drag = null;
    dragLines = null;
    if (committed !== null && resize !== undefined) resize.onLines(committed);
  };

  // Following and staying put: before each update, whether the screen is at its end, else which line is first in view
  // and where; after it, the screen at its end again, or that line back where it was, or the top where it was evicted.
  // Every position is measured against the screen itself (getBoundingClientRect), never an offset parent.
  let anchor: { atEnd: true } | { atEnd: false; id: string | null; offset: number } = { atEnd: true };
  /** Whether the screen follows its end: true until a scroll leaves it, again once a scroll reaches it. */
  let following = true;
  const onScroll = (): void => {
    if (screen !== undefined) following = followsEnd(screen.scrollTop, screen.clientHeight, screen.scrollHeight);
  };
  const lineEl = (s: HTMLElement, id: string): HTMLElement | null => s.querySelector(`[data-line-id="${id}"]`);
  $effect.pre(() => {
    void view;
    void shown;
    const s = screen;
    if (s === undefined) return;
    if (following) {
      anchor = { atEnd: true };
      return;
    }
    const top = s.getBoundingClientRect().top;
    const first = [...s.querySelectorAll<HTMLElement>("[data-live-line]")].find((el) => el.getBoundingClientRect().bottom > top);
    anchor = first === undefined ? { atEnd: false, id: null, offset: 0 } : { atEnd: false, id: first.dataset.lineId ?? null, offset: first.getBoundingClientRect().top - top };
  });
  $effect(() => {
    void view;
    void shown;
    const s = screen;
    if (s === undefined) return;
    if (anchor.atEnd) {
      s.scrollTop = s.scrollHeight;
      return;
    }
    const el = anchor.id === null ? null : lineEl(s, anchor.id);
    if (el === null) s.scrollTop = 0;
    else s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - anchor.offset;
  });

  const color = (c: { r: number; g: number; b: number } | null): string | undefined => (c === null ? undefined : cssColor(c));
</script>

<section
  class="live"
  class:compact
  aria-label={LIVE_OUTPUT_NAME}
  data-live-output
  bind:this={section}
  style:--term-fg={cssColor(TERMINAL_FOREGROUND)}
  style:--term-bg={cssColor(TERMINAL_BACKGROUND)}
  style:--term-dim={cssColor(TERMINAL_DIM)}
  style:--term-failed={cssColor(PALETTE_16[9] ?? TERMINAL_FOREGROUND)}
>
  {#if resize !== undefined}
    <!-- A focusable separator is a widget in WAI-ARIA (a window splitter), which Svelte's check counts as non-interactive. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="handle"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      aria-label={LIVE_OUTPUT_RESIZE_LABEL}
      aria-valuemin={MIN_PANEL_LINES}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={panelHeightText(shown)}
      data-live-resize
      onkeydown={onKey}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
    ></div>
  {/if}
  {#if view.empty}
    <p class="header" data-live-header>{LIVE_OUTPUT_EMPTY}</p>
  {:else if view.running.length > 0}
    <ul class="processes bounded" aria-label={LIVE_PROCESSES_NAME} data-live-processes>
      {#each view.running as p (p.key)}
        <li><span class="mark" role="img" aria-label={p.label} data-mark={p.mark}>{PROCESS_MARK[p.mark]}</span> <span class="tag">{p.tag}</span>{#if p.elapsed !== null} <span class="tag">{p.elapsed}</span>{/if} <span class="name">{p.name}</span></li>
      {/each}
    </ul>
  {/if}
  <div class="screen" bind:this={screen} style:--shown={shown} data-live-screen aria-live="off" onscroll={onScroll}>
    {#each view.lines as line (line.id)}
      <div class="line" data-live-line data-line-id={line.id}>
        <span class="tag">{line._tag === "Touched" ? "" : line.tag}</span>
        <span class="text">{#if line._tag === "Output"}{#each line.runs as run, i (i)}<span style:color={color(run.style.fg)} style:background-color={color(run.style.bg)}>{run.text}</span>{/each}{:else if line._tag === "Begun"}<span class="mark" role="img" aria-label={line.label} data-mark={line.mark}>{PROCESS_MARK[line.mark]}</span> {line.name}{:else if line._tag === "Ended"}<span class="mark" role="img" aria-label={line.label} data-mark={line.mark}>{PROCESS_MARK[line.mark]}</span>{line.detail === "" ? "" : ` ${line.detail}`}{:else}<span class="dim">{line.text}</span>{/if}</span>
      </div>
    {/each}
  </div>
</section>

<style>
  /* The panel may shrink below its height in lines where the column is smaller than its smallest height, so its bottom
     stays the column's bottom; its screen keeps two lines at the least. In the full dashboard the content above shrinks
     first (Dashboard's .above), so the full panel keeps its chosen height while that content scrolls (W3-R2-1). */
  .live { display: flex; flex-direction: column; gap: 0.25rem; flex: 0 1 auto; min-height: 0; font-family: var(--m3-font-mono); font-size: 0.75rem; line-height: 1.125rem; }
  .handle { height: 0.5rem; flex: none; cursor: row-resize; border-radius: var(--m3-shape-full); background: var(--m3c-outline-variant); touch-action: none; }
  .handle:focus-visible { outline: 2px solid var(--m3c-primary); outline-offset: 2px; }
  .header { margin: 0; color: var(--m3c-on-surface-variant); font-family: var(--m3-font); font-size: 0.875rem; line-height: 1.25rem; }
  .processes { margin: 0; padding: 0.25rem 0.75rem; list-style: none; flex: none; max-height: calc(3 * 1.125rem); overflow-y: auto; border-radius: var(--m3-shape-small); background: var(--term-bg); color: var(--term-fg); }
  .compact .processes { max-height: calc(1.125rem); padding-block: 0; }
  .processes li { white-space: pre-wrap; overflow-wrap: anywhere; }
  /* The screen: a terminal's look, its height in lines, scrolling through its scrollback. */
  .screen { position: relative; overflow-y: auto; overflow-anchor: none; height: calc(var(--shown) * 1.125rem + 1rem); box-sizing: border-box; padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-medium); background: var(--term-bg); color: var(--term-fg); flex: 0 1 auto; min-height: calc(2 * 1.125rem + 1rem); }
  .line { display: grid; grid-template-columns: max-content 1fr; column-gap: 0.5rem; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .tag, .dim { color: var(--term-dim); }
  .mark[data-mark="failed"] { color: var(--term-failed); }
  .mark[data-mark="stopped"], .mark[data-mark="unknown"] { color: var(--term-dim); }
</style>
