<script lang="ts">
  // Issue #44: how a run ended, stated as the program concluded it: the ending's mark, hidden from assistive technology
  // since the line's first word states the ending; the ending's line; and the confirmed disposition of the work and the
  // item, each a paragraph of its own. A halt and an abandonment are drawn in the error color (decision Q2), never the
  // only signal. Every text through Svelte's interpolation, so none is markup. It stays shown after the attention mark
  // clears (issue #209). Issue #18: how long the run took, after the ending's line, in the details' style, since it
  // states a measurement and no alert; none where the run's start is unknown.
  import { type Ending, endingAlerts } from "../../../src/ending.ts";
  import { endingDetails, endingLine, endingMarkOf, runTimeText } from "../../../src/prompts.ts";

  let { ending, runTimeMs }: { ending: Ending; runTimeMs: number | null } = $props();
  const alert = $derived(endingAlerts(ending));
</script>

<div class="ending" role="status" data-ending={ending._tag}>
  <span class="mark" class:alert aria-hidden="true">{endingMarkOf(ending)}</span>
  <div class="text">
    <p class="line m3-font-body-medium" class:alert>{endingLine(ending)}</p>
    {#if runTimeMs !== null}
      <p class="detail m3-font-body-small" data-run-time>{runTimeText(runTimeMs)}</p>
    {/if}
    {#each endingDetails(ending) as detail, i (i)}
      <p class="detail m3-font-body-small">{detail}</p>
    {/each}
  </div>
</div>

<style>
  .ending {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }
  .mark {
    flex: none;
    font-weight: 700;
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0;
  }
  .line {
    font-size: 0.875rem;
    line-height: 1.25rem;
  }
  .detail {
    font-size: 0.75rem;
    line-height: 1rem;
    color: var(--m3c-on-surface-variant);
  }
  .alert {
    color: var(--m3c-error);
  }
</style>
