import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { readRefinement, refinementOf, withRefinement } from "../src/refinement.ts";
import { ITEM_STATES, type ItemState } from "../src/tracker.ts";
import { moveBody, nextCursor, pageProblem, refinedDesc, stateOfCard, TRELLO_DESC_LIMIT } from "../src/trelloCards.ts";
import type { TrelloLists } from "../src/schema.ts";

// The seam between moving a card and reading its state, the description's limit, and the paging of a listing (issue #66).
const RUNS = { numRuns: 200, seed: 20261009 };
const arbHexId = fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 24, maxLength: 24 });
const arbConfig = fc.uniqueArray(arbHexId, { minLength: 6, maxLength: 6 }).map(([board, ...ids]) => ({
  kind: "trello" as const,
  board,
  lists: Object.fromEntries(ITEM_STATES.map((state, i) => [state, ids[i]])) as Record<ItemState, string> as TrelloLists,
}));
const arbState = fc.constantFrom(...ITEM_STATES);

test("a card of the board moved to a state's list reads as that state", () => {
  fc.assert(fc.property(arbConfig, arbState, (config, state) => {
    const read = stateOfCard(config, { idBoard: config.board, closed: false, ...moveBody(config.lists, state) });
    return Result.isSuccess(read) && read.success === state;
  }), RUNS);
});

test("refinedDesc fails exactly when the refined text is over the limit, and otherwise reads back the refinement", () => {
  const arbText = fc.oneof(fc.string({ maxLength: 40 }), fc.integer({ min: TRELLO_DESC_LIMIT - 200, max: TRELLO_DESC_LIMIT + 50 }).map((n) => "d".repeat(n)));
  const arbRefinement = fc.string({ minLength: 1, maxLength: 60 }).map((s) => refinementOf(s)).filter(Result.isSuccess).map((r) => r.success);
  fc.assert(fc.property(arbText, arbRefinement, (text, refinement) => {
    const plain = withRefinement(text, refinement);
    const refined = refinedDesc(text, refinement);
    if (Result.isFailure(plain)) return Result.isFailure(refined) && refined.failure._tag === "SectionMalformed";
    if (plain.success.length > TRELLO_DESC_LIMIT) return Result.isFailure(refined) && refined.failure._tag === "DescTooLong" && refined.failure.length === plain.success.length;
    if (Result.isFailure(refined)) return false;
    const back = readRefinement(refined.success);
    return Result.isSuccess(back) && Option.isSome(back.success) && back.success.value === refinement;
  }), RUNS);
});

test("paging newest first by the smallest id of each full page yields every card once, with no problem", () => {
  fc.assert(fc.property(fc.uniqueArray(arbHexId, { maxLength: 40 }), fc.integer({ min: 1, max: 7 }), (ids, size) => {
    // A Trello that returns, of the ids below the cursor, the largest `size`, newest first.
    const answer = (before: string | null) => [...ids].sort().reverse().filter((id) => before === null || id < before).slice(0, size).map((id) => ({ id }));
    const walk = (before: string | null, seen: ReadonlySet<string>, pages: number): ReadonlySet<string> | null => {
      if (pages > ids.length + 2) return null;
      const page = answer(before);
      if (pageProblem(before, seen, page) !== null) return null;
      const all = new Set([...seen, ...page.map((c) => c.id)]);
      return Option.match(nextCursor(page, size), { onNone: () => all, onSome: (cursor) => walk(cursor, all, pages + 1) });
    };
    const got = walk(null, new Set(), 0);
    return got !== null && got.size === ids.length && ids.every((id) => got.has(id));
  }), RUNS);
});
