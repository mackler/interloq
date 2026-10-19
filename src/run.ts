// The complete run: planning phase K, execution phase K and work review K, until Claude Code reports
// 'finished' and the work review converges.

import { Effect, Exit, Option, Result } from "effect";
import { type Refinement, refinementOf } from "./refinement.ts";
import { stateAtEnd, stateAtStart } from "./runMode.ts";
import type { ItemId } from "./tracker.ts";
import { describe, type RunError, TrackerStepFailed, trackerFailureText } from "./errors.ts";
import { executionSteps } from "./planSteps.ts";
import { renderPlanMarkdown, type StepRecords, stepRecordsOf } from "./plan.ts";
import { questionPhase } from "./interview.ts";
import { continuingLine, executionContinuingPrompt, itemStartedLine, NOTHING_TO_SETTLE, refinementInvalidText, refinementWrittenLine, requirementsKeptText, type TrackerStep, execInputPrompt, execStopDetails, execStopQuestion, processEndedDetails, processEndedQuestion, processEndedRemaining, processEndedSummary, executePrompt, implementationBeganLine, implementationEndedLine, initialPlanPrompt, planningBeganLine, planNotEndedLine, workReviewBeganLine, revisePlanAfterExecutionPrompt, type RevisionCause, suiteBeganLine, suiteFailedLine, suitePassedLine, uncommittedLine, type WorkExecution } from "./prompts.ts";
import { recordPath } from "./artifacts.ts";
import { plainPieces, type ShownBlock } from "./pieces.ts";
import { applyDecisions, askPlannerQuestion, bothValidations, planningCall, reviewLoop, userQuestionsValidation } from "./review.ts";
import { askOffering, programContext } from "./offer.ts";
import { attachedOf, type QuestionOrigin } from "./question.ts";
import * as S from "./schema.ts";
import { Decider, Planner, type PlannerShape, RunConfig, type Services, type StepReporter, Store, SuiteRunner, Tracker, type TrackerShape, Ui } from "./services.ts";
import { runTrackerEnv, type TrackerRetryEnv, type TrackerWrite, writeWithRetry } from "./trackerRetry.ts";
import { countOfKind, foreseenPhases as foreseen, type Iteration, iterationsOf, type NumberedPhaseKind, type Phase, phaseName } from "./uiEvents.ts";
import { SUITE_TAIL_LINES, suiteOutcomeOf, tailLines } from "./suite.ts";
import { planField, planSubject, planValidation, savePlan, workSubject } from "./subjects.ts";

/**
 * A refinement run (issue #120, the developer's decision of 8 Oct 2026): the question phase and nothing after it. It sets no
 * state when it starts; when the question phase has written requirements.md, it writes that text back to the item as its
 * section Refined using Interloq and sets the item to refined. A tracker step that fails halts with TrackerStepFailed: the
 * records stand, and no state that was not written is claimed. A halted or stopped refinement sets nothing, and the item
 * stays unrefined.
 */
export const refinementRun = (task: string, item: ItemId, terms: S.TermsMode, held: readonly string[] = []): Effect.Effect<void, RunError, Services | Tracker> =>
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
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    yield* ui.notify({ _tag: "PhasesForeseen", phases: foreseen("refinement", iterationsOf(1)) });
    yield* questionPhase(task, terms).pipe(Effect.provideService(Decider, decider.at(phase, phaseName(phase, 1))));
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
    yield* writeStep(tracker, { kind: "setState", item, state: stateAtEnd("refinement") }, env, "setRefined", kept);
    yield* ui.say(refinementWrittenLine(item, store.requirements));
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
export const implementationRun = (task: string, item: ItemId, requirements: Refinement | null, checks: S.StepChecks, held: readonly string[] = []): Effect.Effect<number, RunError, Services | Tracker | SuiteRunner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    yield* store.init(task);
    yield* converseHeld(held);
    yield* store.converse(`${itemStartedLine("implementation", item, firstLine(task))}\n\n`);
    const env = yield* runTrackerEnv;
    const start = stateAtStart("implementation");
    if (start !== null) yield* writeStep(tracker, { kind: "setState", item, state: start }, env, "setImplementing", null);
    if (requirements !== null) yield* store.writeRequirements(requirements);
    const phases = yield* implementationPhases(task, requirements !== null, checks);
    yield* writeStep(tracker, { kind: "setState", item, state: stateAtEnd("implementation") }, env, "setImplemented", null);
    return phases;
  });

/** The planning, execution and review of a task without a tracker item: the implementation run's phases after a new records directory. */
export const run = (task: string, checks: S.StepChecks = S.NO_STEP_CHECKS): Effect.Effect<number, RunError, Services | SuiteRunner> =>
  Effect.gen(function* () {
    yield* (yield* Store).init(task);
    return yield* implementationPhases(task, false, checks);
  });

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
 * unfinished, and the stop's attached material the same steps beside the question.
 */
const processEndedStop = (ended: PhaseProcessEnded, records: StepRecords): Readonly<{ outcome: S.ExecOutcome; details: readonly ShownBlock[] }> => {
  const question = processEndedQuestion(ended.ending.end, ended.ending.attempts);
  return {
    outcome: { status: "aborted", summary: processEndedSummary(records.done), question, remainingWork: processEndedRemaining(records.unfinished), userInput: null, checks: ended.checks },
    details: processEndedDetails(question, records.done, records.unfinished),
  };
};

const implementationPhases = (task: string, withRequirements: boolean, checks: S.StepChecks): Effect.Effect<number, RunError, Services | SuiteRunner> =>
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
    // The baseline of the work reviews (Q7); a refinement run, which has none, writes none (issue #120).
    yield* store.writeBaseline();
    // The SDK does not report which model answered a Codex turn; the configured one is all that can be said.
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    // Issue #6: the run's shape is known from the start, and each further iteration as soon as it is known.
    let known = 1;
    // Issue #162: the iterations whose suite run has run, in order; where a suite command is set, the next suite run
    // follows the last known iteration, and moves to a new last one when a stop or a correction adds it.
    let suitedIterations: readonly number[] = [];
    const shape = (): readonly Iteration[] =>
      iterationsOf(known).map((_, i) => {
        const ran = suitedIterations.indexOf(i + 1);
        if (ran >= 0) return { suite: ran + 1 };
        return { suite: checks.suite !== null && i + 1 === known ? suitedIterations.length + 1 : null };
      });
    const foreseeShape = Effect.suspend(() => ui.notify({ _tag: "PhasesForeseen", phases: foreseen("implementation", shape()) }));
    const foresee = (iterations: number) => (iterations <= known ? Effect.void : Effect.suspend(() => ((known = iterations), foreseeShape)));
    yield* foreseeShape;
    /** A phase's label as the phases known now number it. */
    const label = (kind: NumberedPhaseKind, n: number): string => phaseName({ kind, n }, countOfKind(foreseen("implementation", shape()), kind));

    /** A line said on the page and written to conversation.md (issues #162, #176). */
    const sayAndWrite = (line: string) => Effect.andThen(ui.say(line), store.converse(`${line.trim()}\n\n`));
    /**
     * Suite run n (issue #162): the whole suite, run by Interloq in the project with no guard, its output written to
     * suite-<n>.log, its result said and written to conversation.md; the revision's cause where it failed, else null.
     */
    const suitePhase = (command: S.CommandLine, n: number) =>
      Effect.gen(function* () {
        const runner = yield* SuiteRunner;
        const phase: Phase = { kind: "suite", n };
        const name = label("suite", n);
        yield* ui.notify({ _tag: "PhaseBegan", phase });
        yield* sayAndWrite(suiteBeganLine(name, command));
        const result = yield* runner.run(command, store.project);
        yield* store.saveSuiteLog(n, result.output);
        const log = recordPath(store.root, { kind: "suiteLog", n });
        yield* ui.notify({ _tag: "PhaseEnded", phase, result: suiteOutcomeOf(result) });
        yield* sayAndWrite(result._tag === "Passed" ? suitePassedLine(name, command) : suiteFailedLine(name, command, result.reason, log));
        return result._tag === "Passed" ? null : ({ _tag: "SuiteFailed", suite: n, command, reason: result.reason, tail: tailLines(result.output, SUITE_TAIL_LINES), log } satisfies RevisionCause);
      });

    /** Why the plan is revised after the previous iteration; the next plan revision is written from it. */
    let previous: RevisionCause | null = null;
    for (let k = 1; ; k++) {
      // The plan as this planning phase begins (issue #6, G-R1-1): its done steps and statuses do not change within the phase.
      const before = Option.getOrNull(yield* store.loadPlan());
      const subject = planSubject(store.root, k, withRequirements, before, checks);
      const reviewed = yield* Effect.gen(function* () {
        // Planning phase K: write or revise the plan, then review it.
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: k } });
        yield* ui.say(planningBeganLine(label("planning", k), previous === null));
        // The reply is the plan (F1): validated, then written by the program as plan.json and plan.md.
        const written = yield* planningCall(previous === null ? initialPlanPrompt(store.root, task, withRequirements, checks) : revisePlanAfterExecutionPrompt(store.root, task, withRequirements, k - 1, previous, checks), S.PlanWrite, "planning", "records", bothValidations(planField<S.PlanWrite>(planValidation(store.root, before)), userQuestionsValidation<S.PlanWrite>()));
        yield* store.savePlanWrite(k, written.output);
        yield* savePlan(k, written.output.plan, before);
        yield* ui.notify({ _tag: "PlanWritten", phase: k, resultText: written.resultText });

        let answered = false;
        for (const question of written.output.questions_for_user) {
          if ((yield* askPlannerQuestion(question, label("planning", k), k, 0)) !== "") answered = true;
        }
        if (answered) yield* applyDecisions(subject);

        return yield* reviewLoop(subject);
      }).pipe(ownSession, inPhase({ kind: "planning", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "planning", n: k }, result: reviewed.result });

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
        const { outcome, details } = ending.status === "processEnded" ? processEndedStop(ending, stepRecordsOf(Option.getOrNull(yield* store.loadPlan()))) : { outcome: ending, details: null };
        yield* store.saveExecution(k, outcome);
        yield* store.checkpoint({ subject: "execution", phase: k, round: 0, stage: "executed" });
        yield* ui.notify({ _tag: "ExecutionEnded", phase: k, outcome });
        yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "execution", n: k }, result: outcome.status });
        yield* ui.say(implementationEndedLine(label("execution", k), outcome.status));
        yield* ui.say(`Summary: ${outcome.summary || "none"}`);
        const stopped = outcome.status !== "finished";
        // A stop always leads to a revision: the next iteration is known now.
        if (stopped) yield* foresee(k + 1);
        if (stopped) {
          // A stop is handled as before the work review existed: its input is recorded first.
          yield* ui.say(`Remaining work: ${outcome.remainingWork || "not reported"}`);
          const origin: QuestionOrigin = { kind: "execStop", phase: k, status: outcome.status };
          const draft = { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(execStopQuestion()), options: [], attached: attachedOf("stopReport", details ?? execStopDetails(outcome.question)), decision: null };
          const input = outcome.userInput ?? (yield* askOffering((p) => ui.ask(p), execInputPrompt, draft, (a) => a !== ""));
          const question = outcome.question.replace(/\s+/g, " ");
          yield* store.appendDecision({ subject: `stop in execution phase ${k} (${outcome.status}): ${question}`, id: null, decision: input, phase: k, round: 0 });
        }
        // Issue #117: the work response, in a session of its own (issue #122), is given the execution's report and the plan as its end left it.
        const ended = Option.getOrNull(yield* store.loadPlan());
        return { stopped, work: { outcome, plan: ended === null ? "(no plan recorded)" : renderPlanMarkdown(ended) } satisfies WorkExecution };
      }).pipe(inPhase({ kind: "execution", n: k }));
      const { stopped } = execution;

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
          const n = suitedIterations.length + 1;
          const failed = yield* suitePhase(checks.suite, n);
          suitedIterations = [...suitedIterations, k];
          if (failed !== null) {
            yield* foresee(k + 1);
            previous = failed;
            continue;
          }
        }
        const committed = yield* store.uncommittedSinceStart();
        if (committed._tag === "Committed") return k;
        // The next iteration is known first, so that the line names this work review as the run now numbers it.
        yield* foresee(k + 1);
        yield* sayAndWrite(uncommittedLine(label("work", k), committed.paths, checks.suite));
        previous = { _tag: "Uncommitted", paths: committed.paths, suite: checks.suite };
        continue;
      }
      yield* foresee(k + 1);
      previous = { _tag: "ExecutionEnded", stopped, workReview: work.result === "converged" ? "converged" : { revisedInRound: work.round } };
    }
  });
