// The document under review of a review loop as the page shows it (issue #86, requirements Q1, Q2 and G-R1-1). Pure, and
// free of Node imports, so that the browser imports it as it imports src/protocol.ts.

import type { DecisionAnalysis } from "./schema.ts";

/**
 * The forms the page renders differently: Markdown (the question list and the terms as conversation.md renders them,
 * plan.md, requirements.md, a verdict's missing points); the whole changes.diff of a code review, uncut and never read
 * as Markdown; and a decision's draft analysis as data, which the page renders through viewOf of src/analysisView.ts,
 * since docs/decision-making.md governs every representation of an analysis.
 */
export type ShownDocument =
  | Readonly<{ _tag: "Markdown"; text: string }>
  | Readonly<{ _tag: "Diff"; text: string }>
  | Readonly<{ _tag: "Analysis"; analysis: DecisionAnalysis }>;

/** Whether two documents are the same: the same form and the same content. */
export const sameDocument = (a: ShownDocument, b: ShownDocument): boolean => a._tag === b._tag && contentOf(a) === contentOf(b);
/** A document's content as one text, which the comparison uses. */
const contentOf = (document: ShownDocument): string => {
  switch (document._tag) {
    case "Markdown":
    case "Diff":
      return document.text;
    case "Analysis":
      return JSON.stringify(document.analysis);
  }
};
