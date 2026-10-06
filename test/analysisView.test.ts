import assert from "node:assert/strict";
import { test } from "node:test";
import { type ArguedColumnView, type ColumnView, symbolFor, viewOf } from "../src/analysisView.ts";
import * as prompts from "../src/prompts.ts";
import type { Argument, DecisionAnalysis, Entry } from "../src/schema.ts";

// Decision support, plan step 4.1 (D8): the renderer owns the heading, the offsets and the symbols.
const el = (text: string, counterarguments: Argument[] = []) => ({ text, counterarguments });
const entry = (id: string, counter: Argument[] = []): Entry => ({
  id,
  title: `Title ${id}.`,
  comparative_condition: el(`c ${id}`, counter),
  starting_cause: el(`s ${id}`),
  intermediate_steps: el(`i ${id}`),
  threshold: el(`t ${id}`),
  effect_on_persons: el(`e ${id}`),
  reason_the_effect_matters: el(`r ${id}`),
  extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
});
const argued = (column: ColumnView): ArguedColumnView => {
  if (column.kind !== "argued") throw new Error(`column ${column.option} is not argued`);
  return column;
};
const arg = (id: string, equivalent_to = "", replies: Argument[] = []): Argument => ({ id, text: `text ${id}`, equivalent_to, replies });

test("symbols run *, †, ‡, §, ‖, ¶, then doubled, then tripled", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(symbolFor), ["*", "†", "‡", "§", "‖", "¶"]);
  assert.equal(symbolFor(6), "**");
  assert.equal(symbolFor(11), "¶¶");
  assert.equal(symbolFor(12), "***");
});

test("columns in order; each entry's elements in the document's order; arguments with their levels and symbols", () => {
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "", [arg("A3", "E3")])])])], disadvantages: [entry("E2")] },
      { kind: "argued", option: "B", advantages: [entry("E3", [arg("A4", "E2")])], disadvantages: [entry("E4")] },
    ],
    recommendation: { option: "", reason: "" },
  };
  const view = viewOf(analysis);
  assert.deepEqual(view.columns.map((c) => c.option), ["A", "B"]);
  assert.equal(argued(view.columns[0]).disadvantagesHeading, prompts.DISADVANTAGES_HEADING);
  assert.equal(prompts.DISADVANTAGES_HEADING, "Disadvantages:");
  const e1 = argued(view.columns[0]).advantages[0];
  assert.deepEqual(e1.elements.map((x) => x.text), ["c E1", "s E1", "i E1", "t E1", "e E1", "r E1", "pp E1", "pa E1", "l E1", "w E1"]);
  assert.deepEqual(e1.elements[0].arguments.map((a) => [a.id, a.level, a.symbol]), [["A1", 1, null], ["A2", 2, null], ["A3", 3, "†"]]);
  // E2 (first referenced in column order) gets *, E3 gets †; unreferenced entries get none.
  assert.deepEqual(view.columns.map(argued).flatMap((c) => [...c.advantages, ...c.disadvantages]).map((e) => [e.id, e.symbol]), [["E1", null], ["E2", "*"], ["E3", "†"], ["E4", null]]);
  assert.equal(argued(view.columns[1]).advantages[0].elements[0].arguments[0].symbol, "*");
  assert.equal(view.recommendation, null);
});

test("a column without disadvantages still shows the heading; a recommendation is shown when present", () => {
  const view = viewOf({ decision: "d", columns: [{ kind: "argued", option: "A", advantages: [entry("E1")], disadvantages: [] }], recommendation: { option: "A", reason: "because" } });
  assert.equal(argued(view.columns[0]).disadvantagesHeading, "Disadvantages:");
  assert.deepEqual(argued(view.columns[0]).disadvantages, []);
  assert.deepEqual(view.recommendation, { option: "A", reason: "because" });
});

// Issue #35: both headings, and entries numbered and labeled within each heading of each column
// (docs/decision-making.md, "Layout and wording").
test("each argued column has both headings, and its entries are labeled Advantage n: and Disadvantage n: from 1", () => {
  const view = viewOf({
    decision: "d",
    columns: [
      { kind: "argued", option: "A", advantages: [entry("E1"), entry("E2")], disadvantages: [entry("E3")] },
      { kind: "argued", option: "B", advantages: [entry("E4")], disadvantages: [entry("E5"), entry("E6")] },
    ],
    recommendation: { option: "", reason: "" },
  });
  assert.equal(prompts.ADVANTAGES_HEADING, "Advantages:");
  for (const column of view.columns.map(argued)) {
    assert.equal(column.advantagesHeading, prompts.ADVANTAGES_HEADING);
    assert.equal(column.disadvantagesHeading, prompts.DISADVANTAGES_HEADING);
  }
  assert.deepEqual(view.columns.map(argued).map((c) => [c.advantages.map((e) => e.label), c.disadvantages.map((e) => e.label)]), [
    [["Advantage 1:", "Advantage 2:"], ["Disadvantage 1:"]],
    [["Advantage 1:"], ["Disadvantage 1:", "Disadvantage 2:"]],
  ]);
  assert.equal(prompts.advantageLabel(3), "Advantage 3:");
  assert.equal(prompts.disadvantageLabel(3), "Disadvantage 3:");
});

// Issue #35, decision Q7: a text opposes the column's option exactly when it argues against it. A disadvantage does; each
// level of reply turns the side, at every depth.
test("opposes: a disadvantage and its elements, a counterargument to an advantage, a defense under a disadvantage, and so on", () => {
  const chain = (p: string): Argument[] => [arg(`${p}1`, "", [arg(`${p}2`, "", [arg(`${p}3`, "", [arg(`${p}4`)])])])];
  const view = viewOf({ decision: "d", columns: [{ kind: "argued", option: "A", advantages: [entry("E1", chain("a"))], disadvantages: [entry("E2", chain("d"))] }], recommendation: { option: "", reason: "" } });
  const [advantage, disadvantage] = [argued(view.columns[0]).advantages[0], argued(view.columns[0]).disadvantages[0]];
  assert.equal(advantage.opposes, false);
  assert.equal(disadvantage.opposes, true);
  assert.ok(advantage.elements.every((e) => !e.opposes));
  assert.ok(disadvantage.elements.every((e) => e.opposes));
  // Level:                                        1 (counterargument)  2 (defense)  3 (counterargument)  4 (defense)
  assert.deepEqual(advantage.elements[0].arguments.map((a) => [a.level, a.opposes]), [[1, true], [2, false], [3, true], [4, false]]);
  assert.deepEqual(disadvantage.elements[0].arguments.map((a) => [a.level, a.opposes]), [[1, false], [2, true], [3, false], [4, true]]);
});

// Issue #35, decision Q8: an unclear column shows its statement in place of the two headings.
test("an unclear column's view is its option and its statement, with no headings and no entries", () => {
  const view = viewOf({
    decision: "d",
    columns: [
      { kind: "argued", option: "A", advantages: [entry("E1")], disadvantages: [] },
      { kind: "unclear", option: "B", unclear: "B could mean a copy or a cache." },
    ],
    recommendation: { option: "", reason: "" },
  });
  assert.deepEqual(view.columns[1], { kind: "unclear", option: "B", unclear: "B could mean a copy or a cache." });
});

test("issue #87: an entry with a counterargument is disputed, one without is not", () => {
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [{ kind: "argued", option: "A", advantages: [entry("E1", [arg("A1")])], disadvantages: [entry("E2")] }],
    recommendation: { option: "", reason: "" },
  };
  const column = argued(viewOf(analysis).columns[0]);
  assert.equal(column.advantages[0].disputed, true);
  assert.equal(column.disadvantages[0].disputed, false);
});
