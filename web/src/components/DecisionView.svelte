<script lang="ts">
  // The analysis of a decision (decision support), over both chat columns until the question is answered. Issue #133
  // (the developer's instruction of 11 Oct 2026, decisions Q2, G-R1-1 and G-R1-2 of its requirements): top to bottom,
  // the question as the heading, the choices under it, the columns of advantages and disadvantages, and then the
  // headings of what the reader has already read (Technical Context, History, the question's attached material,
  // Recommendation), each closed when the page appears and opened one at a time [aesthetic and minimalist design: the
  // arguments are the one new thing, so they take the page; recognition rather than recall: the rest is one click
  // away]. The question and the choices are at the top, so they are in view by construction, and the page does not
  // scroll: an opened heading's text takes height from the columns, at most half, and scrolls inside itself
  // (allotOpened of web/src/layout.ts) [visibility of system status].
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
  // reasoning disputes it [visibility of system status]; which entries are open, and which heading, is the run's shared
  // state, the same in every tab [consistency and standards; user control and freedom]. An equivalence symbol is a link
  // that moves the focus to the entry it names, whose name says what it is (issue #133) [recognition rather than recall].
  // Below 390 px no column is laid out and a message asks for a wider window; the answers and the headings stay usable
  // [help users recognize and recover]. The conversation is one click away and back [user control and freedom].
  import type { Snippet } from "svelte";
  import { Button } from "m3-svelte";
  import { attachedHeading, CONTEXT_BY_PROGRAM, CONTEXT_HEADING, decisionRegionName, ENLARGE_WINDOW_NOTICE, ENTRY_DISPUTED_LABEL, entryToggleName, equivalenceLinkName, QUESTION_HISTORY_HEADING, recommendedOption, RECOMMENDATION_HEADING, SCROLL_SIDEWAYS_HINT, SHOW_CONVERSATION, YOUR_CHOICE } from "../../../src/prompts.ts";
  import { type ArgumentView, type EntryView, viewOf } from "../../../src/analysisView.ts";
  import { blocksText, piecesText } from "../../../src/pieces.ts";
  import type { DecisionSection } from "../../../src/uiState.ts";
  import { allotOpened } from "../layout.ts";
  import type { UiEvent } from "../../../src/uiEvents.ts";
  import QuestionText from "./QuestionText.svelte";
  import Disclosure from "./Disclosure.svelte";

  /**
   * `open` and `onToggle` (issue #87): whether an entry of this decision is open in the run's shared state, and the
   * change asked for; `openSection` and `onSection` (issue #133): the one heading open in the shared state, and the
   * change asked for; `answers`: the choices, rendered under the heading.
   */
  type Props = {
    event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>;
    narrow: boolean;
    open: (entry: string) => boolean;
    onToggle: (entry: string, open: boolean) => void;
    openSection: DecisionSection | null;
    onSection: (section: DecisionSection, open: boolean) => void;
    onShowConversation: () => void;
    answers: Snippet;
  };
  let { event, narrow, open, onToggle, openSection, onSection, onShowConversation, answers }: Props = $props();
  const view = $derived(viewOf(event.analysis));
  const presented = $derived(event.presented);
  const hasText = (blocks: Parameters<typeof blocksText>[0]) => blocksText(blocks).join("").trim() !== "";
  /** The headings present, in order: each only with its text (the open point "a heading with no text"). */
  const sections = $derived<readonly Readonly<{ section: DecisionSection; heading: string }>[]>([
    { section: "context", heading: CONTEXT_HEADING },
    ...(hasText(presented.history) ? [{ section: "history" as const, heading: QUESTION_HISTORY_HEADING }] : []),
    ...(presented.attached === null ? [] : [{ section: "attached" as const, heading: attachedHeading(presented.attached.kind) }]),
    ...(view.recommendation === null ? [] : [{ section: "recommendation" as const, heading: RECOMMENDATION_HEADING }]),
  ]);
  /** The open heading, if it is one this page shows. */
  const shownSection = $derived(sections.some((s) => s.section === openSection) ? openSection : null);
  const sectionId = (section: DecisionSection) => `decision-${event.decision}-section-${section}`;
  const entryButtonId = (index: number) => `decision-${event.decision}-entry-${index}`;
  const entries = $derived(view.columns.flatMap((c) => (c.kind === "unclear" ? [] : [...c.advantages, ...c.disadvantages])));

  let row = $state<HTMLElement | null>(null);
  let overflowing = $state(false);
  const measure = () => {
    if (row !== null) overflowing = row.scrollWidth > row.clientWidth + 1;
  };
  $effect(() => {
    void view;
    measure();
  });

  // Decision Q2: the height the opened text and the columns share is the section's, less its padding, every child but
  // the columns and the opened body, and the gaps between the children; neither of those two enters the sum, so the
  // measurement never depends on the last allotment. The text takes its part (allotOpened), the columns the rest.
  let section = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);
  let bodyInner = $state<HTMLElement | null>(null);
  let textHeight = $state<number | null>(null);
  const px = (v: string) => parseFloat(v) || 0;
  const verticalPadding = (el: Element) => {
    const cs = getComputedStyle(el);
    return px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  };
  const allot = () => {
    if (section === null || body === null || bodyInner === null) {
      if (textHeight !== null) textHeight = null;
      return;
    }
    const kids = [...section.children] as HTMLElement[];
    const fixed = kids.filter((k) => k !== row && k !== body).reduce((n, k) => n + k.getBoundingClientRect().height, 0);
    const gaps = Math.max(0, kids.length - 1) * px(getComputedStyle(section).rowGap);
    const shared = section.clientHeight - verticalPadding(section) - fixed - gaps;
    const content = bodyInner.getBoundingClientRect().height + verticalPadding(body);
    const next = allotOpened({ _tag: narrow ? "Alone" : "BesideColumns", shared, content }).text;
    if (textHeight !== next) textHeight = next;
  };
  $effect(() => {
    void shownSection;
    void narrow;
    void view;
    allot();
  });
  $effect(() => {
    if (section === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => allot());
    observer.observe(section);
    for (const k of section.children) if (k !== row && k !== body) observer.observe(k);
    if (bodyInner !== null) observer.observe(bodyInner);
    return () => observer.disconnect();
  });
  const resized = () => {
    measure();
    allot();
  };
  /** An equivalence symbol's link (issue #133): the focus moves to the entry it names, scrolled into view within the columns alone. */
  const follow = (e: MouseEvent, index: number) => {
    e.preventDefault();
    const target = document.getElementById(entryButtonId(index));
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    target?.focus();
  };
  const targetOf = (argument: ArgumentView) => (argument.symbol === null ? undefined : entries.find((x) => x.index === argument.symbol?.entry));
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
</script>

<svelte:window onresize={resized} />
{#snippet entryOf(entry: EntryView, bodyId: string)}
  {@const expanded = open(entry.id)}
  <div class="entry">
    <!-- Issue #87: the row is the entry's label and whole title (decision Q2), a native button, so that Enter and Space
         open it [flexibility and efficiency of use]; its body is rendered only while it is open [aesthetic and
         minimalist design]. The mark says that a text inside argues the other side [visibility of system status]. -->
    <Disclosure {expanded} id={entryButtonId(entry.index)} controls={bodyId} name={entryToggleName(entry.label, entry.title, expanded)} onToggle={(o) => onToggle(entry.id, o)}>
      {#snippet title()}
        <span class="title m3-font-title-small" class:opposes={entry.opposes} data-opposes={entry.opposes}><span class="label">{entry.label}</span> {marked(entry.title, entry.symbol)}</span>
        {#if entry.disputed}<span class="disputed" role="img" aria-label={ENTRY_DISPUTED_LABEL}>⚠</span>{/if}
      {/snippet}
      <ul class="elements" id={bodyId}>
        {#each entry.elements as element, i (i)}
          <li class="element">
            <span class="element-text" class:opposes={element.opposes} data-opposes={element.opposes}>{element.text}</span>
            {#if element.arguments.length > 0}
              <ul class="arguments">
                {#each element.arguments as argument (argument.id)}
                  {@const target = targetOf(argument)}
                  <li class="argument" class:opposes={argument.opposes} data-opposes={argument.opposes} data-level={argument.level} style:margin-left="{(argument.level - 1) * 1.25}rem">{argument.text}{#if argument.symbol !== null && target !== undefined}{" "}<a class="equivalence" href="#{entryButtonId(target.index)}" aria-label={equivalenceLinkName(argument.symbol.mark, target.label, target.title)} onclick={(e) => follow(e, target.index)}>{argument.symbol.mark}</a>{/if}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </Disclosure>
  </div>
{/snippet}

<section class="decision" aria-label={decisionRegionName(piecesText(presented.question))} bind:this={section}>
  <div class="head">
    <!-- Issue #133: the heading is the question, after "Your Choice:", in title-medium; it wraps, so the whole question
         is read [visibility of system status]. -->
    <h2><span class="your-choice">{YOUR_CHOICE}</span> <QuestionText class="markdown" pieces={presented.question} explanations={presented.explanations} /></h2>
    <Button variant="tonal" type="button" name="conversation" onclick={onShowConversation}>{SHOW_CONVERSATION}</Button>
  </div>
  <div class="answers">{@render answers()}</div>
  {#if narrow}
    <p class="narrow m3-font-body-medium" role="alert">{ENLARGE_WINDOW_NOTICE}</p>
  {:else}
    {#if overflowing}<p class="hint m3-font-body-small">{SCROLL_SIDEWAYS_HINT}</p>{/if}
    <!-- Issue #81: the region scrolls sideways when the columns do not fit, and each column scrolls on its own inside it
         (the developer's instruction of 1 Oct 2026), so a short column stays in view while a long one is read. -->
    <div class="sideways" bind:this={row}>
      <div class="columns" style:grid-template-columns="repeat({view.columns.length}, minmax(20rem, 1fr))">
        {#each view.columns as column, i (i)}
          <article class="column m3-font-body-medium">
            <div class="column-content">
              <h3 class="m3-font-title-medium">{column.option}</h3>
              {#if column.kind === "unclear"}
                <p class="unclear">{column.unclear}</p>
              {:else}
                <h4 class="advantages-heading m3-font-title-small">{column.advantagesHeading}</h4>
                {#each column.advantages as entry, j (entry.id)}{@render entryOf(entry, `decision-${event.decision}-${i}-a${j}`)}{/each}
                <h4 class="disadvantages-heading m3-font-title-small">{column.disadvantagesHeading}</h4>
                {#each column.disadvantages as entry, j (entry.id)}{@render entryOf(entry, `decision-${event.decision}-${i}-d${j}`)}{/each}
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </div>
  {/if}
  <!-- Issue #133, the open points' defaults: the headings side by side, wrapping onto as few rows as fit, one open at a
       time; Disclosure (issue #137's control), sized to its content. -->
  <div class="sections">
    {#each sections as s (s.section)}
      <Disclosure fit expanded={shownSection === s.section} controls={sectionId(s.section)} onToggle={(o) => onSection(s.section, o)}>
        {#snippet title()}<span class="section-title m3-font-title-small">{s.heading}</span>{/snippet}
      </Disclosure>
    {/each}
  </div>
  {#if shownSection !== null}
    <div class="body m3-font-body-medium" id={sectionId(shownSection)} bind:this={body} style:height={textHeight === null ? null : `${textHeight}px`}>
      <div class="body-inner text-columns" bind:this={bodyInner}>
        {#if shownSection === "context"}
          <QuestionText class="markdown" blocks={presented.context.blocks} explanations={presented.explanations} />
          {#if presented.context.by === "program"}<p class="by">({CONTEXT_BY_PROGRAM})</p>{/if}
        {:else if shownSection === "history"}
          <QuestionText class="markdown" blocks={presented.history} explanations={presented.explanations} />
        {:else if shownSection === "attached" && presented.attached !== null}
          <QuestionText class="markdown" blocks={presented.attached.blocks} explanations={presented.explanations} />
        {:else if shownSection === "recommendation" && view.recommendation !== null}
          <div class="recommendation">
            <h3 class="m3-font-title-small">{recommendedOption(view.recommendation.option)}</h3>
            {#each view.recommendation.reason.split(/\n\s*\n/) as paragraph, i (i)}<p>{paragraph}</p>{/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .decision { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-height: 0; min-width: 0; overflow: hidden; padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-lowest); }
  .decision > :not(.sideways) { flex: none; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
  /* M3's title-medium (16/24, weight 500) set here, since the m3-font-* classes are absent from the build. */
  .head h2 { margin: 0; flex: 1 1 16rem; min-width: 0; font-size: 1rem; line-height: 1.5rem; font-weight: 500; overflow-wrap: anywhere; }
  .head > :global(button) { flex-shrink: 0; }
  .hint, .narrow { margin: 0; color: var(--m3c-on-surface-variant); }
  /* The columns take the height the other regions leave (decision Q2), and each column scrolls on its own inside it. */
  .sideways { flex: 1 1 0; min-height: 0; overflow-x: auto; overflow-y: hidden; }
  .columns { display: grid; gap: 0.75rem; height: 100%; min-height: 0; align-items: stretch; }
  .column { box-sizing: border-box; min-height: 0; max-height: 100%; overflow-y: auto; padding: 0 0.75rem 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container); user-select: text; }
  .column-content { display: flow-root; }
  /* W2-R1-2: the column's own surface color, opaque, so the arguments scroll behind the sticky option name. */
  .column h3 { margin: 0 0 0.5rem; padding-top: 0.75rem; position: sticky; top: 0; z-index: 2; background: var(--m3c-surface-container); }
  .advantages-heading { margin: 0 0 0.5rem; }
  .disadvantages-heading { margin: 1rem 0 0.5rem; }
  .unclear { margin: 0; }
  .label { font-weight: 600; }
  /* flow-root: an open body's margins stay inside its entry, so its height is what closing it takes away. */
  .entry { display: flow-root; margin-bottom: 0.25rem; }
  /* Issue #87: the disclosure itself is Disclosure.svelte (issue #137); the entry's title and body are styled here. */
  .title { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .disputed { flex: none; color: var(--m3c-error); font-weight: 700; }
  .elements { animation: reveal 200ms cubic-bezier(0.2, 0, 0, 1); }
  @keyframes reveal { from { opacity: 0; transform: translateY(-0.25rem); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .elements { animation: none; }
  }
  .elements { margin: 0.25rem 0 0.5rem; padding-left: 2.25rem; }
  .element { margin-bottom: 0.25rem; }
  .arguments { list-style: none; margin: 0.25rem 0 0.25rem 0.5rem; padding: 0; }
  .argument { margin-top: 0.25rem; padding-left: 0.5rem; border-left: 2px solid var(--m3c-outline-variant); }
  /* Issue #133: the symbol is a link to the entry it names, in the text's own color, underlined as a link. */
  .equivalence { color: inherit; }
  /* Issue #35 (Q7): what argues against the column's option, in the scheme's error color; the rest keeps the text color. */
  .opposes { color: var(--m3c-error); }
  .sections { display: flex; flex-wrap: wrap; gap: 0.25rem 0.5rem; }
  .section-title { min-width: 0; }
  /* An opened heading's text: its height from allotOpened, scrolling inside itself beyond it. */
  .body { box-sizing: border-box; overflow-y: auto; padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-small); background: var(--m3c-surface-container); color: var(--m3c-on-surface-variant); }
  .body .by { margin: 0.25rem 0 0; font-style: italic; }
  /* The task: the opened text in columns of 16rem, so two at 640 px wide (a body of about 570 px) and three at 1280 px
     (about 970 px), more as the window widens. The columns are on the inner wrapper, which has no height of its own: a
     multi-column box of fixed height would overflow sideways into further columns instead of scrolling. No code block
     or list item is split across two columns. */
  .text-columns { columns: 16rem; column-gap: 1.5rem; }
  .text-columns :global(pre), .text-columns :global(li) { break-inside: avoid; }
  /* M3's compact window class, below 600 px: one column. */
  @media (max-width: 599.98px) {
    .text-columns { columns: auto 1; }
  }
  .body :global(.markdown pre) { overflow-x: auto; }
  .recommendation h3 { margin: 0; }
  .recommendation p { margin: 0.5rem 0 0; }
</style>
