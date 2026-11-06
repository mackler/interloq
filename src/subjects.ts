// The three subjects of the review procedure.

import { Effect, Option, Result } from "effect";
import { phaseOf, recordPath, type RunRoot, type SubjectId } from "./artifacts.ts";
import { interview } from "./conversation.ts";
import { termsValidation } from "./termsValidation.ts";
// Issue #142: the validations of the terms live in src/termsValidation.ts, which src/conversation.ts imports too.
export { requestedTermsValidation, termsValidation, withTermsEntry } from "./termsValidation.ts";
import type { RunError } from "./errors.ts";
import * as prompts from "./prompts.ts";
import type { ReviewThread } from "./reviewThread.ts";
import { renderQuestions, renderTerms, subjectHeading } from "./render.ts";
import type { ShownDocument } from "./reviewedDocument.ts";
import { bothValidations, questionsValidation, type Subject, userQuestionsValidation, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import type { DecisionAnalysis, DecisionApplied, DecisionResponse, Plan, PlannerResponse, PlanResponse, PlanWrite, PlanWriteResult, QuestionList, QuestionListResponse, QuestionsFile, RecordedPlan, TermsEntry, TermsResponse, TermsWrite } from "./schema.ts";
import { FindingsInvalid, QuestionInvalid, SkipConditionInvalid } from "./errors.ts";
import { findingsProblems, interviewedOf } from "./requirementsFindings.ts";
import { skipConditionProblems } from "./premises.ts";
import type { QuestionProblem, QuestionProblems } from "./prompts.ts";
import { sameBlocks, samePieces } from "./pieces.ts";
import { questionProblems } from "./question.ts";
import { validatePlan } from "./plan.ts";
import { normalizeQuestionList } from "./schemaNormalize.ts";
import { analysisTexts, planTexts, questionListTexts, termsTexts } from "./keptCorrections.ts";
import { type ReviewedTree, Store, Ui } from "./services.ts";
import type { VerdictRecord } from "./records.ts";
import { verdictResponseValidation, verdictValidation } from "./verdictValidation.ts";
import { issueApplyValidation, issueUpdateValidation, protectionAfterDecisions, protectionAfterResponse } from "./issueUpdate.ts";

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
      output.questions.map((e, i) => ({ where: e.id.trim() === "" ? `question ${i + 1}` : e.id, question: { context: e.context, history: e.history, question: e.question, explanations: [], options: e.proposed_answers, details: e.reason } })),
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

/**
 * A review loop over the question list (issue #166): its review, and Codex's reading of its questions' last sentences.
 * Claude Code returns the amended list, and the program writes it to questions.json; only the subject's id, its heading,
 * its review prompt and the prompts naming its own records differ.
 */
const questionListLoop = (task: string, id: prompts.QuestionListSubject, reviewPrompt: Subject<QuestionListResponse, QuestionList>["reviewPrompt"]): Subject<QuestionListResponse, QuestionList> => ({
  id,
  phase: phaseOf(id),
  heading: subjectHeading(id),
  fileLabel: "questions.json",
  reviewPrompt,
  respond: { prompt: (root, round) => prompts.questionRespondPrompt(root, round, id), schema: S.QuestionListResponse, after: (output) => writeQuestions(task, output), capability: "records", validate: bothValidations(questionListValidation<QuestionListResponse>(), userQuestionsValidation<QuestionListResponse>()) },
  applyDecisions: { prompt: (root) => prompts.questionApplyDecisionsPrompt(root, id), schema: S.QuestionList, after: (output) => writeQuestions(task, output), validate: questionListValidation() },
  amend: null,
  proceed: prompts.PROCEED_TO_CLARIFICATION,
  onAcceptance: "continue",
  leaveOnDecision: false,
  onUnchanged: "corrective",
  // Issue #112: a disagreement here about how a question to the user is worded is settled by the agents; one Claude
  // Code marks as about what the task requires is still the user's (issue #156).
  disputesSettledBy: "agents",
  reviewSchema: S.Review,
  reviewParts: null,
  prepare: null,
  keepsCorrections: { textsOf: (r) => questionListTexts(r.questions), entriesOf: (r) => r[S.CORRECTION_PASSAGES_FIELD] },
  document: Effect.map(Effect.flatMap(Store, (store) => store.loadQuestions()), (file): ShownDocument => ({ _tag: "Markdown", text: renderQuestions(file, "alt") })),
});

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(task: string): Subject<QuestionListResponse, QuestionList> {
  return questionListLoop(task, "questions", prompts.questionReviewPrompt);
}

/**
 * Issue #166 (requirements Q2): Codex's reading of each agreed question's last sentence on its own, once the question
 * review has ended with no counted issue; its rounds follow behavior 7 as the question list's do.
 */
export function questionReadingSubject(task: string): Subject<QuestionListResponse, QuestionList> {
  return questionListLoop(task, "questionReading", prompts.questionReadingPrompt);
}

/**
 * Issue #216: the issue brought up to date. Codex checks issue.json against the project; Claude Code returns the whole
 * title and text with every response, and the program validates them against the protection baseline as the records
 * hold it at that call (a loaded validation) and writes issue.json with the baseline advanced.
 */
export function updateSubject(): Subject<S.UpdateResponse, S.UpdateWrite> {
  const id = "update" as const;
  const protection = Effect.gen(function* () {
    const store = yield* Store;
    const before = yield* store.loadIssueBefore();
    const file = yield* store.loadIssue();
    return { protection: { before, protected: file.protected }, file };
  });
  const save = (output: Readonly<{ issue: S.UpdateResponse["issue"]; outcome: S.UpdateResponse["outcome"]; developer_passages: readonly string[] }>, protectedNow: readonly string[]) =>
    Effect.flatMap(Store, (store) => store.saveIssue({ version: 2, title: output.issue.title, text: output.issue.text, outcome: output.outcome, developer_passages: [...output.developer_passages], protected: [...protectedNow] }));
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "issue.json",
    reviewPrompt: prompts.updateCheckPrompt,
    respond: {
      prompt: prompts.updateRespondPrompt,
      schema: S.UpdateResponse,
      after: (output) => Effect.flatMap(protection, ({ protection: p }) => save(output, protectionAfterResponse(p, output))),
      capability: "records",
      validate: { _tag: "Loaded", load: Effect.map(protection, ({ protection: p }) => issueUpdateValidation(p)) },
    },
    applyDecisions: {
      prompt: prompts.updateApplyDecisionsPrompt,
      schema: S.UpdateWrite,
      after: (output) => Effect.flatMap(protection, ({ protection: p }) => save(output, protectionAfterDecisions(p, output))),
      validate: { _tag: "Loaded", load: Effect.map(protection, ({ protection: p, file }) => issueApplyValidation(p, file)) },
    },
    amend: null,
    proceed: prompts.PROCEED_WITHOUT_UPDATE,
    onAcceptance: "continue",
    leaveOnDecision: false,
    onUnchanged: "corrective",
    // Q4: a disagreement about a fact of the code is settled by the agents; one Claude Code marks as about what the
    // developer asked for is his if Codex raises it again (issue #156).
    disputesSettledBy: "agents",
    reviewSchema: S.Review,
    reviewParts: null,
    prepare: null,
    keepsCorrections: null,
    document: Effect.gen(function* () {
      const store = yield* Store;
      const file = yield* store.loadIssue();
      const accepted = (yield* store.loadLog(id)).filter((e) => e.source === "review" && !e.superseded && (e.action === "accepted" || e.action === "partially_accepted"));
      const why = accepted.length === 0 ? "" : `\n\n## Corrections\n\n${accepted.map((e) => `- **${e.id}:** ${e.problem} — ${e.rationale}`).join("\n")}`;
      return { _tag: "Markdown", text: `# ${file.title}\n\n${file.text}${why}` } satisfies ShownDocument;
    }),
  };
}

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
    onAcceptance: "continue",
    leaveOnDecision: false,
    onUnchanged: "corrective",
    // Issue #112: a disagreement here about how a question to the user is worded is settled by the agents; one Claude
    // Code marks as about what the task requires is still the user's (issue #156).
    disputesSettledBy: "agents",
    reviewSchema: S.Review,
    reviewParts: null,
    prepare: null,
    keepsCorrections: { textsOf: (r) => termsTexts(r.entries), entriesOf: (r) => r[S.CORRECTION_PASSAGES_FIELD] },
    document: Effect.gen(function* () {
      const entries = yield* (yield* Store).loadTerms();
      return { _tag: "Markdown", text: yield* Effect.fromResult(renderTerms(entries, "alt")) } satisfies ShownDocument;
    }),
  };
}

/** Issue #47: the validation of the classification of the requirements review's accepted findings against requirements.md as it stands. */
export const findingsValidation =
  (current: string): Validation<S.RequirementsResponse> =>
  (output) => {
    const problems = findingsProblems(output.dispositions, output.findings, output.requirements, current);
    return problems.length > 0 ? Result.fail({ error: new FindingsInvalid({ problems }), repair: prompts.findingsRepairPrompt(problems) }) : Result.succeed({ value: output, notes: [] });
  };

/** Issue #47: requirements.md amended outside an interview, the one mechanism a response and the application of decisions share. */
const writeRequirements = (requirements: string | null): Effect.Effect<void, RunError, Store> =>
  requirements === null ? Effect.void : Effect.flatMap(Store, (store) => store.writeRequirements(requirements.trimEnd() + "\n"));
/** requirements.md as it stands, "" where it does not exist. */
const currentRequirements: Effect.Effect<string, RunError, Store> = Effect.map(Effect.flatMap(Store, (store) => store.readContext()), ({ requirements }) => requirements ?? "");

/**
 * The interview's result, written from Claude Code's summary. Issue #47: Claude Code classifies each accepted finding of
 * its review (`findings`); the answers the user already gave and the corrections that need none are written into
 * requirements.md from the response, and only the unresolved and the reopened findings are put to the user in a second
 * interview, so where every finding is answered or corrected the requirements are reviewed again with no interview.
 */
export function requirementsSubject(): Subject<S.RequirementsResponse, S.RequirementsWrite> {
  const id = "requirements" as const;
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "requirements.md",
    reviewPrompt: prompts.requirementsReviewPrompt,
    respond: {
      prompt: prompts.requirementsRespondPrompt,
      schema: S.RequirementsResponse,
      after: (output) =>
        Effect.gen(function* () {
          const ui = yield* Ui;
          const store = yield* Store;
          for (const finding of output.findings) {
            const line = prompts.requirementsFindingLine(finding);
            yield* ui.say(line);
            yield* store.converse(`${line}\n\n`);
          }
          yield* writeRequirements(output.requirements);
        }),
      capability: "records",
      validate: { _tag: "Loaded", load: Effect.map(currentRequirements, (current) => bothValidations(findingsValidation(current), userQuestionsValidation<S.RequirementsResponse>())) },
    },
    applyDecisions: { prompt: prompts.requirementsApplyDecisionsPrompt, schema: S.RequirementsWrite, after: (output) => writeRequirements(output.requirements), validate: null },
    amend: (_review, response, round) =>
      Effect.gen(function* () {
        const interviewed = interviewedOf(response.findings);
        if (interviewed.length === 0) return;
        const { root } = yield* Store;
        yield* interview(
          prompts.interviewGapsPrompt(root, recordPath(root, { kind: "review", subject: id, round }), interviewed),
          interviewed.map((f) => f.id),
        );
      }),
    proceed: prompts.PROCEED_TO_PLANNING,
    onAcceptance: "continue",
    leaveOnDecision: false,
    // Issue #47: findingsValidation requires a changed document wherever a finding is answered or corrected, so the
    // unchanged pause arises only where the interviewed findings left the file as it was; its Retry is another interview.
    onUnchanged: "pause",
    disputesSettledBy: "user",
    reviewSchema: S.Review,
    reviewParts: null,
    prepare: null,
    keepsCorrections: null,
    document: Effect.map(Effect.flatMap(Store, (store) => store.readContext()), ({ requirements }): ShownDocument | null => (requirements === null ? null : { _tag: "Markdown", text: requirements })),
  };
}

/**
 * The plan of planning phase k (issue #6, F1): Claude Code returns the whole plan with every write and every response, the
 * program validates it against `previous`, the plan as it stood when the phase began (G-R1-1: its done steps and its
 * statuses do not change within a planning phase), and writes plan.json and plan.md.
 */
/** `parkedBranch` (issue #186): the parked earlier run's branch the phase's plan starts from, which its review names. */
export function planSubject(root: RunRoot, phase: number, withRequirements: boolean, previous: RecordedPlan | null, checks: S.StepChecks, parkedBranch: string | null = null): Subject<PlanResponse, PlanWrite> {
  const id = { plan: phase };
  const validate = planValidation(root, previous);
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: prompts.PLAN_FILE_LABEL,
    reviewPrompt: (root, round, thread) => prompts.planReviewPrompt(root, phase, round, withRequirements, checks, thread, parkedBranch),
    respond: { prompt: (root, round) => prompts.planRespondPrompt(root, phase, round, checks), schema: S.PlanResponse, after: (output) => savePlan(phase, output.plan, previous), capability: "records", validate: bothValidations(planField<PlanResponse>(validate), userQuestionsValidation<PlanResponse>()) },
    applyDecisions: { prompt: (root) => prompts.planApplyDecisionsPrompt(root, checks, phase), schema: S.PlanWrite, after: (output) => savePlan(phase, output.plan, previous), validate: bothValidations(planField<PlanWrite>(validate), userQuestionsValidation<PlanWrite>()) },
    amend: null,
    proceed: prompts.PROCEED_TO_IMPLEMENTATION,
    onAcceptance: "continue",
    leaveOnDecision: false,
    onUnchanged: "corrective",
    disputesSettledBy: "noWorkEffect",
    reviewSchema: S.EffectReview,
    reviewParts: null,
    prepare: null,
    keepsCorrections: { textsOf: (r) => planTexts(r.plan), entriesOf: (r) => r[S.CORRECTION_PASSAGES_FIELD] },
    document: Effect.map(Effect.flatMap(Store, (store) => store.readContext()), ({ plan }): ShownDocument | null => (plan === null ? null : { _tag: "Markdown", text: plan })),
  };
}

/** The validation of a plan against the plan as the phase began (G-R1-1), with the repair turn's prompt. */
export const planValidation =
  (root: RunRoot, previous: RecordedPlan | null): Validation<Plan> =>
  (plan) => {
    const validated = validatePlan(previous, plan);
    return Result.isFailure(validated) ? Result.fail({ error: validated.failure, repair: prompts.planRepairPrompt(root, validated.failure) }) : Result.succeed({ value: plan, notes: validated.success.notes });
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
    reviewPrompt: (root, round, thread) => prompts.decisionReviewPrompt(root, format, k, round, thread),
    respond: { prompt: (root, round) => prompts.decisionRespondPrompt(root, k, round), schema: S.DecisionResponse, after: (output) => save(output.analysis), capability: "records", validate: bothValidations(validatingField<DecisionResponse>(validate), userQuestionsValidation<DecisionResponse>()) },
    applyDecisions: { prompt: (root) => prompts.decisionApplyDecisionsPrompt(root, k), schema: S.DecisionApplied, after: (output) => save(output.analysis), validate: validatingField(validate) },
    amend: null,
    proceed: prompts.PROCEED_TO_CHOICE,
    onAcceptance: "continue",
    leaveOnDecision: false,
    onUnchanged: "corrective",
    disputesSettledBy: "user",
    reviewSchema: S.Review,
    reviewParts: null,
    prepare: null,
    keepsCorrections: { textsOf: (r) => analysisTexts(r.analysis), entriesOf: (r) => r[S.CORRECTION_PASSAGES_FIELD] },
    document: Effect.map(Effect.flatMap(Store, (store) => store.loadAnalysis(k)), (analysis): ShownDocument => ({ _tag: "Analysis", analysis })),
  };
}

/**
 * The work of execution phase k (the work review, plan 2.7): Codex reviews changes.diff and the project; an accepted
 * issue or a user decision leaves for a planning phase; there is no proceed choice; changes.diff is rewritten before
 * every round's review.
 */
/** Issue #252: the earlier code review a code review's change since starts from, as its prompt names it. */
const sinceOf = (since: ReviewedTree | null): prompts.SinceReview => (since === null ? null : { review: since.review });
/**
 * `since` (issue #252): the tree the latest earlier code review read, from which work-review-<phase>/since-previous.diff
 * is written; null for code review 1 or where none is left. Each cycle is one Codex request over the whole work and one
 * per step recorded done in plan.json, in plan order.
 */
export function workSubject(task: string, phase: number, withRequirements: boolean, execution: prompts.WorkExecution, checks: S.StepChecks, since: ReviewedTree | null): Subject<S.WorkResponse, PlanWrite> {
  const id = { work: phase };
  const promptOf = (part: prompts.ReviewPart) => (root: RunRoot, round: number, thread: ReviewThread) => prompts.workReviewPrompt(root, phase, round, withRequirements, execution, thread, part, sinceOf(since));
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "changes.diff",
    reviewPrompt: promptOf({ _tag: "Whole" }),
    respond: { prompt: (root, round, context) => prompts.workRespondPrompt(root, phase, round, context, execution, task), schema: S.WorkResponse, after: null, capability: "readOnly", validate: userQuestionsValidation() },
    // Never issued: leaveOnDecision ends the loop instead of a planning call (G-R1-1); typed as the plan's.
    applyDecisions: { prompt: (root) => prompts.planApplyDecisionsPrompt(root, checks), schema: S.PlanWrite, after: null, validate: null },
    amend: null,
    proceed: null,
    // Issue #252 (requirements Q1): every finding of every cycle before it leaves.
    onAcceptance: "collect",
    leaveOnDecision: true,
    onUnchanged: null,
    disputesSettledBy: "noWorkEffect",
    reviewSchema: S.EffectReview,
    // Issue #252 (requirements Q2): the whole work first, then each step recorded done; an execution that completed no
    // step is still reviewed by the whole-work request.
    reviewParts: Effect.gen(function* () {
      const plan = yield* (yield* Store).loadPlan();
      const done = Option.match(plan, { onNone: () => [], onSome: (p) => p.stages.flatMap((stage) => stage.steps.filter((st) => st.status === "done")) });
      const parts: readonly prompts.ReviewPart[] = [{ _tag: "Whole" }, ...done.map((st): prompts.ReviewPart => ({ _tag: "Step", id: st.id, label: st.label, text: st.text }))];
      return parts.map((part) => ({ part, prompt: promptOf(part) }));
    }),
    prepare: Effect.gen(function* () {
      const store = yield* Store;
      yield* store.changeRecord(phase, since);
    }),
    keepsCorrections: null,
    document: Effect.map(Effect.flatMap(Store, (store) => store.readChangeRecord(phase)), (text): ShownDocument => ({ _tag: "Diff", text })),
  };
}

/**
 * Verdict n (issue #186, requirements Q2): Claude Code's verdict that the item is not refined, given in place of the
 * run's first plan or at the end of an execution phase, reviewed by Codex in rounds. A round in which Claude Code accepts
 * an objection ends the loop with revise, which the run reads as the verdict withdrawn; a decision of the developer at a
 * pause does too, except one that keeps Claude Code's position, which is recorded and logged and does not leave the loop
 * (standsWithPlanner, as in the work review); a loop that converges means the verdict stands. A disagreement that
 * persists reaches the developer, as a disputed plan review does.
 */
export function verdictSubject(n: number, phase: number, phaseRecord: VerdictRecord["phase"], origin: prompts.VerdictOrigin, withRequirements: boolean): Subject<S.VerdictResponse, S.PlanOnly> {
  const id = { verdict: n };
  const recordOrigin: VerdictRecord["origin"] = origin._tag === "FirstPlan" ? "firstPlan" : "execution";
  return {
    id,
    phase,
    heading: subjectHeading(id),
    fileLabel: "verdict.json",
    reviewPrompt: (root, round, thread) => prompts.verdictReviewPrompt(root, n, round, withRequirements, thread),
    respond: {
      prompt: (root, round) => prompts.verdictRespondPrompt(root, n, round, origin),
      schema: S.VerdictResponse,
      after: (output) => Effect.flatMap(Store, (store) => store.saveVerdict(n, { missing: output.missing, phase: phaseRecord, origin: recordOrigin })),
      capability: "records",
      validate: verdictResponseValidation(),
    },
    // Never issued: leaveOnDecision ends the loop instead of a planning call.
    applyDecisions: { prompt: (root) => prompts.planApplyDecisionsPrompt(root, S.NO_STEP_CHECKS), schema: S.PlanOnly, after: null, validate: null },
    amend: null,
    proceed: null,
    onAcceptance: "leave",
    leaveOnDecision: true,
    onUnchanged: null,
    disputesSettledBy: "user",
    reviewSchema: S.Review,
    reviewParts: null,
    prepare: null,
    keepsCorrections: null,
    document: Effect.map(Effect.flatMap(Store, (store) => store.loadVerdict(n)), (record): ShownDocument => ({ _tag: "Markdown", text: record.missing })),
  };
}

/**
 * The validation of the run's first planning call's reply (issue #186): a plan's (planValidation), or the verdict's
 * (verdictValidation), each with the validation repair turn of behavior 10.
 */
export const firstPlanValidation =
  (root: RunRoot, previous: RecordedPlan | null): Validation<S.FirstPlanReply> =>
  (output) => {
    const reply = output.reply;
    if (reply.kind === "plan") return Result.map(planValidation(root, previous)(reply.plan), ({ value, notes }) => ({ value: { reply: { ...reply, plan: value } }, notes }));
    return Result.map(verdictValidation<S.NotRefinedVerdict>()(reply), ({ value, notes }) => ({ value: { reply: value }, notes }));
  };
