<script lang="ts">
  // The analysis of a decision (decision support), over both chat columns until the question is answered.
  // One column per option, as docs/decision-making.md requires ("Layout and wording"), side by side at a minimum
  // readable width of 20rem (about 45 characters of body text) and scrolling sideways when they do not fit (decision
  // Q5) [aesthetic and minimalist design: nothing is squeezed to unreadable widths; match between the system and the
  // real world: it reads as prose, in columns as on paper]; each column names its option at its head [recognition
  // rather than recall], and a line says when columns lie outside the window [visibility of system status]. Each
  // counterargument is offset under the element it disputes, one step per level, with a rule on its left; the headings
  // "Advantages:" and "Disadvantages:", each entry's label ("Advantage 1:"), the equivalence symbols, and which texts
  // oppose the column's option come from src/analysisView.ts (issue #35). Every text that argues against the column's
  // option is in the scheme's error color, so that a rebuttal reads apart from what it disputes [visibility of system
  // status; match between the system and the real world: the two voices of an argument are told apart at a glance]; the
  // headings and the option's name keep their color. An option whose meaning is unclear shows what is unclear in place of
  // its headings (decision Q8). Issue #87: every entry starts collapsed to its label and whole title, opened one at a
  // time by the reader [aesthetic and minimalist design: a column is first a list of outcomes]; an entry that hides a
  // contradicting position carries a mark, and one that does not carries none, so the reader can skip it knowing no
  // reasoning disputes it [visibility of system status]; which entries are open is the run's shared state, the same in
  // every tab [consistency and standards; user control and freedom]. Below 390 px nothing is laid out and a
  // message asks for a wider window; the prompt below stays usable [help users recognize and recover]. The
  // conversation is one click away and back [user control and freedom].
  import { Button } from "m3-svelte";
  import { CONTEXT_BY_PROGRAM, decisionViewHeading, ENLARGE_WINDOW_NOTICE, ENTRY_DISPUTED_LABEL, entryToggleName, recommendedOption, RECOMMENDATION_HEADING, SCROLL_SIDEWAYS_HINT, SHOW_CONVERSATION } from "../../../src/prompts.ts";
  import { type EntryView, viewOf } from "../../../src/analysisView.ts";
  import type { UiEvent } from "../../../src/uiEvents.ts";
  import QuestionText from "./QuestionText.svelte";

  /** `open` and `onToggle` (issue #87): whether an entry of this decision is open in the run's shared state, and the change asked for. */
  type Props = { event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; narrow: boolean; open: (entry: string) => boolean; onToggle: (entry: string, open: boolean) => void; onShowConversation: () => void };
  let { event, narrow, open, onToggle, onShowConversation }: Props = $props();
  const view = $derived(viewOf(event.analysis));
  let row = $state<HTMLElement | null>(null);
  let overflowing = $state(false);
  const measure = () => {
    if (row !== null) overflowing = row.scrollWidth > row.clientWidth + 1;
  };
  $effect(() => {
    void view;
    measure();
  });
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
</script>

<svelte:window onresize={measure} />
{#snippet entryOf(entry: EntryView, bodyId: string)}
  {@const expanded = open(entry.id)}
  <div class="entry">
    <!-- Issue #87: the row is the entry's label and whole title (decision Q2), a native button, so that Enter and Space
         open it [flexibility and efficiency of use]; its body is rendered only while it is open [aesthetic and
         minimalist design]. The mark says that a text inside argues the other side [visibility of system status]. -->
    <button type="button" class="toggle" aria-expanded={expanded} aria-controls={bodyId} aria-label={entryToggleName(entry.label, entry.title, expanded)} onclick={() => onToggle(entry.id, !expanded)}>
      <span class="chevron" class:expanded aria-hidden="true"></span>
      <span class="title m3-font-title-small" class:opposes={entry.opposes} data-opposes={entry.opposes}><span class="label">{entry.label}</span> {marked(entry.title, entry.symbol)}</span>
      {#if entry.disputed}<span class="disputed" role="img" aria-label={ENTRY_DISPUTED_LABEL}>⚠</span>{/if}
    </button>
    {#if expanded}
      <ul class="elements" id={bodyId}>
        {#each entry.elements as element, i (i)}
          <li class="element">
            <span class="element-text" class:opposes={element.opposes} data-opposes={element.opposes}>{element.text}</span>
            {#if element.arguments.length > 0}
              <ul class="arguments">
                {#each element.arguments as argument (argument.id)}
                  <li class="argument" class:opposes={argument.opposes} data-opposes={argument.opposes} data-level={argument.level} style:margin-left="{(argument.level - 1) * 1.25}rem">{marked(argument.text, argument.symbol)}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<section class="decision" aria-label={decisionViewHeading(event.decision, event.presented.number)}>
  <div class="head">
    <h2 class="m3-font-title-medium">{decisionViewHeading(event.decision, event.presented.number)}</h2>
    <Button variant="tonal" type="button" name="conversation" onclick={onShowConversation}>{SHOW_CONVERSATION}</Button>
  </div>
  <!-- S22: the question the analysis is for, as the user was shown it: its context apart, then the question itself
       [recognition rather than recall: what is being decided stays beside the arguments]. -->
  <div class="question">
    <!-- S28: the question's terms carry their explanations here too; the analysis text does not. -->
    <!-- S46 (W3-R1-3): the details the question is about (a permission's input, a pause's facts, an agreed question's
         reason) follow the context in the same scrolling region, as the terminal prints them. -->
    <div class="question-context m3-font-body-medium">
      <!-- S59 (P9-R2-1): the context is Markdown, as in QuestionPane and the transcript, so a term split by inline
           markup is marked here too. -->
      <QuestionText class="context-text markdown" blocks={event.presented.context.blocks} explanations={event.presented.explanations} />
      {#if event.presented.context.by === "program"}<p class="by">({CONTEXT_BY_PROGRAM})</p>{/if}
      {#if event.presented.details.length > 0}<QuestionText class="details markdown" blocks={event.presented.details} explanations={event.presented.explanations} />{/if}
    </div>
    <p class="question-text m3-font-title-small"><QuestionText class="markdown" pieces={event.presented.question} explanations={event.presented.explanations} /></p>
  </div>
  {#if narrow}
    <p class="narrow m3-font-body-medium" role="alert">{ENLARGE_WINDOW_NOTICE}</p>
  {:else}
    {#if overflowing}<p class="hint m3-font-body-small">{SCROLL_SIDEWAYS_HINT}</p>{/if}
    <!-- The columns and the recommendation scroll together, so that a long recommendation never squeezes the columns
         (W1-R1-3) [aesthetic and minimalist design; visibility of system status: all of it can be reached]. -->
    <div class="scroll" bind:this={row}>
    <div class="columns" style:grid-template-columns="repeat({view.columns.length}, minmax(20rem, 1fr))">
      {#each view.columns as column, i (i)}
        <article class="column m3-font-body-medium">
          <h3 class="m3-font-title-medium">{column.option}</h3>
          {#if column.kind === "unclear"}
            <p class="unclear">{column.unclear}</p>
          {:else}
            <h4 class="advantages-heading m3-font-title-small">{column.advantagesHeading}</h4>
            {#each column.advantages as entry, j (entry.id)}{@render entryOf(entry, `decision-${event.decision}-${i}-a${j}`)}{/each}
            <h4 class="disadvantages-heading m3-font-title-small">{column.disadvantagesHeading}</h4>
            {#each column.disadvantages as entry, j (entry.id)}{@render entryOf(entry, `decision-${event.decision}-${i}-d${j}`)}{/each}
          {/if}
        </article>
      {/each}
    </div>
    {#if view.recommendation !== null}
      <section class="recommendation m3-font-body-medium" aria-label={RECOMMENDATION_HEADING}>
        <h3 class="m3-font-title-small">{recommendedOption(view.recommendation.option)}</h3>
        {#each view.recommendation.reason.split(/\n\s*\n/) as paragraph, i (i)}<p>{paragraph}</p>{/each}
      </section>
    {/if}
    </div>
  {/if}
</section>

<style>
  .decision { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-height: 0; min-width: 0; overflow: hidden; padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-lowest); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .head h2 { margin: 0; }
  /* The question beside its analysis (S39, W2-R1-2): only the context is bounded and scrolls on its own; the question
     text follows it outside any scrolled region, as in QuestionPane, so a long context cannot push it out of view. */
  .question { flex-shrink: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .question-context { margin: 0; box-sizing: border-box; max-height: 2.75rem; overflow-y: auto; padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-small); background: var(--m3c-surface-container); color: var(--m3c-on-surface-variant); }
  .question-context .by { margin: 0.25rem 0 0; font-style: italic; }
  .question-context :global(.details) { margin-top: 0.5rem; white-space: normal; }
  .question-context :global(.details pre) { overflow-x: auto; }
  .question-text { margin: 0; }
  .hint, .narrow { margin: 0; color: var(--m3c-on-surface-variant); }
  /* The columns and the recommendation scroll in both directions within the area, so that the question and the prompt stay in view. */
  .scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .columns { display: grid; gap: 0.75rem; flex-shrink: 0; align-items: start; }
  .column { padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container); user-select: text; }
  .column h3 { margin: 0 0 0.5rem; position: sticky; top: 0; background: inherit; }
  .advantages-heading { margin: 0 0 0.5rem; }
  .disadvantages-heading { margin: 1rem 0 0.5rem; }
  .unclear { margin: 0; }
  .label { font-weight: 600; }
  .entry { margin-bottom: 0.25rem; }
  /* Issue #87: the disclosure, hand-built after M3's list item: a state layer of the on-surface color on hover (8 %),
     focus (10 %) and press (10 %), a focus ring, and the standard easing for the chevron and the body; none of it under
     reduced motion. It asserts that the entry is open or closed and nothing more (docs/ui-review.md). The title wraps
     whole (decision Q2). */
  .toggle { position: relative; display: flex; align-items: flex-start; gap: 0.5rem; width: 100%; margin: 0; padding: 0.375rem 0.5rem; border: 0; border-radius: var(--m3-shape-small); background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; overflow: hidden; }
  .toggle::before { content: ""; position: absolute; inset: 0; background: var(--m3c-on-surface); opacity: 0; transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1); pointer-events: none; }
  .toggle:hover::before { opacity: 0.08; }
  .toggle:focus-visible::before, .toggle:active::before { opacity: 0.1; }
  .toggle:focus-visible { outline: 3px solid var(--m3c-secondary); outline-offset: 2px; }
  .chevron { flex: none; width: 0.5rem; height: 0.5rem; margin-top: 0.4rem; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform 200ms cubic-bezier(0.2, 0, 0, 1); }
  .chevron.expanded { transform: rotate(45deg); }
  .title { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .disputed { flex: none; color: var(--m3c-error); font-weight: 700; }
  .elements { animation: reveal 200ms cubic-bezier(0.2, 0, 0, 1); }
  @keyframes reveal { from { opacity: 0; transform: translateY(-0.25rem); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .toggle::before, .chevron { transition: none; }
    .elements { animation: none; }
  }
  .elements { margin: 0.25rem 0 0.5rem; padding-left: 2.25rem; }
  .element { margin-bottom: 0.25rem; }
  .arguments { list-style: none; margin: 0.25rem 0 0.25rem 0.5rem; padding: 0; }
  .argument { margin-top: 0.25rem; padding-left: 0.5rem; border-left: 2px solid var(--m3c-outline-variant); }
  /* Issue #35 (Q7): what argues against the column's option, in the scheme's error color; the rest keeps the text color. */
  .opposes { color: var(--m3c-error); }
  .recommendation { padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .recommendation { position: sticky; left: 0; flex-shrink: 0; }
  .recommendation h3 { margin: 0; }
  .recommendation p { margin: 0.5rem 0 0; }
</style>
