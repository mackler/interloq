<script lang="ts">
  // A disclosure: a heading that opens and closes the body it controls (issue #137). Extracted from DecisionView's
  // entries (issue #87), so that the decision page's entries and the question page's sections are one control rather
  // than two implementations; the progress rail's rows (issues #63, #110, #115) keep their own, whose mark is the
  // control. A native button, so that Enter and Space open it [flexibility and efficiency of use], with aria-expanded
  // and aria-controls; the body is rendered only while open [aesthetic and minimalist design], and the parent puts the
  // element carrying the id `controls` inside it. The open state belongs to the parent, which onToggle reports to.
  // Issue #133: without `children` the parent renders the body wherever it wants, so that the decision page's headings
  // share one row while their bodies sit below it; `fit` sizes the button to its content for such a row, and `id`
  // names the button, so that a link (an equivalence symbol) can move the focus to it.
  import type { Snippet } from "svelte";

  let {
    expanded,
    controls,
    name,
    id,
    fit = false,
    onToggle,
    title,
    children,
  }: {
    expanded: boolean;
    /** The id of the body's element, which the parent renders inside `children`. */
    controls: string;
    /** The button's accessible name; absent, its text is its name. */
    name?: string;
    /** The button's own id, for a link that moves the focus to it. */
    id?: string;
    /** Sized to its content, for a row of disclosures sharing a line; full width otherwise. */
    fit?: boolean;
    onToggle: (open: boolean) => void;
    /** The button's content after the chevron. */
    title: Snippet;
    /** The body, rendered only while expanded; absent, the parent renders it. */
    children?: Snippet;
  } = $props();
</script>

<button type="button" class="toggle" class:fit {id} aria-expanded={expanded} aria-controls={controls} aria-label={name} onclick={() => onToggle(!expanded)}>
  <span class="chevron" class:expanded aria-hidden="true"></span>
  {@render title()}
</button>
{#if expanded && children !== undefined}{@render children()}{/if}

<style>
  /* Issue #87: hand-built after M3's list item: a state layer of the on-surface color on hover (8 %), focus (10 %) and
     press (10 %), a focus ring, and the standard easing for the chevron; none of it under reduced motion. It asserts
     that the body is open or closed and nothing more (docs/ui-review.md). The title wraps whole (decision Q2). */
  .toggle { position: relative; box-sizing: border-box; display: flex; align-items: flex-start; gap: 0.5rem; width: 100%; margin: 0; padding: 0.375rem 0.5rem; border: 0; border-radius: var(--m3-shape-small); background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; overflow: hidden; }
  .toggle.fit { width: auto; flex: none; }
  .toggle::before { content: ""; position: absolute; inset: 0; background: var(--m3c-on-surface); opacity: 0; transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1); pointer-events: none; }
  .toggle:hover::before { opacity: 0.08; }
  .toggle:focus-visible::before, .toggle:active::before { opacity: 0.1; }
  .toggle:focus-visible { outline: 3px solid var(--m3c-secondary); outline-offset: 2px; }
  .chevron { flex: none; width: 0.5rem; height: 0.5rem; margin-top: 0.4rem; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform 200ms cubic-bezier(0.2, 0, 0, 1); }
  .chevron.expanded { transform: rotate(45deg); }
  @media (prefers-reduced-motion: reduce) {
    .toggle::before, .chevron { transition: none; }
  }
</style>
