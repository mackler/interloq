// The representation of a decision as the page shows it (D8 of the decision-support plan). Pure, and
// free of Node imports, so that the browser imports it as it imports src/protocol.ts. The agent owns the sentences; this
// module owns the layout that docs/decision-making.md assigns to the renderer: the headings "Advantages:" and
// "Disadvantages:", the numbered labels of the entries (issue #35), the nesting of counterarguments under the element
// they dispute, the equivalence symbols, and which texts oppose the column's option (decision Q7 of issue #35: the page
// colors them), and which entries hide a contradicting position (`disputed`, issue #87: the page
// marks them beside the collapsed entry), and each element's role and group (issue #41: the page marks the chain of causes
// and the parts that frame, qualify and measure it).

import { ADVANTAGES_HEADING, advantageLabel, DISADVANTAGES_HEADING, disadvantageLabel, ELEMENT_ROLES, type ElementRole } from "./prompts.ts";
import type { Argument, DecisionAnalysis, Element, Entry } from "./schema.ts";

/**
 * The equivalence symbol an argument carries (issue #133): its mark, and the `index` of the entry its `equivalent_to`
 * names, so that the page links the mark to that entry. An entry's id cannot name it in the page (ids may hold any
 * character, and no sanitizer of them is injective); its position can.
 */
export type SymbolView = Readonly<{ mark: string; entry: number }>;
/** `opposes`: the text argues against the column's option (decision Q7 of issue #35). */
export type ArgumentView = Readonly<{ id: string; text: string; level: number; symbol: SymbolView | null; opposes: boolean }>;
export { ELEMENT_ROLES, type ElementRole };
/** `role` (issue #41): which part of the entry the element is, by which the page marks it. */
export type ElementView = Readonly<{ role: ElementRole; text: string; opposes: boolean; arguments: readonly ArgumentView[] }>;
/** The groups of an entry's parts, in the order the page shows them (issue #41). */
export const GROUP_KINDS = ["premise", "chain", "reason", "extent"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export type ElementGroup = Readonly<{ kind: GroupKind; elements: readonly ElementView[] }>;
/**
 * The group a part belongs to (issue #41): the comparative condition is the premise; the starting cause, the steps, the
 * threshold and the effect are the chain, the threshold between the steps and the effect as in `elementsOf`; the reason
 * the effect matters stands apart; the four statements of the extent are one group.
 */
export const groupOf = (role: ElementRole): GroupKind => {
  switch (role) {
    case "comparativeCondition":
      return "premise";
    case "startingCause":
    case "intermediateSteps":
    case "threshold":
    case "effectOnPersons":
      return "chain";
    case "reasonTheEffectMatters":
      return "reason";
    case "perPerson":
    case "personsAffected":
    case "likelihood":
    case "timing":
      return "extent";
  }
};
/**
 * `disputed` (issue #87): some element of the entry has a counterargument, so a text under it argues the other side.
 * `index` (issue #133): the entry's position in entriesOf, unique in the analysis; `symbol` is its own mark.
 */
export type EntryView = Readonly<{ id: string; index: number; label: string; title: string; symbol: string | null; opposes: boolean; disputed: boolean; groups: readonly ElementGroup[] }>;
/** An entry's elements in `elementsOf`'s order, its groups joined (issue #41). */
export const elementViewsOf = (entry: EntryView): readonly ElementView[] => entry.groups.flatMap((g) => g.elements);
export type ArguedColumnView = Readonly<{ kind: "argued"; option: string; advantagesHeading: string; advantages: readonly EntryView[]; disadvantagesHeading: string; disadvantages: readonly EntryView[] }>;
export type ColumnView = ArguedColumnView | Readonly<{ kind: "unclear"; option: string; unclear: string }>;
export type AnalysisView = Readonly<{ decision: string; columns: readonly ColumnView[]; recommendation: Readonly<{ option: string; reason: string }> | null }>;

/** An entry's elements partitioned by `groupOf` into the groups of `GROUP_KINDS`, in its order (issue #41). */
const groupsOf = (elements: readonly ElementView[]): readonly ElementGroup[] => GROUP_KINDS.map((kind) => ({ kind, elements: elements.filter((e) => groupOf(e.role) === kind) }));

/** The elements of an entry, in the order of docs/decision-making.md ("Elements of an advantage or disadvantage"). */
export const elementsOf = (entry: Entry): readonly Element[] => [
  entry.comparative_condition,
  entry.starting_cause,
  entry.intermediate_steps,
  entry.threshold,
  entry.effect_on_persons,
  entry.reason_the_effect_matters,
  entry.extent.per_person,
  entry.extent.persons_affected,
  entry.extent.likelihood,
  entry.extent.timing,
];
/** Every entry of the representation, column by column, advantages before disadvantages; an unclear column has none. */
export const entriesOf = (analysis: DecisionAnalysis): readonly Entry[] => analysis.columns.flatMap((c) => (c.kind === "unclear" ? [] : [...c.advantages, ...c.disadvantages]));
/**
 * The arguments under an element, depth first, each with its level (1 for a counterargument, 2 for its defense, …).
 * The depth is that of a value JSON.parse has already built, so plain recursion is as deep as the parse was.
 */
export const flatten = (args: readonly Argument[], level = 1): readonly (Argument & { level: number })[] => args.flatMap((a) => [{ ...a, level }, ...flatten(a.replies, level + 1)]);

const SYMBOLS = ["*", "†", "‡", "§", "‖", "¶"];
/** The n-th symbol (from 0): *, †, ‡, §, ‖, ¶, then the doubled forms, then the tripled ("Equivalence symbols"). */
export const symbolFor = (n: number): string => SYMBOLS[n % SYMBOLS.length].repeat(Math.floor(n / SYMBOLS.length) + 1);

/** The view of an analysis: symbols go to the entries that some argument refers to, in the order of the entries in the columns. */
export const viewOf = (analysis: DecisionAnalysis): AnalysisView => {
  const entries = entriesOf(analysis);
  const referenced = new Set(entries.flatMap((e) => elementsOf(e).flatMap((el) => flatten(el.counterarguments).map((a) => a.equivalent_to))).filter((id) => id !== ""));
  const symbols = new Map(entries.filter((e) => referenced.has(e.id)).map((e, i) => [e.id, symbolFor(i)] as const));
  // Issue #133: each entry's position in entriesOf, by which an argument's symbol names its target.
  const indexes = new Map(entries.map((e, i) => [e.id, i] as const));
  const symbolOf = (id: string): SymbolView | null => {
    const mark = symbols.get(id);
    const entry = indexes.get(id);
    return mark === undefined || entry === undefined ? null : { mark, entry };
  };
  // A disadvantage opposes the option; each level of reply turns the side: a counterargument (odd level) opposes what an
  // advantage says and supports what a disadvantage says, a defense (even level) the reverse.
  const entryView = (e: Entry, i: number, disadvantage: boolean): EntryView => ({
    id: e.id,
    index: indexes.get(e.id) ?? 0,
    label: disadvantage ? disadvantageLabel(i + 1) : advantageLabel(i + 1),
    title: e.title,
    symbol: symbols.get(e.id) ?? null,
    opposes: disadvantage,
    disputed: elementsOf(e).some((el) => el.counterarguments.length > 0),
    groups: groupsOf(
      elementsOf(e).map((el, i) => ({
        role: ELEMENT_ROLES[i],
        text: el.text,
        opposes: disadvantage,
        arguments: flatten(el.counterarguments).map((a) => ({ id: a.id, text: a.text, level: a.level, symbol: symbolOf(a.equivalent_to), opposes: disadvantage !== (a.level % 2 === 1) })),
      })),
    ),
  });
  return {
    decision: analysis.decision,
    columns: analysis.columns.map(
      (c): ColumnView =>
        c.kind === "unclear"
          ? { kind: "unclear", option: c.option, unclear: c.unclear }
          : {
              kind: "argued",
              option: c.option,
              advantagesHeading: ADVANTAGES_HEADING,
              advantages: c.advantages.map((e, i) => entryView(e, i, false)),
              disadvantagesHeading: DISADVANTAGES_HEADING,
              disadvantages: c.disadvantages.map((e, i) => entryView(e, i, true)),
            },
    ),
    recommendation: analysis.recommendation.option === "" ? null : analysis.recommendation,
  };
};
