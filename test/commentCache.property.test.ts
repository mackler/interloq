// Issue #219: the comment cache keyed by each item's comment activity (src/commentCache.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Option } from "effect";
import { cachedComments, EMPTY_COMMENT_CACHE, trackerKeyOf, withComments } from "../src/commentCache.ts";
import type { CommentId, ItemComment, ItemId, TrackerItem } from "../src/tracker.ts";
import type { TrackerConfig } from "../src/schema.ts";

const RUNS = { numRuns: 200, seed: 20261106 };
const GITHUB = trackerKeyOf({ kind: "github", owner: "mackler", repo: "interloq" } as TrackerConfig);
const GITLAB = trackerKeyOf({ kind: "gitlab", project: "mackler/interloq" } as TrackerConfig);
const itemOf = (id: string, activity: Option.Option<{ updated: string; count: number }>): TrackerItem => ({ id: id as ItemId, title: "t", body: "", state: "unrefined", url: Option.none(), activity });
const comments = (n: number): ItemComment[] => Array.from({ length: n }, (_, i) => ({ id: `c-${i}` as CommentId, body: `b${i}`, created: "2026-11-05T00:00:00Z" }));
const arbActivity = fc.record({ updated: fc.constantFrom("2026-11-05T10:00:00Z", "2026-11-05T11:00:00Z", "2026-11-05T12:00:00Z"), count: fc.integer({ min: 1, max: 5 }) });

test("a stored entry is returned while the activity is unchanged, and not after either field changes", () => {
  fc.assert(
    fc.property(fc.string(), arbActivity, arbActivity, (id, stored, now) => {
      const cache = withComments(EMPTY_COMMENT_CACHE, GITHUB, itemOf(id, Option.some(stored)), comments(stored.count));
      const got = cachedComments(cache, GITHUB, itemOf(id, Option.some(now)));
      if (stored.updated === now.updated && stored.count === now.count) assert.deepEqual(got, Option.some(comments(stored.count)));
      else assert.deepEqual(got, Option.none());
    }),
    RUNS,
  );
});

test("an activity of no comments needs no entry; an unknown activity is never cached nor answered", () => {
  assert.deepEqual(cachedComments(EMPTY_COMMENT_CACHE, GITHUB, itemOf("1", Option.some({ updated: "x", count: 0 }))), Option.some([]));
  const unknown = itemOf("1", Option.none());
  assert.equal(withComments(EMPTY_COMMENT_CACHE, GITHUB, unknown, comments(2)), EMPTY_COMMENT_CACHE);
  assert.deepEqual(cachedComments(withComments(EMPTY_COMMENT_CACHE, GITHUB, itemOf("1", Option.some({ updated: "x", count: 2 })), comments(2)), GITHUB, unknown), Option.none());
});

test("the entries of two trackers do not collide", () => {
  fc.assert(
    fc.property(fc.string(), arbActivity, (id, activity) => {
      const cache = withComments(EMPTY_COMMENT_CACHE, GITHUB, itemOf(id, Option.some(activity)), comments(activity.count));
      assert.deepEqual(cachedComments(cache, GITLAB, itemOf(id, Option.some(activity))), Option.none());
    }),
    RUNS,
  );
  assert.notEqual(GITHUB, GITLAB);
  assert.notEqual(trackerKeyOf(null), GITHUB);
});
