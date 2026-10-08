// The three subjects of the review procedure.

import { Effect, Result } from "effect";
import { phaseOf, recordPath, type SubjectId } from "./artifacts.ts";
import { interview } from "./conversation.ts";
import type { RunError } from "./errors.ts";
import * as prompts from "./prompts.ts";
import { subjectHeading } from "./render.ts";
import { bothValidations, questionsValidation, type Subject, userQuestionsValidation, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import type { DecisionAnalysis, DecisionApplied, DecisionResponse, Plan, PlannerResponse, PlanResponse, PlanWrite, PlanWriteResult, QuestionList, QuestionListResponse, QuestionsFile, RecordedPlan, TermsEntry, TermsResponse, TermsWrite } from "./schema.ts";
import { QuestionInvalid, SkipConditionInvalid } from "./errors.ts";
import { skipConditionProblems } from "./premises.ts";
import type { QuestionProblem } from "./prompts.ts";
import { sameBlocks, samePieces } from "./pieces.ts";
import { questionProblems } from "./question.ts";
import { validatePlan } from "./plan.ts";
import { normalizeQuestionList } from "./schemaNormalize.ts";
import { Store, Ui } from "./services.ts";

/** Records the list as questions.json after normalisation: an invalid list halts, and a dropped default is noted in the conversation. */
export const writeQuestions = (task: string, list: QuestionList): Effect.Effect<void, RunError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const normalized = yield* Effect.fromResult(normalizeQuestionList(list));
    for (const note of normalized.notes) yield* store.converse(`**Note:** ${note}\n\n`);
    yield* store.saveQuestions(task, normalized.questions);
  });

/**
 * The question list's validation (S15): every entry under the rules of every question (its terms come later, from the
 * terms subject), inside behaviour 10's validation budget, at the first call, at a response and at the application of
 * the user's decisions alike. An entry is named by its id, or by its position when it has none.
 */
export const questionListValidation = <T extends Readonly<{ questions: readonly QuestionList["questions"][number][] }>>(): Validation<T> =>
  bothValidations(
    questionsValidation((output: T) =>
      output.questions.map((e, i) => ({ where: e.id.trim() === "" ? `question ${i + 1}` : e.id, question: { context: e.context, question: e.question, explanations: [], options: e.proposed_answers, details: e.reason } })),
    ),
    skipConditionValidation<T>(),
  );

/** The skip conditions of a question list (issue #99): each names another entry and one of its answers, and none loops. */
export const skipConditionValidation =
  <T extends Readonly<{ questions: readonly QuestionList["questions"][number][] }>>(): Validation<T> =>
  (output) => {
    const problems = skipConditionProblems(output.questions);
    return problems.length === 0 ? Result.succeed({ value: output, notes: [] }) : Result.fail({ error: new SkipConditionInvalid({ problems }), repair: prompts.skipConditionRepairPrompt(problems) });
  };

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(task: string): Subject<QuestionListResponse, QuestionList> {
  const id = "questions" as const;
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "questions.json",
    reviewPrompt: prompts.questionReviewPrompt,
    respond: { prompt: prompts.questionRespondPrompt, schema: S.QuestionListResponse, after: (output) => writeQuestions(task, output), capability: "records", validate: bothValidations(questionListValidation<QuestionListResponse>(), userQuestionsValidation<QuestionListResponse>()) },
    applyDecisions: { prompt: prompts.questionApplyDecisionsPrompt, schema: S.QuestionList, after: (output) => writeQuestions(task, output), validate: questionListValidation() },
    amend: null,
    proceed: prompts.PROCEED_TO_CLARIFICATION,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    onUnchanged: "corrective",
    // Issue #112: a disputed issue here is about how a question to the user is worded.
    disputesSettledBy: "agents",
    prepare: null,
  };
}

/** The kinds of problem of the question list itself, which its own review settled: not the explanations' to repair. */
const LIST_PROBLEMS: readonly QuestionProblem["kind"][] = ["blankContext", "notLast", "bareNumber"];
/** The fields of an agreed entry whose wording the division into pieces keeps (decision Q1), each compared by its words and blocks. */
const wordingChanges = (agreed: QuestionsFile["questions"][number], entry: TermsEntry): readonly QuestionProblem[] => [
  ...(sameBlocks(entry.context, agreed.context) ? [] : ["context"]),
  ...(samePieces(entry.question, agreed.question) ? [] : ["question"]),
  ...(sameBlocks(entry.reason, agreed.reason) ? [] : ["reason"]),
  ...(entry.proposed_answers.length === agreed.proposed_answers.length && entry.proposed_answers.every((a, i) => samePieces(a.label, agreed.proposed_answers[i].label) && samePieces(a.description, agreed.proposed_answers[i].description)) ? [] : ["proposed_answers"]),
].map((subject) => ({ kind: "wordingChanged" as const, subject }));
/**
 * The validation of the explanations (S17; S6 of the task of issue #36, decision Q1): every entry names a question of the
 * agreed list, keeps its wording (its fields' words and blocks), and holds its explanations under the data clauses of
 * the format: every ref names an explanation, every explanation is referred to, none blank. Inside behaviour 10's
 * validation budget, like the list's own validation.
 */
export const termsValidation =
  <T extends Readonly<{ entries: readonly TermsEntry[] }>>(questions: QuestionsFile["questions"]): Validation<T> =>
  (output) => {
    const failing = output.entries.flatMap((entry): { where: string; problems: readonly QuestionProblem[] }[] => {
      const q = questions.find((x) => x.id === entry.id);
      if (q === undefined) return [{ where: entry.id, problems: [{ kind: "unknownQuestion", subject: entry.id }] }];
      const problems = [
        ...wordingChanges(q, entry),
        ...questionProblems({ context: entry.context, question: entry.question, explanations: entry.explanations, options: entry.proposed_answers, details: entry.reason }).filter((p) => !LIST_PROBLEMS.includes(p.kind)),
      ];
      return problems.length === 0 ? [] : [{ where: entry.id, problems }];
    });
    if (failing.length === 0) return Result.succeed({ value: output, notes: [] });
    return Result.fail({ error: new QuestionInvalid({ questions: failing }), repair: prompts.questionRepairPrompt(failing) });
  };
/** Writes the explanations to terms.json. */
export const saveTerms = (entries: readonly TermsEntry[]): Effect.Effect<void, RunError, Store> =>
  Effect.gen(function* () {
    yield* (yield* Store).saveTerms(entries);
  });
/**
 * The explanations of the agreed questions' terms (S17, issue #36): Codex reviews them in cycles; Claude Code returns the
 * complete amended explanations with every response, which the program validates and writes to terms.json.
 */
export function termsSubject(questions: QuestionsFile["questions"]): Subject<TermsResponse, TermsWrite> {
  const id = "terms" as const;
  const validate = termsValidation<TermsResponse>(questions);
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "terms.json",
    reviewPrompt: prompts.termsReviewPrompt,
    respond: { prompt: prompts.termsRespondPrompt, schema: S.TermsResponse, after: (output) => saveTerms(output.entries), capability: "records", validate: bothValidations(validate, userQuestionsValidation<TermsResponse>()) },
    applyDecisions: { prompt: prompts.termsApplyDecisionsPrompt, schema: S.TermsWrite, after: (output) => saveTerms(output.entries), validate: termsValidation<TermsWrite>(questions) },
    amend: null,
    proceed: prompts.PROCEED_TO_CLARIFICATION_WITH_TERMS,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    onUnchanged: "corrective",
    // Issue #112: a disputed issue here is about how a question to the user is worded.
    disputesSettledBy: "agents",
    prepare: null,
  };
}

/** The confirmed interview result. An accepted issue is put to the user in a second interview. */
export function requirementsSubject(): Subject<PlannerResponse, PlanWriteResult> {
  const id = "requirements" as const;
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "requirements.md",
    reviewPrompt: prompts.requirementsReviewPrompt,
    respond: { prompt: prompts.requirementsRespondPrompt, schema: S.PlannerResponse, after: null, capability: "records", validate: userQuestionsValidation() },
    applyDecisions: { prompt: prompts.requirementsApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null, validate: userQuestionsValidation() },
    amend: (_review, response, round) => {
      const ids = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
      if (ids.length === 0) return Effect.succeed(undefined);
      return interview(prompts.interviewGapsPrompt(recordPath({ kind: "review", subject: id, round }), ids), "followUp", ids);
    },
    proceed: prompts.PROCEED_TO_PLANNING,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    onUnchanged: "pause",
    disputesSettledBy: "user",
    prepare: null,
  };
}

/**
 * The plan of planning phase k (issue #6, F1): Claude Code returns the whole plan with every write and every response, the
 * program validates it against `previous`, the plan as it stood when the phase began (G-R1-1: its done steps and its
 * statuses do not change within a planning phase), and writes plan.json and plan.md.
 */
export function planSubject(phase: number, withRequirements: boolean, previous: RecordedPlan | null): Subject<PlanResponse, PlanWrite> {
  const id = { plan: phase };
  const validate = planValidation(previous);
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "plan.json",
    reviewPrompt: (round) => prompts.planReviewPrompt(phase, round, withRequirements),
    respond: { prompt: (round) => prompts.planRespondPrompt(phase, round), schema: S.PlanResponse, after: (output) => savePlan(phase, output.plan, previous), capability: "records", validate: bothValidations(planField<PlanResponse>(validate), userQuestionsValidation<PlanResponse>()) },
    applyDecisions: { prompt: prompts.planApplyDecisionsPrompt, schema: S.PlanWrite, after: (output) => savePlan(phase, output.plan, previous), validate: bothValidations(planField<PlanWrite>(validate), userQuestionsValidation<PlanWrite>()) },
    amend: null,
    proceed: prompts.PROCEED_TO_IMPLEMENTATION,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    onUnchanged: "corrective",
    disputesSettledBy: "user",
    prepare: null,
  };
}

/** The validation of a plan against the plan as the phase began (G-R1-1), with the repair turn's prompt. */
export const planValidation =
  (previous: RecordedPlan | null): Validation<Plan> =>
  (plan) => {
    const validated = validatePlan(previous, plan);
    return Result.isFailure(validated) ? Result.fail({ error: validated.failure, repair: prompts.planRepairPrompt(validated.failure) }) : Result.succeed({ value: plan, notes: validated.success.notes });
  };
/** A plan's validation for an output that carries the plan in its field `plan`. */
export const planField =
  <T extends Readonly<{ plan: Plan }>>(validate: Validation<Plan>): Validation<T> =>
  (output) =>
    Result.map(validate(output.plan), ({ value, notes }) => ({ value: { ...output, plan: value }, notes }));

/**
 * Writes the plan of planning phase k as recorded against `previous` (statuses carried by id), then notifies it: the
 * plan belongs to Implementation k (Q5). The reply was validated before, so the validation succeeds here.
 */
export const savePlan = (phase: number, plan: Plan, previous: RecordedPlan | null): Effect.Effect<void, RunError, Store | Ui> =>
  Effect.gen(function* () {
    const recorded = yield* Effect.fromResult(validatePlan(previous, plan));
    yield* (yield* Store).savePlan(recorded.value);
    yield* (yield* Ui).notify({ _tag: "PlanChanged", phase, plan: recorded.value, step: null });
  });

/**
 * Decision k (decision support): Codex reviews decision-<k>/analysis.json against docs/decision-making.md; Claude Code
 * returns the complete amended analysis with every response, which the program validates and writes (D5). The phase is
 * where the decision took place.
 */
/** An analysis's validation for an output that carries the analysis in its field `analysis` (a response, an application). */
export const validatingField =
  <T extends Readonly<{ analysis: DecisionAnalysis }>>(validate: Validation<DecisionAnalysis>): Validation<T> =>
  (output) =>
    Result.map(validate(output.analysis), ({ value, notes }) => ({ value: { ...output, analysis: value }, notes }));

export function decisionSubject(k: number, phase: number, format: string, validate: Validation<DecisionAnalysis>): Subject<DecisionResponse, DecisionApplied> {
  const save = (analysis: DecisionAnalysis) =>
    Effect.gen(function* () {
      yield* (yield* Store).saveAnalysis(k, analysis);
    });
  const id: SubjectId = { decision: k };
  return {
    id,
    phase,
    heading: subjectHeading(id),
    fileLabel: "analysis.json",
    reviewPrompt: (round) => prompts.decisionReviewPrompt(format, k, round),
    respond: { prompt: (round) => prompts.decisionRespondPrompt(k, round), schema: S.DecisionResponse, after: (output) => save(output.analysis), capability: "records", validate: bothValidations(validatingField<DecisionResponse>(validate), userQuestionsValidation<DecisionResponse>()) },
    applyDecisions: { prompt: prompts.decisionApplyDecisionsPrompt(k), schema: S.DecisionApplied, after: (output) => save(output.analysis), validate: validatingField(validate) },
    amend: null,
    proceed: prompts.PROCEED_TO_CHOICE,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    onUnchanged: "corrective",
    disputesSettledBy: "user",
    prepare: null,
  };
}

/**
 * The work of execution phase k (the work review, plan 2.7): Codex reviews changes.diff and the project; an accepted
 * issue or a user decision leaves for a planning phase; there is no proceed choice; changes.diff is rewritten before
 * every round's review.
 */
export function workSubject(phase: number, withRequirements: boolean): Subject<PlannerResponse, PlanWrite> {
  const id = { work: phase };
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "changes.diff",
    reviewPrompt: (round) => prompts.workReviewPrompt(phase, round, withRequirements),
    respond: { prompt: (round, context) => prompts.workRespondPrompt(phase, round, context), schema: S.PlannerResponse, after: null, capability: "readOnly", validate: userQuestionsValidation() },
    // Never issued: leaveOnDecision ends the loop instead of a planning call (G-R1-1); typed as the plan's.
    applyDecisions: { prompt: prompts.planApplyDecisionsPrompt, schema: S.PlanWrite, after: null, validate: null },
    amend: null,
    proceed: null,
    leaveOnAcceptance: true,
    leaveOnDecision: true,
    onUnchanged: null,
    disputesSettledBy: "user",
    prepare: Effect.gen(function* () {
      const store = yield* Store;
      yield* store.changeRecord(phase);
    }),
  };
}
