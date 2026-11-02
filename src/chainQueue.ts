// The chain's queue (issue #196): the explicit, ordered sublist of refined items the developer chose for one unattended
// session, and the edits that change it. Pure: no I/O, no Effect services; also imported by the browser (through
// src/chain.ts, src/protocol.ts and web/src/queuePending.ts).
//
// Every edit names items, never positions, so edits from several tabs compose and never undo each other, and an edit
// carries an id, recorded in `applied`, by which a tab learns that its edit reached the server.
import { type Brand, Result, Schema } from "effect";
import type { ItemId } from "./tracker.ts";

/** Which items the chain starts: every eligible refined item in the tracker's order (today's behavior), or the queue alone. */
export const CHAIN_SOURCES = ["backlog", "queue"] as const;
export type ChainSource = (typeof CHAIN_SOURCES)[number];

/** A queued item: its id with the title it had when queued, so the page shows what he chose without a listing. */
export type QueueEntry = Readonly<{ item: ItemId; title: string }>;

/** An edit's id, unique across tabs: a text with a character other than whitespace, built by editIdOf alone. */
export type EditId = Brand.Branded<string, "EditId">;
export type InvalidEditId = Readonly<{ _tag: "InvalidEditId"; text: string }>;
export const editIdOf = (text: string): Result.Result<EditId, InvalidEditId> =>
  /\S/u.test(text) ? Result.succeed(text as EditId) : Result.fail({ _tag: "InvalidEditId", text });

/** How many of the last applied edits' ids the queue keeps: enough to outlast the one broadcast that follows each edit. */
export const QUEUE_APPLIED_KEPT = 64;

/** The queue: its source, its entries in the order they are to run, and the ids of the last edits applied, newest last. */
export type ChainQueue = Readonly<{ source: ChainSource; entries: readonly QueueEntry[]; applied: readonly EditId[] }>;
export const EMPTY_QUEUE: ChainQueue = { source: "backlog", entries: [], applied: [] };

/** A change of the queue, by item: added at the end, removed, placed immediately before another (at the end where null), or the source chosen. */
export type QueueChange =
  | Readonly<{ _tag: "Add"; item: ItemId; title: string }>
  | Readonly<{ _tag: "Remove"; item: ItemId }>
  | Readonly<{ _tag: "Move"; item: ItemId; before: ItemId | null }>
  | Readonly<{ _tag: "Source"; source: ChainSource }>;
export type QueueEdit = Readonly<{ id: EditId; change: QueueChange }>;

const NonBlank = Schema.String.check(Schema.makeFilter((text: string) => /\S/u.test(text) || "a text that is not blank"));
const ItemIdSchema = NonBlank.pipe(Schema.brand("ItemId"));
const EditIdSchema = NonBlank.pipe(Schema.brand("EditId"));
export const ChainSourceSchema = Schema.Literals(CHAIN_SOURCES);
const QueueEntrySchema = Schema.Struct({ item: ItemIdSchema, title: Schema.String });
export const ChainQueueSchema = Schema.Struct({ source: ChainSourceSchema, entries: Schema.Array(QueueEntrySchema), applied: Schema.Array(EditIdSchema) });
export const QueueChangeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Add"), item: ItemIdSchema, title: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Remove"), item: ItemIdSchema }),
  Schema.Struct({ _tag: Schema.Literal("Move"), item: ItemIdSchema, before: Schema.NullOr(ItemIdSchema) }),
  Schema.Struct({ _tag: Schema.Literal("Source"), source: ChainSourceSchema }),
]);
export const QueueEditSchema = Schema.Struct({ id: EditIdSchema, change: QueueChangeSchema });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T | undefined => undefined;
void same<Same<typeof ChainQueueSchema.Type, ChainQueue>>();
void same<Same<typeof QueueEditSchema.Type, QueueEdit>>();

const without = (entries: readonly QueueEntry[], item: ItemId): readonly QueueEntry[] => entries.filter((e) => e.item !== item);

/** `entry` placed immediately before `before`, or at the end where null; the entries never hold `entry` itself. */
const insertBefore = (entries: readonly QueueEntry[], entry: QueueEntry, before: ItemId | null): readonly QueueEntry[] => {
  const at = before === null ? -1 : entries.findIndex((e) => e.item === before);
  return at < 0 ? [...entries, entry] : [...entries.slice(0, at), entry, ...entries.slice(at)];
};

const changed = (entries: readonly QueueEntry[], change: QueueChange): readonly QueueEntry[] => {
  const has = (item: ItemId) => entries.some((e) => e.item === item);
  switch (change._tag) {
    case "Add":
      return has(change.item) ? entries : [...entries, { item: change.item, title: change.title }];
    case "Remove":
      return without(entries, change.item);
    case "Move": {
      const entry = entries.find((e) => e.item === change.item);
      if (entry === undefined || change.before === change.item || (change.before !== null && !has(change.before))) return entries;
      return insertBefore(without(entries, change.item), entry, change.before);
    }
    case "Source":
      return entries;
  }
};

/**
 * The queue after an edit. An edit whose id was already applied changes nothing at all, so applying an edit twice
 * equals applying it once; otherwise each change refers to items, so edits from several tabs compose: an item already
 * queued is not added again, and a change naming an absent item changes nothing. A later Source is the developer's newer
 * choice. The edit's id is recorded, the last QUEUE_APPLIED_KEPT kept.
 */
export const applyQueueEdit = (queue: ChainQueue, edit: QueueEdit): ChainQueue =>
  queue.applied.includes(edit.id)
    ? queue
    : {
        source: edit.change._tag === "Source" ? edit.change.source : queue.source,
        entries: changed(queue.entries, edit.change),
        applied: [...queue.applied, edit.id].slice(-QUEUE_APPLIED_KEPT),
      };

/** The queue without an item, no edit recorded: a start consumes its item. The same queue where it was not queued. */
export const withoutItem = (queue: ChainQueue, item: ItemId): ChainQueue =>
  queue.entries.some((e) => e.item === item) ? { ...queue, entries: without(queue.entries, item) } : queue;

/**
 * The change that puts an item at `index` of the queue as it is after the item's removal (as a drop computes it), or
 * null where the item is absent or would not move. The one place a position becomes a change by item.
 */
export const moveToChange = (entries: readonly QueueEntry[], item: ItemId, index: number): QueueChange | null => {
  const from = entries.findIndex((e) => e.item === item);
  if (from < 0) return null;
  const rest = without(entries, item);
  const to = Math.max(0, Math.min(index, rest.length));
  return to === from ? null : { _tag: "Move", item, before: rest[to]?.item ?? null };
};
/** The change that moves an item one place up, or null on the first entry or an absent item. */
export const moveUpChange = (entries: readonly QueueEntry[], item: ItemId): QueueChange | null => {
  const from = entries.findIndex((e) => e.item === item);
  return from <= 0 ? null : moveToChange(entries, item, from - 1);
};
/** The change that moves an item one place down, or null on the last entry or an absent item. */
export const moveDownChange = (entries: readonly QueueEntry[], item: ItemId): QueueChange | null => {
  const from = entries.findIndex((e) => e.item === item);
  return from < 0 || from === entries.length - 1 ? null : moveToChange(entries, item, from + 1);
};
