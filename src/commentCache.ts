// The comments a listing reads, kept by each item's comment activity (pure; issue #219): a listing reads again only the
// comments of an item whose activity changed since they were read, so a listing of an unchanged list costs one request
// per page of items rather than one per item. The cache lives in the run manager for the server's life and is not
// persisted; an entry is replaced when its item's activity changes and never evicted otherwise, one per item.
import { Option } from "effect";
import type { TrackerConfig } from "./schema.ts";
import type { CommentActivity, ItemComment, TrackerItem } from "./tracker.ts";

/** Which project's tracker an entry belongs to, so a configuration naming another project never reads another's entries. */
export type TrackerKey = string & { readonly TrackerKey: unique symbol };
export const trackerKeyOf = (config: TrackerConfig | null): TrackerKey =>
  (config === null ? "none" : config.kind === "github" ? `github:${config.owner}/${config.repo}` : `gitlab:${config.project}`) as TrackerKey;

type Entry = Readonly<{ activity: CommentActivity; comments: readonly ItemComment[] }>;
export type CommentCache = ReadonlyMap<string, Entry>;
export const EMPTY_COMMENT_CACHE: CommentCache = new Map();

const entryKey = (key: TrackerKey, item: TrackerItem): string => `${key}\u0000${item.id}`;
const sameActivity = (a: CommentActivity, b: CommentActivity): boolean => a.updated === b.updated && a.count === b.count;

/**
 * The item's comments without a request, where the cache can give them: none where the item has no comments by its
 * activity, the entry's where its activity is the item's, and nothing where the activity is unknown or changed.
 */
export const cachedComments = (cache: CommentCache, key: TrackerKey, item: TrackerItem): Option.Option<readonly ItemComment[]> => {
  if (Option.isNone(item.activity)) return Option.none();
  const activity = item.activity.value;
  if (activity.count === 0) return Option.some([]);
  const entry = cache.get(entryKey(key, item));
  return entry !== undefined && sameActivity(entry.activity, activity) ? Option.some(entry.comments) : Option.none();
};

/** The cache with the comments just read of an item whose activity is known; an item whose activity is unknown is not kept. */
export const withComments = (cache: CommentCache, key: TrackerKey, item: TrackerItem, comments: readonly ItemComment[]): CommentCache => {
  if (Option.isNone(item.activity)) return cache;
  const next = new Map(cache);
  next.set(entryKey(key, item), { activity: item.activity.value, comments });
  return next;
};
