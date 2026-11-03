// Issue #39, W1-R1-1 of work review 2: scopeOf reads a short option's attached value as Playwright's parser
// (Commander) does, whatever the value.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { scopeOf } from "../e2e/countsReporter.ts";

const PLAYWRIGHT = ["/usr/bin/node", "/workspace/node_modules/.bin/playwright", "test"];

test("-g or -G with any attached value is a selection", () => {
  fc.assert(
    fc.property(fc.constantFrom("-g", "-G"), fc.string({ minLength: 1 }), (flag, value) =>
      scopeOf({}, [...PLAYWRIGHT, flag + value]) === "selection"),
    { numRuns: 200 },
  );
});

test("an attached worker count consumes no following file filter", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000 }),
      fc.string({ minLength: 1 }).filter((p) => !p.startsWith("-")),
      (n, p) => {
        assert.equal(scopeOf({}, [...PLAYWRIGHT, `-j${n}`]), "whole");
        assert.equal(scopeOf({}, [...PLAYWRIGHT, `-j${n}`, p]), "selection");
      },
    ),
    { numRuns: 200 },
  );
});

// W1-R1-1 of work review 3: a value option at the end of a combined group takes the next argument.
test("-xj with any worker count is whole, and -xg with any pattern is a selection", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1 }), fc.string({ minLength: 1 }), (n, v) => {
      assert.equal(scopeOf({}, [...PLAYWRIGHT, "-xj", String(n)]), "whole");
      assert.equal(scopeOf({}, [...PLAYWRIGHT, "-xg", v]), "selection");
    }),
    { numRuns: 200 },
  );
});
