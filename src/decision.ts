// Decision support ("Help me decide", docs/decision-support-design.md): a decision loop analyzes the options of a
// question under docs/decision-making.md, reviewed by Codex in rounds like every other loop (reviewLoop), in a fresh
// Claude Code session (decision Q3). Decisions are numbered across the run; the loop sits inside the phase in which
// the question was asked and changes nothing about the phases.

import { writeContext } from "./questionContext.ts";
import { Effect, Layer, Result } from "effect";
import { validateAnalysis } from "./analysis.ts";
import type { RunError } from "./errors.ts";
import { analysisRepairPrompt, decisionAnalysisPrompt } from "./prompts.ts";
import { renderDecisionOpened, renderLabelCorrected, renderReferenceDropped } from "./render.ts";
import { analysisProgress, planningCall, reviewLoop, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import type { DecisionAnalysis } from "./schema.ts";
import { Decider, type DecisionQuestion, type DeciderShape, Planner, type Reviewer, type RunConfig, type RunKind, type Services, Store, Ui } from "./services.ts";
import { decisionSubject } from "./subjects.ts";
import { type LoopResult, phaseName } from "./uiEvents.ts";

export type DecisionEnd = Readonly<{ decision: number; question: DecisionQuestion; analysis: DecisionAnalysis; result: LoopResult }>;

/** The phase number a decision's loop records: 0 in Gather Requirements, the phase's number otherwise. */
export const phaseNumber = (phase: DecisionQuestion["phase"]): number => (phase.kind === "questions" ? 0 : phase.n);

/**
 * The validation of an analysis against the question's options (issue #37, decision Q1), for the analysis call, a
 * response and the application of the user's decisions alike (P1-R2-1): the normalized analysis with a note in
 * conversation.md for each correction, or the repair turn whose prompt lists the exact option labels.
 */
export const analysisValidation =
  (options: DecisionQuestion["options"]): Validation<DecisionAnalysis> =>
  (analysis) => {
    const validated = validateAnalysis(options, analysis);
    if (Result.isFailure(validated)) return Result.fail({ error: validated.failure, repair: analysisRepairPrompt(validated.failure, options) });
    const notes = validated.success.notes.map((note) => (note.kind === "reference" ? renderReferenceDropped(note.argument, note.named) : renderLabelCorrected(note.given, note.exact)));
    return Result.succeed({ value: validated.success.analysis, notes });
  };
/** One decision loop: the analysis, its review to convergence (or the user's proceed), and the analysis as it stands. */
export const decisionLoop = (format: string, task: string, question: DecisionQuestion, number: number | null = null): Effect.Effect<DecisionEnd, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // A fresh session (Q3): the run's main session, possibly paused mid-call, is neither resumed nor forked.
    const planner = yield* (yield* Planner).fresh;
    const k = yield* store.openDecision(question);
    yield* store.converse(renderDecisionOpened(k, question.question, question.options));
    // S21 (Q4): one plain status while the analysis is prepared, from the moment the offer is taken.
    yield* analysisProgress(k, number, 0);
    const context = { task, ...(yield* store.readContext()) };
    const validate = analysisValidation(question.options);
    const loop = Effect.gen(function* () {
      const written = yield* planningCall(decisionAnalysisPrompt(store.root, format, question, context), S.DecisionAnalysis, "planning", "records", validate);
      yield* store.saveAnalysisWrite(k, written.reply);
      yield* store.saveAnalysis(k, written.output);
      return yield* reviewLoop({ ...decisionSubject(k, phaseNumber(question.phase), format, validate), question: number });
    }).pipe(Effect.provideService(Planner, planner));
    const end = yield* loop;
    return { decision: k, question, analysis: yield* store.loadAnalysis(k), result: end.result };
  });


// ---- the Decider (D3) --------------------------------------------------------------------------------

/** The services a decision loop runs over, captured when the Decider is built. */
export type DeciderDeps = Ui | Planner | Reviewer | Store | RunConfig | RunKind;

/**
 * The Decider of a run: its loops run over the services captured here, so that `decide` requires nothing and an SDK
 * callback can run it. A loop's own prompts get the Decider of the same phase, so decisions nest.
 */
export const makeDecider = (task: string, format: string): Effect.Effect<DeciderShape, never, DeciderDeps> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<DeciderDeps>();
    const at = (phase: DecisionQuestion["phase"], label: string): DeciderShape => {
      const self: DeciderShape = {
        at,
        decide: (request) =>
          decisionLoop(format, task, { phase, label, question: request.question, options: request.options, ...(request.shown === undefined ? {} : { shown: request.shown }) }, request.number ?? null).pipe(
            Effect.map((end) => ({ decision: end.decision, analysis: end.analysis, result: end.result })),
            Effect.provideService(Decider, self),
            Effect.provideContext(context),
          ),
        explain: (request) => writeContext(task, request).pipe(Effect.provideService(Decider, self), Effect.provideContext(context)),
      };
      return self;
    };
    return at({ kind: "questions" }, phaseName({ kind: "questions" }, 1));
  });
export const deciderLayer = (task: string, format: string): Layer.Layer<Decider, never, DeciderDeps> => Layer.effect(Decider, makeDecider(task, format));
