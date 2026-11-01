<script lang="ts">
  // The document under review of a review loop (issue #86, requirements Q1 and Q2), inside the dashboard's heading of it.
  // Markdown through the page's sanitized renderer; the diff as text in a pre, never read as Markdown, so a backtick or
  // an angle bracket stays a character; a decision's draft analysis through viewOf, whose headings, labels, nesting,
  // equivalence symbols and opposing texts are what docs/decision-making.md requires of every representation of an
  // analysis, the opposing texts in the error color. The symbols are plain marks here: the link of issue #133 belongs to
  // the decision page. The region has a bounded height and scrolls inside itself, so a long document never takes the
  // dashboard [aesthetic and minimalist design].
  import { render } from "../markdown.ts";
  import { viewOf, type EntryView } from "../../../src/analysisView.ts";
  import { recommendedOption } from "../../../src/prompts.ts";
  import type { ShownDocument } from "../../../src/reviewedDocument.ts";

  let { document, id }: { document: ShownDocument; id: string } = $props();
  const view = $derived(document._tag === "Analysis" ? viewOf(document.analysis) : null);
</script>

{#snippet entryOf(entry: EntryView)}
  <li class="entry" class:opposes={entry.opposes}>
    <p class="title"><strong>{entry.label}</strong> {entry.title}{#if entry.symbol !== null} <span data-symbol>{entry.symbol}</span>{/if}</p>
    {#each entry.elements as element, i (i)}
      <p class:opposes={element.opposes}>{element.text}</p>
      {#each element.arguments as argument (argument.id)}
        <p class="argument" class:opposes={argument.opposes} data-argument-level={argument.level} style:margin-inline-start="{argument.level}rem">{argument.text}{#if argument.symbol !== null} <span data-symbol>{argument.symbol.mark}</span>{/if}</p>
      {/each}
    {/each}
  </li>
{/snippet}

<div class="document" {id} data-document>
  {#if document._tag === "Markdown"}
    <div class="markdown m3-font-body-medium">{@html render(document.text)}</div>
  {:else if document._tag === "Diff"}
    <pre class="diff">{document.text}</pre>
  {:else if view !== null}
    <div class="analysis m3-font-body-medium">
      {#each view.columns as column, c (c)}
        <section class="column">
          <h3>{column.option}</h3>
          {#if column.kind === "unclear"}
            <p>{column.unclear}</p>
          {:else}
            <h4>{column.advantagesHeading}</h4>
            <ol>{#each column.advantages as entry (entry.index)}{@render entryOf(entry)}{/each}</ol>
            <h4>{column.disadvantagesHeading}</h4>
            <ol>{#each column.disadvantages as entry (entry.index)}{@render entryOf(entry)}{/each}</ol>
          {/if}
        </section>
      {/each}
      {#if view.recommendation !== null}
        <section class="recommendation">
          <h3>{recommendedOption(view.recommendation.option)}</h3>
          {#each view.recommendation.reason.split(/\n\s*\n/) as paragraph, i (i)}<p>{paragraph}</p>{/each}
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .document { max-height: 24rem; overflow-y: auto; margin-top: 0.25rem; padding: 0.5rem 0.875rem; border-radius: var(--m3-shape-large); background: var(--m3c-surface-container-high); color: var(--m3c-on-surface); }
  .diff { margin: 0; overflow-x: auto; white-space: pre; font-family: var(--m3-font-mono); font-size: 0.8125em; }
  .markdown :global(pre) { overflow-x: auto; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
  .analysis h3 { margin: 0.5rem 0 0.25rem; font-size: 1rem; }
  .analysis h4 { margin: 0.25rem 0; font-size: 0.875rem; }
  .analysis ol { list-style: none; margin: 0; padding: 0; }
  .analysis p { margin: 0.125rem 0; }
  .entry { margin-bottom: 0.5rem; }
  .opposes { color: var(--m3c-error); }
</style>
