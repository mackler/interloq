<script lang="ts">
  // A tab's items (issue #120): an M3 list of the project's tracker's items in the tab's state, each with its id and
  // title as the headline, its text as supporting text, and a trailing text button that starts the tab's run [error
  // prevention without a confirmation, which behavior 1 forbids: selecting or scrolling through the list starts nothing;
  // only the button does]. A refresh, an empty state, a loading indicator, and, when the tracker cannot be reached, its
  // notice with Try again [visibility of system status; help users recognize, diagnose and recover from errors]. The
  // server makes every tracker call; this component sends frames through its callbacks alone.
  // Issue #142 (requirements Q3): above the Refinement tab's list, the choice of how the agreed questions' terms are
  // explained, M3's connected button group with one choice among three (radio inputs, which m3-svelte's buttons show
  // as toggles): it starts at the configured value and applies to the next refinement [user control and freedom;
  // visibility of system status]. The Implementation tab has none, since an implementation run asks no questions.
  // Issue #125: each row is laid out by hand after M3's list item, not m3-svelte's ListItem, which fixes a row's height
  // from its line count and so drew a wrapped title's text over the next row. The row keeps M3's list item metrics
  // (padding, gap, the trailing action, the headline's and supporting text's type and colors) and grows with its
  // content: the whole title and the whole excerpt, nothing clamped (the deviation is recorded in docs/ui-review.md).
  // The headline links to the item's page in its tracker, in a new tab, apart from the start button, so the developer
  // reads the whole issue without leaving the list [recognition rather than recall]; an item without an address shows
  // its headline as plain text.
  import { Button, ConnectedButtons, LoadingIndicator } from "m3-svelte";
  import type { ListedItem } from "../../../src/protocol.ts";
  import type { RunMode } from "../../../src/runMode.ts";
  import { TERMS_MODES, type TermsMode } from "../../../src/schema.ts";
  import { ITEMS_LOADING, ITEMS_REFRESH, ITEMS_RETRY, itemHeadline, TAB_TEXTS, TERMS_CHOICE_LABEL, TERMS_CHOICE_TEXTS } from "../../../src/prompts.ts";
  import type { ItemsView } from "../state.ts";

  type Props = { mode: RunMode; items: ItemsView; running: boolean; offline?: boolean; terms?: TermsMode | null; onTerms?: (terms: TermsMode) => void; onStart: (item: ListedItem) => void; onRefresh: () => void };
  let { mode, items, running, offline = false, terms = null, onTerms = () => undefined, onStart, onRefresh }: Props = $props();
  const texts = $derived(TAB_TEXTS[mode]);
</script>

<section class="items" aria-label={texts.list}>
  <div class="head">
    <h2 class="m3-font-title-medium">{texts.list}</h2>
    {#if items._tag === "Listed"}<Button variant="text" type="button" name="refresh" disabled={offline} onclick={onRefresh}>{ITEMS_REFRESH}</Button>{/if}
  </div>
  {#if mode === "refinement" && items._tag === "Listed" && terms !== null}
    <div class="terms">
      <span class="m3-font-label-large">{TERMS_CHOICE_LABEL}</span>
      <ConnectedButtons role="radiogroup" aria-label={TERMS_CHOICE_LABEL}>
        {#each TERMS_MODES as value (value)}
          <Button variant="tonal" label>
            <input type="radio" name="terms-choice" {value} checked={terms === value} onchange={() => onTerms(value)} />
            {TERMS_CHOICE_TEXTS[value]}
          </Button>
        {/each}
      </ConnectedButtons>
    </div>
  {/if}
  {#if items._tag === "Unasked" || items._tag === "Loading"}
    <div class="loading" role="status"><LoadingIndicator aria-label={ITEMS_LOADING} /><span class="m3-font-body-medium">{ITEMS_LOADING}</span></div>
  {:else if items._tag === "Unavailable"}
    <div class="unavailable" role="alert">
      <p class="m3-font-body-medium">{items.notice}</p>
      <Button variant="tonal" type="button" name="retry" disabled={offline} onclick={onRefresh}>{ITEMS_RETRY}</Button>
    </div>
  {:else if items.items.length === 0}
    <p class="empty m3-font-body-large">{texts.empty}</p>
  {:else}
    <ul>
      {#each items.items as item (item.id)}
        <li class:two-line={item.excerpt !== ""}>
          <div class="body">
            <p class="headline" data-headline>
              {#if item.url === null}{itemHeadline(item.id, item.title)}{:else}<a href={item.url} target="_blank" rel="noopener noreferrer">{itemHeadline(item.id, item.title)}</a>{/if}
            </p>
            {#if item.excerpt !== ""}<p class="supporting" data-supporting>{item.excerpt}</p>{/if}
          </div>
          <div class="trailing">
            <Button variant="text" type="button" name="start" data-item={item.id} disabled={running || offline} onclick={() => onStart(item)}>{texts.action}</Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .items { display: flex; flex-direction: column; gap: 0.5rem; max-width: 56rem; width: 100%; margin: 1rem auto; padding: 0 1rem; box-sizing: border-box; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  h2 { margin: 0; }
  .terms { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
  ul { list-style: none; margin: 0; padding: 0; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  /* M3's list item, by hand (issue #125): its padding and gap, its one-line and two-line heights as a minimum only. */
  li { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1.5rem 0.5rem 1rem; min-height: 3.5rem; box-sizing: border-box; }
  li.two-line { min-height: 4.5rem; }
  .body { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .trailing { flex: none; }
  /* Body large and body medium, set here since the m3-font classes are absent from the build. */
  .headline, .supporting { margin: 0; font-family: var(--m3-font); }
  .headline { font-size: 1rem; line-height: 1.5; font-weight: 400; color: var(--m3c-on-surface); }
  .supporting { font-size: 0.875rem; line-height: 1.429; color: var(--m3c-on-surface-variant); }
  .headline a { color: inherit; text-decoration: none; border-radius: 0.25rem; }
  .headline a:hover, .headline a:focus-visible { text-decoration: underline; }
  .headline a:focus-visible { outline: 3px solid var(--m3c-secondary); outline-offset: 2px; }
  .loading, .unavailable { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; }
  .unavailable { color: var(--m3c-error); flex-wrap: wrap; }
  .unavailable p, .empty { margin: 0; }
  .empty { color: var(--m3c-on-surface-variant); padding: 1rem; }
</style>
