<script lang="ts">
  // An entry's parts as the page shows them (issue #41), for the decision page and the dashboard's draft analysis alike,
  // so the two never disagree. The structure carries the relations (WCAG 2.1, 1.3.1): the chain of causes (the starting
  // cause, the steps, the threshold, the effect) is one ordered list and the extent's four statements one list, each
  // named; every part's text begins with its name, read by screen readers alone (the developer's decision Q1 of the
  // refinement of issue #41), and every glyph is hidden from them [match between the system and the real world: one
  // chain reads as one chain, not ten parallel reasons]. The marks sit in one column at the chain's indent, so an arrow
  // never reads as following from the threshold or a counterargument above it; the threshold carries no mark and a rule
  // on its left. Each type style is set on its part's own text, never on the counterarguments beside it, which keep
  // plain body text and their side's color (issue #35).
  import type { Snippet } from "svelte";
  import type { ArgumentView, ElementRole, ElementView, EntryView } from "../../../src/analysisView.ts";
  import { CHAIN_LINK_MARK, CHAIN_START_MARK, ELEMENT_GROUP_NAMES, ELEMENT_ROLE_NAMES, REASON_MARK } from "../../../src/prompts.ts";

  /** `symbol`: an argument's equivalence symbol as the caller shows it (a link on the decision page, a mark in a draft). */
  type Props = { entry: EntryView; symbol: Snippet<[ArgumentView]> };
  let { entry, symbol }: Props = $props();

  const markOf = (role: ElementRole): string | null => {
    switch (role) {
      case "startingCause":
        return CHAIN_START_MARK;
      case "intermediateSteps":
      case "effectOnPersons":
        return CHAIN_LINK_MARK;
      case "reasonTheEffectMatters":
        return REASON_MARK;
      case "comparativeCondition":
      case "threshold":
      case "perPerson":
      case "personsAffected":
      case "likelihood":
      case "timing":
        return null;
    }
  };
  const groupElements = (kind: string): readonly ElementView[] => entry.groups.find((g) => g.kind === kind)?.elements ?? [];
</script>

{#snippet body(element: ElementView)}
  {@const mark = markOf(element.role)}
  {#if mark !== null}<span class="mark" aria-hidden="true">{mark}</span>{/if}
  <div class="content">
    <span class="element-text {element.role}" class:opposes={element.opposes} data-opposes={element.opposes} data-role={element.role}><span class="visually-hidden">{`${ELEMENT_ROLE_NAMES[element.role]}: `}</span>{element.text}</span>
    {#if element.arguments.length > 0}
      <ul class="arguments">
        {#each element.arguments as argument (argument.id)}
          <li class="argument" class:opposes={argument.opposes} data-opposes={argument.opposes} data-level={argument.level} data-argument-level={argument.level} style:margin-left="{(argument.level - 1) * 1.25}rem">{argument.text}{#if argument.symbol !== null}{" "}{@render symbol(argument)}{/if}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<div class="analysis-elements">
  {#each groupElements("premise") as element (element.role)}
    <div class="part premise" data-role={element.role}>{@render body(element)}</div>
  {/each}
  <ol class="chain" aria-label={ELEMENT_GROUP_NAMES.chain}>
    {#each groupElements("chain") as element (element.role)}
      <li class="part" data-role={element.role}>{@render body(element)}</li>
    {/each}
  </ol>
  {#each groupElements("reason") as element (element.role)}
    <div class="part reason" data-role={element.role}>{@render body(element)}</div>
  {/each}
  <ul class="extent" aria-label={ELEMENT_GROUP_NAMES.extent}>
    {#each groupElements("extent") as element (element.role)}
      <li class="part" data-role={element.role}>{@render body(element)}</li>
    {/each}
  </ul>
</div>

<style>
  .analysis-elements { display: flow-root; }
  .chain, .extent { list-style: none; margin: 0; padding: 0; }
  /* One column of marks at the chain's own indent, and every text, counterarguments included, in the second. */
  /* position: relative: the hidden names, absolutely positioned, stay inside the scroller that holds their column. */
  .part { position: relative; display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); margin-bottom: 0.25rem; }
  .content { grid-column: 2; min-width: 0; overflow-wrap: anywhere; }
  .mark { grid-column: 1; }
  .extent { margin-top: 0.25rem; }
  /* Each part's style on its own text alone (issue #41, proposed; judged on a rendered example). */
  .element-text.comparativeCondition { font-style: italic; }
  .element-text.threshold { display: block; font-weight: 700; padding-left: 0.5rem; border-left: 2px solid var(--m3c-outline-variant); }
  .element-text:is(.perPerson, .personsAffected, .likelihood, .timing) { font-size: 1rem; line-height: 1.5rem; }
  .arguments { list-style: none; margin: 0.25rem 0 0.25rem 0.5rem; padding: 0; font-weight: 400; font-style: normal; font-size: 0.875rem; line-height: 1.25rem; }
  .argument { margin-top: 0.25rem; padding-left: 0.5rem; border-left: 2px solid var(--m3c-outline-variant); }
  /* Issue #35 (Q7): what argues against the column's option, in the scheme's error color. */
  .opposes { color: var(--m3c-error); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
