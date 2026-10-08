<script lang="ts">
  // The top app bar: the title, the task, the connection, and Stop [user control and freedom; error prevention by
  // placement away from the prompt, an outlined button labelled "Stop task" in the error role, disabled without a run,
  // and a confirmation that says what ends and the exit code (S25, issue #25), since the run cannot be resumed].
  // Below M3's expanded width (finding 7 of docs/gui-review.md) the bar wraps: the title, the connection and Stop stay
  // on the first line, and the project and the task move to a secondary line [visibility of system status: nothing
  // that says what runs or whether the page is connected is dropped].
  // Issue #29 (the developer's decisions of 28 Sep and 6 Oct 2026): the bar identifies the project, conspicuously, so
  // that two windows of two servers are told apart at a glance. The headline (M3's title-large role, where a top app
  // bar names what the user is in) is the project's own name, the one text that differs between two windows [visibility
  // of system status; recognition rather than recall; error prevention: an answer or a Stop in the wrong window]. The
  // word Interloq, the same in every window, stands before it as a small label in the on-surface-variant color
  // [aesthetic and minimalist design]. The whole identification (the host directory, or the path as given) stands
  // beside it, on the secondary line below 840 px, wrapping anywhere rather than cut, since its end is what
  // distinguishes, with its whole text as its title; the task's summary stays below it. The bar shows it with no run
  // in progress too: the run's location during a run, the server's from its hello otherwise, nothing before the first
  // hello. The roles are argued from the class names, not from rendered sizes (issue #106: the classes are inert).
  import { Button } from "m3-svelte";
  import ConfirmEndDialog from "./ConfirmEndDialog.svelte";
  import type { RunView, ViewState } from "../state.ts";
  import { ownName } from "../../../src/hostDir.ts";

  // A failed page (defect B of docs/page-question-phase-defects.md) reads "disconnected", and Stop, which can no longer
  // reach the server, is disabled [visibility of system status; error prevention].
  // S38 (W2-R1-1, P3-R1-1): the confirmation is bound to the server's incarnation and the run it was opened for (run ids
  // restart at 1 in each incarnation), stops exactly that, and closes without acting when either changes [error
  // prevention].
  type Props = { run: RunView | null; location: string | null; incarnation?: string | null; connection: ViewState["connection"]; onStop: (incarnation: string, run: number) => void };
  let { run, location, incarnation = null, connection, onStop }: Props = $props();
  const CONNECTION: Record<ViewState["connection"], string> = { connecting: "connecting…", open: "connected", reconnecting: "reconnecting…", failed: "disconnected" };
  // The run's identification while there is a run, the server's otherwise; nothing before the first hello.
  const shown = $derived(run !== null && run.location !== "" ? run.location : location);
  const running = $derived(run !== null && run.ended === null);
  let confirming = $state<{ incarnation: string; run: number } | null>(null);
  const current = $derived(run === null || run.ended !== null ? null : { incarnation: incarnation ?? "", run: run.id });
  $effect(() => {
    if (confirming !== null && (current === null || current.incarnation !== confirming.incarnation || current.run !== confirming.run)) confirming = null;
  });
  const confirm = () => {
    const target = confirming;
    confirming = null;
    if (target !== null && current !== null && current.incarnation === target.incarnation && current.run === target.run) onStop(target.incarnation, target.run);
  };
</script>

<header class="bar">
  <h1 class="m3-font-title-large">
    <span class="brand m3-font-label-large">Interloq</span>
    {#if shown !== null}<span class="project-name">{ownName(shown)}</span>{/if}
  </h1>
  <div class="task">
    {#if shown !== null}<span class="m3-font-body-medium location" title={shown}>{shown}</span>{/if}
    {#if run !== null}
      <span class="m3-font-body-small summary" title={run.task}>{run.task}</span>
    {/if}
  </div>
  <span class="connection m3-font-label-medium {connection}" role="status">{CONNECTION[connection]}</span>
  <span class="stop"><Button variant="outlined" type="button" name="stop" disabled={!running || connection === "failed"} onclick={() => (confirming = current)}>Stop task</Button></span>
</header>
<ConfirmEndDialog ending={confirming !== null ? "stopTask" : null} onConfirm={confirm} onCancel={() => (confirming = null)} />

<style>
  .bar { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1rem; background: var(--m3c-surface-container); box-shadow: var(--m3-elevation-2); position: relative; z-index: 1; }
  h1 { margin: 0; white-space: nowrap; display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
  .brand { color: var(--m3c-on-surface-variant); }
  .project-name { overflow: hidden; text-overflow: ellipsis; }
  .location { overflow-wrap: anywhere; }
  .task { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .summary { color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stop { --m3c-primary: var(--m3c-error); --m3c-outline: var(--m3c-error); }
  .connection { padding: 0.25rem 0.75rem; border-radius: var(--m3-shape-full); background: var(--m3c-surface-container-highest); }
  @media (max-width: 839px) {
    .bar { flex-wrap: wrap; gap: 0.25rem 0.75rem; }
    h1 { flex: 1; }
    .task { order: 2; flex-basis: 100%; }
  }
  /* A compact window: M3's title size for a small top app bar (22 px), so that Stop stays on the first line. */
  @media (max-width: 599px) {
    h1 { font-size: 1.375rem; line-height: 1.75rem; }
  }
  .connection.reconnecting, .connection.connecting, .connection.failed { background: var(--m3c-error-container); color: var(--m3c-on-error-container); }
</style>
