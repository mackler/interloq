// The representation of a decision as the page and the terminal show it (D8 of the decision-support plan). Pure, and
// free of Node imports, so that the browser imports it as it imports src/protocol.ts. The agent owns the sentences; this
// module owns the layout that docs/decision-making.md assigns to the renderer: the headings "Advantages:" and
// "Disadvantages:", the numbered labels of the entries (issue #35), the nesting of counterarguments under the element
// they dispute, the equivalence symbols, and which texts oppose the column's option (decision Q7 of issue #35: the page
// colors them, the terminal marks them).

import { ADVANTAGES_HEADING, advantageLabel, DISADVANTAGES_HEADING, disadvantageLabel } from "./prompts.ts";
import type { Argument, DecisionAnalysis, Element, Entry } from "./schema.ts";

/** `opposes`: the text argues against the column's option (decision Q7 of issue #35). */
export type ArgumentView = Readonly<{ id: string; text: string; level: number; symbol: string | null; opposes: boolean }>;
export type ElementView = Readonly<{ text: string; opposes: boolean; arguments: readonly ArgumentView[] }>;
/** `disputed` (issue #87): some element of the entry has a counterargument, so a text under it argues the other side. */
export type EntryView = Readonly<{ id: string; label: string; title: string; symbol: string | null; opposes: boolean; disputed: boolean; elements: readonly ElementView[] }>;
export type ArguedColumnView = Readonly<{ kind: "argued"; option: string; advantagesHeading: string; advantages: readonly EntryView[]; disadvantagesHeading: string; disadvantages: readonly EntryView[] }>;
export type ColumnView = ArguedColumnView | Readonly<{ kind: "unclear"; option: string; unclear: string }>;
export type AnalysisView = Readonly<{ decision: string; columns: readonly ColumnView[]; recommendation: Readonly<{ option: string; reason: string }> | null }>;

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
  // A disadvantage opposes the option; each level of reply turns the side: a counterargument (odd level) opposes what an
  // advantage says and supports what a disadvantage says, a defense (even level) the reverse.
  const entryView = (e: Entry, i: number, disadvantage: boolean): EntryView => ({
    id: e.id,
    label: disadvantage ? disadvantageLabel(i + 1) : advantageLabel(i + 1),
    title: e.title,
    symbol: symbols.get(e.id) ?? null,
    opposes: disadvantage,
    disputed: false,
    elements: elementsOf(e).map((el) => ({
      text: el.text,
      opposes: disadvantage,
      arguments: flatten(el.counterarguments).map((a) => ({ id: a.id, text: a.text, level: a.level, symbol: symbols.get(a.equivalent_to) ?? null, opposes: disadvantage !== (a.level % 2 === 1) })),
    })),
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
