// The interview: a conversation between the user and Claude Code in the page. Separate from
// src/interview.ts (the question phase) so that src/subjects.ts can use it without an import cycle (finding 28).

import { Effect, Result } from "effect";
import { InterviewTurnInvalid, type RunError } from "./errors.ts";
import { type AgreedAnswers, mentionsId, skippedQuestions, type TurnSkipProblem, waitingFor } from "./premises.ts";
import { parseInterviewMessage } from "./input.ts";
import * as prompts from "./prompts.ts";
import { interviewSays, recordHeading, renderTerms } from "./render.ts";
import { requestedTermsValidation, withTermsEntry } from "./termsValidation.ts";
import { bothValidations, planningCall, questionsValidation, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import type { QuestionsFile, TermsEntry } from "./schema.ts";
import { clarificationCount, normalizeTurn, type TurnVariant } from "./schemaNormalize.ts";
import { Planner, type Services, Store, Ui } from "./services.ts";
import { agentContext, askOffering, numberedOptions, programContext, type QuestionDraft } from "./offer.ts";
import { blocksText, type Piece, piecesText, plainPieces } from "./pieces.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import type { InterviewStage } from "./uiEvents.ts";

/**
 * The validation of an interview turn (S16, Q12): the question it asks now, when its id is not one of questions.json
 * (a follow-up, an accepted requirements issue), under the rules; an agreed question, whose presentation comes from the
 * records (S18), and a turn that asks nothing are not checked.
 */
export const turnValidation =
  (recorded: readonly string[], premises: Premises | null): Validation<S.InterviewTurn> =>
    bothValidations(questionRules(recorded), premises === null ? null : premiseValidation(premises));

/**
 * What an interview knows of the premises of its agreed questions (issue #99): the list with its skip conditions and the
 * user's choices so far. Only the first interview has it; the second asks accepted requirements issues, which name none.
 */
export type Premises = Readonly<{ questions: QuestionsFile["questions"]; answers: AgreedAnswers }>;

/**
 * A turn may not ask a skipped question, nor a question before its premise is answered, and its summary names every
 * skipped question; each a failure with the validation repair turn of behaviour 10.
 */
export const premiseValidation =
  (premises: Premises): Validation<S.InterviewTurn> =>
  (turn) => {
    const skipped = skippedQuestions(premises.questions, premises.answers);
    const id = turn.current_question.id;
    const asked = skipped.find((k) => k.id === id);
    const premise = id === "" ? null : waitingFor(premises.questions, premises.answers, id);
    const omitted = turn.complete && turn.summary.trim() !== "" ? skipped.filter((k) => !mentionsId(turn.summary, k.id)).map((k) => k.id) : [];
    const problems: readonly TurnSkipProblem[] = [
      ...(asked !== undefined ? [{ kind: "skippedAsked" as const, id, question: asked.question, answer: asked.answer }] : premise !== null ? [{ kind: "askedBeforePremise" as const, id, premise }] : []),
      ...(omitted.length > 0 ? [{ kind: "summaryOmits" as const, ids: omitted }] : []),
    ];
    return problems.length === 0 ? Result.succeed({ value: turn, notes: [] }) : Result.fail({ error: new InterviewTurnInvalid({ problems }), repair: prompts.interviewTurnRepairPrompt(problems) });
  };

/** The rules of every question, for a question the turn asks outside questions.json. */
const questionRules =
  (recorded: readonly string[]): Validation<S.InterviewTurn> =>
  (turn) => {
    const current = turn.current_question;
    // S35 (W1-R1-3): only a turn that asks nothing, or asks an agreed question by its id, is not checked.
    if (asksNothing(current) || (current.id.trim() !== "" && recorded.includes(current.id))) return Result.succeed({ value: turn, notes: [] });
    const where = current.id.trim() === "" ? "the current question" : current.id;
    return questionsValidation((t: S.InterviewTurn) => [{ where, question: { context: t.current_question.context, history: t.current_question.history, question: t.current_question.text, explanations: t.current_question.explanations, options: t.current_question.options } }])(turn);
  };

/**
 * Whether a turn asks no particular question (S35): every field of its current question blank or empty. turnDraft
 * presents exactly such a turn as a reply to Claude Code's message, and turnValidation checks every other one.
 */
export const asksNothing = (current: S.InterviewTurn["current_question"]): boolean =>
  current.id.trim() === "" && blocksText(current.context).join("").trim() === "" && blocksText(current.history).join("").trim() === "" && piecesText(current.text).trim() === "" && current.explanations.length === 0 && current.options.length === 0;

/** The reviewed records an interview presents its agreed questions from (S18): questions.json and terms.json. */
export type AgreedRecords = Readonly<{ questions: QuestionsFile["questions"]; terms: readonly TermsEntry[] }>;

/** The default's mark on a proposed answer's description (S18): after its last piece, as the program's words. */
const markedDefault = (description: readonly Piece[]): readonly Piece[] => {
  const marked = prompts.defaultMarked(piecesText(description));
  const words = piecesText(description);
  return [...description, ...plainPieces(marked.slice(words.length))];
};

/**
 * The question an interview turn asks (S7, S18). A question of questions.json is presented from the reviewed records
 * alone: its entry in terms.json, divided into pieces that refer to its explanations (decision Q1), or where there is
 * none the agreed entry's plain pieces; its reason as its attached material and its proposed answers as options with the default
 * marked; what the turn writes beside the id is ignored, so no word shown can lose its explanation. Any other question (a
 * follow-up, an accepted requirements issue) is presented from the turn, as validated (S16). A turn that names none asks
 * for the user's reply to its message, which is then the context, shown whole (S7).
 */
export const turnDraft = (turn: TurnVariant, records: AgreedRecords): QuestionDraft => {
  const current = turn.current;
  const agreed = records.questions.find((q) => q.id === current.id && current.id !== "");
  if (agreed !== undefined) {
    const origin: QuestionOrigin = { kind: "clarification", id: agreed.id };
    const divided = records.terms.find((t) => t.id === agreed.id);
    const entry = divided ?? { ...agreed, explanations: [] };
    const options = numberedOptions(entry.proposed_answers.map((a) => ({ label: a.label, description: piecesText(a.label) === agreed.default_answer ? markedDefault(a.description) : a.description })));
    return { origin, context: agentContext(entry.context, origin), history: entry.history, explanations: entry.explanations, question: entry.question, options, attached: attachedOf("reason", entry.reason), decision: null };
  }
  if (asksNothing(current)) return { origin: { kind: "reply" }, context: { blocks: [{ kind: "document", markdown: turn.message }], by: "agent" }, history: [], explanations: [], question: plainPieces(prompts.REPLY_QUESTION), options: [], decision: null };
  const origin: QuestionOrigin = { kind: "followUp", id: current.id };
  return { origin, context: agentContext(current.context, origin), history: current.history, explanations: current.explanations, question: current.text, options: numberedOptions(current.options), decision: null };
};

/**
 * Issue #142: whether an interview offers the explanations of an agreed question that has none, on the user's request
 * (the run's choice onRequest, with the task the request's prompt carries), or never.
 */
export type TermsOffer = Readonly<{ kind: "never" }> | Readonly<{ kind: "onRequest"; task: string }>;

/**
 * The request for one agreed question's explanations (issue #142): one Claude Code call in a fresh session, a planning
 * call under behavior 3 with no review, whose entry joins terms.json; the question is then presented from the records
 * again, its wording unchanged since requestedTermsValidation refused any change.
 */
const requestTerms = (task: string, agreed: QuestionsFile["questions"][number], turn: TurnVariant, questions: QuestionsFile["questions"], number: number): Effect.Effect<QuestionDraft, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    yield* ui.say(prompts.termsRequestedLine(number));
    const planner = yield* (yield* Planner).fresh;
    const written = yield* planningCall(prompts.termsOnRequestPrompt(store.root, task, agreed.id), S.TermsWrite, "planning", "records", requestedTermsValidation<S.TermsWrite>(agreed)).pipe(Effect.provideService(Planner, planner));
    const entries = written.output.entries.filter((e) => e.id === agreed.id);
    const terms = entries.reduce((all, e) => withTermsEntry(all, e, questions), yield* store.loadTerms());
    yield* store.saveTerms(terms);
    yield* store.converse(`## ${prompts.termsRequestedHeading(number)}\n\n${yield* Effect.fromResult(renderTerms(entries))}\n`);
    return turnDraft(turn, { questions, terms });
  });

/**
 * A conversation between the user and Claude Code. It ends when Claude Code
 * reports completion and the user confirms the summary, which the program writes to requirements.md.
 * Issue #142: terms.json is read again before each question, so that explanations written on request stay with it.
 */
export const interview = (opening: string, stage: InterviewStage, agreed: readonly string[], termsOffer: TermsOffer): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // The user reads "User Decisions" (issues #21, #113); conversation.md, a record, keeps its heading.
    const heading = prompts.clarificationHeading(stage);
    // Each interface renders its own help (finding 8 of docs/gui-review.md): the page its Shift+Enter.
    yield* ui.notify({ _tag: "InterviewOpened", heading, stage, total: clarificationCount(agreed, [], [], []).total });
    yield* store.converse(`## ${recordHeading(stage)}\n\n`);
    // S16, S18: the questions of questions.json were reviewed, and are presented from the records with their terms; any
    // other question a turn asks is held to the rules here.
    const questions = (yield* store.loadQuestions()).questions;
    const records = { questions };
    const recorded = questions.map((q) => q.id);
    let prompt = opening;
    // Issue #99: the user's choice for each agreed question, replaced after each reply; the first interview alone skips.
    let answers: AgreedAnswers = new Map();
    for (;;) {
      const premises: Premises | null = stage === "clarification" ? { questions: records.questions, answers } : null;
      const skippedIds = premises === null ? [] : skippedQuestions(premises.questions, answers).map((k) => k.id);
      const turn = normalizeTurn((yield* planningCall(prompt, S.InterviewTurn, "interview", "records", turnValidation(recorded, premises))).output);
      const [messageLine] = interviewSays(turn);
      yield* ui.notify({ _tag: "InterviewTurn", heading, message: turn.message, summary: turn.kind === "summary_proposed" ? turn.summary : null, ...clarificationCount(agreed, turn.asked, turn.answered, skippedIds) });
      yield* ui.say(messageLine);
      yield* store.converse(`**Claude Code:** ${turn.message}\n\n`);

      if (turn.kind === "summary_proposed") {
        // S7: the summary is read beside the question that confirms it, after the program's paragraph.
        const origin: QuestionOrigin = { kind: "confirmSummary" };
        const draft: QuestionDraft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(prompts.CONFIRM_SUMMARY_QUESTION), options: [], attached: attachedOf("summary", [{ kind: "document", markdown: turn.summary.trim() }]), decision: null };
        const reply = parseInterviewMessage(yield* askOffering((m) => ui.askMessage(m), prompts.confirmSummaryPrompt, draft));
        if (reply.kind !== "text") {
          yield* store.writeRequirements(turn.summary.trimEnd() + "\n");
          yield* store.converse(`**User:** confirmed the summary.\n\n### Confirmed summary\n\n${turn.summary}\n\n`);
          return;
        }
        yield* store.converse(`**User:** ${reply.text}\n\n`);
        prompt = prompts.interviewNotConfirmed(reply.text);
        continue;
      }

      // A blank message is asked again inside the offer, so that it is never recorded as the choice (W1-R1-1).
      const terms = yield* store.loadTerms();
      const draft = turnDraft(turn, { questions, terms });
      const asked = draft.origin.kind === "clarification" ? questions.find((q) => draft.origin.kind === "clarification" && q.id === draft.origin.id) : undefined;
      const request =
        termsOffer.kind === "onRequest" && asked !== undefined && !terms.some((t) => t.id === asked.id)
          ? (number: number) => requestTerms(termsOffer.task, asked, turn, questions, number)
          : null;
      const reply = parseInterviewMessage(yield* askOffering((m) => ui.askMessage(m), prompts.interviewMessagePrompt, draft, (m) => m !== "", request));
      if (reply.kind === "empty") continue;
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      if (reply.kind === "done") {
        prompt = prompts.interviewDonePrompt;
        continue;
      }
      prompt = prompts.interviewUserMessage(reply.text);
      if (premises === null || draft.origin.kind !== "clarification") continue;
      // The reply to an agreed question: the option it chooses, or text that chooses none (issue #99).
      const chosen = draft.options.find((o) => o.matches(reply.text));
      answers = new Map([...answers, [draft.origin.id, chosen === undefined ? { kind: "text" } : { kind: "option", label: chosen.label }]]);
      const now = skippedQuestions(records.questions, answers);
      const added = now.filter((k) => !skippedIds.includes(k.id));
      const restored = skippedIds.filter((id) => !now.some((k) => k.id === id));
      if (added.length === 0 && restored.length === 0) continue;
      const note = prompts.skippedNote(added, restored);
      yield* ui.say(note);
      yield* store.converse(`**Note:** ${note}\n\n`);
      prompt = `${prompt}\n\n${note}`;
    }
  });

