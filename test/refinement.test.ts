import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { CLOSING_LINE, OPENING_LINE, type Refinement, readRefinement, refinementOf, SEPARATOR, withoutRefinement, withRefinement } from "../src/refinement.ts";

// Issue #120, part 1: the `Refined using Interloq` section, appended once and replaced later; the developer's text is
// never changed. The seam: what withRefinement writes is what readRefinement reads.

const refinement = (text: string): Refinement => Result.getOrThrow(refinementOf(text));
const ok = <A>(r: Result.Result<A, unknown>): A => {
  assert.ok(Result.isSuccess(r), `expected a success, got ${JSON.stringify(r)}`);
  return r.success;
};

test("the seam: the refinement written into a body is the refinement read back out", () => {
  const r = refinement("## Steps\n\n1. Do the thing.\n2. Check it.");
  const body = "The developer's issue.\n\nWith two paragraphs.";
  assert.deepEqual(ok(readRefinement(ok(withRefinement(body, r)))), Option.some(r));
});

test("a body without a section reads as none", () => {
  assert.deepEqual(ok(readRefinement("just text")), Option.none());
  assert.deepEqual(ok(readRefinement("")), Option.none());
});

test("an empty body gets the section alone, with no separator", () => {
  const r = refinement("r");
  const written = ok(withRefinement("", r));
  assert.equal(written, `${OPENING_LINE}\n${r}\n${CLOSING_LINE}`);
  assert.equal(ok(withoutRefinement(written)), "");
});

test("a body is kept exactly: the section follows it after the separator", () => {
  const r = refinement("r");
  const body = "text";
  assert.equal(ok(withRefinement(body, r)), `${body}${SEPARATOR}${OPENING_LINE}\n${r}\n${CLOSING_LINE}`);
});

test("a body with \\r\\n line endings keeps them, and its section reads back", () => {
  const r = refinement("a\nb");
  const body = "line one\r\nline two\r\n";
  const written = ok(withRefinement(body, r));
  assert.ok(written.startsWith(body));
  assert.equal(ok(withoutRefinement(written)), body);
  assert.deepEqual(ok(readRefinement(written)), Option.some(r));
});

test("a section whose own lines end in \\r\\n (an edit on GitHub) reads back without them", () => {
  const body = `text\r\n\r\n${OPENING_LINE}\r\nthe refinement\r\n${CLOSING_LINE}\r\n`;
  assert.deepEqual(ok(readRefinement(body)), Option.some(refinement("the refinement")));
});

test("a body ending in spaces and blank lines is given back exactly by withoutRefinement", () => {
  const body = "Ends with spaces   \n\n\n  \t";
  const written = ok(withRefinement(body, refinement("r")));
  assert.equal(ok(withoutRefinement(written)), body);
});

test("a second write replaces the first and keeps text the developer added after the section", () => {
  const first = ok(withRefinement("issue", refinement("first")));
  const edited = `${first}\n\nAdded later by the developer.`;
  const second = ok(withRefinement(edited, refinement("second")));
  assert.deepEqual(ok(readRefinement(second)), Option.some(refinement("second")));
  assert.ok(!second.includes("first"));
  assert.equal(ok(withoutRefinement(second)), "issue\n\nAdded later by the developer.");
  assert.equal(second, ok(withRefinement("issue", refinement("second"))) + "\n\nAdded later by the developer.");
});

test("a malformed section is refused by every function: an opening line alone, a closing line alone, two sections", () => {
  const r = refinement("r");
  const one = ok(withRefinement("x", r));
  const cases = [`x\n\n${OPENING_LINE}\nr`, `x\n${CLOSING_LINE}`, `${one}\n\n${one}`, `x\n${CLOSING_LINE}\n${OPENING_LINE}\nr`, `${OPENING_LINE}\n${CLOSING_LINE}`];
  for (const body of cases) {
    assert.ok(Result.isFailure(readRefinement(body)), JSON.stringify(body));
    assert.ok(Result.isFailure(withRefinement(body, r)), JSON.stringify(body));
    assert.ok(Result.isFailure(withoutRefinement(body)), JSON.stringify(body));
  }
});

test("refinementOf refuses blank text, a marker line, and a trailing carriage return, and accepts the rest", () => {
  for (const text of ["", "  \n\t", `a\n${OPENING_LINE}\nb`, `${CLOSING_LINE}`, "a\r\n" + CLOSING_LINE, "ends\r"]) {
    assert.ok(Result.isFailure(refinementOf(text)), JSON.stringify(text));
  }
  for (const text of ["x", `a ${OPENING_LINE}`, "line\n", "\nleading"]) assert.ok(Result.isSuccess(refinementOf(text)), JSON.stringify(text));
});
