// The offer of decision support ("Help me decide", D2 of the decision-support plan): a question with two or more options
// carries it, whatever interface asks. Separate from src/decision.ts, which runs the loop, so that the places that ask
// (src/review.ts, src/conversation.ts, src/claude.ts) do not import the loop (no import cycle).

import { Deferred, Effect, Fiber, Option, Ref, type Scope } from "effect";
import { type RunError, UserStopped } from "./errors.ts";

import { answerOf, chooseOption, isDecide, isTermsRequest, parseAskLine, limitStops, parseExtraRounds, parseTransportAnswer, parseUnchangedAnswer } from "./input.ts";
import * as prompts from "./prompts.ts";
import { type Block, blocksMarkdown, blocksText, type Explanation, type Piece, type PieceOption, piecesText, plainBlocks, plainOption, plainPieces, type ShownBlock } from "./pieces.ts";
import { type Attached, attachedOf, type ContextWritten, type OptionAnswer, type PresentedQuestion, type QuestionContextText, type QuestionOrigin, optionFigures, presentFigures, shownExplanations } from "./question.ts";
import { Result } from "effect";
import { QuestionInvalid } from "./errors.ts";
import type { Figure } from "./figure.ts";
import { attachedMarkdown, renderChoice, renderDecisionAbandoned, renderQuestionRecord, termItem } from "./render.ts";
import { type AskKind, Decider, OpenQuestions, Store, Ui, type UiShape } from "./services.ts";


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
  Result.flatMap(shownExplanations(draft.explanations), (explanations) =>
    Result.map(shownFigures(draft.options), (figures) => ({
      number,
      origin: draft.origin,
      context: draft.context,
      history: draft.history,
      explanations,
      question: draft.question,
      options: draft.options.map((o, i) => ({ label: o.shown.label, description: o.shown.description, figure: figures[i] ?? null, answer: o.answer })),
      attached: draft.attached ?? null,
      decision: draft.decision,
    })),
  );
/** The options' pictures as the user is shown them (issue #98), by position. */
const shownFigures = (options: readonly OfferedOption[]): Result.Result<readonly (Figure | null)[], QuestionInvalid> =>
  optionFigures(options.map((o) => o.shown), "the question shown");
/**
 * Issue #98: writes the pictures of the given options to their files before a record links them (Store.saveFigures);
 * `where` names the question should a picture that bypassed every validation fail figureOf.
 */
export const saveOptionFigures = (options: readonly Pick<PieceOption, "figure">[], where: string): Effect.Effect<void, RunError, Store> =>
  Effect.gen(function* () {
    const figures = yield* Effect.fromResult(optionFigures(options, where));
    yield* (yield* Store).saveFigures(presentFigures(figures));
  });

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
export const positionOptions = (pause: prompts.DisputedPauseKind, options: readonly Readonly<{ label: string; description: string }>[], pass: prompts.PassNoun): readonly OfferedOption[] => {
  const outcomes = prompts.positionLabels(pause, pass);
  const outcomeOf = (label: string): string =>
    label === prompts.REVIEWER_POSITION ? outcomes.reviewer : label === prompts.PLANNER_POSITION ? outcomes.planner : label === prompts.RESOLUTION_POSITION ? outcomes.resolution : label;
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
export const unchangedOptions = (interview: boolean, pass: prompts.PassNoun): readonly OfferedOption[] => {
  const d = prompts.unchangedOptionDescriptions(interview, pass);
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
  // Issue #98: the picture is the draft's, whatever the call returned (KEEP_FIGURES, which its validation enforces).
  const kept = { ...shown, figure: o.shown.figure };
  return o.matchesShown === true ? { ...o, shown: kept, matches: (a: string) => o.matches(a) || a.trim() === label } : { ...o, shown: kept };
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

/** Numbers, presents and records a question with no context call and no offer (askUnoffered, openBesideUnoffered). */
const presentUnoffered = <E2>(ui: UiShape, record: (text: string) => Effect.Effect<void, E2>, draft: QuestionDraft) =>
  Effect.gen(function* () {
    const question = yield* Effect.fromResult(presentedQuestion(draft, yield* ui.nextQuestion));
    const present = ui.notify({ _tag: "QuestionPresented", question });
    yield* present;
    yield* record(renderQuestionRecord(question));
    return { question, present };
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
    const { present } = yield* presentUnoffered(ui, record, draft);
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
 * Issue #217: the request is forked beside the open question as a decision is (below), the question asked without the
 * offer or the terms line; an answer the question accepts given then interrupts it, is said to have stopped it
 * (`termsAbandonedLine`, on the page alone) and is the answer, recorded as any answer is; a "/decide", a "/terms" or an
 * answer `acceptable` rejects is rejected and the question stays open.
 * Issue #153 (requirements Q1, G-R1-1): the asking enters its question's frame (`UiShape.enterQuestion`) before it
 * presents the question, and "/decide" forks the decision and keeps the question open beside it, with neither the offer
 * nor the terms line. An answer the question accepts given then abandons the decision: the loop is interrupted, and
 * where it had allocated decision k the answer is recorded as k's choice, with the abandoned line, and returned. A
 * "/decide", a "/terms" or an answer `acceptable` rejects is rejected and the question stays open. Abandoning an outer
 * decision abandons every decision nested in it, and none is open then: a question asked inside a decision blocks the
 * question beneath it for its whole asking (S2), so each nested decision has recorded its choice before the outer
 * question can be answered.
 */
/**
 * Issue #243: where a question is asked: in the foreground, the asker waiting for its answer (as before), or beside the
 * running run (`openBeside`). Beside: `presented` is succeeded with the question's number once it is presented and
 * recorded; every ask goes through the frame's `askBeside`, and every answer the Ui takes, at the question or while a
 * decision is prepared beside it, is handed to `onTaken` with the options as shown, inside the Ui's take; `offer` says
 * whether the hint carries Help me decide (without it "/decide" is rejected); `stored` is the raw answer `onTaken`
 * accepted, from which the asking's finalizer writes the records of a decision abandoned by an answer the producer did not
 * resume to record.
 */
export type Place =
  | Readonly<{ _tag: "Foreground" }>
  | Readonly<{
      _tag: "Beside";
      offer: boolean;
      presented: Deferred.Deferred<number>;
      onTaken: (raw: string, options: readonly OfferedOption[]) => Effect.Effect<void>;
      stored: Effect.Effect<Option.Option<string>>;
    }>;
const FOREGROUND: Place = { _tag: "Foreground" };

/**
 * Issue #243 (Q1): the disputes of each decision withdrawn, each said and written; an answer the Ui took before the
 * withdrawal is recorded in user-decisions.md with the note that it was not applied. Failures of the records are ignored,
 * since this runs as a finalizer, whose failure would mask the asking's exit.
 */
const withdrawDecisionDisputes = (decisions: readonly number[]): Effect.Effect<void, never, Ui | Store> =>
  Effect.gen(function* () {
    const open = yield* Effect.serviceOption(OpenQuestions);
    if (Option.isNone(open) || decisions.length === 0) return;
    const ui = yield* Ui;
    const store = yield* Store;
    for (const k of decisions) {
      const { withdrawn, answered } = yield* open.value.withdrawOwned({ _tag: "Decision", decision: k });
      for (const d of withdrawn) {
        const line = prompts.disputeWithdrawnByDecisionLine(k, d.heading);
        yield* ui.say(line);
        yield* store.converse(`${line}\n\n`).pipe(Effect.ignore);
      }
      for (const a of answered)
        yield* store.appendDecision({ subject: a.dispute.recordSubject, id: a.dispute.id, decision: `${a.text} ${prompts.DISPUTE_NOT_APPLIED_NOTE}`, phase: a.dispute.phase, round: a.dispute.round }).pipe(Effect.ignore);
    }
  });

/** Issue #217: what an answer did about the question's terms: nothing, the terms written, or an answer given while they were. */
type TermsAsked = Readonly<{ _tag: "NotAsked" }> | Readonly<{ _tag: "Explained" }> | Readonly<{ _tag: "Answered"; text: string }>;

export const askOffering = <E, R = never>(
  asking: Asking<E>,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean = () => true,
  terms: ((question: number) => Effect.Effect<QuestionDraft, E | RunError, R>) | null = null,
  resolve: ((answer: string, options: readonly OfferedOption[]) => string) | null = null,
  place: Place = FOREGROUND,
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
    const beside = place._tag === "Beside" ? place : null;
    // Issue #243: a decision being prepared beside a question open beside the run; where an answer the Ui took abandons it
    // and the producer is interrupted before it resumes to record that, this finalizer writes the abandoned records.
    // Likewise an answer given after a decision was made, its choice not yet recorded (`recorded`).
    const inFlight = yield* Ref.make<Option.Option<Ref.Ref<number | null>>>(Option.none());
    const recorded = yield* Ref.make(false);
    const decisions: number[] = [];
    // Issue #243 (Q1): every decision this asking opened; their disputes are withdrawn when the asking ends, however it ends.
    const openedDecisions = yield* Ref.make<readonly number[]>([]);
    yield* Effect.addFinalizer(() => Effect.flatMap(Ref.get(openedDecisions), withdrawDecisionDisputes));
    if (beside !== null)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const raw = yield* beside.stored;
          if ((yield* Ref.get(recorded)) || Option.isNone(raw)) return;
          const flight = yield* Ref.get(inFlight);
          if (Option.isSome(flight)) {
            const k = yield* Ref.get(flight.value);
            if (k !== null) yield* recordAbandoned(k, raw.value);
          } else yield* recordChoices(raw.value);
        }).pipe(Effect.ignore),
      );
    const present = Effect.suspend(() => ui.notify({ _tag: "QuestionPresented", question }));
    yield* present;
    yield* store.saveFigures(presentFigures(question.options.map((o) => o.figure)));
    yield* store.converse(renderQuestionRecord(question));
    if (beside !== null) yield* Deferred.succeed(beside.presented, question.number);
    const takenBy = (raw: string) => (beside === null ? Effect.void : beside.onTaken(raw, explained.options));
    /** Issue #153: the records of decision k abandoned by `answer`. */
    const recordAbandoned = (k: number, answer: string) =>
      Effect.gen(function* () {
        const option = explained.options.find((o) => o.matches(answer))?.label ?? null;
        yield* store.saveChoice(k, { answer, option });
        yield* store.converse(renderDecisionAbandoned(k));
        yield* store.converse(renderChoice(k, answer, option));
        yield* ui.say(prompts.decisionAbandonedLine(k));
      });
    /** The answer recorded as the choice of every decision made for this question (decision Q4). */
    const recordChoices = (answer: string) =>
      Effect.gen(function* () {
        const option = explained.options.find((o) => o.matches(answer))?.label ?? null;
        for (const k of decisions) {
          yield* store.saveChoice(k, { answer, option });
          yield* store.converse(renderChoice(k, answer, option));
        }
      });
    // The page keeps a decision's analysis for the question asked again (W3-R1-1).
    const rejected = ui.notify({ _tag: "AnswerRejected" }).pipe(Effect.andThen(present));
    const askOffered = (prompt: string): Effect.Effect<string, E | UserStopped> => {
      const shown = request === null ? prompt : prompts.withTermsOffer(prompt);
      return beside === null ? asking.ask(shown) : frame.askBeside(shown, asking.kind, takenBy);
    };
    /**
     * Issue #153: asks the question beside `fiber`'s work, its prompt the bare hint (no offer, no terms line); a
     * "/decide", a "/terms" or an answer `acceptable` rejects is rejected and asked again, so what it returns is the
     * work's end or an answer the question accepts.
     */
    const besideWork = <A, E2>(fiber: Fiber.Fiber<A, E2>) =>
      Effect.gen(function* () {
        const onTaken = beside === null ? undefined : takenBy;
        let during = yield* frame.askDuring(hint, asking.kind, Fiber.join(fiber), onTaken);
        while (during._tag === "Answered" && (isDecide(during.text) || isTermsRequest(during.text) || !acceptable(during.text))) {
          yield* rejected;
          during = yield* frame.askDuring(hint, asking.kind, Fiber.join(fiber), onTaken);
        }
        return during;
      });
    /**
     * Whether the answer asked for the terms. Issue #217: the request runs beside the question, which stays open; when
     * it ends the question is presented again with its explanations and asked again (`Explained`), and an answer the
     * question accepts given before then interrupts it and is the answer (`Answered`).
     */
    const requested = (answer: string) =>
      Effect.gen(function* () {
        if (request === null || !isTermsRequest(answer)) return { _tag: "NotAsked" } as TermsAsked;
        const run = request;
        request = null;
        const fiber = yield* Effect.forkScoped(run(question.number));
        const during = yield* besideWork(fiber);
        if (during._tag === "Answered") {
          // The request is interrupted first, so it writes nothing after the answer.
          yield* Fiber.interrupt(fiber);
          yield* ui.say(prompts.termsAbandonedLine(question.number));
          return { _tag: "Answered", text: during.text } as TermsAsked;
        }
        explained = during.value;
        question = yield* Effect.fromResult(presentedQuestion(explained, question.number));
        yield* ui.notify({ _tag: "QuestionExplained", question });
        yield* present;
        return { _tag: "Explained" } as TermsAsked;
      });
    if (draft.options.length < 2) {
      for (;;) {
        const asked = yield* askOffered(hint);
        const terms = yield* requested(asked);
        if (terms._tag === "Explained") continue;
        const answer = terms._tag === "Answered" ? terms.text : asked;
        if (acceptable(answer)) return answer;
        yield* rejected;
      }
    }
    const decider = yield* Decider;
    // S10: the analysis is of the question as the user was shown it, its options' words as displayed, paired by position.
    // Issue #98: an option's picture reaches the analysis as what it shows; the columns show no picture.
    const optionsShown = () => explained.options.map((o) => ({ label: piecesText(o.shown.label), description: o.shown.figure === null ? piecesText(o.shown.description) : `${piecesText(o.shown.description)} ${prompts.pictureText(o.shown.figure.alt)}` }));
    for (;;) {
      // Issue #133 (S6): the offer stands until a decision is made; the question asked beside its own analysis carries
      // none, and "/decide" there is an answer like any other.
      // Issue #243: beside the run, without the offer "/decide" is rejected, as an answer the question does not accept.
      const offered = decisions.length === 0 && (beside === null || beside.offer);
      const asked = yield* askOffered(offered ? prompts.withOffer(hint) : hint);
      const terms = yield* requested(asked);
      if (terms._tag === "Explained") continue;
      const answer = terms._tag === "Answered" ? terms.text : asked;
      if (beside !== null && !offered && isDecide(answer)) {
        yield* rejected;
        continue;
      }
      if (terms._tag === "NotAsked" && offered && isDecide(answer)) {
        const options = optionsShown();
        const asked = decisionQuestionOf(explained);
        // S37, S10: the analysis is given the question as the user was shown it, after the context call.
        const shown = { context: blocksMarkdown(explained.context.blocks), history: blocksMarkdown(explained.history), terms: question.explanations.map((e) => termItem(e, "")).join("\n"), details: attachedMarkdown(explained.attached ?? null) };
        // Issue #153 (Q1): the decision runs beside the question, which stays open, without the offer or the terms line.
        const opened = yield* Ref.make<number | null>(null);
        const fiber = yield* Effect.forkScoped(decider.decide({ question: asked, options, number: question.number, shown, opened: (k) => Ref.set(opened, k).pipe(Effect.andThen(Ref.update(openedDecisions, (ks) => [...ks, k]))) }));
        yield* Ref.set(inFlight, Option.some(opened));
        const during = yield* besideWork(fiber);
        if (during._tag === "Answered") {
          const answer = during.text;
          // The loop is interrupted first, so it writes nothing after the record.
          yield* Fiber.interrupt(fiber);
          const k = yield* Ref.get(opened);
          yield* Effect.uninterruptible(Effect.andThen(Ref.set(recorded, true), k === null ? Effect.void : recordAbandoned(k, answer)));
          return resolve === null ? answer : resolve(answer, explained.options);
        }
        yield* Ref.set(inFlight, Option.none());
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
      yield* Effect.uninterruptible(Effect.andThen(Ref.set(recorded, true), recordChoices(answer)));
      return resolve === null ? answer : resolve(answer, explained.options);
    }
  }));

// ---- issue #243: a question open beside the running run ----

/** Issue #243: a question open beside the run: its number, its accepted answer (set in the Ui's take), and its producer. */
export type BesideQuestion = Readonly<{
  number: number;
  answer: Effect.Effect<Option.Option<string>>;
  fiber: Fiber.Fiber<string, UserStopped | RunError>;
}>;
export type BesideOptions = Readonly<{ offer: boolean; resolve?: (answer: string, options: readonly OfferedOption[]) => string; onAccepted?: (text: string) => Effect.Effect<void> }>;
/** Issue #243: what an answer taken beside the run is: an answer the question accepts, an end of the run, Help me decide, or rejected. */
type Accepted = Readonly<{ _tag: "Answer"; raw: string; text: string }> | Readonly<{ _tag: "Quit" }> | Readonly<{ _tag: "Decide" }> | Readonly<{ _tag: "Rejected" }>;
const acceptedOf = (raw: string, offer: boolean, acceptable: (answer: string) => boolean, resolve: BesideOptions["resolve"], options: readonly OfferedOption[]): Accepted => {
  const parsed = parseAskLine(raw);
  if (parsed.kind === "quit") return { _tag: "Quit" };
  const text = parsed.text;
  if (isDecide(text)) return offer ? { _tag: "Decide" } : { _tag: "Rejected" };
  if (isTermsRequest(text) || !acceptable(text)) return { _tag: "Rejected" };
  return { _tag: "Answer", raw: text, text: resolve === undefined ? text : resolve(text, options) };
};

/**
 * Issue #243: presents a question beside the running run and returns once it is presented and recorded, so its context
 * call never overlaps the run's next agent call. Its producer (`askOffering` in beside mode, forked in `scope`, so the
 * question may outlive the effect that presented it) keeps it open: an answer the question accepts is stored in the Ui's
 * own take (`answer`, and `onAccepted`, the registry of disputes), whether given at the question or while a decision is
 * prepared beside it; "q" ends the run through `OpenQuestions.quit`; a producer that fails otherwise ends it through
 * `OpenQuestions.fail`. A handle is answered at most once; interrupting its fiber cancels the question on the page.
 * Help me decide (`offer`) is carried only by a review loop's limit, idle and unchanged questions, which live only while
 * their loop runs, when no agent writes to the project: a dispute's question can outlive its loop into an execution
 * phase, where a decision's planning call would find the project changing and halt the run; the transport question's
 * decision would need the agent that cannot be reached; the tracker's and the suite's run while the project changes.
 */
export const openBeside = (
  scope: Scope.Scope,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean,
  options: BesideOptions,
): Effect.Effect<BesideQuestion, RunError, Ui | Store | Decider | OpenQuestions> =>
  Effect.gen(function* () {
    const open = yield* OpenQuestions;
    const presented = yield* Deferred.make<number>();
    const stored = yield* Ref.make(Option.none<Readonly<{ raw: string; text: string }>>());
    const onTaken = (raw: string, shown: readonly OfferedOption[]): Effect.Effect<void> => {
      const accepted = acceptedOf(raw, options.offer, acceptable, options.resolve, shown);
      switch (accepted._tag) {
        case "Answer":
          return Ref.set(stored, Option.some({ raw: accepted.raw, text: accepted.text })).pipe(Effect.andThen(options.onAccepted === undefined ? Effect.void : options.onAccepted(accepted.text)));
        case "Quit":
          return open.quit(new UserStopped({ where: hint }));
        case "Decide":
        case "Rejected":
          return Effect.void;
      }
    };
    const place: Place = { _tag: "Beside", offer: options.offer, presented, onTaken, stored: Effect.map(Ref.get(stored), Option.map((s) => s.raw)) };
    const producer = askOffering(byLine((): Effect.Effect<string> => Effect.never), hint, draft, acceptable, null, options.resolve ?? null, place).pipe(
      Effect.tapError((e) => (e._tag === "UserStopped" ? Effect.void : open.fail(e))),
    );
    const fiber = yield* Effect.forkIn(producer, scope);
    const number = yield* Effect.raceFirst(Deferred.await(presented), Effect.andThen(Fiber.join(fiber), Effect.never));
    return { number, answer: Effect.map(Ref.get(stored), Option.map((s) => s.text)), fiber };
  });

/** Issue #243: where a question presented without the run's services is recorded (the tracker's first read, held). */
export type BesideRecord = Readonly<{ ui: UiShape; record: (markdown: string) => Effect.Effect<void, RunError> }>;

/**
 * Issue #243: `openBeside` without the context call, the Decider, the offer or OpenQuestions (the tracker's first read,
 * before the run's services exist): presented and recorded through `env` before it returns; "q" fails its fiber with
 * UserStopped, which the caller watches.
 */
export const openBesideUnoffered = (
  scope: Scope.Scope,
  env: BesideRecord,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean,
): Effect.Effect<BesideQuestion, RunError> =>
  Effect.gen(function* () {
    const { question, present } = yield* presentUnoffered(env.ui, env.record, draft);
    const stored = yield* Ref.make(Option.none<string>());
    const onTaken = (raw: string): Effect.Effect<void> => {
      const parsed = parseAskLine(raw);
      return parsed.kind === "answer" && acceptable(parsed.text) ? Ref.set(stored, Option.some(parsed.text)) : Effect.void;
    };
    const producer = Effect.scoped(
      Effect.gen(function* () {
        const frame = yield* env.ui.enterQuestion(question.number);
        for (;;) {
          const answer = yield* frame.askBeside(hint, "line", onTaken);
          if (acceptable(answer)) return answer;
          yield* env.ui.notify({ _tag: "AnswerRejected" });
          yield* present;
        }
      }),
    );
    const fiber = yield* Effect.forkIn(producer, scope);
    return { number: question.number, answer: Ref.get(stored), fiber };
  });
