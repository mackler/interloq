// Issue #131: the seam between the preparation's writer and its reader, from one source: what is written reads back
// exactly, a part of it never reads as a preparation, and an edit of the item makes it stale.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { runCommentKey } from "../src/itemComments.ts";
import { digestOf, type PreparationRecord, preparationOf, type PreparedQuestion, preparedComments } from "../src/preparedComments.ts";
import type { StoredQuestion, TermsEntry } from "../src/schema.ts";
import type { ItemComment, ItemId, TrackerItem } from "../src/tracker.ts";
import { seededId } from "./fakeTracker.ts";

const RUNS = { numRuns: 60 };
const KEY = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131");
const awkward = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom("-->", "--!>", ">", "<!--", "\\", "\\u003e", "\\n", "\r\n", "\r", "\n", " ", "a --> b", "<!-- interloq:data {} -->"),
);
const text = fc.array(awkward, { maxLength: 4 }).map((parts) => parts.join(""));
const nonBlank = text.map((t) => `${t}x`);
const pieces = fc.array(fc.record({ text, ref: fc.constant(""), code: fc.boolean() }), { maxLength: 3 });
const block = fc.oneof(
  fc.record({ kind: fc.constant("paragraph" as const), pieces }),
  fc.record({ kind: fc.constant("list" as const), items: fc.array(fc.record({ level: fc.constant(0), pieces }), { maxLength: 2 }) }),
  fc.record({ kind: fc.constant("code" as const), text }),
);
const blocks = fc.array(block, { maxLength: 2 });
const option = fc.record({ label: pieces, description: pieces });
const entry = (id: string): fc.Arbitrary<StoredQuestion> =>
  fc.record({ context: blocks, history: blocks, question: pieces, reason: blocks, proposed_answers: fc.array(option, { maxLength: 3 }), default_answer: fc.option(text, { nil: null }), skip_if: fc.option(fc.record({ question: text, answer: text }), { nil: null }) }).map((e) => ({ id, ...e }));
const prepared = (id: string): fc.Arbitrary<PreparedQuestion> =>
  fc.tuple(entry(id), fc.boolean(), fc.array(fc.record({ id: nonBlank, term: nonBlank, senses: fc.array(nonBlank, { minLength: 1, maxLength: 2 }) }), { maxLength: 2 })).map(([e, withTerms, explanations]) => ({
    entry: e,
    terms: withTerms ? ({ id: e.id, explanations, context: e.context, history: e.history, question: e.question, reason: e.reason, proposed_answers: e.proposed_answers } satisfies TermsEntry) : null,
  }));
const questions = fc.integer({ min: 0, max: 3 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => prepared(`Q${i + 1}`))));
const item = fc.record({ title: text, body: text }).map(({ title, body }): TrackerItem => ({ id: "131" as ItemId, title, body, state: "unrefined", url: Option.none() }));
const asComments = (texts: readonly string[]): ItemComment[] => texts.map((body, i) => ({ id: seededId(`c-${i + 1}`), body, created: "2026-10-30T00:00:00Z" }));
const record = (i: TrackerItem, count: number): PreparationRecord => ({ _tag: "Prepared", key: KEY, digest: digestOf(i), count, generation: 2, date: "2026-10-30" });
const write = (i: TrackerItem, qs: readonly PreparedQuestion[]) => Result.getOrThrow(preparedComments(KEY, qs, record(i, qs.length))).map((c) => c.text);

test("a preparation written reads back Prepared with the entries and terms written", () => {
  fc.assert(fc.property(item, questions, (i, qs) => {
    const found = preparationOf(asComments(write(i, qs)), i, 2);
    assert.equal(found._tag, "Prepared");
    if (found._tag !== "Prepared") return;
    // fast-check's records have a null prototype; the values compared are the same JSON.
    const plain = <A>(a: A): A => JSON.parse(JSON.stringify(a)) as A;
    assert.deepEqual(found.questions, plain(qs.map((q) => q.entry)));
    assert.deepEqual(found.terms, plain(qs.flatMap((q) => (q.terms === null ? [] : [q.terms]))));
  }), RUNS);
});

test("every data line written holds no greater-than character but the one that closes it", () => {
  fc.assert(fc.property(item, questions, (i, qs) => {
    for (const body of write(i, qs)) {
      // The data line is the one before the marker line, the last two lines that are not blank.
      const data = body.split(/\r\n|\r|\n/u).filter((l) => l.trim() !== "").at(-2) ?? "";
      assert.ok(data.startsWith("<!-- interloq:data "), data);
      assert.equal(data.indexOf(">"), data.length - 1);
    }
  }), RUNS);
});

test("dropping any non-empty subset of the comments never reads as Prepared", () => {
  fc.assert(fc.property(item, questions, fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), (i, qs, keep) => {
    const all = asComments(write(i, qs));
    const kept = all.filter((_, j) => keep[j] === true);
    fc.pre(kept.length < all.length);
    assert.ok(["Partial", "None"].includes(preparationOf(kept, i, 2)._tag));
  }), RUNS);
});

test("an item whose title or text changed reads its preparation as Stale", () => {
  fc.assert(fc.property(item, questions, text, (i, qs, extra) => {
    const changed = { ...i, title: `${i.title}${extra}!` };
    fc.pre(digestOf(changed) !== digestOf(i));
    assert.equal(preparationOf(asComments(write(i, qs)), changed, 2)._tag, "Stale");
  }), RUNS);
});

test("a set-aside reads back SetAside at its generation and Released at any other", () => {
  fc.assert(fc.property(item, fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 }), text, (i, generation, other, question) => {
    const r: PreparationRecord = { _tag: "SetAside", key: KEY, digest: digestOf(i), generation, date: "2026-10-30", cause: { _tag: "Paused", question } };
    const comments = asComments(Result.getOrThrow(preparedComments(KEY, [], r)).map((c) => c.text));
    assert.equal(preparationOf(comments, i, generation)._tag, "SetAside");
    assert.equal(preparationOf(comments, i, other)._tag, other === generation ? "SetAside" : "Released");
  }), RUNS);
});
