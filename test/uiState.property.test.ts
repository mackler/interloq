import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { choiceOf, emptyUiState, isOpen, newer, type RunUiState, scopeKey, type UiFlag, type UiScope, withFlag } from "../src/uiState.ts";

// Issue #87 (decision G-R1-1 of its task): the shared state of a run's page, keyed by decision and entry.
const RUNS = { numRuns: 200, seed: 20261006 };
const decisionEntry: fc.Arbitrary<Extract<UiScope, { _tag: "DecisionEntry" }>> = fc.record({ _tag: fc.constant("DecisionEntry" as const), decision: fc.nat({ max: 5 }), entry: fc.string({ maxLength: 4 }) }, { noNullPrototype: true });
// Issue #63: the progress rail's phases and branches, keyed by short strings so that collisions are tried.
const railPhase: fc.Arbitrary<UiScope> = fc.record({ _tag: fc.constant("RailPhase" as const), phase: fc.string({ maxLength: 3 }) }, { noNullPrototype: true });
const railBranch: fc.Arbitrary<UiScope> = fc.record({ _tag: fc.constant("RailBranch" as const), phase: fc.string({ maxLength: 3 }), branch: fc.string({ maxLength: 3 }) }, { noNullPrototype: true });
const scope: fc.Arbitrary<UiScope> = fc.oneof(decisionEntry, railPhase, railBranch);
const flag: fc.Arbitrary<UiFlag> = fc.record({ scope, open: fc.boolean() }, { noNullPrototype: true });
/** A state reached from the empty one by flags, as the server reaches it. */
const reached: fc.Arbitrary<RunUiState> = fc.array(flag, { maxLength: 8 }).map((flags) => flags.reduce(withFlag, emptyUiState));
const openSet = (s: RunUiState) => new Set(s.choices.filter((c) => c.open).map((c) => scopeKey(c.scope)));

test("after a flag, its scope is open exactly as the flag says, and the version rises by one", () => {
  fc.assert(
    fc.property(reached, flag, (s, f) => {
      const next = withFlag(s, f);
      assert.equal(isOpen(next, f.scope), f.open);
      assert.equal(next.version, s.version + 1);
    }),
    RUNS,
  );
});

test("a flag applied twice leaves the same open set, each scope held once", () => {
  fc.assert(
    fc.property(reached, flag, (s, f) => {
      const once = withFlag(s, f);
      const twice = withFlag(once, f);
      assert.deepEqual(openSet(twice), openSet(once));
      assert.equal(twice.choices.filter((c) => c.open).length, openSet(twice).size);
    }),
    RUNS,
  );
});

test("a flag changes no other scope", () => {
  fc.assert(
    fc.property(reached, flag, scope, (s, f, other) => {
      fc.pre(scopeKey(other) !== scopeKey(f.scope));
      assert.equal(isOpen(withFlag(s, f), other), isOpen(s, other));
    }),
    RUNS,
  );
});

test("scopeKey is injective: two decisions that share an entry id have different keys", () => {
  fc.assert(
    fc.property(decisionEntry, decisionEntry, (a, b) => {
      assert.equal(scopeKey(a) === scopeKey(b), a.decision === b.decision && a.entry === b.entry);
    }),
    RUNS,
  );
  assert.notEqual(scopeKey({ _tag: "DecisionEntry", decision: 1, entry: "e1" }), scopeKey({ _tag: "DecisionEntry", decision: 2, entry: "e1" }));
  assert.notEqual(scopeKey({ _tag: "DecisionEntry", decision: 1, entry: "2:e" }), scopeKey({ _tag: "DecisionEntry", decision: 12, entry: ":e" }));
});

test("of the server's successive states, newer keeps the higher version, in any order and grouping", () => {
  fc.assert(
    fc.property(fc.array(flag, { minLength: 1, maxLength: 8 }), fc.integer(), (flags, seed) => {
      // The server's states in order; a tab receives them in any order.
      const states = flags.reduce<RunUiState[]>((acc, f) => [...acc, withFlag(acc.at(-1) ?? emptyUiState, f)], []);
      const last = states.at(-1)!;
      const shuffled = fc.sample(fc.shuffledSubarray(states, { minLength: states.length }), { numRuns: 1, seed })[0];
      assert.deepEqual(shuffled.reduce(newer, emptyUiState), last);
      for (const a of states) for (const b of states) {
        assert.deepEqual(newer(a, b), newer(b, a));
        assert.equal(newer(a, b).version, Math.max(a.version, b.version));
        for (const c of states) assert.deepEqual(newer(newer(a, b), c), newer(a, newer(b, c)));
      }
    }),
    { numRuns: 60, seed: 20261006 },
  );
});

// Issue #63: three values, not two. A scope the user closed stays closed, one he opened stays open, and one he has not
// touched is untouched, so that the rail can let it follow the run.
test("a rail scope the user closed is closed, one he opened is open, one he never touched is untouched", () => {
  const phase: UiScope = { _tag: "RailPhase", phase: "execution-2" };
  const stage: UiScope = { _tag: "RailBranch", phase: "execution-2", branch: "stage:current-1" };
  const closed = withFlag(emptyUiState, { scope: phase, open: false });
  assert.equal(choiceOf(closed, phase), "closed");
  assert.equal(choiceOf(withFlag(closed, { scope: phase, open: true }), phase), "open");
  assert.equal(choiceOf(closed, stage), "untouched", "a branch and its phase are different scopes");
  assert.equal(choiceOf(emptyUiState, phase), "untouched");
  assert.equal(isOpen(closed, phase), false);
});

test("choiceOf is total, and after a flag the scope's choice is as the flag says and no other scope's changes", () => {
  fc.assert(
    fc.property(reached, flag, scope, (s, f, other) => {
      assert.ok(["open", "closed", "untouched"].includes(choiceOf(s, other)));
      assert.equal(choiceOf(withFlag(s, f), f.scope), f.open ? "open" : "closed");
      if (scopeKey(other) !== scopeKey(f.scope)) assert.equal(choiceOf(withFlag(s, f), other), choiceOf(s, other));
      assert.equal(isOpen(s, other), choiceOf(s, other) === "open");
    }),
    RUNS,
  );
});

test("each touched scope is held once", () => {
  fc.assert(
    fc.property(reached, (s) => {
      const keys = s.choices.map((c) => scopeKey(c.scope));
      assert.equal(new Set(keys).size, keys.length);
    }),
    RUNS,
  );
});

test("scopeKey is injective over every variant", () => {
  fc.assert(
    fc.property(scope, scope, (a, b) => {
      assert.equal(scopeKey(a) === scopeKey(b), JSON.stringify(a) === JSON.stringify(b));
    }),
    RUNS,
  );
  assert.notEqual(scopeKey({ _tag: "RailBranch", phase: "a:b", branch: "c" }), scopeKey({ _tag: "RailBranch", phase: "a", branch: "b:c" }));
});
