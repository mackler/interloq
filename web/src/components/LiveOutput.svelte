<script lang="ts">
  // The live panel (issue #49): what the running processes of the run print, as it arrives over this tab's connection,
  // as plain preformatted text [visibility of system status]. It is not Interloq's status: its header names the
  // processes running, its note says Interloq does not write the text, and it is set in monospace on a surface of its
  // own, so it is never read as the status line. Every text goes through Svelte's text interpolation, never {@html}
  // and never the Markdown renderer, so a backtick or an angle bracket in a process's output stays a character. Its
  // height is fixed at `lines` lines, so it keeps its place whether or not a process runs (requirements Q1).
  // The compact dashboard mounts it only while a process runs (issue #200, requirements Q2).
  import { LIVE_OUTPUT_NAME, LIVE_OUTPUT_NOTE } from "../../../src/prompts.ts";
  import { type LivePanel, lineText, panelView } from "../livePanel.ts";

  type Props = { panel: LivePanel; lines: number };
  let { panel, lines }: Props = $props();
  const view = $derived(panelView(panel, lines));
</script>

<section class="live" aria-label={LIVE_OUTPUT_NAME} data-live-output>
  <p class="header" data-live-header>{view.header}</p>
  <p class="note">{LIVE_OUTPUT_NOTE}</p>
  <div class="screen" style:--lines={lines}>
    <pre aria-live="off">{#each view.lines as line, i (i)}<span class:ended={line._tag !== "Output"}>{lineText(line)}</span>{"\n"}{/each}</pre>
  </div>
</section>

<style>
  .live { display: flex; flex-direction: column; gap: 0.125rem; flex: none; }
  .header { margin: 0; font-size: 0.875rem; line-height: 1.25rem; font-weight: 500; color: var(--m3c-on-surface); }
  .note { margin: 0; font-size: 0.75rem; line-height: 1rem; color: var(--m3c-on-surface-variant); }
  /* The lines sit at the bottom of a fixed height, as a terminal's do; a wrapped line pushes the oldest out at the top. */
  .screen { height: calc(var(--lines) * 1.125rem + 1rem); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-highest); color: var(--m3c-on-surface); }
  pre { margin: 0; font-family: var(--m3-font-mono); font-size: 0.75rem; line-height: 1.125rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .ended { color: var(--m3c-on-surface-variant); }
</style>
