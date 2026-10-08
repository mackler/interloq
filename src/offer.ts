// The offer of decision support ("Help me decide", D2 of the decision-support plan): a question with two or more options
// carries it, whatever interface asks. Separate from src/decision.ts, which runs the loop, so that the places that ask
// (src/review.ts, src/conversation.ts, src/claude.ts) do not import the loop (no import cycle).

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { chooseOption, isDecide, limitStops, parseExtraRounds, parseTransportAnswer, parseUnchangedAnswer } from "./input.ts";
import * as prompts from "./prompts.ts";
import { type Block, blocksMarkdown, blocksText, type Explanation, type Piece, type PieceOption, piecesText, plainBlocks, plainOption, plainPieces, type ShownBlock } from "./pieces.ts";
import { type ContextWritten, type OptionAnswer, type PresentedQuestion, type QuestionContextText, type QuestionOrigin, shownExplanations } from "./question.ts";
import { Result } from "effect";
import type { QuestionInvalid } from "./errors.ts";
import { renderChoice, renderQuestionRecord, termItem } from "./render.ts";
import { Decider, Store, Ui } from "./services.ts";

// ---- the offer (D2) ------------------------------------------------------------------------------------

/**
 * An option of a question, with the answer the user gives to choose it (S8: its exact text, or any number he types) and
 * the answers that choose it (P1-R1-4). Each `answer` is one that `matches` accepts, which test/offer.test.ts asserts.
 * `label` and `description` are the option's own words, by which it is chosen and recorded; `shown` is the option as the
 * user reads it, as pieces (issue #36), which a context call may rephrase (S10: the pairing is by position).
 */
export type OfferedOption = Readonly<{ label: string; description: string; shown: PieceOption; answer: OptionAnswer; matches: (answer: string) => boolean }>;
/** A question before it is numbered (S7): everything the user is shown of it but its number. */
export type QuestionDraft = Readonly<{
  origin: QuestionOrigin;
  context: QuestionContextText;
  explanations: readonly Explanation[];
  question: readonly Piece[];
  options: readonly OfferedOption[];
  details?: readonly ShownBlock[];
  /**
   * A question the program composed asks a context call for its context and terms (S9, decision Q1): the facts of the
   * case in prose beside `details`. Absent: the draft's own context stands.
   */
  explain?: string;
  decision: number | null;
}>;
/** The fixed context paragraph of a question the program composes (S7, S10), marked as the program's. */
export const programContext = (origin: QuestionOrigin): QuestionContextText => ({ blocks: plainBlocks(prompts.fallbackContext(origin)), by: "program" });
/** An agent's context paragraph; the program's own paragraph where the agent wrote none. */
export const agentContext = (blocks: readonly ShownBlock[], origin: QuestionOrigin): QuestionContextText =>
  blocksText(blocks).join("").trim() === "" ? programContext(origin) : { blocks, by: "agent" };
/**
 * What a decision's analysis is asked about, as the user was shown it (S10): the question's words, or for a reply to
 * Claude Code's message in the clarification the message itself, which is that question's context and what its numbered
 * answers answer.
 */
export const decisionQuestionOf = (draft: QuestionDraft): string => (draft.origin.kind === "reply" ? blocksMarkdown(draft.context.blocks) : piecesText(draft.question));
/**
 * The question as the user is shown it, with its number in the run; its explanations' senses built by sensesOf (issue
 * #112), which fails only for an explanation that bypassed every validation: the program's error, typed.
 */
export const presentedQuestion = (draft: QuestionDraft, number: number): Result.Result<PresentedQuestion, QuestionInvalid> =>
  Result.map(shownExplanations(draft.explanations), (explanations) => ({
    number,
    origin: draft.origin,
    context: draft.context,
    explanations,
    question: draft.question,
    options: draft.options.map((o) => ({ label: o.shown.label, description: o.shown.description, answer: o.answer })),
    details: draft.details ?? [],
    decision: draft.decision,
  }));

/**
 * Options chosen by their number or their exact label: the interview, a relayed question, a pause, a plan writer's
 * question. An option given as pieces is chosen by its words; one given as text is shown as plain pieces.
 */
export const numberedOptions = (options: readonly (Readonly<{ label: string; description: string }> | PieceOption)[]): readonly OfferedOption[] =>
  options.map((o, i) => {
    const shown = typeof o.label === "string" ? plainOption(o.label, o.description as string) : (o as PieceOption);
    const label = piecesText(shown.label);
    return { label, description: piecesText(shown.description), shown, answer: { token: String(i + 1) }, matches: (answer: string) => chooseOption(answer, options.length) === i || answer.trim() === label };
  });
/** An option of the program's own words: shown as it is. */
const own = (label: string, description: string, answer: OptionAnswer, matches: (answer: string) => boolean): OfferedOption => ({ label, description, shown: plainOption(label, description), answer, matches });
/** A permission request: y allows, and anything else denies (the prompt's own rule); n is the answer shown for the denial. */
export const permissionOptions: readonly OfferedOption[] = [
  own(prompts.PERMISSION_ALLOW, prompts.PERMISSION_ALLOW_DESCRIPTION, { token: "y" }, (answer) => answer.trim().toLowerCase() === "y"),
  own(prompts.PERMISSION_DENY, prompts.PERMISSION_DENY_DESCRIPTION, { token: "n" }, (answer) => answer.trim().toLowerCase() !== "y"),
];
/**
 * A permission request as the user is asked it (S34, S49): the tool's input under plain labels in the details, a field
 * without a label explained as a term, the question naming the action, and the facts a context call is given.
 */
export const permissionDraft = (tool: string, input: unknown): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "permission", tool, input: prompts.toolInputProse(input) };
  return {
    origin,
    context: programContext(origin),
    explanations: prompts.toolInputExplanations(input),
    question: plainPieces(prompts.permissionQuestion(tool, input)),
    options: permissionOptions,
    details: prompts.toolInputBlocks(input),
    explain: prompts.permissionFacts(tool, input),
    decision: null,
  };
};
/** The pause of issue #30: Retry, Proceed and Stop, each chosen by the answers parseUnchangedAnswer reads as it. */
export const unchangedOptions = (interview: boolean): readonly OfferedOption[] => {
  const d = prompts.unchangedOptionDescriptions(interview);
  return [
    own(prompts.UNCHANGED_RETRY, d.retry, { token: prompts.UNCHANGED_ANSWERS.retry }, (answer: string) => parseUnchangedAnswer(answer) === "retry"),
    own(prompts.UNCHANGED_PROCEED, d.proceed, { token: prompts.UNCHANGED_ANSWERS.proceed }, (answer: string) => parseUnchangedAnswer(answer) === "proceed"),
    own(prompts.UNCHANGED_STOP, d.stop, { token: prompts.UNCHANGED_ANSWERS.stop }, (answer: string) => parseUnchangedAnswer(answer) === "stop"),
  ];
};
/** The pause of issue #26: Retry again and Stop, each chosen by the answers parseTransportAnswer reads as it. */
export const transportOptions = (): readonly OfferedOption[] => {
  const d = prompts.transportOptionDescriptions();
  return [
    own(prompts.TRANSPORT_RETRY_AGAIN, d.retry, { token: prompts.TRANSPORT_ANSWERS.retry }, (answer: string) => parseTransportAnswer(answer) === "retry"),
    own(prompts.TRANSPORT_STOP, d.stop, { token: prompts.TRANSPORT_ANSWERS.stop }, (answer: string) => parseTransportAnswer(answer) === "stop"),
  ];
};
/**
 * The cycle limit (decision Q6): p proceeds where offered, a number adds cycles, and every other answer stops the run
 * (the review loop halts on it), so "2" is never read as the second option.
 */
export const limitOptions = (proceed: string | null): readonly OfferedOption[] => {
  const d = prompts.limitOptionDescriptions(proceed);
  const proceeds = (answer: string) => proceed !== null && answer.trim() === prompts.LIMIT_ANSWERS.proceed;
  const more = (answer: string) => parseExtraRounds(answer) !== null;
  return [
    ...(proceed === null ? [] : [own(prompts.LIMIT_PROCEED, d.proceed, { token: prompts.LIMIT_ANSWERS.proceed }, proceeds)]),
    own(prompts.LIMIT_STOP, d.stop, { token: prompts.LIMIT_ANSWERS.stop }, (answer: string) => limitStops(answer, proceed !== null)),
    own(prompts.LIMIT_MORE, d.more, { numeric: true }, more),
  ];
};

/**
 * A draft with what a context call wrote (S9; decision G-R1-1): its paragraph and explanations, and the question, the
 * options and the details as it rephrased them; each option keeps its answer, paired by position (S10). Where the call
 * could not succeed, the program's paragraph and its own question stand.
 */
export const withContext = (draft: QuestionDraft, written: ContextWritten): QuestionDraft => ({
  ...draft,
  context: written.context,
  explanations: written.explanations,
  question: written.question ?? draft.question,
  options: written.options === undefined ? draft.options : draft.options.map((o, i) => ({ ...o, shown: written.options?.[i] ?? o.shown })),
  details: written.details ?? draft.details,
});
/** Details the program gave a context call: blocks of its own words; a document is Markdown shown whole, never divided. */
const requestDetails = (details: readonly ShownBlock[]): readonly Block[] => details.flatMap((b): readonly Block[] => (b.kind === "document" ? plainBlocks(b.markdown) : [b]));
/** What a context call writes for a question the program composed (S9), before it is presented. */
const explain = (draft: QuestionDraft, facts: string) =>
  Effect.gen(function* () {
    const decider = yield* Decider;
    const options = draft.options.map((o) => o.shown);
    return yield* decider.explain({ origin: draft.origin, decision: draft.decision, question: draft.question, options, details: requestDetails(draft.details ?? []), explanations: draft.explanations, facts });
  });

/**
 * Asks a question (S7), the one way a question reaches the user: it takes the question's number in the run, presents
 * the question (the page's event) and records it in conversation.md, then asks with the
 * kind's input hint. With two or more options the hint carries the offer of decision support (D2): "/decide" runs a
 * decision loop, shows its analysis, presents the question again and asks again. Any other answer is returned as
 * typed; after an analysis it is recorded as the choice of every decision made for this question (decision Q4), with
 * the option it chose. An answer that `acceptable` rejects (a blank reply where one is required) is neither returned
 * nor recorded: the question is presented again and asked again (W1-R1-1, W1-R1-2), with or without options.
 */
export const askOffering = <E>(
  ask: (prompt: string) => Effect.Effect<string, E>,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean = () => true,
): Effect.Effect<string, E | RunError, Decider | Store | Ui> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const explained = draft.explain === undefined ? draft : withContext(draft, yield* explain(draft, draft.explain));
    const question = yield* Effect.fromResult(presentedQuestion(explained, yield* ui.nextQuestion));
    const present = ui.notify({ _tag: "QuestionPresented", question });
    yield* present;
    yield* store.converse(renderQuestionRecord(question));
    // The page keeps a decision's analysis for the question asked again (W3-R1-1).
    const rejected = ui.notify({ _tag: "AnswerRejected" }).pipe(Effect.andThen(present));
    if (draft.options.length < 2) {
      for (;;) {
        const answer = yield* ask(hint);
        if (acceptable(answer)) return answer;
        yield* rejected;
      }
    }
    const decider = yield* Decider;
    // S10: the analysis is of the question as the user was shown it, its options' words as displayed, paired by position.
    const options = explained.options.map((o) => ({ label: piecesText(o.shown.label), description: piecesText(o.shown.description) }));
    const decisions: number[] = [];
    for (;;) {
      const answer = yield* ask(prompts.withOffer(hint));
      if (isDecide(answer)) {
        const asked = decisionQuestionOf(explained);
        // S37, S10: the analysis is given the question as the user was shown it, after the context call.
        const shown = { context: blocksMarkdown(explained.context.blocks), terms: question.explanations.map((e) => termItem(e, "")).join("\n"), details: blocksMarkdown(explained.details ?? []) };
        const outcome = yield* decider.decide({ question: asked, options, number: question.number, shown });
        decisions.push(outcome.decision);
        yield* ui.notify({ _tag: "DecisionAnalyzed", decision: outcome.decision, question: asked, presented: question, options, analysis: outcome.analysis });
        yield* present;
        continue;
      }
      if (!acceptable(answer)) {
        yield* rejected;
        continue;
      }
      const option = explained.options.find((o) => o.matches(answer))?.label ?? null;
      for (const k of decisions) {
        yield* store.saveChoice(k, { answer, option });
        yield* store.converse(renderChoice(k, answer, option));
      }
      return answer;
    }
  });
