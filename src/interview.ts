// The question phase: question list, its review, the interview (src/conversation.ts), and the review of its result.

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { interview } from "./conversation.ts";
import * as prompts from "./prompts.ts";
import { planningCall, reviewLoop } from "./review.ts";
import { renderQuestions, renderTerms } from "./render.ts";
import * as S from "./schema.ts";
import { Planner, type Services, Store, Ui } from "./services.ts";
import { questionListValidation, questionSubject, requirementsSubject, saveTerms, termsSubject, termsValidation, writeQuestions } from "./subjects.ts";
import type { QuestionsFile } from "./schema.ts";

/**
 * The explanations of the agreed questions' terms (S17, decision Q8): a fresh session writes them after the question
 * review has converged, against the final wording, and answers Codex's review of them in the same session.
 */
const explainTerms = (task: string, agreed: QuestionsFile["questions"]): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const planner = yield* (yield* Planner).fresh;
    yield* Effect.gen(function* () {
      yield* ui.say(prompts.termsLine);
      const written = yield* planningCall(prompts.termsPrompt(store.root, task), S.TermsWrite, "planning", "records", termsValidation<S.TermsWrite>(agreed));
      yield* saveTerms(written.output.entries);
      yield* store.converse(`## Explanations of terms proposed by Claude Code\n\n${yield* Effect.fromResult(renderTerms(written.output.entries))}\n`);
      yield* reviewLoop(termsSubject(agreed));
    }).pipe(Effect.provideService(Planner, planner));
  });

/** Runs before planning phase 1 and ends with requirements.md written. */
export const questionPhase = (task: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;

    yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "questions" } });
    yield* ui.say(prompts.questionListLine);
    const generated = yield* planningCall(prompts.questionListPrompt(task), S.QuestionList, "planning", "records", questionListValidation());
    yield* writeQuestions(task, generated.output);
    yield* store.converse(`## Question list proposed by Claude Code\n\n${renderQuestions(generated.output)}\n`);

    yield* reviewLoop(questionSubject(task));

    const agreed = (yield* store.loadQuestions()).questions;
    yield* store.converse(`## Agreed question list\n\n${renderQuestions({ questions: agreed })}\n`);
    // Issue #83 (the developer's instruction of 4 Oct 2026): an empty agreed list is no reason to pause; planning starts.
    if (agreed.length === 0) {
      yield* store.writeRequirements(`# Requirements\n\n## Task\n\n${task}\n\nNo question was needed.\n`);
      yield* store.converse("Planning starts without a conversation: no question was needed.\n\n");
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "no conversation" });
      return;
    }
    // S17 (issue #36, Q8): the explanations of the terms, written against the converged list, reviewed in their own loop.
    yield* explainTerms(task, agreed);
    yield* ui.say(`\nThe agreed list contains ${agreed.length} question(s).`);
    yield* interview(prompts.interviewOpenPrompt(store.root), "clarification", agreed.map((q) => q.id));

    const reviewed = yield* reviewLoop(requirementsSubject());
    yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: reviewed.result });
  });
