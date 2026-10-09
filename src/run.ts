// The complete run: planning phase K, execution phase K and work review K, until Claude Code reports
// 'finished' and the work review converges.

import { Effect, Exit, Option, Result } from "effect";
import { refinementOf } from "./refinement.ts";
import { stateAtEnd } from "./runMode.ts";
import type { ItemId } from "./tracker.ts";
import { describe, type RunError, TrackerStepFailed, trackerFailureText } from "./errors.ts";
import { executionSteps } from "./planSteps.ts";
import { renderPlanMarkdown } from "./plan.ts";
import { questionPhase } from "./interview.ts";
import { itemStartedLine, NOTHING_TO_SETTLE, refinementInvalidText, refinementWrittenLine, requirementsKeptText, type TrackerStep, execInputPrompt, execStopDetails, execStopQuestion, executePrompt, implementationBeganLine, implementationEndedLine, initialPlanPrompt, planningBeganLine, planNotEndedLine, workReviewBeganLine, revisePlanAfterExecutionPrompt, type WorkExecution, type WorkReviewEnd } from "./prompts.ts";
import { plainPieces } from "./pieces.ts";
import { applyDecisions, askPlannerQuestion, bothValidations, planningCall, reviewLoop, userQuestionsValidation } from "./review.ts";
import { askOffering, programContext } from "./offer.ts";
import type { QuestionOrigin } from "./question.ts";
import * as S from "./schema.ts";
import { Decider, Planner, RunConfig, type Services, Store, Tracker, Ui } from "./services.ts";
import { countOfKind, foreseenPhases as foreseen, type Phase, phaseName } from "./uiEvents.ts";
import { planField, planSubject, planValidation, savePlan, workSubject } from "./subjects.ts";

/**
 * A refinement run (issue #120, the developer's decision of 8 Oct 2026): the question phase and nothing after it. It sets no
 * state when it starts; when the question phase has written requirements.md, it writes that text back to the item as its
 * section Refined using Interloq and sets the item to refined. A tracker step that fails halts with TrackerStepFailed: the
 * records stand, and no state that was not written is claimed. A halted or stopped refinement sets nothing, and the item
 * stays unrefined.
 */
export const refinementRun = (task: string, item: ItemId): Effect.Effect<void, RunError, Services | Tracker> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const decider = yield* Decider;
    const tracker = yield* Tracker;
    const phase: Phase = { kind: "questions" };
    yield* store.init(task);
    yield* store.converse(`${itemStartedLine("refinement", item, firstLine(task))}\n\n`);
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    yield* ui.notify({ _tag: "PhasesForeseen", phases: foreseen("refinement", 1) });
    yield* questionPhase(task).pipe(Effect.provideService(Decider, decider.at(phase, phaseName(phase, 1))));
    // Issue #83: an empty agreed list is no failure; a refinement that asks nothing found nothing to settle.
    if ((yield* store.loadQuestions()).questions.length === 0) {
      yield* store.converse(`${NOTHING_TO_SETTLE}\n\n`);
      yield* ui.say(NOTHING_TO_SETTLE);
    }
    const { requirements } = yield* store.readContext();
    const failed = (step: TrackerStep, cause: string, done: string | null) => Effect.fail(new TrackerStepFailed({ item, step, cause, done }));
    const refinement = refinementOf(requirements ?? "");
    if (Result.isFailure(refinement)) return yield* failed("writeRefinement", refinementInvalidText(refinement.failure.reason, store.requirements), requirementsKeptText(store.requirements));
    yield* tracker.writeRefinement(item, refinement.success).pipe(Effect.catch((e) => failed("writeRefinement", trackerFailureText(e), requirementsKeptText(store.requirements))));
    yield* tracker.setState(item, stateAtEnd("refinement")).pipe(Effect.catch((e) => failed("setRefined", trackerFailureText(e), requirementsKeptText(store.requirements))));
    yield* ui.say(refinementWrittenLine(item, store.requirements));
  });

/** The first line of a task: an item's title (taskTextOf puts it first). */
const firstLine = (task: string): string => task.split("\n")[0] ?? "";

/** The whole run. Succeeds with the number of execution phases when Claude Code reports 'finished' and the work review converges. */
export const run = (task: string): Effect.Effect<number, RunError, Services> =>
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
    yield* store.init(task);
    // The baseline of the work reviews (Q7); a refinement run, which has none, writes none (issue #120).
    yield* store.writeBaseline();
    // The SDK does not report which model answered a Codex turn; the configured one is all that can be said.
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    const withRequirements = config.questionPhase;
    // Issue #6: the run's shape is known from the start, and each further iteration as soon as it is known.
    let known = 1;
    // Until the refinement run exists (S6 of issue #120), a run with the question phase foresees it before planning.
    const foreseenPhases = (_: boolean, iterations: number): readonly Phase[] => [...(withRequirements ? foreseen("refinement", 1) : []), ...foreseen("implementation", iterations)];
    const foresee = (iterations: number) =>
      iterations <= known ? Effect.void : Effect.suspend(() => ((known = iterations), ui.notify({ _tag: "PhasesForeseen", phases: foreseenPhases(withRequirements, iterations) })));
    yield* ui.notify({ _tag: "PhasesForeseen", phases: foreseenPhases(withRequirements, known) });
    /** A phase's label as the phases known now number it. */
    const label = (kind: "planning" | "execution" | "work", n: number): string => phaseName({ kind, n }, countOfKind(foreseenPhases(withRequirements, known), kind));
    if (withRequirements) yield* questionPhase(task).pipe(inPhase({ kind: "questions" }));

    /** How the previous execution phase and its work review ended; the next plan revision is written from it. */
    let previous: Readonly<{ stopped: boolean; workReview: WorkReviewEnd }> | null = null;
    for (let k = 1; ; k++) {
      // The plan as this planning phase begins (issue #6, G-R1-1): its done steps and statuses do not change within the phase.
      const before = Option.getOrNull(yield* store.loadPlan());
      const subject = planSubject(store.root, k, withRequirements, before);
      const reviewed = yield* Effect.gen(function* () {
        // Planning phase K: write or revise the plan, then review it.
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: k } });
        yield* ui.say(planningBeganLine(label("planning", k), previous === null));
        // The reply is the plan (F1): validated, then written by the program as plan.json and plan.md.
        const written = yield* planningCall(previous === null ? initialPlanPrompt(store.root, task, withRequirements) : revisePlanAfterExecutionPrompt(store.root, k - 1, previous), S.PlanWrite, "planning", "records", bothValidations(planField<S.PlanWrite>(planValidation(store.root, before)), userQuestionsValidation<S.PlanWrite>()));
        yield* store.savePlanWrite(k, written.output);
        yield* savePlan(k, written.output.plan, before);
        yield* ui.notify({ _tag: "PlanWritten", phase: k, resultText: written.resultText });

        let answered = false;
        for (const question of written.output.questions_for_user) {
          if ((yield* askPlannerQuestion(question, label("planning", k), k, 0)) !== "") answered = true;
        }
        if (answered) yield* applyDecisions(subject);

        return yield* reviewLoop(subject);
      }).pipe(inPhase({ kind: "planning", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "planning", n: k }, result: reviewed.result });

      // Execution phase K.
      const execution = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "execution", n: k } });
        yield* ui.say(implementationBeganLine(label("execution", k), config.execPermissionMode));
        // The steps of the plan (issue #6, Q2): report_step records on the plan as the phase began; when the call ends,
        // however it ends, a started step becomes unfinished and the held plan is written (G-R1-2, P1-R1-4).
        const steps = yield* executionSteps(k);
        // Issue #117 (the developer's decision of 8 Oct 2026): each execution phase runs in a Claude Code session of its
        // own, so that the run's main session does not grow by every execution's tool results; a transport retry and a
        // usage-limit wait resume this session, which the planner it is called on holds.
        const executor = yield* planner.fresh;
        const outcome = yield* executor.executing(executePrompt(store.root, task, withRequirements), steps.report).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : steps.end.pipe(Effect.catch((e: RunError) => ui.say(planNotEndedLine(describe(e))))))),
        );
        yield* steps.end;
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
          const draft = { origin, context: programContext(origin), explanations: [], question: plainPieces(execStopQuestion()), options: [], details: execStopDetails(outcome.question), decision: null };
          const input = outcome.userInput ?? (yield* askOffering((p) => ui.ask(p), execInputPrompt, draft, (a) => a !== ""));
          const question = outcome.question.replace(/\s+/g, " ");
          yield* store.appendDecision({ subject: `stop in execution phase ${k} (${outcome.status}): ${question}`, id: null, decision: input, phase: k, round: 0 });
        }
        // Issue #117: the work response, in the main session, is given the execution's report and the plan as its end left it.
        const ended = Option.getOrNull(yield* store.loadPlan());
        return { stopped, work: { outcome, plan: ended === null ? "(no plan recorded)" : renderPlanMarkdown(ended) } satisfies WorkExecution };
      }).pipe(inPhase({ kind: "execution", n: k }));
      const { stopped } = execution;

      // Work review K, after every execution phase whatever its status (behaviour 12).
      const work = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "work", n: k } });
        yield* ui.say(workReviewBeganLine(label("work", k)));
        return yield* reviewLoop(workSubject(k, withRequirements, execution.work));
      }).pipe(inPhase({ kind: "work", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "work", n: k }, result: work.result });
      // The run is finished only when Claude Code reported finished and the work review converged.
      if (!stopped && work.result === "converged") return k;
      yield* foresee(k + 1);
      previous = { stopped, workReview: work.result === "converged" ? "converged" : { revisedInRound: work.round } };
    }
  });
