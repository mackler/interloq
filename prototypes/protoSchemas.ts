// The schemas that prototypes/proto-schema.ts sends, transcribed field by field from src/schema.ts (the prototype
// imports nothing from src/). Free of side effects, so that test/jsonSchema.test.ts can check that they generate what
// the program sends (P1-R1-2 of the task of issues #35 and #37): a stale copy would prove another shape.

import { Schema } from "effect";

// Transcribed field by field from src/schemas.ts.
const Str = Schema.String;
const Strings = Schema.Array(Schema.String);
const Issue = Schema.Struct({ id: Str, severity: Schema.Literals(["blocking", "major", "minor"]), location: Str, problem: Str, evidence: Str });
const Disposition = Schema.Struct({
  id: Str,
  action: Schema.Literals(["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"]),
  rationale: Str,
  duplicate_of: Str,
  reverses: Str,
});
const SelfCorrection = Schema.Struct({ id: Str, new_action: Schema.Literals(["accepted", "rejected", "plan_error"]), explanation: Str });
// Issue #36 (30 Sep 2026): a question's text is blocks and pieces, and its explanations a list the pieces refer to.
const Piece = Schema.Struct({ text: Str, ref: Str, code: Schema.Boolean });
const Pieces = Schema.Array(Piece);
const Explanation = Schema.Struct({ id: Str, term: Str, explanation: Str });
const Block = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("paragraph"), pieces: Pieces }),
  Schema.Struct({ kind: Schema.Literal("list"), items: Schema.Array(Schema.Struct({ level: Schema.Int, pieces: Pieces })) }),
  Schema.Struct({ kind: Schema.Literal("code"), text: Str }),
]);
const Blocks = Schema.Array(Block);
const PieceOption = Schema.Struct({ label: Pieces, description: Pieces });
const UserQuestion = Schema.Struct({ context: Blocks, question: Pieces, explanations: Schema.Array(Explanation), options: Schema.Array(PieceOption) });
const plannerFields = { dispositions: Schema.Array(Disposition), self_corrections: Schema.Array(SelfCorrection), reviewer_feedback: Str, questions_for_user: Schema.Array(UserQuestion) };
const QuestionEntry = Schema.Struct({
  id: Str,
  context: Blocks,
  question: Pieces,
  reason: Blocks,
  proposed_answers: Schema.Array(PieceOption),
  default_answer: Str,
});
const TermsEntry = Schema.Struct({ id: Str, explanations: Schema.Array(Explanation), context: Blocks, question: Pieces, reason: Blocks, proposed_answers: Schema.Array(PieceOption) });

// Decision support (28 Sep 2026): the representation of docs/decision-making.md, recursive through Schema.suspend.
type Argument = { readonly id: string; readonly text: string; readonly equivalent_to: string; readonly replies: readonly Argument[] };
const Argument: Schema.Codec<Argument> = Schema.Struct({ id: Str, text: Str, equivalent_to: Str, replies: Schema.Array(Schema.suspend((): Schema.Codec<Argument> => Argument)) });
const Element = Schema.Struct({ text: Str, counterarguments: Schema.Array(Argument) });
const Entry = Schema.Struct({
  id: Str,
  title: Str,
  comparative_condition: Element,
  starting_cause: Element,
  intermediate_steps: Element,
  threshold: Element,
  effect_on_persons: Element,
  reason_the_effect_matters: Element,
  extent: Schema.Struct({ per_person: Element, persons_affected: Element, likelihood: Element, timing: Element }),
});
const DecisionAnalysis = Schema.Struct({
  decision: Str,
  // Issue #35 (Q8): a column is argued, or unclear with a statement of what is unclear.
  columns: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("argued"), option: Str, advantages: Schema.Array(Entry), disadvantages: Schema.Array(Entry) }),
      Schema.Struct({ kind: Schema.Literal("unclear"), option: Str, unclear: Str }),
    ]),
  ),
  recommendation: Schema.Struct({ option: Str, reason: Str }),
});
// Issue #6 (28 Sep 2026): the plan as data. Every call that creates or changes the plan returns it whole.
const PlanStep = Schema.Struct({ id: Str, number: Schema.Int, label: Str, text: Str });
const Plan = Schema.Struct({ stages: Schema.Array(Schema.Struct({ number: Schema.Int, title: Str, steps: Schema.Array(PlanStep) })) });
/** The recursive schemas: their strict variant cannot exist (a cycle of $ref cannot be inlined), so only raw is sent. */
export const RECURSIVE = new Set(["decisionAnalysis", "decisionResponse", "decisionApplied"]);

export const protoSchemas: Record<string, Schema.Top> = {
  review: Schema.Struct({ issues: Schema.Array(Issue) }),
  plannerResponse: Schema.Struct(plannerFields),
  planWrite: Schema.Struct({ questions_for_user: Schema.Array(UserQuestion) }),
  execReport: Schema.Struct({ status: Schema.Literals(["finished", "needs_input", "blocked"]), summary: Str, question: Str, remaining_work: Str }),
  questionList: Schema.Struct({ questions: Schema.Array(QuestionEntry) }),
  questionListResponse: Schema.Struct({ ...plannerFields, questions: Schema.Array(QuestionEntry) }),
  interviewTurn: Schema.Struct({ message_to_user: Str, current_question: Schema.Struct({ id: Str, context: Blocks, text: Pieces, explanations: Schema.Array(Explanation), options: Schema.Array(PieceOption) }), asked_ids: Strings, answered_ids: Strings, complete: Schema.Boolean, summary: Str }),
  decisionAnalysis: DecisionAnalysis,
  decisionResponse: Schema.Struct({ ...plannerFields, analysis: DecisionAnalysis }),
  decisionApplied: Schema.Struct({ analysis: DecisionAnalysis }),
  planReply: Schema.Struct({ plan: Plan, questions_for_user: Schema.Array(UserQuestion) }),
  planResponse: Schema.Struct({ ...plannerFields, plan: Plan }),
  // S9: the reply of the call that writes the context paragraph of a question the program composes, with the whole
  // question as pieces (issue #36, decisions G-R1-1 and F1).
  questionContext: Schema.Struct({ context: Blocks, question: Pieces, options: Schema.Array(PieceOption), details: Blocks, explanations: Schema.Array(Explanation) }),
  // S17: the explanations of the agreed questions' terms, each question divided into pieces (issue #36, decision Q1).
  termsWrite: Schema.Struct({ entries: Schema.Array(TermsEntry) }),
  termsResponse: Schema.Struct({ ...plannerFields, entries: Schema.Array(TermsEntry) }),
};

export type Json = Record<string, any>;

export function protoRaw(s: Schema.Top): Json {
  const doc = Schema.toJsonSchemaDocument(s, { onExcessProperty: "error" });
  const defs = doc.definitions as Json;
  return Object.keys(defs).length > 0 ? { ...(doc.schema as Json), $defs: defs } : (doc.schema as Json);
}

