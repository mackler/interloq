// The unattended preparation of an item's questions (issue #131) as the server and the page share it: pure, also
// imported by the browser, so it imports nothing of node.
import { Schema } from "effect";

/** An item's mark in the Refinement tab's list (requirements Q6): being prepared, prepared with its count of questions, or set aside with why. */
export const PreparationMarkSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Preparing") }),
  Schema.Struct({ _tag: Schema.Literal("Prepared"), questions: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("SetAside"), reason: Schema.String }),
]);
export type PreparationMark = typeof PreparationMarkSchema.Type;
