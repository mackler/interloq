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
  // Issue #163 (decision Q1): while On request is selected, a line under the choice says that each question will offer
  // the Explain the terms button [recognition rather than recall; help and documentation].
  // Issue #125: each row is laid out by hand after M3's list item, not m3-svelte's ListItem, which fixes a row's height
  // from its line count and so drew a wrapped title's text over the next row. The row keeps M3's list item metrics
  // (padding, gap, the trailing action, the headline's and supporting text's type and colors) and grows with its
  // content: the whole title and the whole excerpt, nothing clamped (the deviation is recorded in docs/ui-review.md).
  // The headline links to the item's page in its tracker, in a new tab, apart from the start button, so the developer
  // reads the whole issue without leaving the list [recognition rather than recall]; an item without an address shows
  // its headline as plain text.
  // Issue #191: any number of refinement runs may be in progress; an item being refined says so and its start is
  // disabled, while every other item's start stays enabled [visibility of system status; error prevention without a
  // confirmation: the start the server would refuse cannot be pressed].
  import { Button, ConnectedButtons, LoadingIndicator } from "m3-svelte";
  import type { ListedItem } from "../../../src/protocol.ts";
  import type { RunMode } from "../../../src/runMode.ts";
  import { TERMS_MODES, type TermsMode } from "../../../src/schema.ts";
  import type { PreparationMark } from "../../../src/preparationSwitch.ts";
  import { END_WAIT_LABEL, itemsRateLimitText, RATE_LIMIT_WAITING_LABEL, QUEUE_ADD, queuedMarkText, PREPARED_TERMS_NOTE, PREPARING_MARK, preparedMarkText, setAsideMarkText, ABANDONED_IN_CHAIN, ITEM_IN_PROGRESS, ITEMS_LOADING, sentBackCountText, ITEMS_REFRESH, ITEMS_RETRY, itemHeadline, TAB_TEXTS, TERMS_CHOICE_LABEL, TERMS_CHOICE_TEXTS, TERMS_ON_REQUEST_NOTE } from "../../../src/prompts.ts";
  import { countdownView, type ItemsView, type ItemsWait, type StartableItems } from "../state.ts";
  import Countdown from "./Countdown.svelte";

  // Issue #185: `abandoned`, the items whose run in the current chain stopped waiting for an answer, which carry a mark,
  // so an item back in the refined list does not look untouched [visibility of system status].
  // Issue #131 (requirements Q6): `markOf`, what a row shows of its preparation (shownMark of web/src/state.ts).
  // Issue #196: `queued`, the items of the chain's queue in its order, and `onQueue`, which adds an item to it; given in
  // the Implementation tab alone. A row not queued offers Add to queue, enabled while a run is in progress (unlike the
  // start), and a queued row shows its place in the queue instead [visibility of system status].
  // Issue #219: `itemsWait`, the listing waiting out the tracker's rate limit, shown with its countdown and Try again now
  // (as the status line shows a run's wait), which calls `onEndItemsWait` once per wait and is disabled once pressed
  // [visibility of system status; user control and freedom]. It asserts only that the list is asked for again then.
  // Work review 2 (W2-R1-1, P3-R1-1): `itemsWaits`, one wait per listing of the tab still waiting; the newest is shown,
  // and one press ends every wait still running and not yet sent, never one that already ran out.
  type Props = { itemsWaits?: readonly ItemsWait[]; onEndItemsWait?: (wait: number) => void; endItemsWaitSent?: (wait: number) => boolean; mode: RunMode; items: ItemsView; startable: StartableItems; offline?: boolean; terms?: TermsMode | null; abandoned?: ReadonlySet<string>; markOf?: (item: ListedItem) => PreparationMark | null; onTerms?: (terms: TermsMode) => void; onStart: (item: ListedItem) => void; onRefresh: () => void; queued?: readonly string[]; onQueue?: ((item: ListedItem) => void) | null };
  let { itemsWaits = [], onEndItemsWait = () => undefined, endItemsWaitSent = () => false, mode, items, startable, offline = false, terms = null, abandoned = new Set<string>(), markOf = (i: ListedItem) => i.preparation, onTerms = () => undefined, onStart, onRefresh, queued = [], onQueue = null }: Props = $props();
  const queueable = $derived(mode === "implementation" && onQueue !== null);
  const markText = (mark: PreparationMark): string => (mark._tag === "Preparing" ? PREPARING_MARK : mark._tag === "Prepared" ? preparedMarkText(mark.questions) : setAsideMarkText(mark.reason));
  const texts = $derived(TAB_TEXTS[mode]);
  const inProgress = (id: string): boolean => startable._tag === "Except" && startable.items.includes(id);
  const startableItem = (id: string): boolean => startable._tag === "Except" && !startable.items.includes(id);
  let now = $state(Date.now());
  const itemsWait = $derived(itemsWaits.at(-1) ?? null);
  $effect(() => {
    if (itemsWaits.length === 0) return;
    const until = Math.max(...itemsWaits.map((w) => w.untilMs));
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), 1000);
    const end = setTimeout(() => (now = Math.max(Date.now(), until)), Math.max(until - Date.now(), 0));
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
  });
  const running = $derived(itemsWaits.filter((w) => countdownView(w, now) !== null));
  const unsent = $derived(running.filter((w) => !endItemsWaitSent(w.waitId)));
  const endAll = (): void => {
    for (const w of unsent) onEndItemsWait(w.waitId);
  };
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
      {#if terms === "onRequest"}<p class="supporting terms-note" data-terms-note>{TERMS_ON_REQUEST_NOTE}</p>{/if}
    </div>
  {/if}
  {#if itemsWait !== null}
    <div class="items-wait" role="status" data-items-wait>
      <p class="m3-font-body-medium">{itemsRateLimitText(itemsWait.tracker, itemsWait.stated)}</p>
      <div class="wait-row">
        <Countdown wait={itemsWait} label={RATE_LIMIT_WAITING_LABEL} attr="data-items-countdown" />
        {#if running.length > 0}<Button variant="text" type="button" name="end-items-wait" disabled={unsent.length === 0} onclick={endAll}>{END_WAIT_LABEL}</Button>{/if}
      </div>
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
            {#if markOf(item)?._tag === "Prepared"}<p class="supporting" data-prepared-terms>{PREPARED_TERMS_NOTE}</p>{/if}
          </div>
          <div class="trailing">
            <!-- Issue #186 (F1): how many times Interloq sent the item back to refinement, and nothing more. -->
            {#if item.sentBack > 0}<span class="in-progress m3-font-label-medium" data-sent-back>{sentBackCountText(item.sentBack)}</span>{/if}
            {#if abandoned.has(item.id)}<span class="in-progress m3-font-label-medium" data-abandoned>{ABANDONED_IN_CHAIN}</span>{/if}
            {#if inProgress(item.id)}<span class="in-progress m3-font-label-medium">{ITEM_IN_PROGRESS}</span>{/if}
            <!-- Issue #131: the item's preparation, set aside in the error color; the start stays enabled for every mark. -->
            {#if markOf(item) !== null}<span class="in-progress m3-font-label-medium" class:error={markOf(item)?._tag === "SetAside"} data-preparation>{markText(markOf(item)!)}</span>{/if}
            {#if queueable}
              {#if queued.includes(item.id)}<span class="in-progress m3-font-label-medium" data-queued-mark>{queuedMarkText(queued.indexOf(item.id) + 1)}</span>
              {:else}<Button variant="text" type="button" name="queue-add" data-item={item.id} disabled={offline} onclick={() => onQueue?.(item)}>{QUEUE_ADD}</Button>{/if}
            {/if}
            <Button variant="text" type="button" name="start" data-item={item.id} disabled={!startableItem(item.id) || offline} onclick={() => onStart(item)}>{texts.action}</Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .items-wait { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.5rem 1rem; }
  .items-wait p { margin: 0; color: var(--m3c-on-surface-variant); }
  .wait-row { display: flex; align-items: center; gap: 0.5rem; }
  .items { display: flex; flex-direction: column; gap: 0.5rem; max-width: 56rem; width: 100%; margin: 1rem auto; padding: 0 1rem; box-sizing: border-box; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  h2 { margin: 0; }
  .terms { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
  .terms-note { flex-basis: 100%; }
  ul { list-style: none; margin: 0; padding: 0; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  /* M3's list item, by hand (issue #125): its padding and gap, its one-line and two-line heights as a minimum only. */
  li { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1.5rem 0.5rem 1rem; min-height: 3.5rem; box-sizing: border-box; }
  li.two-line { min-height: 4.5rem; }
  .body { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .trailing { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0.5rem; max-width: 50%; }
  .in-progress { color: var(--m3c-on-surface-variant); }
  .in-progress.error { color: var(--m3c-error); }
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
