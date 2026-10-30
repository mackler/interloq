// The question phase: question list, its review, the interview (src/conversation.ts), and the review of its result.

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { clarification, type TermsOffer } from "./conversation.ts";
import * as prompts from "./prompts.ts";
import { planningCall, reviewLoop } from "./review.ts";
import { renderQuestions, renderTerms } from "./render.ts";
import * as S from "./schema.ts";
import { Planner, type Services, Store, Ui } from "./services.ts";
import { questionListValidation, questionSubject, requirementsSubject, saveTerms, termsSubject, termsValidation, writeQuestions } from "./subjects.ts";
import type { QuestionsFile, TermsMode } from "./schema.ts";

/**
 * The explanations of the agreed questions' terms (S17, decision Q8): a fresh session writes them after the question
 * review has converged, against the final wording, and, where `reviewed`, answers Codex's review of them in the same
 * session. Issue #142: without the review (the choice unchecked) the program's own validation and its repair turn stay.
 */
const explainTerms = (task: string, agreed: QuestionsFile["questions"], reviewed: boolean): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const planner = yield* (yield* Planner).fresh;
    yield* Effect.gen(function* () {
      yield* ui.notify({ _tag: "TermsBegan" });
      yield* ui.say(prompts.termsLine);
      const written = yield* planningCall(prompts.termsPrompt(store.root, task), S.TermsWrite, "planning", "records", termsValidation<S.TermsWrite>(agreed));
      yield* saveTerms(written.output.entries);
      yield* store.converse(`## Explanations of terms proposed by Claude Code\n\n${yield* Effect.fromResult(renderTerms(written.output.entries))}\n`);
      if (reviewed) yield* reviewLoop(termsSubject(agreed));
    }).pipe(Effect.provideService(Planner, planner));
  });

/** Issue #142: the terms before the first question, as the run's choice has them. */
const termsBeforeInterview = (task: string, agreed: QuestionsFile["questions"], terms: TermsMode): Effect.Effect<void, RunError, Services> => {
  switch (terms) {
    case "checked":
      return explainTerms(task, agreed, true);
    case "unchecked":
      return explainTerms(task, agreed, false);
    case "onRequest":
      return Effect.void;
  }
};

/**
 * Issue #131: the part of the question phase that needs no one (steps 1 to 3): the question list, its review, the agreed
 * list recorded, and, where it is not empty, its terms as the choice has them. Returns the agreed list. An unattended
 * preparation runs it alone; a refinement run runs it unless a current preparation supplies its result.
 */
export const prepareQuestionList = (task: string, terms: TermsMode): Effect.Effect<QuestionsFile["questions"], RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    yield* ui.say(prompts.questionListLine);
    const generated = yield* planningCall(prompts.questionListPrompt(task), S.QuestionList, "planning", "records", questionListValidation());
    yield* writeQuestions(task, generated.output);
    yield* store.converse(`## Question list proposed by Claude Code\n\n${renderQuestions(generated.output)}\n`);

    yield* reviewLoop(questionSubject(task));

    const agreed = (yield* store.loadQuestions()).questions;
    yield* store.converse(`## Agreed question list\n\n${renderQuestions({ questions: agreed })}\n`);
    // S17 (issue #36, Q8): the explanations of the terms, written against the converged list, reviewed in their own loop.
    if (agreed.length > 0) yield* termsBeforeInterview(task, agreed, terms);
    return agreed;
  });

/**
 * Issue #131: the part of the question phase that is nothing but the developer (step 4): the clarification of the agreed
 * list and the review of its result, or, for an empty list, requirements.md with no question.
 */
export const askAgreed = (task: string, agreed: QuestionsFile["questions"], termsOffer: TermsOffer): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // Issue #83 (the developer's instruction of 4 Oct 2026): an empty agreed list is no reason to pause; planning starts.
    if (agreed.length === 0) {
      yield* store.writeRequirements(`# Requirements\n\n## Task\n\n${task}\n\nNo question was needed.\n`);
      yield* store.converse("Planning starts without a conversation: no question was needed.\n\n");
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "no conversation" });
      return;
    }
    yield* ui.say(`\nThe agreed list contains ${agreed.length} question(s).`);
    yield* clarification(agreed.map((q) => q.id), termsOffer);

    const reviewed = yield* reviewLoop(requirementsSubject());
    yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: reviewed.result });
  });

/** Runs before planning phase 1 and ends with requirements.md written. */
export const questionPhase = (task: string, terms: TermsMode): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;

    yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "questions" } });
    yield* store.converse(`${prompts.termsChoiceLine(terms)}\n\n`);
    yield* ui.say(prompts.termsChoiceLine(terms));
    const agreed = yield* prepareQuestionList(task, terms);
    yield* askAgreed(task, agreed, terms === "onRequest" ? { kind: "onRequest", task } : { kind: "never" });
  });
