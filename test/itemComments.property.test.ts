import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { type CommentKey, type InterloqComment, commentKeyOf, runCommentKey, commentText, keyOf, lastRefinementAsked, parseComment, sentBackCount } from "../src/itemComments.ts";
import type { ItemComment } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

// Issue #186: the comments Interloq writes read back as written, and the counts over them.
const key = fc.stringMatching(/^[A-Za-z0-9._:/-]{1,40}$/u).filter((k) => !k.includes("-->")).map((k) => Result.getOrThrow(commentKeyOf(k)));
const date = fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-31T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
const missing = fc.oneof(fc.string(), fc.constantFrom("a\n<!-- interloq:sent-back key=x -->\nb", "<!-- interloq:refinement key=y asked=no -->\ntrailing words"));
const comment: fc.Arbitrary<InterloqComment> = fc.oneof(
  fc.record({ _tag: fc.constant("SentBack" as const), key, date, missing }),
  fc.record({ _tag: fc.constant("StoppedUnrefined" as const), key, date, missing }),
  fc.record({ _tag: fc.constant("RefinementRecord" as const), key, date, asked: fc.boolean() }),
);
const markerOf = (c: InterloqComment) => (c._tag === "RefinementRecord" ? { _tag: c._tag, key: c.key, asked: c.asked } : { _tag: c._tag, key: c.key });
const asItem = (c: InterloqComment): ItemComment => ({ id: seededId(), body: commentText(c), created: "2026-10-29T00:00:00Z" });

test("a comment Interloq writes reads back as its kind, key and flag", () => {
  fc.assert(fc.property(comment, (c) => {
    assert.deepEqual(parseComment(commentText(c)), markerOf(c));
    assert.equal(keyOf(commentText(c)), c.key);
  }), { numRuns: 300 });
});

test("the count of send-backs is the number of distinct send-back keys", () => {
  fc.assert(fc.property(fc.array(comment, { maxLength: 12 }), fc.array(fc.string(), { maxLength: 4 }), (cs, others) => {
    const items = [...cs.map(asItem), ...others.map((body) => ({ id: seededId(), body, created: "2026-10-29T00:00:00Z" }))];
    assert.equal(sentBackCount(items), new Set(cs.filter((c) => c._tag === "SentBack").map((c) => c.key)).size);
  }), { numRuns: 200 });
});

test("two send-backs on one day with one reason and different keys count 2", () => {
  const k = (t: string): CommentKey => Result.getOrThrow(commentKeyOf(t));
  const sent = (x: string): ItemComment => asItem({ _tag: "SentBack", key: k(x), date: "2026-10-29", missing: "the same" });
  assert.equal(sentBackCount([sent("a/verdict-1"), sent("b/verdict-1"), sent("a/verdict-1")]), 2);
});

test("whether the last refinement asked is the newest record's, and true where there is none", () => {
  fc.assert(fc.property(fc.array(comment, { maxLength: 12 }), (cs) => {
    const records = cs.filter((c) => c._tag === "RefinementRecord");
    const newest = records.at(-1);
    assert.equal(lastRefinementAsked(cs.map(asItem)), newest === undefined ? true : newest.asked);
  }), { numRuns: 200 });
});

test("a run's comment key is always a key commentKeyOf accepts, and a records directory name is kept as it is", () => {
  fc.assert(fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (name, suffix) => {
    assert.ok(Result.isSuccess(commentKeyOf(runCommentKey(name, suffix))));
  }), { numRuns: 300 });
  assert.equal(runCommentKey("2026-10-29T09-40-49-531Z-implementation-186", "verdict-2"), "2026-10-29T09-40-49-531Z-implementation-186/verdict-2");
});

// Issue #131: a preparation's marker line reads back as written.
test("a body ending in a preparation's marker line parses back to its kind and key", async () => {
  const { preparationMarkerLine } = await import("../src/itemComments.ts");
  const root = fc.string({ maxLength: 30 });
  fc.assert(fc.property(fc.constantFrom("Preparation" as const, "PreparedQuestion" as const), root, fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }), fc.string(), (kind, r, n, words) => {
    const k = runCommentKey(r, n === null ? null : `q-${n}`);
    assert.deepEqual(parseComment(`${words}\n\n${preparationMarkerLine(kind, k)}`), { _tag: kind, key: k });
  }), { numRuns: 200 });
});
