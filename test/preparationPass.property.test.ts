// Work review 1 of issue #131 (W1-R1-2): which Refine releases have done their work. A release is spent exactly when
// its item is listed and none of that item's listed comments carries the release's key, bare or as a question's key.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Option } from "effect";
import { preparationMarkerLine, runCommentKey } from "../src/itemComments.ts";
import { type Candidate, spentReleases } from "../src/preparationPass.ts";
import type { PreparationRelease } from "../src/preparationSwitch.ts";
import type { ItemComment, ItemId, TrackerItem } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

const ITEMS = ["1", "2", "3", "4"];
const KEYS = ["ka", "kb", "kc"];
const itemOf = (id: string): TrackerItem => ({ id: id as ItemId, title: `t${id}`, body: "", state: "unrefined", url: Option.none() });

type Marked = Readonly<{ key: string; question: number | null }>;
const markedArb: fc.Arbitrary<Marked | null> = fc.option(fc.record({ key: fc.constantFrom(...KEYS), question: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }) }), { nil: null });
const commentOf = (m: Marked | null, i: number): ItemComment => ({
  id: seededId(`c${i}`),
  body: m === null ? "a comment of a person" : `text\n\n${preparationMarkerLine(m.question === null ? "Preparation" : "PreparedQuestion", runCommentKey(m.key, m.question === null ? null : `q-${m.question}`))}`,
  created: "t",
});
const listingArb = fc.uniqueArray(fc.record({ id: fc.constantFrom(...ITEMS), marks: fc.array(markedArb, { maxLength: 4 }) }), { selector: (c) => c.id, maxLength: 4 });
const releasesArb = fc.uniqueArray(fc.record({ item: fc.constantFrom(...ITEMS), key: fc.constantFrom(...KEYS) }), { selector: (r) => r.item, maxLength: 4 });

test("spentReleases: a release is spent exactly when its item is listed without the release's key; an absent item never is", () => {
  fc.assert(
    fc.property(releasesArb, listingArb, (released: PreparationRelease[], rows) => {
      const listed: Candidate[] = rows.map((r) => ({ item: itemOf(r.id), comments: r.marks.map(commentOf) }));
      const expected = released
        .filter((r) => {
          const row = rows.find((c) => c.id === r.item);
          return row !== undefined && !row.marks.some((m) => m !== null && m.key === r.key);
        })
        .map((r) => r.item);
      const spent = spentReleases(released, listed);
      assert.deepEqual([...spent].sort(), [...expected].sort());
      for (const item of spent) assert.ok(rows.some((c) => c.id === item));
    }),
    { numRuns: 300 },
  );
});
