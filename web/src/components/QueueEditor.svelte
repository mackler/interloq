<script lang="ts">
  // Issue #196: the chain's queue as the developer composes it, in the Implementation tab's list view (reachable during a
  // run since issue #144). An ordered list laid out by hand after M3's list item, as ItemList's rows are (issue #125):
  // each row its position, its item, a note where a loaded listing lacks it, and three icon buttons, Move up, Move down
  // and Remove, which make reordering operable by keyboard [flexibility and efficiency of use; WCAG 2.5.7's single-pointer
  // alternative to dragging]. A drag handle moves a row with the pointer: the drop line previews where it goes, the move
  // is sent once on release, and Escape cancels [user control and freedom]. Every change goes through `onEdit`; the
  // queue shown is the page's (the server's with this page's pending edits), so nothing is applied here.
  import { Button } from "m3-svelte";
  import { type ChainQueue, moveDownChange, moveToChange, moveUpChange, type QueueChange, type QueueEntry } from "../../../src/chainQueue.ts";
  import { QUEUE_EMPTY, QUEUE_HEADING, QUEUE_STALE, QUEUE_SUPPORT, queueHandleName, queueMoveDownName, queueMoveUpName, queueRemoveName } from "../../../src/prompts.ts";

  let { queue, listed = null, offline = false, onEdit }: { queue: ChainQueue; listed?: readonly string[] | null; offline?: boolean; onEdit: (change: QueueChange) => void } = $props();

  const labelOf = (entry: QueueEntry): string => `#${entry.item} ${entry.title}`;
  const send = (change: QueueChange | null) => {
    if (change !== null) onEdit(change);
  };
  const stale = (entry: QueueEntry): boolean => listed !== null && !listed.includes(entry.item);

  // The drag: the row being dragged and the index it would be dropped at, among the other rows.
  let list: HTMLOListElement | undefined = $state();
  let dragging: QueueEntry | null = $state(null);
  let target: number | null = $state(null);
  const targetAt = (entry: QueueEntry, clientY: number): number => {
    const others = [...(list?.querySelectorAll<HTMLElement>("li[data-queued]") ?? [])].filter((row) => row.dataset.queued !== entry.item);
    return others.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 <= clientY;
    }).length;
  };
  const down = (entry: QueueEntry) => (e: PointerEvent) => {
    if (offline) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragging = entry;
    target = null;
  };
  const move = (e: PointerEvent) => {
    if (dragging !== null) target = targetAt(dragging, e.clientY);
  };
  const up = () => {
    if (dragging !== null && target !== null) send(moveToChange(queue.entries, dragging.item, target));
    dragging = null;
    target = null;
  };
  /** Whether the drop line stands before this row: the drop index among the rows other than the dragged one. */
  const dropBefore = (entry: QueueEntry): boolean =>
    dragging !== null && target !== null && entry.item !== dragging.item && queue.entries.filter((e) => e.item !== dragging?.item).findIndex((e) => e.item === entry.item) === target;
  const dropAtEnd = $derived(dragging !== null && target !== null && target === queue.entries.length - 1);
  const cancel = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dragging !== null) {
      dragging = null;
      target = null;
    }
  };
</script>

<section class="queue-editor" aria-label={QUEUE_HEADING}>
  <h2 class="m3-font-title-medium">{QUEUE_HEADING}</h2>
  <p class="support">{QUEUE_SUPPORT}</p>
  {#if queue.entries.length === 0}
    <p class="empty">{QUEUE_EMPTY}</p>
  {:else}
    <ol bind:this={list} class:drop-end={dropAtEnd}>
      {#each queue.entries as entry, i (entry.item)}
        <li data-queued={entry.item} class:dragging={dragging?.item === entry.item} class:drop-before={dropBefore(entry)}>
          <button type="button" tabindex="-1" class="handle" data-handle aria-label={queueHandleName(labelOf(entry))} onpointerdown={down(entry)} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={cancel}>⠿</button>
          <span class="position">{i + 1}</span>
          <div class="body">
            <p class="headline">{labelOf(entry)}</p>
            {#if stale(entry)}<p class="supporting" data-stale>{QUEUE_STALE}</p>{/if}
          </div>
          <div class="trailing">
            <Button variant="text" type="button" iconType="full" aria-label={queueMoveUpName(labelOf(entry))} disabled={offline || i === 0} onclick={() => send(moveUpChange(queue.entries, entry.item))}>↑</Button>
            <Button variant="text" type="button" iconType="full" aria-label={queueMoveDownName(labelOf(entry))} disabled={offline || i === queue.entries.length - 1} onclick={() => send(moveDownChange(queue.entries, entry.item))}>↓</Button>
            <Button variant="text" type="button" iconType="full" aria-label={queueRemoveName(labelOf(entry))} disabled={offline} onclick={() => send({ _tag: "Remove", item: entry.item })}>✕</Button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</section>
<svelte:window onkeydown={cancel} />

<style>
  .queue-editor { display: flex; flex-direction: column; gap: 0.5rem; max-width: 56rem; width: 100%; margin: 1rem auto 0; padding: 0 1rem; box-sizing: border-box; }
  h2 { margin: 0; }
  .support, .empty { margin: 0; font-size: 0.875rem; line-height: 1.429; color: var(--m3c-on-surface-variant); }
  ol { list-style: none; margin: 0; padding: 0; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  /* M3's list item, by hand, as ItemList's rows (issue #125): its padding and gap, its one-line height as a minimum only. */
  li { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1.5rem 0.5rem 1rem; min-height: 3.5rem; box-sizing: border-box; border-top: 2px solid transparent; }
  li.drop-before { border-top-color: var(--m3c-primary); }
  ol.drop-end { border-bottom: 2px solid var(--m3c-primary); }
  li.dragging { opacity: 0.6; }
  /* The handle is for the pointer alone, out of the tab order: the three buttons move a row by keyboard. */
  .handle { flex: none; border: none; background: none; padding: 0; cursor: grab; touch-action: none; user-select: none; color: var(--m3c-on-surface-variant); font-size: 1.25rem; }
  .position { flex: none; min-width: 1.5rem; color: var(--m3c-on-surface-variant); font-family: var(--m3-font); }
  .body { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .headline, .supporting { margin: 0; font-family: var(--m3-font); }
  .headline { font-size: 1rem; line-height: 1.5; color: var(--m3c-on-surface); }
  .supporting { font-size: 0.875rem; line-height: 1.429; color: var(--m3c-on-surface-variant); }
  .trailing { flex: none; display: flex; align-items: center; gap: 0.25rem; }
</style>
