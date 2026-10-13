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
  import { Button, ConnectedButtons, ListItem, LoadingIndicator } from "m3-svelte";
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
        <li>
          <ListItem headline={itemHeadline(item.id, item.title)} supporting={item.excerpt} lines={item.excerpt === "" ? 1 : 2}>
            {#snippet trailing()}
              <Button variant="text" type="button" name="start" data-item={item.id} disabled={running || offline} onclick={() => onStart(item)}>{texts.action}</Button>
            {/snippet}
          </ListItem>
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
  .loading, .unavailable { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; }
  .unavailable { color: var(--m3c-error); flex-wrap: wrap; }
  .unavailable p, .empty { margin: 0; }
  .empty { color: var(--m3c-on-surface-variant); padding: 1rem; }
</style>
