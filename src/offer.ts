// The offer of decision support ("Help me decide", D2 of the decision-support plan): a question with two or more options
// carries it, whatever interface asks. Separate from src/decision.ts, which runs the loop, so that the places that ask
// (src/review.ts, src/conversation.ts, src/claude.ts) do not import the loop (no import cycle).

import { Effect, Fiber, Ref } from "effect";
import type { RunError } from "./errors.ts";
import { answerOf, chooseOption, isDecide, isTermsRequest, limitStops, parseExtraRounds, parseTransportAnswer, parseUnchangedAnswer } from "./input.ts";
import * as prompts from "./prompts.ts";
import { type Block, blocksMarkdown, blocksText, type Explanation, type Piece, type PieceOption, piecesText, plainBlocks, plainOption, plainPieces, type ShownBlock } from "./pieces.ts";
import { type Attached, attachedOf, type ContextWritten, type OptionAnswer, type PresentedQuestion, type QuestionContextText, type QuestionOrigin, shownExplanations } from "./question.ts";
import { Result } from "effect";
import type { QuestionInvalid } from "./errors.ts";
import { attachedMarkdown, renderChoice, renderDecisionAbandoned, renderQuestionRecord, termItem } from "./render.ts";
import { type AskKind, Decider, Store, Ui, type UiShape } from "./services.ts";

// ---- the offer (D2) ------------------------------------------------------------------------------------

/**
 * An option of a question, with the answer the user gives to choose it (S8: its exact text, or any number he types) and
 * the answers that choose it (P1-R1-4). Each `answer` is one that `matches` accepts, which test/offer.test.ts asserts.
 * `label` and `description` are the option's own words, by which it is chosen and recorded; `shown` is the option as the
 * user reads it, as pieces (issue #36), which a context call may rephrase (S10: the pairing is by position).
 */
export type OfferedOption = Readonly<{
  label: string;
  description: string;
  shown: PieceOption;
  answer: OptionAnswer;
  matches: (answer: string) => boolean;
  /**
   * Issue #159: the option is also chosen by the label it is shown with, a label a context call wrote included
   * (`withContext`). Opt-in, since other options are chosen by a token that is not their label (a permission's y).
   */
  matchesShown?: true;
}>;
/** A question before it is numbered (S7): everything the user is shown of it but its number. */
export type QuestionDraft = Readonly<{
  origin: QuestionOrigin;
  context: QuestionContextText;
  /** What happened before that led to the question (issue #133); empty when there is none. */
  history: readonly ShownBlock[];
  explanations: readonly Explanation[];
  question: readonly Piece[];
  options: readonly OfferedOption[];
  attached?: Attached | null;
  /**
   * A question the program composed asks a context call for its context and terms (S9, decision Q1): the facts of the
   * case in prose beside its attached material. Absent: the draft's own context stands.
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
    history: draft.history,
    explanations,
    question: draft.question,
    options: draft.options.map((o) => ({ label: o.shown.label, description: o.shown.description, answer: o.answer })),
    attached: draft.attached ?? null,
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
/**
 * The two positions of a disputed pause (issue #159): each keeps its record label (`REVIEWER_POSITION`,
 * `PLANNER_POSITION`), by which it is chosen and recorded, and is shown with the outcome label of `positionLabels`,
 * matched by its record label, not its position. It is chosen by its number, its record label or its shown label.
 */
export const positionOptions = (pause: prompts.DisputedPauseKind, options: readonly Readonly<{ label: string; description: string }>[]): readonly OfferedOption[] => {
  const outcomes = prompts.positionLabels(pause);
  const outcomeOf = (label: string): string => (label === prompts.REVIEWER_POSITION ? outcomes.reviewer : label === prompts.PLANNER_POSITION ? outcomes.planner : label);
  return options.map((o, i) => {
    const outcome = outcomeOf(o.label);
    return {
      label: o.label,
      description: o.description,
      shown: plainOption(outcome, o.description),
      answer: { token: String(i + 1) },
      matches: (answer: string) => chooseOption(answer, options.length) === i || answer.trim() === o.label || answer.trim() === outcome,
      matchesShown: true,
    };
  });
};
/**
 * The text an answer to a decision stands for (issue #159): an option's number gives "label: description" (`answerOf`);
 * an answer another option matches gives that option's record label, so a label the user was shown stands for its
 * position; any other answer is itself.
 */
export const decisionAnswerOf = (answer: string, options: readonly OfferedOption[]): string =>
  chooseOption(answer, options.length) !== null ? answerOf(answer, options) : (options.find((o) => o.matches(answer))?.label ?? answer);
/** An option of the program's own words: shown as it is. */
const own = (label: string, description: string, answer: OptionAnswer, matches: (answer: string) => boolean): OfferedOption => ({ label, description, shown: plainOption(label, description), answer, matches });
/** A permission request: y allows, and anything else denies (the prompt's own rule); n is the answer shown for the denial. */
export const permissionOptions: readonly OfferedOption[] = [
  own(prompts.PERMISSION_ALLOW, prompts.PERMISSION_ALLOW_DESCRIPTION, { token: "y" }, (answer) => answer.trim().toLowerCase() === "y"),
  own(prompts.PERMISSION_DENY, prompts.PERMISSION_DENY_DESCRIPTION, { token: "n" }, (answer) => answer.trim().toLowerCase() !== "y"),
];
/**
 * A permission request as the user is asked it (S34, S49): the tool's input under plain labels as its attached material, a field
 * without a label explained as a term, the question naming the action, and the facts a context call is given.
 */
export const permissionDraft = (tool: string, input: unknown): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "permission", tool, input: prompts.toolInputProse(input) };
  return {
    origin,
    context: programContext(origin),
    history: [],
    explanations: prompts.toolInputExplanations(input),
    question: plainPieces(prompts.permissionQuestion(tool, input)),
    options: permissionOptions,
    attached: attachedOf("request", prompts.toolInputBlocks(input)),
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
/** Issue #171: the tracker's exhaustion question, with the transport pause's labels and answers and the tracker's descriptions. */
export const trackerOptions = (): readonly OfferedOption[] => {
  const d = prompts.trackerOptionDescriptions();
  return [
    own(prompts.TRANSPORT_RETRY_AGAIN, d.retry, { token: prompts.TRANSPORT_ANSWERS.retry }, (answer: string) => parseTransportAnswer(answer) === "retry"),
    own(prompts.TRANSPORT_STOP, d.stop, { token: prompts.TRANSPORT_ANSWERS.stop }, (answer: string) => parseTransportAnswer(answer) === "stop"),
  ];
};
/** Issue #181: the question after the final suite was stopped outside the work again, with the transport pause's answers. */
export const suiteStoppedOptions = (): readonly OfferedOption[] => {
  const d = prompts.suiteStoppedOptionDescriptions();
  return [
    own(prompts.SUITE_RUN_AGAIN, d.retry, { token: prompts.TRANSPORT_ANSWERS.retry }, (answer: string) => parseTransportAnswer(answer) === "retry"),
    own(prompts.SUITE_STOP, d.stop, { token: prompts.TRANSPORT_ANSWERS.stop }, (answer: string) => parseTransportAnswer(answer) === "stop"),
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
 * could not succeed, the draft's own context, marked as the program's, and its own question stand (issue #156, W1-R1-1).
 */
export const withContext = (draft: QuestionDraft, written: ContextWritten): QuestionDraft => ({
  ...draft,
  context: written.context,
  history: written.history,
  explanations: written.explanations,
  question: written.question ?? draft.question,
  options: written.options === undefined ? draft.options : draft.options.map((o, i) => rephrased(o, written.options?.[i])),
  attached: draft.attached == null ? null : attachedOf(draft.attached.kind, written.details ?? draft.attached.blocks),
});
/** An option as a context call rephrased it: shown with its words, and, where it `matchesShown`, chosen by them too (issue #159). */
const rephrased = (o: OfferedOption, shown: PieceOption | undefined): OfferedOption => {
  if (shown === undefined) return o;
  const label = piecesText(shown.label);
  return o.matchesShown === true ? { ...o, shown, matches: (a: string) => o.matches(a) || a.trim() === label } : { ...o, shown };
};
/** Details the program gave a context call: blocks of its own words; a document is Markdown shown whole, never divided. */
const requestDetails = (details: readonly ShownBlock[]): readonly Block[] => details.flatMap((b): readonly Block[] => (b.kind === "document" ? plainBlocks(b.markdown) : [b]));
/** What a context call writes for a question the program composed (S9), before it is presented. */
const explain = (draft: QuestionDraft, facts: string) =>
  Effect.gen(function* () {
    const decider = yield* Decider;
    const options = draft.options.map((o) => o.shown);
    return yield* decider.explain({ origin: draft.origin, decision: draft.decision, question: draft.question, options, details: requestDetails(draft.attached?.blocks ?? []), explanations: draft.explanations, facts, fallback: requestDetails(draft.context.blocks), history: requestDetails(draft.history) });
  });

/**
 * Asks a question with no offer of decision support (issue #171, the developer's decision of 15 Oct 2026): the run's
 * first read of its item, before its records directory, Store and Decider exist. Like `askOffering` it numbers the
 * question, presents it and records it, through `record`, which the caller holds until conversation.md exists; it asks
 * `hint` through the caller's `ask`, never with the offer line, and an answer `acceptable` rejects is followed by
 * AnswerRejected and the question presented and asked again. It has no request for terms, since a question the program
 * composes carries no explanations to request.
 */
export const askUnoffered = <E>(
  ask: (prompt: string) => Effect.Effect<string, E>,
  ui: UiShape,
  record: (text: string) => Effect.Effect<void>,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean,
): Effect.Effect<string, E | QuestionInvalid> =>
  Effect.gen(function* () {
    const question = yield* Effect.fromResult(presentedQuestion(draft, yield* ui.nextQuestion));
    const present = ui.notify({ _tag: "QuestionPresented", question });
    yield* present;
    yield* record(renderQuestionRecord(question));
    const asked: Effect.Effect<string, E> = Effect.flatMap(ask(hint), (answer) =>
      acceptable(answer) ? Effect.succeed(answer) : ui.notify({ _tag: "AnswerRejected" }).pipe(Effect.andThen(present), Effect.andThen(Effect.suspend(() => asked))),
    );
    return yield* asked;
  });

/**
 * Issue #153: how a caller asks: its own `ask` (with its expiry and its parsing) and the kind of answer it reads, with
 * which a question open beside its decision is read the same way.
 */
export type Asking<E> = Readonly<{ kind: AskKind; ask: (prompt: string) => Effect.Effect<string, E> }>;
/** A one-line prompt ("q" ends the run). */
export const byLine = <E>(ask: (prompt: string) => Effect.Effect<string, E>): Asking<E> => ({ kind: "line", ask });
/** An interview message ("/quit" ends the run). */
export const byMessage = <E>(ask: (prompt: string) => Effect.Effect<string, E>): Asking<E> => ({ kind: "message", ask });

/**
 * Asks a question (S7), the one way a question reaches the user: it takes the question's number in the run, presents
 * the question (the page's event) and records it in conversation.md, then asks with the
 * kind's input hint. With two or more options the hint carries the offer of decision support (D2): "/decide" runs a
 * decision loop, shows its analysis, presents the question again and asks again, without the offer (issue #133). Any other answer is returned as
 * typed; after an analysis it is recorded as the choice of every decision made for this question (decision Q4), with
 * the option it chose. An answer that `acceptable` rejects (a blank reply where one is required) is neither returned
 * nor recorded: the question is presented again and asked again (W1-R1-1, W1-R1-2), with or without options.
 * Issue #142: `terms`, where given, is the request for the question's explanations, given the question's number, which
 * yields the same draft with them. While it has not run, the hint carries its line outermost; "/terms" runs it, presents the same question again
 * under the same number with its explanations (QuestionExplained, then QuestionPresented), and asks again without the
 * line. "/terms" is never returned or recorded as a choice; without a request it is an answer like any other.
 * Issue #153 (requirements Q1, G-R1-1): the asking enters its question's frame (`UiShape.enterQuestion`) before it
 * presents the question, and "/decide" forks the decision and keeps the question open beside it, with neither the offer
 * nor the terms line. An answer the question accepts given then abandons the decision: the loop is interrupted, and
 * where it had allocated decision k the answer is recorded as k's choice, with the abandoned line, and returned. A
 * "/decide", a "/terms" or an answer `acceptable` rejects is rejected and the question stays open. Abandoning an outer
 * decision abandons every decision nested in it, and none is open then: a question asked inside a decision blocks the
 * question beneath it for its whole asking (S2), so each nested decision has recorded its choice before the outer
 * question can be answered.
 */
export const askOffering = <E, R = never>(
  asking: Asking<E>,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean = () => true,
  terms: ((question: number) => Effect.Effect<QuestionDraft, E | RunError, R>) | null = null,
  resolve: ((answer: string, options: readonly OfferedOption[]) => string) | null = null,
): Effect.Effect<string, E | RunError, Decider | Store | Ui | R> =>
  Effect.scoped(Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    // The question as it is shown: replaced, under its number, when its explanations arrive on request (issue #142).
    let explained = draft.explain === undefined ? draft : withContext(draft, yield* explain(draft, draft.explain));
    let question = yield* Effect.fromResult(presentedQuestion(explained, yield* ui.nextQuestion));
    let request = terms;
    // Issue #153: this asking's frame, entered before the question is presented, so that a question being prepared
    // beneath it (this question asked inside its decision) is neither shown nor answerable until this asking returns.
    const frame = yield* ui.enterQuestion(question.number);
    const present = Effect.suspend(() => ui.notify({ _tag: "QuestionPresented", question }));
    yield* present;
    yield* store.converse(renderQuestionRecord(question));
    // The page keeps a decision's analysis for the question asked again (W3-R1-1).
    const rejected = ui.notify({ _tag: "AnswerRejected" }).pipe(Effect.andThen(present));
    const askOffered = (prompt: string) => asking.ask(request === null ? prompt : prompts.withTermsOffer(prompt));
    /** Whether the answer asked for the terms, which then are written and presented: the question is asked again. */
    const requested = (answer: string) =>
      Effect.gen(function* () {
        if (request === null || !isTermsRequest(answer)) return false;
        const run = request;
        request = null;
        explained = yield* run(question.number);
        question = yield* Effect.fromResult(presentedQuestion(explained, question.number));
        yield* ui.notify({ _tag: "QuestionExplained", question });
        yield* present;
        return true;
      });
    if (draft.options.length < 2) {
      for (;;) {
        const answer = yield* askOffered(hint);
        if (yield* requested(answer)) continue;
        if (acceptable(answer)) return answer;
        yield* rejected;
      }
    }
    const decider = yield* Decider;
    // S10: the analysis is of the question as the user was shown it, its options' words as displayed, paired by position.
    const optionsShown = () => explained.options.map((o) => ({ label: piecesText(o.shown.label), description: piecesText(o.shown.description) }));
    const decisions: number[] = [];
    for (;;) {
      // Issue #133 (S6): the offer stands until a decision is made; the question asked beside its own analysis carries
      // none, and "/decide" there is an answer like any other.
      const offered = decisions.length === 0;
      const answer = yield* askOffered(offered ? prompts.withOffer(hint) : hint);
      if (yield* requested(answer)) continue;
      if (offered && isDecide(answer)) {
        const options = optionsShown();
        const asked = decisionQuestionOf(explained);
        // S37, S10: the analysis is given the question as the user was shown it, after the context call.
        const shown = { context: blocksMarkdown(explained.context.blocks), history: blocksMarkdown(explained.history), terms: question.explanations.map((e) => termItem(e, "")).join("\n"), details: attachedMarkdown(explained.attached ?? null) };
        // Issue #153 (Q1): the decision runs beside the question, which stays open, without the offer or the terms line.
        const opened = yield* Ref.make<number | null>(null);
        const fiber = yield* Effect.forkScoped(decider.decide({ question: asked, options, number: question.number, shown, opened: (k) => Ref.set(opened, k) }));
        let during = yield* frame.askDuring(hint, asking.kind, Fiber.join(fiber));
        while (during._tag === "Answered" && (isDecide(during.text) || isTermsRequest(during.text) || !acceptable(during.text))) {
          yield* rejected;
          during = yield* frame.askDuring(hint, asking.kind, Fiber.join(fiber));
        }
        if (during._tag === "Answered") {
          const answer = during.text;
          // The loop is interrupted first, so it writes nothing after the record.
          yield* Fiber.interrupt(fiber);
          const k = yield* Ref.get(opened);
          if (k !== null) {
            const option = explained.options.find((o) => o.matches(answer))?.label ?? null;
            yield* store.saveChoice(k, { answer, option });
            yield* store.converse(renderDecisionAbandoned(k));
            yield* store.converse(renderChoice(k, answer, option));
            yield* ui.say(prompts.decisionAbandonedLine(k));
          }
          return resolve === null ? answer : resolve(answer, explained.options);
        }
        const outcome = during.value;
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
      return resolve === null ? answer : resolve(answer, explained.options);
    }
  }));
