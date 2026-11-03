import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_LINK_MARK, CHAIN_START_MARK, REASON_MARK } from "../src/prompts.ts";

// Issue #41: the developer rejected ∴ for the reason the effect matters at the first judgment
// (3 Nov 2026), because it may read as a proved conclusion, which that statement is not.
test("the reason's mark is no sign of logical consequence or of a link of the chain", () => {
  for (const sign of ["∴", "∵", "⇒", "→", "➔", "⟹"]) assert.notEqual(REASON_MARK, sign);
});

test("the three marks are distinct single code points", () => {
  const marks = [REASON_MARK, CHAIN_LINK_MARK, CHAIN_START_MARK];
  for (const mark of marks) assert.equal([...mark].length, 1, mark);
  assert.equal(new Set(marks).size, marks.length);
});
