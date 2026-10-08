import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { CLOSING_LINE, OPENING_LINE, type Refinement, readRefinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";

// Issue #120, part 1 (issue #66): for any body and refinements, the developer's text survives, writing is idempotent,
// and the last write wins. Compared exactly, with no trimming.

const RUNS = { numRuns: 200, seed: 20261008 };
const piece = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom("\n", "\r\n", "\r", " ", "\t", "\n\n", "#", OPENING_LINE.slice(0, 5)));
const text = fc.array(piece, { maxLength: 8 }).map((ps) => ps.join(""));
const hasMarker = (s: string): boolean => s.split(/\r\n|\r|\n/u).some((l) => l === OPENING_LINE || l === CLOSING_LINE);
/** Texts a refinement may be (not blank, no marker line, no trailing carriage return), built by refinementOf. */
const arbRefinement: fc.Arbitrary<Refinement> = text.filter((s) => s.trim() !== "" && !hasMarker(s) && !s.endsWith("\r")).map((s) => Result.getOrThrow(refinementOf(s)));
const plainBody = text.filter((s) => !hasMarker(s));
/** A body without a section, or one that already holds a section, with the developer's text after it on lines of its own. */
const arbBody = fc.oneof(plainBody, fc.tuple(plainBody, arbRefinement, fc.constantFrom("", "\n", "\r\n"), plainBody).map(([b, r, br, after]) => Result.getOrThrow(withRefinement(b, r)) + (br === "" ? "" : br + after)));

const ok = <A>(r: Result.Result<A, unknown>): A => Result.getOrThrow(r);

test("the original text survives a write", () => {
  fc.assert(fc.property(plainBody, arbRefinement, (b, r) => ok(withoutRefinement(ok(withRefinement(b, r)))) === b), RUNS);
  fc.assert(fc.property(arbBody, arbRefinement, (b, r) => ok(withoutRefinement(ok(withRefinement(b, r)))) === ok(withoutRefinement(b))), RUNS);
});

test("writing twice gives the same body as writing once", () => {
  fc.assert(fc.property(arbBody, arbRefinement, (b, r) => {
    const once = ok(withRefinement(b, r));
    return ok(withRefinement(once, r)) === once;
  }), RUNS);
});

test("writing r1 then r2 equals writing r2, reads back r2, and keeps the original", () => {
  fc.assert(fc.property(arbBody, arbRefinement, arbRefinement, (b, r1, r2) => {
    const both = ok(withRefinement(ok(withRefinement(b, r1)), r2));
    assert.equal(both, ok(withRefinement(b, r2)));
    const read = ok(readRefinement(both));
    assert.ok(read._tag === "Some" && read.value === r2);
    assert.equal(ok(withoutRefinement(both)), ok(withoutRefinement(b)));
  }), RUNS);
});
