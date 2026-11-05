// Issue #166 (requirements Q1): the question page shows Technical Context open when a question first appears.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { DEFAULT_OPEN, type OpenSections, openOf, type PaneSection, withSection } from "./sections.ts";

const section = fc.constantFrom<PaneSection>("context", "history", "attached");
const key = fc.option(fc.string({ maxLength: 6 }), { nil: null });
const toggle = fc.record({ key, section, open: fc.boolean() });
const EMPTY: OpenSections = { key: null, open: [] };

describe("the question page's open sections", () => {
  test("a question first shown opens Technical Context alone", () => {
    expect(DEFAULT_OPEN).toEqual(["context"]);
    expect(openOf(EMPTY, "q1")).toEqual(["context"]);
  });

  test("a toggle is read back for its question, and another question restores the default", () => {
    fc.assert(
      fc.property(fc.array(toggle, { maxLength: 8 }), toggle, key, (before, t, other) => {
        const state = withSection(before.reduce((s, b) => withSection(s, b.key, b.section, b.open), EMPTY), t.key, t.section, t.open);
        expect(openOf(state, t.key).includes(t.section)).toBe(t.open);
        if (other !== t.key) expect(openOf(state, other)).toEqual(DEFAULT_OPEN);
      }),
    );
  });

  test("closing the context of a question just shown keeps it closed", () => {
    expect(openOf(withSection(EMPTY, "q1", "context", false), "q1")).toEqual([]);
    expect(openOf(withSection(EMPTY, "q1", "history", true), "q1")).toEqual(["context", "history"]);
  });
});
