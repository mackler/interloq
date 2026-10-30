// The complete run: planning phase K, execution phase K and work review K, until Claude Code reports
// 'finished' and the work review converges.

import { Clock, Effect, Exit, Fiber, Option, Queue, Ref, Result } from "effect";
import { NEW_SANITIZER, type ProcessKey, processKeyOf, type Sanitizer, sanitizeChunk } from "./liveOutput.ts";
import { commentDateOf, commentText, runCommentKey } from "./itemComments.ts";
import { observingQuestions } from "./questionsSeen.ts";
import { rootName } from "./park.ts";
import { type Refinement, refinementOf } from "./refinement.ts";
import { stateAtEnd, stateAtStart } from "./runMode.ts";
import type { ItemId } from "./tracker.ts";
import { describe, isTrackerError, NotRefinedStopped, type RunError, SuiteStopped, TrackerStepFailed, trackerFailureText } from "./errors.ts";
import { executionSteps } from "./planSteps.ts";
import { renderPlanMarkdown, type StepRecords, stepRecordsOf } from "./plan.ts";
import { askAgreed, questionPhase } from "./interview.ts";
import { type PreparationFound, preparationOf } from "./preparedComments.ts";
import { renderQuestions } from "./render.ts";
import { type EarlierPlan, undonePlan } from "./earlierPlan.ts";
import { PREPARED_TERMS_CHOICE_LINE, preparationCleanupFailedLine, preparationUsedLine, continuingLine, earlierPlanPrompt, type FirstPlanCause, parkedBranchFirstStepRule, planAfterVerdictPrompt, verdictGivenLine, verdictStandsLine, verdictWithdrawnLine, earlierParkingIncompleteLine, earlierPlanSetAsideLine, earlierPlanTakenLine, earlierRunParkedLine, parkedMergedLine, parkedMergeConflictLine, executionContinuingPrompt, itemStartedLine, NOTHING_TO_SETTLE, refinementInvalidText, refinementWrittenLine, requirementsKeptText, type TrackerStep, processEndedQuestion, processEndedRemaining, processEndedSummary, executePrompt, implementationBeganLine, implementationEndedLine, initialPlanPrompt, planningBeganLine, planNotEndedLine, workReviewBeganLine, revisePlanAfterExecutionPrompt, type ExecStop, execStopRevisionLine, type RevisionCause, suiteBeganLine, suiteFailedLine, suiteFailureText, suitePassedLine, suiteRepeatLine, suiteStoppedDetails, suiteStoppedFacts, SUITE_OUTPUT_NAME,
  suiteStoppedHistory, suiteStoppedLine, suiteStoppedQuestion, transportPrompt, uncommittedLine, type WorkExecution } from "./prompts.ts";
import { recordPath, type RunRoot } from "./artifacts.ts";
import type { Baseline } from "./records.ts";
import { plainPieces } from "./pieces.ts";
import { applyDecisions, askPlannerQuestion, bothValidations, planningCall, reviewLoop, userQuestionsValidation } from "./review.ts";
import { askOffering, byLine, programContext, type QuestionDraft, suiteStoppedOptions } from "./offer.ts";
import { parseTransportAnswer } from "./input.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import * as S from "./schema.ts";
import { Decider, Planner, type PlannerShape, RunConfig, type Services, type StepReporter, Store, type StoreError, SuiteRunner, Tracker, type TrackerShape, Ui } from "./services.ts";
import { readCommentsWithRetry, runTrackerEnv, type TrackerRetryEnv, type TrackerWrite, unattendedTrackerEnv, writeWithRetry } from "./trackerRetry.ts";
import { countOfKind, foreseenPhases as foreseen, type Iteration, iterationsOf, type NumberedPhaseKind, type Phase, phaseName } from "./uiEvents.ts";
import { SUITE_TAIL_LINES, type SuiteResult, type SuiteStop, suiteOutcomeOf, suiteStatusOf, suiteVerdictOf, tailLines } from "./suite.ts";
import { firstPlanValidation, planField, planSubject, planValidation, savePlan, verdictSubject, workSubject } from "./subjects.ts";
import { type SentBack, sendBack } from "./sendBack.ts";

/**
 * A refinement run (issue #120, the developer's decision of 8 Oct 2026): the question phase and nothing after it. It sets no
 * state when it starts; when the question phase has written requirements.md, it writes that text back to the item as its
 * section Refined using Interloq and sets the item to refined. A tracker step that fails halts with TrackerStepFailed: the
 * records stand, and no state that was not written is claimed. A halted or stopped refinement sets nothing, and the item
 * stays unrefined.
 */
/** The preparation a refinement run uses (issue #131): a current, complete, unspent one, as preparationOf found it. */
export type UsedPreparation = Extract<PreparationFound, { _tag: "Prepared" }>;

/**
 * Issue #131: the question phase of a prepared item. The questions and terms Codex reviewed are written as this run's
 * questions.json and terms.json unchanged, the preparation and the terms choice's having no effect are said and
 * recorded, and the agreed questions are asked at once (askAgreed); a preparation with no question writes the
 * requirements with no agent call (behavior 2, issue #83).
 */
const preparedPhase = (task: string, prepared: UsedPreparation): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "questions" } });
    for (const line of [preparationUsedLine(prepared.key), PREPARED_TERMS_CHOICE_LINE]) {
      yield* store.converse(`${line}\n\n`);
      yield* ui.say(line);
    }
    yield* store.saveQuestions(task, prepared.questions);
    if (prepared.questions.length > 0) yield* store.saveTerms(prepared.terms);
    yield* store.converse(`## Agreed question list\n\n${renderQuestions({ questions: prepared.questions })}\n`);
    yield* askAgreed(task, prepared.questions, { kind: "never" });
  });

/**
 * Issue #131: after the item was refined, every preparation comment on it is deleted, through the tracker retry with
 * no question; a deletion that fails for good is said and recorded and does not halt the run, whose section, record and
 * state are written, and a leftover is never used again, since the refinement's record follows it (Spent).
 */
const deletePreparations = (tracker: TrackerShape, item: ItemId, env: TrackerRetryEnv): Effect.Effect<void, never, Store | Ui> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const unattended = unattendedTrackerEnv(env);
    const deleted = yield* Effect.result(
      Effect.flatMap(readCommentsWithRetry(tracker, item, unattended), (comments) =>
        Effect.forEach(preparationOf(comments, { title: "", body: "" }, null).ids, (comment) => writeWithRetry(tracker, { kind: "deleteComment", item, comment }, unattended), { discard: true }),
      ),
    );
    if (Result.isSuccess(deleted)) return;
    const failure = deleted.failure;
    const line = preparationCleanupFailedLine(item, failure._tag === "TrackerWriteFailed" ? trackerFailureText(failure.error) : isTrackerError(failure) ? trackerFailureText(failure) : describe(failure));
    yield* ui.say(line);
    yield* store.converse(`${line}\n\n`).pipe(Effect.ignore);
  });

export const refinementRun = (task: string, item: ItemId, terms: S.TermsMode, held: readonly string[] = [], prepared: UsedPreparation | null = null): Effect.Effect<void, RunError, Services | Tracker> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const decider = yield* Decider;
    const tracker = yield* Tracker;
    const phase: Phase = { kind: "questions" };
    yield* store.init(task);
    yield* converseHeld(held);
    yield* store.converse(`${itemStartedLine("refinement", item, firstLine(task))}\n\n`);
    yield* ui.notify({ _tag: "ModelNamed", model: { agent: "codex", name: config.codexModel } });
    yield* ui.notify({ _tag: "PhasesForeseen", phases: foreseen("refinement", iterationsOf(1)) });
    // Issue #186 (requirements Q5): whether the developer was presented any question, which the item's record keeps.
    const asked = yield* Ref.make(false);
    yield* (prepared === null ? questionPhase(task, terms) : preparedPhase(task, prepared)).pipe(Effect.provideService(Decider, decider.at(phase, phaseName(phase, 1))), Effect.provideService(Ui, observingQuestions(ui, asked)));
    // Issue #83: an empty agreed list is no failure; a refinement that asks nothing found nothing to settle.
    if ((yield* store.loadQuestions()).questions.length === 0) {
      yield* store.converse(`${NOTHING_TO_SETTLE}\n\n`);
      yield* ui.say(NOTHING_TO_SETTLE);
    }
    const { requirements } = yield* store.readContext();
    const kept = requirementsKeptText(store.requirements);
    const refinement = refinementOf(requirements ?? "");
    if (Result.isFailure(refinement)) return yield* Effect.fail(new TrackerStepFailed({ item, step: "writeRefinement", cause: refinementInvalidText(refinement.failure.reason, store.requirements), done: kept, check: null }));
    // Issue #171: the write-back closes the question phase, so its exhaustion question's decision is bound to that phase.
    const env = yield* runTrackerEnv.pipe(Effect.provideService(Decider, decider.at(phase, phaseName(phase, 1))));
    yield* writeStep(tracker, { kind: "writeRefinement", item, refinement: refinement.success }, env, "writeRefinement", kept);
    // Issue #186: the record before the state, so an item is never labeled refined without it.
    const key = runCommentKey(rootName(store.root));
    const record = commentText({ _tag: "RefinementRecord", key, date: commentDateOf(yield* Clock.currentTimeMillis), asked: yield* Ref.get(asked) });
    yield* writeStep(tracker, { kind: "comment", item, text: record, key }, env, "recordRefinement", kept);
    yield* writeStep(tracker, { kind: "setState", item, state: stateAtEnd("refinement") }, env, "setRefined", kept);
    yield* ui.say(refinementWrittenLine(item, store.requirements));
    yield* deletePreparations(tracker, item, env);
  });

/**
 * A write of a run to its item through the tracker retry (issue #171); one that fails for good halts with
 * TrackerStepFailed, naming the step, the cause and what the item held after the last attempt.
 */
const writeStep = (tracker: TrackerShape, write: TrackerWrite, env: TrackerRetryEnv, step: TrackerStep, done: string | null): Effect.Effect<void, RunError> =>
  writeWithRetry(tracker, write, env).pipe(
    Effect.catchTag("TrackerWriteFailed", (e) => Effect.fail(new TrackerStepFailed({ item: write.item, step, cause: trackerFailureText(e.error), done, check: e.check }))),
  );

/**
 * The records of the run's first read of its item, held until conversation.md exists (issue #171, requirements Q3):
 * written right after it is created, so that the record is in the order of events.
 */
const converseHeld = (held: readonly string[]): Effect.Effect<void, RunError, Store> =>
  Effect.flatMap(Store, (store) => Effect.forEach(held, (markdown) => store.converse(markdown), { discard: true }));

/** The first line of a task: an item's title (taskTextOf puts it first). */
const firstLine = (task: string): string => task.split("\n")[0] ?? "";

/**
 * An implementation run (issue #120, the developer's decisions of 8 Oct 2026): no question phase. It sets its item to
 * implementing before any agent call, writes the item's section Refined using Interloq to its own requirements.md where
 * the item has one (then the plan, the work review and the execution follow it, as after a question phase), plans,
 * executes and reviews, and sets the item to implemented when the run finishes. A run that halts or is stopped sets
 * nothing more, and Interloq never moves an item backward. Succeeds with the number of execution phases.
 */
export const implementationRun = (task: string, item: ItemId, requirements: Refinement | null, checks: S.StepChecks, held: readonly string[] = []): Effect.Effect<ImplementationEnd, RunError, Services | Tracker | SuiteRunner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    yield* store.init(task);
    yield* converseHeld(held);
    yield* store.converse(`${itemStartedLine("implementation", item, firstLine(task))}\n\n`);
    const env = yield* runTrackerEnv;
    const atStart = stateAtStart("implementation");
    if (atStart !== null) yield* writeStep(tracker, { kind: "setState", item, state: atStart }, env, "setImplementing", null);
    if (requirements !== null) yield* store.writeRequirements(requirements);
    // Issue #180 (Q1): the plan of the newest earlier run of the item whose plan review ended in agreement, without
    // asking; after the requirements, so that the revision is written for the item's section as it stands now (Q5).
    const earlier = yield* store.earlierPlan(item);
    const start: PlanStart = yield* planStartOf(earlier);
    const ended = yield* implementationPhases(task, requirements !== null, checks, start);
    // Issue #186: a verdict that stood sends the item back, its work parked, instead of setting it implemented.
    if (ended._tag === "NotRefined") return { _tag: "SentBack", verdict: ended.verdict, ...(yield* sendBack(item, ended.verdict, ended.missing)) } as const;
    yield* writeStep(tracker, { kind: "setState", item, state: stateAtEnd("implementation") }, env, "setImplemented", null);
    return ended;
  });

/** The planning, execution and review of a task without a tracker item: the implementation run's phases after a new records directory. */
export const run = (task: string, checks: S.StepChecks = S.NO_STEP_CHECKS): Effect.Effect<ImplementationEnd, RunError, Services | SuiteRunner> =>
  Effect.gen(function* () {
    yield* (yield* Store).init(task);
    const ended = yield* implementationPhases(task, false, checks, { _tag: "Fresh" });
    // Issue #186: without a tracker there is no item to send back.
    if (ended._tag === "NotRefined") return yield* Effect.fail(new NotRefinedStopped({ item: null, missing: ended.missing, reason: "noTracker", park: null }));
    return ended;
  });

/** Where an implementation run's planning starts, from what the Store found of the item's earlier runs, with its line said and written. */
const planStartOf = (earlier: EarlierPlan): Effect.Effect<PlanStart, StoreError, Ui | Store> => {
  switch (earlier._tag) {
    case "NoEarlierPlan":
      return Effect.succeed({ _tag: "Fresh" });
    case "EarlierPlanTaken":
      return sayAndWrite(earlierPlanTakenLine(earlier.root)).pipe(Effect.as({ _tag: "Earlier", root: earlier.root, plan: earlier.plan, baseline: earlier.baseline } as const));
    case "EarlierPlanSetAside":
      return sayAndWrite(earlierPlanSetAsideLine(earlier.root)).pipe(Effect.as({ _tag: "Fresh" } as const));
    case "EarlierRunParked": {
      // Issue #186 (Q6, review P1-R2-1): an incomplete parking's branch is not trusted.
      if (earlier.parking === "incomplete") return sayAndWrite(earlierParkingIncompleteLine(earlier.root, earlier.branch)).pipe(Effect.as({ _tag: "Fresh" } as const));
      switch (earlier.ending) {
        // Issue #185 (F1): a halted or abandoned run's branch is merged at the start, and its agreed plan taken.
        case "halted":
        case "abandoned":
          return Effect.succeed({ _tag: "ParkedMerge", root: earlier.root, branch: earlier.branch, plan: earlier.plan } as const);
        // Issue #186 (Q6): a sent-back item was refined again, so its plan starts afresh from the branch.
        case "sentBack":
        case "stoppedUnrefined":
          return sayAndWrite(earlierRunParkedLine(earlier.root, earlier.branch)).pipe(Effect.as({ _tag: "ParkedBranch", root: earlier.root, branch: earlier.branch } as const));
      }
    }
  }
};

/** A line said on the page and written to conversation.md (issues #162, #176, #180). */
const sayAndWrite = (line: string): Effect.Effect<void, StoreError, Ui | Store> =>
  Effect.gen(function* () {
    yield* (yield* Ui).say(line);
    yield* (yield* Store).converse(`${line.trim()}\n\n`);
  });

/**
 * Where planning phase 1 starts (issue #180): from nothing, or from an earlier run's plan, its statuses carried, with
 * that run's baseline, which this run adopts (Q4).
 */
export type PlanStart =
  | Readonly<{ _tag: "Fresh" }>
  | Readonly<{ _tag: "Earlier"; root: RunRoot; plan: S.RecordedPlan; baseline: Baseline }>
  /** Issue #186 (Q6): from nothing, with this run's own baseline, the plan's first step bringing the earlier run's parked branch onto the working branch. */
  | Readonly<{ _tag: "ParkedBranch"; root: RunRoot; branch: string }>
  /**
   * Issue #185 (F1): a halted or abandoned run's parked branch, merged into the working branch after this run's own
   * baseline is written, with that run's agreed plan, or null where its plan review did not agree.
   */
  | Readonly<{ _tag: "ParkedMerge"; root: RunRoot; branch: string; plan: S.RecordedPlan | null }>;
/** Why a planning phase writes or revises the plan: the first plan, a plan taken from an earlier run (issue #180), or a revision. */
export type PlanningCause = FirstPlanCause | RevisionCause;
/** The prompt of planning phase k for its cause. */
const planningPrompt = (root: RunRoot, task: string, withRequirements: boolean, k: number, cause: PlanningCause, checks: S.StepChecks): string => {
  switch (cause._tag) {
    case "FirstPlan":
      return initialPlanPrompt(root, task, withRequirements, checks);
    case "EarlierPlan":
      return earlierPlanPrompt(root, task, withRequirements, cause.root, checks, cause.merge);
    case "ParkedBranch":
      return initialPlanPrompt(root, task, withRequirements, checks, parkedBranchFirstStepRule(cause.branch));
    case "ExecutionEnded":
    case "SuiteFailed":
    case "Uncommitted":
    case "VerdictWithdrawn":
      return revisePlanAfterExecutionPrompt(root, task, withRequirements, k - 1, cause, checks);
  }
};

/**
 * Planning phase K, execution phase K and work review K, until Claude Code reports 'finished' and the work review
 * converges; succeeds with the number of execution phases. `withRequirements`: the run's requirements.md exists.
 */
/**
 * A phase whose last call's Claude Code process ended on every attempt (issue #157), with the checks its earlier calls
 * reported (issue #162, W1-R1-1): the call that ended has no report and so no checks of its own.
 */
type PhaseProcessEnded = Readonly<{ status: "processEnded"; ending: S.ExecProcessEnded; checks: ReadonlyArray<S.StepCheckRun> }>;

/**
 * One execution phase's calls on its own planner (issue #154, decisions Q2 and Q3): a call that ends with status
 * continuing is followed by another in the same session, told to go on with the work it reported left, said on the page
 * and written to conversation.md, with no question and no limit; the phase's outcome is the first other outcome.
 */
const continuedExecution = (executor: PlannerShape, prompt: string, report: StepReporter, phaseLabel: string, earlier: ReadonlyArray<S.StepCheckRun> = []): Effect.Effect<S.ExecOutcome | PhaseProcessEnded, RunError, Decider | Ui | Store> =>
  Effect.gen(function* () {
    const outcome = yield* executor.executing(prompt, report);
    // Issue #162: a continued phase reports the checks of all its calls.
    if (outcome.status === "processEnded") return { status: "processEnded", ending: outcome, checks: earlier };
    if (outcome.status !== "continuing") return { ...outcome, checks: [...earlier, ...outcome.checks] };
    const line = continuingLine(phaseLabel, outcome.remainingWork);
    yield* (yield* Ui).say(line);
    yield* (yield* Store).converse(`${line}\n\n`);
    return yield* continuedExecution(executor, executionContinuingPrompt(outcome.remainingWork), report, phaseLabel, [...earlier, ...outcome.checks]);
  });

/**
 * An execution call whose Claude Code process ended on every attempt (issue #157, decision Q2) as the phase's outcome:
 * aborted, so that it takes the stop's path, its summary and remaining work the steps recorded as done and left
 * unfinished, which the revision prompt carries (issue #181).
 */
const processEndedStop = (ended: PhaseProcessEnded, records: StepRecords): S.ExecOutcome => ({
  status: "aborted",
  summary: processEndedSummary(records.done),
  question: processEndedQuestion(ended.ending.end, ended.ending.attempts),
  remainingWork: processEndedRemaining(records.unfinished),
  userInput: null,
  checks: ended.checks,
});

/** How the implementation phases ended (issue #186): the run finished, or a verdict that the item is not refined stood. */
export type PhasesEnd = Readonly<{ _tag: "Finished"; phases: number }> | Readonly<{ _tag: "NotRefined"; missing: string; verdict: number }>;
/** How an implementation run ended when it did not halt: finished, or its item sent back to refinement (issue #186). */
export type ImplementationEnd = Readonly<{ _tag: "Finished"; phases: number }> | (Readonly<{ _tag: "SentBack"; verdict: number }> & SentBack);

/** A cause of the run's first planning call, whose reply may be the verdict (issue #186), or null for a revision. */
const firstCauseOf = (cause: PlanningCause): FirstPlanCause | null => {
  switch (cause._tag) {
    case "FirstPlan":
    case "EarlierPlan":
    case "ParkedBranch":
      return cause;
    case "ExecutionEnded":
    case "SuiteFailed":
    case "Uncommitted":
    case "VerdictWithdrawn":
      return null;
  }
};

const implementationPhases = (task: string, withRequirements: boolean, checks: S.StepChecks, start: PlanStart): Effect.Effect<PhasesEnd, RunError, Services | SuiteRunner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const planner = yield* Planner;
    const decider = yield* Decider;
    /** A phase's body, with the Decider of that phase: a decision taken in it is recorded in it (D3). */
    // W1-R1-2: the Decider names the phase as its phase line does, by the phases known when the phase begins.
    const inPhase = (phase: Phase) => <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => Effect.provideService(body, Decider, decider.at(phase, phase.kind === "questions" ? phaseName(phase, 1) : label(phase.kind, phase.n))));
    /**
     * Issue #122 (Q1): a planning phase's or a work review's body on a Claude Code session of its own, which every call of
     * the phase reaches through the Planner service (its repair and corrective turns included), and which ends with it.
     */
    const ownSession = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Planner>> =>
      Effect.flatMap(planner.fresh, (session) => Effect.provideService(body, Planner, session));
    // The baseline of the work reviews (Q7); a refinement run, which has none, writes none (issue #120). A run that takes
    // an earlier run's plan adopts that run's baseline (issue #180, Q4) and starts from that plan (Q3).
    const firstCause: PlanningCause = yield* Effect.gen(function* () {
      switch (start._tag) {
        case "Fresh":
          yield* store.writeBaseline();
          return { _tag: "FirstPlan" } as const;
        case "Earlier":
          yield* store.adoptBaseline(start.baseline);
          yield* store.savePlan(start.plan);
          return { _tag: "EarlierPlan", root: start.root } as const;
        case "ParkedBranch":
          yield* store.writeBaseline();
          return { _tag: "ParkedBranch", root: start.root, branch: start.branch } as const;
        case "ParkedMerge": {
          // Issue #185 (G-R1-2): the baseline before the merge, so the diff covers the merged work and this run's own and
          // no other item's, and the commit a later abandonment of this run returns to is its own start.
          yield* store.writeBaseline();
          const merged = yield* store.mergeParked(start.branch);
          if (merged._tag === "Merged") yield* sayAndWrite(parkedMergedLine(start.root, start.branch));
          else yield* sayAndWrite(parkedMergeConflictLine(start.root, start.branch, merged.message));
          if (start.plan === null) return { _tag: "FirstPlan" } as const;
          yield* store.savePlan(merged._tag === "Merged" ? start.plan : undonePlan(start.plan));
          return { _tag: "EarlierPlan", root: start.root, merge: merged._tag === "Merged" ? "merged" : "conflicted" } as const;
        }
      }
    });
    // The SDK does not report which model answered a Codex turn; the configured one is all that can be said.
    yield* ui.notify({ _tag: "ModelNamed", model: { agent: "codex", name: config.codexModel } });
    // Issue #6: the run's shape is known from the start, and each further iteration as soon as it is known.
    let known = 1;
    // Issue #162: the suite runs so far, in order, each with its iteration and whether it passed (run n is the n-th);
    // where a suite command is set, the next suite run follows the last known iteration, unless that iteration's last
    // run passed, and moves to a new last one when a stop or a correction adds it. Issue #181: an iteration may hold
    // several runs, a repeat after a stop outside the work following the run it repeats.
    let suiteRuns: ReadonlyArray<Readonly<{ iteration: number; passed: boolean }>> = [];
    const shape = (): readonly Iteration[] =>
      iterationsOf(known).map((_, i) => {
        const ran = suiteRuns.flatMap((r, j) => (r.iteration === i + 1 ? [j + 1] : []));
        const last = ran.at(-1);
        const pending = checks.suite !== null && i + 1 === known && (last === undefined || !suiteRuns[last - 1].passed);
        return { suites: pending ? [...ran, suiteRuns.length + 1] : ran };
      });
    const foreseeShape = Effect.suspend(() => ui.notify({ _tag: "PhasesForeseen", phases: foreseen("implementation", shape()) }));
    const foresee = (iterations: number) => (iterations <= known ? Effect.void : Effect.suspend(() => ((known = iterations), foreseeShape)));
    yield* foreseeShape;
    /** A phase's label as the phases known now number it. */
    const label = (kind: NumberedPhaseKind, n: number): string => phaseName({ kind, n }, countOfKind(foreseen("implementation", shape()), kind));

    /**
     * Suite run n (issue #162): the whole suite, run by Interloq in the project with no guard, its output written to
     * suite-<n>.log, its end notified; a pass or a failure of the work is said and written to conversation.md here, a
     * stop outside the work by `finalSuite`, once the rail foresees what follows it (issue #181).
     */
    /**
     * Issue #49: the suite run with its output on the live panel as it arrives: its Started, each chunk sanitized by one
     * sanitizer held for the run, and its Finished once every chunk was passed on; Stopped where Stop task ends it.
     * The runner's callback puts each chunk on a queue in arrival order; a fiber of the phase passes them on; null ends it.
     */
    const liveSuite = (key: ProcessKey, runSuite: (onOutput: (text: string) => void) => Effect.Effect<SuiteResult>) =>
      Effect.gen(function* () {
        const name = SUITE_OUTPUT_NAME;
        const chunks = yield* Queue.unbounded<string | null>();
        yield* ui.output({ _tag: "Started", key, name });
        const forward = (sanitizer: Sanitizer): Effect.Effect<void> =>
          Queue.take(chunks).pipe(
            Effect.flatMap((chunk) => {
              if (chunk === null) return Effect.void;
              const [next, text] = sanitizeChunk(sanitizer, chunk);
              return (text === "" ? Effect.void : ui.output({ _tag: "Printed", key, name, text })).pipe(Effect.andThen(forward(next)));
            }),
          );
        const forwarder = yield* Effect.forkChild(forward(NEW_SANITIZER));
        const result = yield* runSuite((text) => void Queue.offerUnsafe(chunks, text));
        Queue.offerUnsafe(chunks, null);
        yield* Fiber.join(forwarder);
        yield* ui.output({ _tag: "Finished", key, name, status: suiteStatusOf(result) });
        return result;
      }).pipe(Effect.onInterrupt(() => ui.output({ _tag: "Finished", key, name: SUITE_OUTPUT_NAME, status: { _tag: "Stopped" } })));

    const suitePhase = (command: S.CommandLine, n: number) =>
      Effect.gen(function* () {
        const runner = yield* SuiteRunner;
        const phase: Phase = { kind: "suite", n };
        const name = label("suite", n);
        yield* ui.notify({ _tag: "PhaseBegan", phase });
        yield* sayAndWrite(suiteBeganLine(name, command));
        const runSuite = (onOutput: (text: string) => void) => runner.run(command, store.project, config.suiteTimeoutMinutes * 60_000, onOutput);
        const result = yield* Result.match(processKeyOf({ kind: "suite", run: n }), { onFailure: () => runSuite(() => undefined), onSuccess: (key) => liveSuite(key, runSuite) });
        yield* store.saveSuiteLog(n, result.output);
        const log = recordPath(store.root, { kind: "suiteLog", n });
        yield* ui.notify({ _tag: "PhaseEnded", phase, result: suiteOutcomeOf(result) });
        const verdict = suiteVerdictOf(result);
        if (verdict._tag === "Passed") yield* sayAndWrite(suitePassedLine(name, command));
        if (verdict._tag === "WorkFailed") yield* sayAndWrite(suiteFailedLine(name, command, verdict.reason, log));
        return { verdict, log, tail: tailLines(result.output, SUITE_TAIL_LINES) };
      });

    /**
     * Issue #181 (requirements Q1, W1-R1-1): the stop after which the run's one automatic repeat of a suite stopped
     * outside the work was used, or null while it is unused, so the flag and the stop it records cannot disagree.
     */
    let repeated: SuiteStop | null = null;
    /**
     * The final suite after iteration k's work review found nothing left to correct (issue #162; issue #181, Q1 and Q2):
     * null where it passed; the revision's cause where the work failed it (an exit code or a signal). A stop outside the
     * work (the limit, or a shell that could not start) is never a cause: the first in the run is repeated at once
     * without a question, and every later one asks Run the suite again or Stop, Stop halting with SuiteStopped. The
     * question names every stop of this call's loop and the stop that used the repeat (W1-R1-1).
     */
    const finalSuite = (command: S.CommandLine, k: number) =>
      Effect.gen(function* () {
        // The stops outside the work of this call's loop, in order.
        let here: readonly SuiteStop[] = [];
        for (;;) {
          const n = suiteRuns.length + 1;
          const { verdict, log, tail } = yield* suitePhase(command, n);
          suiteRuns = [...suiteRuns, { iteration: k, passed: verdict._tag === "Passed" }];
          if (verdict._tag === "Passed") return null;
          if (verdict._tag === "WorkFailed") return { _tag: "SuiteFailed", suite: n, command, reason: verdict.reason, tail, log } satisfies RevisionCause;
          // The next suite run of this iteration is foreseen first, so that the lines name this one as the run now numbers it.
          yield* foreseeShape;
          const name = label("suite", n);
          yield* sayAndWrite(suiteStoppedLine(name, command, verdict.reason, log));
          const latest: SuiteStop = { suite: n, reason: verdict.reason, log };
          const stops: readonly [...SuiteStop[], SuiteStop] = [...here, latest];
          here = stops;
          if (repeated === null) {
            repeated = latest;
            yield* sayAndWrite(suiteRepeatLine(name, command));
            continue;
          }
          const reason = suiteFailureText(verdict.reason);
          const origin: QuestionOrigin = { kind: "suiteStopped", command, suite: n, stops: stops.length, reason };
          const draft: QuestionDraft = {
            origin,
            context: programContext(origin),
            history: suiteStoppedHistory(stops, repeated),
            explanations: [],
            question: plainPieces(suiteStoppedQuestion(name, command)),
            options: suiteStoppedOptions(),
            attached: attachedOf("suiteStop", suiteStoppedDetails(stops, repeated)),
            explain: suiteStoppedFacts(command, stops, repeated),
            decision: null,
          };
          const answer = yield* askOffering(byLine((p) => ui.ask(p)), transportPrompt, draft, (a) => parseTransportAnswer(a) !== null).pipe(inPhase({ kind: "suite", n }));
          if (parseTransportAnswer(answer) === "stop") return yield* Effect.fail(new SuiteStopped({ command, suite: n, stops: stops.length, reason }));
        }
      });

    /** The verdicts given so far, numbered across the run (issue #186). */
    let verdicts = 0;
    /** Why the plan is revised after the previous iteration; the next plan revision is written from it. */
    let previous: PlanningCause = firstCause;
    for (let k = 1; ; k++) {
      // The plan as this planning phase begins (issue #6, G-R1-1): its done steps and statuses do not change within the phase.
      const before = Option.getOrNull(yield* store.loadPlan());
      const subject = planSubject(store.root, k, withRequirements, before, checks, previous._tag === "ParkedBranch" ? previous.branch : null);
      const reviewed = yield* Effect.gen(function* () {
        // Planning phase K: write or revise the plan, then review it.
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: k } });
        yield* ui.say(planningBeganLine(label("planning", k), previous._tag === "FirstPlan"));
        // Issue #186: the run's first planning call returns a plan or the verdict that the item is not refined; Codex
        // reviews a verdict in this phase and session, and where it is withdrawn Claude Code writes the plan instead.
        const first = firstCauseOf(previous);
        if (first !== null) {
          const reply = yield* planningCall(planningPrompt(store.root, task, withRequirements, k, previous, checks), S.FirstPlanReply, "planning", "records", firstPlanValidation(store.root, before));
          const replied = reply.output.reply;
          if (replied.kind === "plan") {
            yield* store.savePlanWrite(k, { questions_for_user: [] });
            yield* savePlan(k, replied.plan, before);
            yield* ui.notify({ _tag: "PlanWritten", phase: k, resultText: reply.resultText });
            return { _tag: "Reviewed", loop: yield* reviewLoop(subject) } as const;
          }
          verdicts += 1;
          const n = verdicts;
          const phase = { kind: "planning", n: k } as const;
          yield* store.saveVerdict(n, { missing: replied.missing, phase, origin: "firstPlan" });
          yield* sayAndWrite(verdictGivenLine(label("planning", k)));
          const judged = yield* reviewLoop(verdictSubject(n, k, phase, { _tag: "FirstPlan" }, withRequirements));
          if (judged.result !== "revise") {
            yield* sayAndWrite(verdictStandsLine(n));
            return { _tag: "NotRefined", missing: (yield* store.loadVerdict(n)).missing, verdict: n, loop: judged } as const;
          }
          yield* sayAndWrite(verdictWithdrawnLine(n));
          const replaced = yield* planningCall(planAfterVerdictPrompt(store.root, task, withRequirements, n, first, checks), S.PlanOnly, "planning", "records", planField<S.PlanOnly>(planValidation(store.root, before)));
          yield* savePlan(k, replaced.output.plan, before);
          yield* ui.notify({ _tag: "PlanWritten", phase: k, resultText: replaced.resultText });
          return { _tag: "Reviewed", loop: yield* reviewLoop(subject) } as const;
        }

        // The reply is the plan (F1): validated, then written by the program as plan.json and plan.md.
        const written = yield* planningCall(planningPrompt(store.root, task, withRequirements, k, previous, checks), S.PlanWrite, "planning", "records", bothValidations(planField<S.PlanWrite>(planValidation(store.root, before)), userQuestionsValidation<S.PlanWrite>()));
        yield* store.savePlanWrite(k, written.output);
        yield* savePlan(k, written.output.plan, before);
        yield* ui.notify({ _tag: "PlanWritten", phase: k, resultText: written.resultText });

        let answered = false;
        for (const question of written.output.questions_for_user) {
          if ((yield* askPlannerQuestion(question, label("planning", k), k, 0)) !== "") answered = true;
        }
        if (answered) yield* applyDecisions(subject);

        return { _tag: "Reviewed", loop: yield* reviewLoop(subject) } as const;
      }).pipe(ownSession, inPhase({ kind: "planning", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "planning", n: k }, result: reviewed.loop.result });
      if (reviewed._tag === "NotRefined") return { _tag: "NotRefined", missing: reviewed.missing, verdict: reviewed.verdict } as const;

      // Execution phase K.
      const execution = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "execution", n: k } });
        yield* ui.say(implementationBeganLine(label("execution", k), config.execPermissionMode));
        // The steps of the plan (issue #6, Q2): report_step records on the plan as the phase began; when the call ends,
        // however it ends, a started step becomes unfinished and the held plan is written (G-R1-2, P1-R1-4).
        const steps = yield* executionSteps(k);
        // Issue #117 (the developer's decision of 8 Oct 2026): each execution phase runs in a Claude Code session of its
        // own, as each planning phase and work review does since issue #122; a transport retry and a usage-limit wait
        // resume this session, which the planner it is called on holds.
        const executor = yield* planner.fresh;
        // Issue #154 (Q2, Q3): a call that reports work left and nothing to decide is continued in this session, without
        // asking and without limit; the steps' end runs once, when the last call ends.
        const ending = yield* continuedExecution(executor, executePrompt(store.root, task, withRequirements, checks), steps.report, label("execution", k)).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : steps.end.pipe(Effect.catch((e: RunError) => ui.say(planNotEndedLine(describe(e))))))),
        );
        yield* steps.end;
        // Issue #157 (Q2): a process that ended on every attempt is an aborted stop, its texts the steps recorded.
        const outcome = ending.status === "processEnded" ? processEndedStop(ending, stepRecordsOf(Option.getOrNull(yield* store.loadPlan()))) : ending;
        yield* store.saveExecution(k, outcome);
        yield* store.checkpoint({ subject: "execution", phase: k, round: 0, stage: "executed" });
        yield* ui.notify({ _tag: "ExecutionEnded", phase: k, outcome });
        yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "execution", n: k }, result: outcome.status });
        yield* ui.say(implementationEndedLine(label("execution", k), outcome.status));
        yield* ui.say(`Summary: ${outcome.summary || "none"}`);
        const stopped = outcome.status !== "finished";
        // A stop always leads to a revision: the next iteration is known now.
        if (stopped) yield* foresee(k + 1);
        // Issue #181 (Q6, Q7): a stop is not put to the user. A question Claude Code relayed and the user answered during
        // the call is recorded as his decision; any other stop is revised from Claude Code's own account, which the
        // revision prompt carries, after the work review, with nothing recorded as a decision of his.
        // Issue #186: a verdict that the item is not refined is no stop; Codex reviews it in place of the work review.
        const stop: ExecStop | null =
          outcome.status === "finished" || outcome.status === "not_refined" ? null : outcome.userInput !== null ? { _tag: "Answered" } : { _tag: "Unanswered", status: outcome.status, summary: outcome.summary, question: outcome.question, remainingWork: outcome.remainingWork };
        if (stop !== null) yield* ui.say(`Remaining work: ${outcome.remainingWork || "not reported"}`);
        if (stop?._tag === "Answered" && outcome.userInput !== null) {
          const question = outcome.question.replace(/\s+/g, " ");
          yield* store.appendDecision({ subject: `stop in execution phase ${k} (${outcome.status}): ${question}`, id: null, decision: outcome.userInput, phase: k, round: 0 });
        }
        if (stop?._tag === "Unanswered") yield* sayAndWrite(execStopRevisionLine(label("execution", k), stop.status));
        // Issue #117: the work response, in a session of its own (issue #122), is given the execution's report and the plan as its end left it.
        const ended = Option.getOrNull(yield* store.loadPlan());
        return { stopped, stop, work: { outcome, plan: ended === null ? "(no plan recorded)" : renderPlanMarkdown(ended) } satisfies WorkExecution };
      }).pipe(inPhase({ kind: "execution", n: k }));
      const { stopped } = execution;

      // Issue #186 (requirements Q1, Q2): an execution that reports the item not refined has its verdict reviewed by
      // Codex in Code review K, in a session of its own, in place of the work review. A verdict that stands sends the
      // item back, this run's work parked; one withdrawn is followed by planning phase K+1, revised from it, whose next
      // work review covers this phase's work, since its diff runs from the baseline.
      const executed = execution.work.outcome;
      if (executed.status === "not_refined") {
        verdicts += 1;
        const n = verdicts;
        const judged = yield* Effect.gen(function* () {
          yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "work", n: k } });
          yield* store.saveVerdict(n, { missing: executed.question, phase: { kind: "execution", n: k }, origin: "execution" });
          yield* sayAndWrite(verdictGivenLine(label("work", k)));
          const origin = { _tag: "Execution", phase: k, task, summary: executed.summary, remainingWork: executed.remainingWork } as const;
          return yield* reviewLoop(verdictSubject(n, k, { kind: "execution", n: k }, origin, withRequirements));
        }).pipe(ownSession, inPhase({ kind: "work", n: k }));
        yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "work", n: k }, result: judged.result });
        if (judged.result !== "revise") {
          yield* sayAndWrite(verdictStandsLine(n));
          return { _tag: "NotRefined", missing: (yield* store.loadVerdict(n)).missing, verdict: n } as const;
        }
        yield* sayAndWrite(verdictWithdrawnLine(n));
        previous = { _tag: "VerdictWithdrawn", verdict: n };
        continue;
      }

      // Work review K, after every execution phase whatever its status (behaviour 12).
      const work = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "work", n: k } });
        yield* ui.say(workReviewBeganLine(label("work", k)));
        return yield* reviewLoop(workSubject(task, k, withRequirements, execution.work, checks));
      }).pipe(ownSession, inPhase({ kind: "work", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "work", n: k }, result: work.result });
      // The run is finished only when Claude Code reported finished and the work review converged, then, where the
      // project names a suite command, only when the whole suite passes (issue #162, G-R1-1, F1), and then only when no
      // file the run changed is uncommitted (issue #176, Q1): otherwise the plan is revised, without limit.
      if (!stopped && work.result === "converged") {
        if (checks.suite !== null) {
          const failed = yield* finalSuite(checks.suite, k);
          if (failed !== null) {
            yield* foresee(k + 1);
            previous = failed;
            continue;
          }
        }
        const committed = yield* store.uncommittedSinceStart();
        if (committed._tag === "Committed") return { _tag: "Finished", phases: k } as const;
        // The next iteration is known first, so that the line names this work review as the run now numbers it.
        yield* foresee(k + 1);
        yield* sayAndWrite(uncommittedLine(label("work", k), committed.paths, checks.suite));
        previous = { _tag: "Uncommitted", paths: committed.paths, suite: checks.suite };
        continue;
      }
      yield* foresee(k + 1);
      previous = { _tag: "ExecutionEnded", stop: execution.stop, workReview: work.result === "converged" ? "converged" : { revisedInRound: work.round } };
    }
  });
