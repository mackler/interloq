// The chain's queue edits this page sent and the server has not yet acknowledged (issue #196). Pure. An edit is
// acknowledged when its id appears in the server's `queue.applied`; until then the page shows the server's queue with
// its own pending edits applied over it, so two tabs' edits both survive at the server and each tab keeps only its own
// unacknowledged edits on screen. No edit is ever sent twice.
import { applyQueueEdit, type ChainQueue, type EditId, editIdOf, type QueueChange, type QueueEdit } from "../../src/chainQueue.ts";
import { Result } from "effect";

/** This page's edits sent or queued and not yet seen in the server's `applied`, oldest first. */
export type QueuePending = readonly QueueEdit[];
export const NO_PENDING_EDITS: QueuePending = [];

/** The pending edits less those the server's queue shows applied. */
export const afterServer = (pending: QueuePending, queue: ChainQueue): QueuePending => pending.filter((e) => !queue.applied.includes(e.id));

/** The queue the page shows: the server's, with this page's pending edits applied over it. */
export const shownQueue = (queue: ChainQueue, pending: QueuePending): ChainQueue => pending.reduce(applyQueueEdit, queue);

/** A new edit of this page: its id `<pageId>:<n>`, unique across tabs since the page id is. */
export const newEdit = (pageId: string, n: number, change: QueueChange): QueueEdit => ({ id: editIdFor(pageId, n), change });
const editIdFor = (pageId: string, n: number): EditId => Result.getOrElse(editIdOf(`${pageId}:${n}`), () => `page:${n}` as EditId);
