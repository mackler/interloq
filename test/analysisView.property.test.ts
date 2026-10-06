import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { elementsOf, viewOf } from "../src/analysisView.ts";
import type { Argument, DecisionAnalysis, Entry } from "../src/schema.ts";

// Issue #87: an entry is marked when it hides a contradicting position. The mark is `disputed` of EntryView, true
// exactly when some element of the entry has a counterargument; equivalently, some text under the entry is colored
// for the other side than the entry's own (a counterargument has level 1 and the opposite `opposes`).

const RUNS = { numRuns: 100, seed: 20261006 };
/** A counterargument with replies, at most three levels deep (a reply turns the side at each level). */
const arbArgumentAt = (depth: number): fc.Arbitrary<Argument> =>
  fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), text: fc.string({ maxLength: 8 }), equivalent_to: fc.constant(""), replies: depth <= 1 ? fc.constant([] as Argument[]) : fc.array(arbArgumentAt(depth - 1), { maxLength: 2 }) }, { noNullPrototype: true });
const arbArgument = arbArgumentAt(3);
const arbElement = fc.record({ text: fc.string({ maxLength: 8 }), counterarguments: fc.oneof({ weight: 3, arbitrary: fc.constant([] as Argument[]) }, { weight: 1, arbitrary: fc.array(arbArgument, { maxLength: 2 }) }) }, { noNullPrototype: true });
const arbEntry: fc.Arbitrary<Entry> = fc
  .tuple(fc.string({ maxLength: 6 }), fc.array(arbElement, { minLength: 10, maxLength: 10 }))
  .map(([title, els]): Entry => ({
    id: "",
    title,
    comparative_condition: els[0],
    starting_cause: els[1],
    intermediate_steps: els[2],
    threshold: els[3],
    effect_on_persons: els[4],
    reason_the_effect_matters: els[5],
    extent: { per_person: els[6], persons_affected: els[7], likelihood: els[8], timing: els[9] },
  }));
/** An analysis with unique entry ids, so that view entries map back to their source. */
const arbAnalysis: fc.Arbitrary<DecisionAnalysis> = fc.array(fc.record({ advantages: fc.array(arbEntry, { maxLength: 3 }), disadvantages: fc.array(arbEntry, { maxLength: 3 }) }), { minLength: 1, maxLength: 3 }).map((cols) => {
  let n = 0;
  const id = (e: Entry): Entry => ({ ...e, id: `E${++n}` });
  return { decision: "d", columns: cols.map((c, i) => ({ kind: "argued" as const, option: `O${i}`, advantages: c.advantages.map(id), disadvantages: c.disadvantages.map(id) })), recommendation: { option: "", reason: "" } };
});
const pairs = (analysis: DecisionAnalysis) => {
  const view = viewOf(analysis);
  return analysis.columns.flatMap((c, i) => {
    const v = view.columns[i];
    if (c.kind !== "argued" || v.kind !== "argued") return [];
    return [...c.advantages.map((e, j) => [e, v.advantages[j]] as const), ...c.disadvantages.map((e, j) => [e, v.disadvantages[j]] as const)];
  });
};

test("disputed holds exactly when some element of the entry has a counterargument", () => {
  fc.assert(
    fc.property(arbAnalysis, (analysis) => {
      for (const [source, view] of pairs(analysis)) assert.equal(view.disputed, elementsOf(source).some((el) => el.counterarguments.length > 0), source.id);
    }),
    RUNS,
  );
});

test("disputed holds exactly when some text under the entry argues the other side than the entry", () => {
  fc.assert(
    fc.property(arbAnalysis, (analysis) => {
      for (const [, view] of pairs(analysis)) assert.equal(view.disputed, view.elements.some((el) => el.opposes !== view.opposes || el.arguments.some((a) => a.opposes !== view.opposes)), view.id);
    }),
    RUNS,
  );
});
