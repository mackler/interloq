import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { CLOSING_LINE, OPENING_LINE, type Refinement, itemTextOf, readRefinement, refinementOf, withDeveloperText, withoutRefinement, withRefinement } from "../src/refinement.ts";

// Issue #216: the developer's title and text as a value, written around the section, which survives byte for byte.

const RUNS = { numRuns: 200, seed: 20261102 };
const piece = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom("\n", "\r\n", "\r", " ", "\t", "\n\n", "#", OPENING_LINE.slice(0, 5)));
const text = fc.array(piece, { maxLength: 8 }).map((ps) => ps.join(""));
const hasMarker = (s: string): boolean => s.split(/\r\n|\r|\n/u).some((l) => l === OPENING_LINE || l === CLOSING_LINE);
const arbRefinement: fc.Arbitrary<Refinement> = text.filter((s) => s.trim() !== "" && !hasMarker(s) && !s.endsWith("\r")).map((s) => Result.getOrThrow(refinementOf(s)));
const plainBody = text.filter((s) => !hasMarker(s));
const arbBody = fc.oneof(plainBody, fc.tuple(plainBody, arbRefinement, fc.constantFrom("", "\n", "\r\n"), plainBody).map(([b, r, br, after]) => Result.getOrThrow(withRefinement(b, r)) + (br === "" ? "" : br + after)));
const arbTitle = fc.string({ maxLength: 20 }).filter((s) => s.trim() !== "" && !/[\r\n]/u.test(s));
const arbItemText = fc.tuple(arbTitle, plainBody).map(([t, b]) => Result.getOrThrow(itemTextOf(t, b)));
const ok = <A>(r: Result.Result<A, unknown>): A => Result.getOrThrow(r);

test("the developer's text written around the section reads back as written", () => {
  fc.assert(fc.property(arbBody, arbItemText, (b, t) => ok(withoutRefinement(ok(withDeveloperText(b, t)))) === t.text), RUNS);
});

test("the section survives a rewrite of the developer's text byte for byte", () => {
  fc.assert(fc.property(arbBody, arbItemText, (b, t) => {
    assert.deepEqual(ok(readRefinement(ok(withDeveloperText(b, t)))), ok(readRefinement(b)));
  }), RUNS);
});

test("itemTextOf refuses a blank title, a title of two lines and a text with a marker line", () => {
  const reason = (r: ReturnType<typeof itemTextOf>): string | null => (Result.isFailure(r) ? r.failure.reason : null);
  assert.equal(reason(itemTextOf("  ", "x")), "blankTitle");
  assert.equal(reason(itemTextOf("a\nb", "x")), "multiLineTitle");
  assert.equal(reason(itemTextOf("a\rb", "x")), "multiLineTitle");
  assert.equal(reason(itemTextOf("a", `x\n${OPENING_LINE}\ny`)), "markerLine");
  assert.equal(reason(itemTextOf("a", `x\n${CLOSING_LINE}`)), "markerLine");
  assert.equal(reason(itemTextOf("a", "")), null);
});

test("a body with a malformed section is SectionMalformed", () => {
  const t = ok(itemTextOf("a", "b"));
  const r = withDeveloperText(`x\n${OPENING_LINE}\ny`, t);
  assert.ok(Result.isFailure(r) && r.failure._tag === "SectionMalformed");
});

test("text written after the section is placed before it", () => {
  const body = ok(withRefinement("before", ok(refinementOf("r")))) + "\nafter";
  const t = ok(itemTextOf("T", "new"));
  assert.equal(ok(withDeveloperText(body, t)), `new\n\n${OPENING_LINE}\nr\n${CLOSING_LINE}`);
  assert.equal(ok(withDeveloperText("old", t)), "new");
});
