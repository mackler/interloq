// Issue #171: the pure core of the tracker retry, with properties: which failures are repeated, which writes are read
// back, the waits, and the seam with the section writer: a write `withRefinement` made is one `landed` recognizes.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { TrackerAuthRefused, TrackerBodyInvalid, TrackerItemNotFound, TrackerRequestRefused, TrackerStateAmbiguous, TrackerUnreachable } from "../src/errors.ts";
import { CLOSING_LINE, OPENING_LINE, type Refinement, readRefinement, refinementOf, withRefinement } from "../src/refinement.ts";
import type { TrackerError } from "../src/services.ts";
import { commentIdOf, ITEM_STATES, type ItemId, type ItemState, type TrackerItem } from "../src/tracker.ts";
import { commentDeleted, landed, retryable, trackerRetryDelays, uncertainWrite, commentLanded } from "../src/trackerRetry.ts";
import { commentKeyOf, commentText, type InterloqComment } from "../src/itemComments.ts";
import { seededId } from "./fakeTracker.ts";

const RUNS = { numRuns: 200, seed: 20261015 };
const ID = "98" as ItemId;
const status = fc.option(fc.integer({ min: 100, max: 599 }), { nil: null });
const arbError: fc.Arbitrary<TrackerError> = fc.oneof(
  fc.tuple(fc.string(), status).map(([message, s]) => new TrackerUnreachable({ tracker: "GitLab", message, status: s })),
  fc.integer({ min: 400, max: 499 }).map((s) => new TrackerRequestRefused({ tracker: "GitHub", status: s, message: "m" })),
  fc.constantFrom(401, 403).map((s) => new TrackerAuthRefused({ tracker: "GitHub", status: s })),
  fc.constant(new TrackerItemNotFound({ id: "98" })),
  fc.string().map((message) => new TrackerBodyInvalid({ id: "98", message })),
  fc.array(fc.string()).map((labels) => new TrackerStateAmbiguous({ id: "98", labels })),
);

test("retryable is true for TrackerUnreachable alone", () => {
  fc.assert(fc.property(arbError, (e) => retryable(e) === (e._tag === "TrackerUnreachable")), RUNS);
});

test("uncertainWrite is true for a TrackerUnreachable with a status alone", () => {
  fc.assert(fc.property(arbError, (e) => uncertainWrite(e) === (e._tag === "TrackerUnreachable" && e.status !== null)), RUNS);
});

test("trackerRetryDelays has maxTrackerRetries waits, the first the setting, each double the previous", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.double({ min: 0.001, max: 1000, noNaN: true }), (count, first) => {
      const delays = trackerRetryDelays({ maxTrackerRetries: count, trackerRetryDelaySeconds: first });
      return delays.length === count && delays[0] === first && delays.every((d, k) => k === 0 || d === delays[k - 1]! * 2);
    }),
    RUNS,
  );
  assert.deepEqual(trackerRetryDelays({ maxTrackerRetries: 5, trackerRetryDelaySeconds: 15 }), [15, 30, 60, 120, 240]);
});

const piece = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom("\n", "\r\n", " ", "\n\n", "#"));
const text = fc.array(piece, { maxLength: 8 }).map((ps) => ps.join(""));
const hasMarker = (s: string): boolean => s.split(/\r\n|\r|\n/u).some((l) => l === OPENING_LINE || l === CLOSING_LINE);
const arbRefinement: fc.Arbitrary<Refinement> = text.filter((s) => s.trim() !== "" && !hasMarker(s) && !s.endsWith("\r")).map((s) => Result.getOrThrow(refinementOf(s)));
const plainBody = text.filter((s) => !hasMarker(s));
const arbBody = fc.oneof(plainBody, fc.tuple(plainBody, arbRefinement).map(([b, r]) => Result.getOrThrow(withRefinement(b, r))));
const itemOf = (body: string, state: ItemState = "unrefined"): TrackerItem => ({ id: ID, title: "t", body, state, url: Option.none() });

test("the seam with the section writer: an item whose body withRefinement wrote has landed, the body before it has not unless it held the same", () => {
  fc.assert(
    fc.property(arbBody, arbRefinement, (body, r) => {
      const write = { kind: "writeRefinement", item: ID, refinement: r } as const;
      const written = Result.getOrThrow(withRefinement(body, r));
      const before = Result.getOrThrow(readRefinement(body));
      const heldAlready = Option.isSome(before) && before.value === r;
      return Result.isSuccess(landed(write, itemOf(written))) && Result.isSuccess(landed(write, itemOf(body))) === heldAlready;
    }),
    RUNS,
  );
});

test("what an item held after a refinement that did not land: no section, or another one", () => {
  const r = Result.getOrThrow(refinementOf("the requirements"));
  const other = Result.getOrThrow(refinementOf("other requirements"));
  const write = { kind: "writeRefinement", item: ID, refinement: r } as const;
  assert.deepEqual(landed(write, itemOf("the developer's text")), Result.fail({ kind: "noSection" }));
  assert.deepEqual(landed(write, itemOf(Result.getOrThrow(withRefinement("text", other)))), Result.fail({ kind: "otherSection" }));
  // A malformed section (an opening line without its closing line) counts as another section.
  assert.deepEqual(landed(write, itemOf(`text\n\n${OPENING_LINE}\nhalf`)), Result.fail({ kind: "otherSection" }));
});

test("a state set has landed exactly when the item is in that state, and otherwise names the state it held", () => {
  fc.assert(
    fc.property(fc.constantFrom(...ITEM_STATES), fc.constantFrom(...ITEM_STATES), (target, held) => {
      const result = landed({ kind: "setState", item: ID, state: target }, itemOf("b", held));
      return target === held ? Result.isSuccess(result) : Result.isFailure(result) && result.failure.kind === "state" && result.failure.state === held;
    }),
    RUNS,
  );
});

// Issue #186: a comment write is reconciled by its key alone, read from comments commentText wrote (the seam with src/itemComments.ts).
test("commentLanded holds exactly when some comment carries the key", () => {
  const key = fc.constantFrom("a/verdict-1", "a/verdict-2", "b/verdict-1", "r").map((k) => Result.getOrThrow(commentKeyOf(k)));
  const comment: fc.Arbitrary<InterloqComment> = fc.oneof(
    fc.record({ _tag: fc.constant("SentBack" as const), key, date: fc.constant("2026-10-29"), missing: fc.string() }),
    fc.record({ _tag: fc.constant("RefinementRecord" as const), key, date: fc.constant("2026-10-29"), asked: fc.boolean() }),
  );
  fc.assert(fc.property(key, fc.array(comment, { maxLength: 6 }), fc.array(fc.string(), { maxLength: 3 }), (k, cs, others) => {
    const items = [...cs.map((c) => ({ id: seededId(), body: commentText(c), created: "t" })), ...others.map((body) => ({ id: seededId(), body, created: "t" }))];
    const found = Result.isSuccess(commentLanded(k, items));
    assert.equal(found, cs.some((c) => c.key === k));
    if (!found) assert.deepEqual(Result.getFailure(commentLanded(k, items)), Option.some({ kind: "noComment" }));
  }), RUNS);
});

// Issue #131: a deletion is done exactly when no comment carries its id.
test("commentDeleted holds exactly when no comment has the id", () => {
  const ids = fc.constantFrom("1", "2", "3", "c-4").map((t) => Result.getOrThrow(commentIdOf(t)));
  fc.assert(fc.property(ids, fc.array(ids, { maxLength: 6 }), (id, present) => {
    const comments = present.map((c) => ({ id: c, body: "b", created: "t" }));
    assert.equal(Result.isSuccess(commentDeleted(id, comments)), !present.includes(id));
  }), RUNS);
});
