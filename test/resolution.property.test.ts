// Issue #38: the properties of src/resolution.ts, against reference models written here.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { changesAuthority, investigatedIds, positionOf, previousRound, resolutionOf, resolutionOutcomes, standingDisputes } from "../src/resolution.ts";
import type * as S from "../src/schema.ts";
import { reviewEntry, selfEntry } from "./resolutionFixtures.ts";

const blankOr = fc.oneof(fc.constantFrom("", " ", "\n\t"), fc.string());
const nonBlank = (s: string) => /\S/u.test(s);
const text = (s: string) => s as S.PositionText;

test("positionOf succeeds exactly when both texts are not blank, and keeps them unchanged", () => {
  fc.assert(
    fc.property(blankOr, blankOr, (concern, remedy) => {
      const r = positionOf({ concern, remedy });
      if (nonBlank(concern) && nonBlank(remedy)) assert.deepEqual(r, Result.succeed({ concern, remedy }));
      else assert.deepEqual(r, Result.fail("blank"));
    }),
  );
});

test("resolutionOf succeeds exactly when the text and every change are not blank, and keeps them unchanged", () => {
  fc.assert(
    fc.property(blankOr, fc.array(blankOr, { maxLength: 3 }), (t, changes) => {
      const r = resolutionOf({ text: t, changes });
      if (nonBlank(t) && changes.every(nonBlank)) assert.deepEqual(r, Result.succeed({ text: t, changes }));
      else assert.deepEqual(r, Result.fail("blank"));
      assert.equal(changesAuthority({ text: text(t), changes: changes.map(text) }), changes.length > 0);
    }),
  );
});

const before = (a: { phase: number; round: number }, b: { phase: number; round: number }) => a.phase < b.phase || (a.phase === b.phase && a.round < b.round);
const arbPlace = fc.record({ phase: fc.nat(3), round: fc.nat(4) });

test("previousRound is the latest (phase, round) strictly before the given one", () => {
  fc.assert(
    fc.property(fc.array(arbPlace, { maxLength: 6 }), arbPlace, (places, at) => {
      const log = places.map((p, k) => reviewEntry(`I${k}`, "rejected", p));
      const earlier = places.filter((p) => before(p, at)).sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
      assert.deepEqual(previousRound(log, at.phase, at.round), earlier.length === 0 ? null : { phase: earlier.at(-1)!.phase, round: earlier.at(-1)!.round });
    }),
  );
});

const ACTIONS = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"] as const;
const arbResolution = fc.option(fc.record({ text: fc.constantFrom("t1", "t2").map(text), changes: fc.array(fc.constantFrom("c1", "c2").map(text), { maxLength: 2 }) }), { nil: null });
const arbEntry = (i: string): fc.Arbitrary<S.LogEntry> =>
  fc.oneof(
    fc.record({ place: arbPlace, action: fc.constantFrom(...ACTIONS), resolution: arbResolution, superseded: fc.boolean() }).map(({ place, action, resolution, superseded }) => reviewEntry(i, action, { ...place, resolution, superseded })),
    fc.record({ place: arbPlace, action: fc.constantFrom("accepted" as const, "plan_error" as const, "correction_disputed" as const), resolution: arbResolution, superseded: fc.boolean() }).map(({ place, action, resolution, superseded }) => selfEntry(i, action, { ...place, resolution, superseded })),
  );
const arbLog = fc.uniqueArray(fc.constantFrom("A", "B", "C", "D", "E"), { maxLength: 5 }).chain((ids) => fc.tuple(...ids.map(arbEntry)));

test("resolutionOutcomes against its reference model", () => {
  fc.assert(
    fc.property(arbLog, fc.subarray(["A", "B", "C", "D", "E"]), arbPlace, (log, raised, at) => {
      const prev = previousRound(log, at.phase, at.round);
      const candidates = log.filter((e) => !e.superseded && e.source !== "user" && prev !== null && e.phase === prev.phase && e.round === prev.round && e.resolution !== null && !raised.includes(e.id));
      const out = resolutionOutcomes(log, raised, at.phase, at.round);
      const agreed = out.agreed.map((a) => a.id);
      const authority = out.authority.map((e) => e.id);
      assert.deepEqual(agreed, candidates.filter((e) => e.source !== "user" && e.resolution!.changes.length === 0).map((e) => e.id));
      assert.deepEqual(authority, candidates.filter((e) => e.source === "review" && e.resolution!.changes.length > 0).map((e) => e.id));
      assert.ok(agreed.every((a) => !authority.includes(a)));
      assert.ok(out.authority.every((e) => e.source === "review"));
    }),
  );
});

test("an entry with no record of an investigation is never investigated and never stands", () => {
  fc.assert(
    fc.property(arbLog, (log) => {
      assert.equal(investigatedIds(log).size, 0);
      assert.deepEqual(standingDisputes(log), []);
    }),
  );
});
