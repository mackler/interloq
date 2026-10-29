// The interviews in the page. The first, `clarification` (issue #184), presents the agreed questions itself and sends each
// answer to Claude Code through the interview's worker (src/interviewWorker.ts); the second, `interview`, on the accepted
// gaps of the requirements review, goes turn by turn. Separate from src/interview.ts (the question phase) so that
// src/subjects.ts can use it without an import cycle (finding 28).

import { Effect, Ref, Result } from "effect";
import type { RunError } from "./errors.ts";
import { type AgreedAnswer, skippedQuestions } from "./premises.ts";
import { parseInterviewMessage } from "./input.ts";
import * as prompts from "./prompts.ts";
import { interviewSays, recordHeading, renderTerms } from "./render.ts";
import { requestedTermsValidation, withTermsEntry } from "./termsValidation.ts";
import { planningCall, questionsValidation, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import type { QuestionsFile, TermsEntry } from "./schema.ts";
import { clarificationCount, normalizeTurn, type TurnVariant } from "./schemaNormalize.ts";
import { Planner, type Services, Store, Ui } from "./services.ts";
import { agentContext, askOffering, byMessage, numberedOptions, type QuestionDraft } from "./offer.ts";
import { blocksText, type Piece, piecesText, plainPieces } from "./pieces.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import type { InterviewStage } from "./uiEvents.ts";
import { INITIAL_CLARIFICATION, nextQuestion, progressOf, takeFollowUp, withAnswer, withEnded, withShown } from "./clarificationState.ts";
import { makeInterviewWorker } from "./interviewWorker.ts";
import type { ClarificationTrailer } from "./prompts.ts";

/**
 * The validation of a turn of the second interview (S16, Q12): the question it asks now, when its id is not one of
 * questions.json (an accepted requirements issue), under the rules; an agreed question, whose presentation comes from
 * the records (S18), and a turn that asks nothing are not checked.
 */
export const turnValidation = (recorded: readonly string[]): Validation<S.InterviewTurn> => questionRules(recorded);

export { replyValidation } from "./clarificationReply.ts";
export type { Premises } from "./clarificationReply.ts";

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
  if (agreed !== undefined) return agreedDraft(agreed, records);
  if (asksNothing(current)) return replyDraft(turn.message);
  return followUpDraft(current);
};

/** An agreed question, presented from the reviewed records alone (S18, decision Q1). */
export const agreedDraft = (agreed: QuestionsFile["questions"][number], records: AgreedRecords): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "clarification", id: agreed.id };
  const divided = records.terms.find((t) => t.id === agreed.id);
  const entry = divided ?? { ...agreed, explanations: [] };
  const options = numberedOptions(entry.proposed_answers.map((a) => ({ label: a.label, description: piecesText(a.label) === agreed.default_answer ? markedDefault(a.description) : a.description })));
  return { origin, context: agentContext(entry.context, origin), history: entry.history, explanations: entry.explanations, question: entry.question, options, attached: attachedOf("reason", entry.reason), decision: null };
};

/** A follow-up question, presented from Claude Code's reply as validated (S16). */
export const followUpDraft = (current: S.InterviewTurn["current_question"]): QuestionDraft => {
  const origin: QuestionOrigin = { kind: "followUp", id: current.id };
  return { origin, context: agentContext(current.context, origin), history: current.history, explanations: current.explanations, question: current.text, options: numberedOptions(current.options), decision: null };
};

/** The user's reply to Claude Code's message, which is the context, shown whole (S7). */
const replyDraft = (message: string): QuestionDraft => ({ origin: { kind: "reply" }, context: { blocks: [{ kind: "document", markdown: message }], by: "agent" }, history: [], explanations: [], question: plainPieces(prompts.REPLY_QUESTION), options: [], decision: null });

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
const requestTerms = (task: string, agreed: QuestionsFile["questions"][number], questions: QuestionsFile["questions"], number: number): Effect.Effect<QuestionDraft, RunError, Services> =>
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
    return agreedDraft(agreed, { questions, terms });
  });

/**
 * The second interview (issue #184: the first is `clarification`), on the accepted gaps of the requirements review: a
 * conversation between the user and Claude Code, turn by turn, since Claude Code writes each of its questions. It ends
 * when Claude Code reports completion with a summary, which the program writes to requirements.md at once (issue #138:
 * an answer is final when the user gives it, so nothing asks him to confirm the summary).
 */
export const interview = (opening: string, agreed: readonly string[]): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // The user reads "More for you to decide" (issues #21, #113); conversation.md, a record, keeps its heading.
    const heading = prompts.clarificationHeading("followUp");
    yield* ui.notify({ _tag: "InterviewOpened", heading, stage: "followUp", total: clarificationCount(agreed, [], [], []).total });
    yield* store.converse(`## ${recordHeading("followUp")}\n\n`);
    // S16, S18: a question of questions.json is presented from the records; any other question a turn asks is held to the rules.
    const questions = (yield* store.loadQuestions()).questions;
    const recorded = questions.map((q) => q.id);
    let prompt = opening;
    for (;;) {
      const turn = normalizeTurn((yield* planningCall(prompt, S.InterviewTurn, "interview", "records", turnValidation(recorded))).output);
      const [messageLine] = interviewSays(turn);
      yield* ui.notify({ _tag: "InterviewTurn", heading, message: turn.message, summary: turn.kind === "summary_proposed" ? turn.summary : null, ...clarificationCount(agreed, turn.asked, turn.answered, []) });
      yield* ui.say(messageLine);
      yield* store.converse(`**Claude Code:** ${turn.message}\n\n`);

      if (turn.kind === "summary_proposed") return yield* writeSummary(turn.summary);

      // A blank message is asked again inside the offer, so that it is never recorded as the choice (W1-R1-1).
      const draft = turnDraft(turn, { questions, terms: yield* store.loadTerms() });
      const reply = parseInterviewMessage(yield* askOffering(byMessage((m) => ui.askMessage(m)), prompts.interviewMessagePrompt, draft, (m) => m !== ""));
      if (reply.kind === "empty") continue;
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      prompt = reply.kind === "done" ? prompts.interviewDonePrompt : prompts.interviewUserMessage(reply.text);
    }
  });

/** The end of an interview (issue #138): Claude Code's summary written to requirements.md and recorded, with no prompt. */
const writeSummary = (summary: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.writeRequirements(summary.trimEnd() + "\n");
    yield* store.converse(`### ${prompts.SUMMARY_WRITTEN_HEADING}\n\n${summary}\n\n`);
  });

/** A question presented and asked until the developer's reply is not empty. */
const askUntilAnswered = (draft: QuestionDraft, request: ((number: number) => Effect.Effect<QuestionDraft, RunError, Services>) | null): Effect.Effect<Exclude<ReturnType<typeof parseInterviewMessage>, { kind: "empty" }>, RunError, Services> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    for (;;) {
      const reply = parseInterviewMessage(yield* askOffering(byMessage((m) => ui.askMessage(m)), prompts.interviewMessagePrompt, draft, (m) => m !== "", request));
      if (reply.kind !== "empty") return reply;
    }
  });

/**
 * The first interview (issue #184, the developer's instruction of 19 Oct 2026: a question appears as soon as the one
 * before it is answered). Interloq presents each agreed question itself (nextQuestion of src/clarificationState.ts) and
 * sends every answer to Claude Code at once through the interview's worker, which runs beside this fiber; a follow-up
 * a reply asks is presented after the question then on the page. When nothing is left to present, the worker is
 * drained: every reply arrived and applied, every follow-up answered, and only then is the list reported done and the
 * summary asked for. The first of the two fibers to end decides: a summary, which the program writes to
 * requirements.md, ends the interview and interrupts
 * the worker, and a halt of the worker ends the run and interrupts the pending prompt.
 */
export const clarification = (agreed: readonly string[], termsOffer: TermsOffer): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const heading = prompts.clarificationHeading("clarification");
    yield* ui.notify({ _tag: "InterviewOpened", heading, stage: "clarification", total: clarificationCount(agreed, [], [], []).total });
    yield* store.converse(`## ${recordHeading("clarification")}\n\n`);
    const questions = (yield* store.loadQuestions()).questions;
    const state = yield* Ref.make(INITIAL_CLARIFICATION);
    // Decision G-R1-1: while agreed questions remain, a request whose retries are used up is tried again in the background
    // and nothing is asked; the question is asked once the developer waits for Claude Code (the worker's drain).
    const worker = yield* makeInterviewWorker({ questions, state, heading, exhaustion: (waiting, untilWaiting) => ({ kind: "background", waiting, untilWaiting }) });
    const counted = Ref.get(state).pipe(Effect.flatMap((s) => ui.notify({ _tag: "InterviewCounted", ...progressOf(agreed, questions, s) })));

    /** Presents the next question and sends its answer; false when nothing is left to present. */
    const presentNext = Effect.gen(function* () {
      const next = nextQuestion(questions, yield* Ref.get(state));
      if (next.kind === "none") return false;
      if (next.kind === "followUp") {
        const followUp = next.followUp;
        yield* Ref.update(state, takeFollowUp);
        const reply = yield* askUntilAnswered(followUpDraft(followUp), null);
        yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
        if (reply.kind === "done") {
          yield* Ref.update(state, withEnded);
          return true;
        }
        yield* Ref.update(state, (s) => withAnswer(s, followUp.id, null));
        yield* worker.send({ kind: "followUp", id: followUp.id, text: reply.text }, []);
        yield* counted;
        return true;
      }
      const question = next.question;
      const terms = yield* store.loadTerms();
      const draft = agreedDraft(question, { questions, terms });
      const request = termsOffer.kind === "onRequest" && !terms.some((t) => t.id === question.id) ? (number: number) => requestTerms(termsOffer.task, question, questions, number) : null;
      const reply = yield* askUntilAnswered(draft, request);
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      if (reply.kind === "done") {
        yield* Ref.update(state, (s) => withEnded(withShown(s, question.id)));
        return true;
      }
      // The reply chooses an option, or text that chooses none (issue #99); a chosen answer may remove later questions.
      const chosen = draft.options.find((o) => o.matches(reply.text));
      const answer: AgreedAnswer = chosen === undefined ? { kind: "text" } : { kind: "option", label: chosen.label };
      const before = skippedQuestions(questions, (yield* Ref.get(state)).answers).map((k) => k.id);
      yield* Ref.update(state, (s) => withAnswer(withShown(s, question.id), question.id, answer));
      const added = skippedQuestions(questions, (yield* Ref.get(state)).answers).filter((k) => !before.includes(k.id));
      const note = added.length === 0 ? null : prompts.skippedNote(added);
      if (note !== null) {
        yield* ui.say(note);
        yield* store.converse(`**Note:** ${note}\n\n`);
      }
      yield* worker.send({ kind: "agreed", id: question.id, text: reply.text, option: chosen === undefined ? null : chosen.label }, note === null ? [] : [note]);
      yield* counted;
      return true;
    });

    /** The closing: the worker drained, then the summary written, or what is still outstanding presented. */
    const close = (trailer: ClarificationTrailer): Effect.Effect<"done" | "present", RunError, Services> =>
      Effect.gen(function* () {
        const drained = yield* worker.drain(trailer);
        if (drained.kind === "followUps") return "present";
        const reply = drained.reply;
        if (reply.kind === "summary_proposed") {
          yield* writeSummary(reply.summary);
          return "done";
        }
        if ((yield* Ref.get(state)).followUps.length > 0) return "present";
        // A closing reply that neither proposes the summary nor asks a follow-up: the developer replies to its message.
        const answer = yield* askUntilAnswered(replyDraft(reply.message), null);
        yield* store.converse(`**User:** ${answer.kind === "done" ? "/done" : answer.text}\n\n`);
        if (answer.kind === "done") yield* Ref.update(state, withEnded);
        else yield* worker.send({ kind: "message", text: answer.text }, []);
        return "present";
      });

    const main = Effect.gen(function* () {
      for (;;) {
        if (yield* presentNext) continue;
        const ended = (yield* Ref.get(state)).ended;
        if ((yield* close(ended ? { kind: "done" } : { kind: "listDone" })) === "done") return;
      }
    });
    yield* Effect.raceFirst(main, worker.run);
  });
