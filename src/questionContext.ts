// The context call (S9, decision Q1): a fresh Claude Code session, which may read the project and change nothing, writes the context paragraph and the terms of a
// question the program composed itself, under the rules of every question; a reply that breaks them gets the repair
// turns of behaviour 10, and a call that cannot be made or repaired leaves the program's own paragraph (S10, G-R1-1).

import { Effect, Result } from "effect";
import { QuestionInvalid, type RunError } from "./errors.ts";
import { type ContextRequest, contextFallbackNote, contextPrompt, fallbackContext, type QuestionProblem, questionRepairPrompt } from "./prompts.ts";
import { describe } from "./errors.ts";
import { plainBlocks, type ValueToken, valueTokensOf } from "./pieces.ts";
import { type ContextWritten, questionPieces, questionProblems, type SuppliedRef, suppliedOf } from "./question.ts";
import { planningCall, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import { type Decider, Planner, type RunConfig, Store, type Ui } from "./services.ts";

/** The code pieces with a ref that the program supplied in its request (the names of a tool's settings it explains, S55), each with its part (P5-R1-1). */
const suppliedRefs = (request: ContextRequest): readonly SuppliedRef[] => suppliedOf({ context: [], question: request.question, explanations: [], options: request.options, details: request.details });

/**
 * The values of the request and of the reply agree position by position, in kind, text and ref (W1-R1-1, W4-R1-1); a
 * supplied reference merely dropped is left to suppliedRefDropped, which names it.
 */
const sameValues = (asked: readonly ValueToken[], replied: readonly ValueToken[]): boolean =>
  asked.length === replied.length && asked.every((a, i) => a.kind === replied[i].kind && a.text === replied[i].text && (a.ref === replied[i].ref || replied[i].ref === ""));

/**
 * The reply of a context call (S9; decisions G-R1-1 and F1): the whole question under the rules of every question and the
 * data clauses of its format, the program's supplied references the one exception to "no ref on a code piece"; the
 * options neither added, removed nor reordered; every literal value of the details kept exactly, in order; and every
 * supplied reference kept (KEEP_SUPPLIED_REFS).
 */
export const contextValidation =
  (request: ContextRequest): Validation<S.QuestionContext> =>
  (reply) => {
    const supplied = suppliedRefs(request);
    const shown = questionPieces({ context: reply.context, question: reply.question, explanations: reply.explanations, options: reply.options, details: reply.details });
    const problems: readonly QuestionProblem[] = [
      ...questionProblems({ context: reply.context, question: reply.question, explanations: reply.explanations, options: reply.options, details: reply.details }, supplied),
      ...(reply.options.length === request.options.length ? [] : [{ kind: "optionsChanged" as const, subject: "" }]),
      // W1-R1-1: every value, code or phrase, kept in its kind and its order, none added; W4-R1-1: each code value's ref kept on its occurrence.
      ...(sameValues(valueTokensOf(request.details), valueTokensOf(reply.details)) ? [] : [{ kind: "literalChanged" as const, subject: "" }]),
      ...supplied.map((s) => s.piece).filter((p) => !shown.some((q) => q.code && q.text === p.text && q.ref === p.ref)).map((p) => ({ kind: "suppliedRefDropped" as const, subject: p.text })),
    ];
    if (problems.length === 0) return Result.succeed({ value: reply, notes: [] });
    const questions = [{ where: "the question", problems }];
    return Result.fail({ error: new QuestionInvalid({ questions }), repair: questionRepairPrompt(questions) });
  };

/** The program's own paragraph (S10), marked as the program's; its question, options, details and explanations stand. */
export const programWritten = (request: ContextRequest): ContextWritten => ({ context: { blocks: plainBlocks(fallbackContext(request.origin)), by: "program" }, explanations: request.explanations });

/**
 * Writes a question's context in a fresh session, which may read the project and change nothing (S33): the agent's
 * paragraph and terms, or, when the call fails for any reason but the user's stop or a change the guards find, the
 * program's paragraph with a note in conversation.md, so that the question always reaches the user.
 */
export const writeContext = (task: string, request: ContextRequest): Effect.Effect<ContextWritten, RunError, Store | Planner | Decider | Ui | RunConfig> =>
  Effect.gen(function* () {
    const planner = yield* (yield* Planner).fresh;
    // S33: it may read the project and change nothing; the project and the guarded records are compared after the call.
    const written = yield* planningCall(contextPrompt(task, request), S.QuestionContext, "context", "readProject", contextValidation(request)).pipe(Effect.provideService(Planner, planner));
    const reply = written.output;
    return { context: { blocks: reply.context, by: "agent" as const }, explanations: reply.explanations, question: reply.question, options: reply.options, details: reply.details };
  }).pipe(
    Effect.catch((error: RunError): Effect.Effect<ContextWritten, RunError, Store> =>
      error._tag === "UserStopped" || error._tag === "Interrupted" || error._tag === "ProjectChanged" || error._tag === "RecordsChanged"
        ? Effect.fail(error)
        : Effect.gen(function* () {
            yield* (yield* Store).converse(contextFallbackNote(describe(error)));
            return programWritten(request);
          }),
    ),
  );
