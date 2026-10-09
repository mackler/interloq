// The program: arguments, configuration, the live services, the run, and what is printed at the
// end. The run manager runs it for the page (src/runManager.ts); the tests run it with scripted services.

import { type Brand, Cause, Clock, Context, Data, Effect, Exit, FileSystem, Layer, Option, Result, type Scope } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionFormatUnreadable, describe, type RunError, type NoTracker, type TrackerCredentialMissing, trackerFailureText } from "./errors.ts";
import { blankItemText, itemStartedLine, mainSessionLine, sectionMalformedText, taskFinishedLine } from "./prompts.ts";
import { refinementRun, run } from "./run.ts";
import type { AgentSdk } from "./sdk.ts";
import { Planner, type Reviewer, RunConfig, Sdk, Store, type StoreShape, Tracker, Ui, type UiShape } from "./services.ts";
import type { Config } from "./schema.ts";
import { loadConfig } from "./config.ts";
import type { Platform } from "./platform.ts";
import { allocateRunRoot, makeStore } from "./store.ts";
import { recordPath, type RunRoot, runRootOf } from "./artifacts.ts";
import { deciderLayer } from "./decision.ts";
import { renderUsage, summarizeUsage } from "./usage.ts";
import type { ItemId, TrackerItem } from "./tracker.ts";
import type { RunMode } from "./runMode.ts";
import { type SectionMalformed, withoutRefinement } from "./refinement.ts";

/** What the program is wired to: the Ui, the platform, the SDKs and the agents. */
export type Wiring = Readonly<{
  /** The Ui of the run; a scoped resource (live: the run's web Ui). */
  ui: Effect.Effect<UiShape, never, Scope.Scope>;
  /** The platform services (live: platformLayer). */
  platform: Layer.Layer<Platform>;
  /** The two SDKs (live: liveSdk). */
  sdk: AgentSdk;
  /** The planner and the reviewer over the services (live: the Claude Code and Codex layers). */
  agents: Layer.Layer<Planner | Reviewer, never, Sdk | Ui | Store | RunConfig>;
  /** The shared config file (live: config.json of this repository). */
  sharedConfig: string;
  /** The project's tracker from the run's configuration (issue #120; live: liveTracker), or why there is none. */
  tracker: (config: Config) => Result.Result<Layer.Layer<Tracker>, NoTracker | TrackerCredentialMissing>;
  /** The format of a decision analysis, read before the run (D7); by default docs/decision-making.md of this repository. */
  decisionFormat?: string;
}>;

/** The task of a run: a text with at least one character other than whitespace (issue #88). */
export type Task = Brand.Branded<string, "Task">;
/** A task that is empty or whitespace alone, which no run is started with. */
export class BlankTask extends Data.TaggedError("BlankTask")<{}> {}
/** The task, or BlankTask; the text is kept unchanged. */
export const taskOf = (text: string): Result.Result<Task, BlankTask> => (text.trim() === "" ? Result.fail(new BlankTask()) : Result.succeed(text as Task));
/**
 * What a run starts with (issue #120): its mode, the item of the project's tracker it is started from, and the project
 * directory. A tagged union keyed by the mode, because what a run does turns on its mode at every point (its phases,
 * the states it sets, the guard of Claude Code's planning calls, how its task text is made), and each of those is an
 * exhaustive switch the type checker holds to both cases. The task text is not here: the program reads it from the
 * tracker (taskTextOf).
 */
export type RunStart =
  | Readonly<{ mode: "refinement"; item: ItemId; project: string }>
  | Readonly<{ mode: "implementation"; item: ItemId; project: string }>;

/**
 * The task text of a run from its item: the title, a blank line, and the body. A refinement run takes the body without
 * its `Refined using Interloq` section, since the run writes a new one; an implementation run takes the whole body,
 * the section included. A malformed section is SectionMalformed; a blank text BlankTask.
 */
export const taskTextOf = (mode: RunMode, item: TrackerItem): Result.Result<Task, BlankTask | SectionMalformed> => {
  const body = mode === "refinement" ? withoutRefinement(item.body) : Result.succeed(item.body);
  return Result.flatMap(body, (text) => taskOf(text.trim() === "" ? item.title : `${item.title}\n\n${text}`));
};
/** What a run starts with until the program reads its item (S5 of issue #120 replaces it with RunStart). */
export type TaskStart = Readonly<{ task: Task; project: string }>;

/** The developer's format of the representation of a decision (docs/decision-making.md), beside the program. */
export const DECISION_FORMAT = fileURLToPath(new URL("../docs/decision-making.md", import.meta.url));

/** How a run ended when it finished: a refinement run, or an implementation run with its number of execution phases. */
type RunOutcome = Readonly<{ mode: "refinement" }> | Readonly<{ mode: "implementation"; phases: number }>;
/** How a run is started: from an item (RunStart), or, until the run manager starts runs from items (S10 of issue #120), from a task. */
type Started = Readonly<{ project: string; mode: RunMode; item: ItemId; task: (config: Config, ui: UiShape) => Effect.Effect<Result.Result<Readied, string>> }>;
/** What a run has read before its records exist: its task, and its tracker (none for a run started from a task). */
type Readied = Readonly<{ task: Task; tracker: Layer.Layer<Tracker> | null }>;

/**
 * Runs the program and returns the code the run ends with (behavior 11); everything else is said through the Ui.
 * Issue #120: the run reads its item from the project's tracker, before any agent call, and its task text is the item's
 * (taskTextOf); a tracker that is not configured or cannot be reached, an item it cannot read, a malformed section or a
 * blank text halts the run with 1 before any agent exists.
 * A typed error of the run says HALTED and gives 1; UserStopped (End the run: q, /quit, the page's button) says
 * INTERRUPTED and gives 130 (S24). An interruption (Stop task) says INTERRUPTED from a finalizer and leaves the
 * fiber interrupted; `exitCodeOf` turns that into 130. In every case the main Claude Code session id and the usage
 * summary are said last.
 */
export const program = (start: RunStart, wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  programWith(
    {
      project: start.project,
      mode: start.mode,
      item: start.item,
      task: (config, ui) =>
        Effect.gen(function* () {
          const layer = wiring.tracker(config);
          if (Result.isFailure(layer)) return Result.fail(trackerFailureText(layer.failure));
          const read = yield* Effect.exit(Effect.flatMap(Tracker, (t) => t.read(start.item)).pipe(Effect.provide(layer.success)));
          if (Exit.isFailure(read)) {
            const error = Cause.findErrorOption(read.cause);
            if (Option.isNone(error)) return yield* Effect.die(Cause.squash(read.cause));
            return Result.fail(trackerFailureText(error.value));
          }
          const item = read.value;
          yield* ui.say(itemStartedLine(start.mode, item.id, item.title));
          return Result.mapBoth(taskTextOf(start.mode, item), {
            onFailure: (e) => (e._tag === "BlankTask" ? blankItemText(item.id) : sectionMalformedText(item.id, e.reason)),
            onSuccess: (task): Readied => ({ task, tracker: layer.success }),
          });
        }),
    },
    wiring,
  );

/** The program started from a task, as the run manager starts it until S10 of issue #120 (removed there). */
export const programOfTask = (start: TaskStart, wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  programWith({ project: start.project, mode: "implementation", item: "task" as ItemId, task: () => Effect.succeed(Result.succeed({ task: start.task, tracker: null })) }, wiring);

const programWith = (start: Started, wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const project = path.resolve(start.project);
    const ui = yield* wiring.ui;
    // Issue #120: the run's records directory, named by its start time, mode and item; allocated after the configuration
    // is read, so that a run refused by its configuration leaves no directory.
    const planned = runRootOf(start.mode, start.item, new Date(yield* Clock.currentTimeMillis).toISOString());
    const store = (root: RunRoot, ignorePaths: readonly string[]) => makeStore(project, root, ignorePaths).pipe(Effect.provide(wiring.platform));

    /** The last two lines of every ending. */
    const tail = (sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(mainSessionLine(records.root, sessionId));
        const usage = yield* records.usageLines().pipe(Effect.map(summarizeUsage), Effect.map((s) => renderUsage(s, recordPath(records.root, { kind: "usage" }))), Effect.catch((e) => Effect.succeed(`unavailable: ${describe(e)}`)));
        yield* ui.say(`Usage: ${usage}`);
      });
    const halted = (reason: string, sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`\nHALTED: ${reason}\nState is preserved in ${records.dir}.`);
        yield* tail(sessionId, records);
        return 1;
      });

    // The configuration, before any agent exists and before the records are initialised (Q4).
    const configExit = yield* Effect.exit(loadConfig(project, wiring.sharedConfig).pipe(Effect.provide(wiring.platform)));
    if (Exit.isFailure(configExit)) {
      const error = Cause.findErrorOption(configExit.cause);
      if (Option.isNone(error)) return yield* Effect.die(Cause.squash(configExit.cause));
      return yield* halted(describe(error.value), null, yield* store(planned, []));
    }
    const config = configExit.value;

    // The format of a decision analysis (D7), before any agent exists and before the records are initialized.
    const formatFile = wiring.decisionFormat ?? DECISION_FORMAT;
    const formatExit = yield* Effect.exit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(formatFile);
      }).pipe(Effect.provide(wiring.platform)),
    );
    if (Exit.isFailure(formatExit)) {
      const error = Cause.findErrorOption(formatExit.cause);
      if (Option.isNone(error)) return yield* Effect.die(Cause.squash(formatExit.cause));
      return yield* halted(describe(new DecisionFormatUnreadable({ file: formatFile, message: error.value.message })), null, yield* store(planned, []));
    }
    const decisionFormat = formatExit.value;

    // Issue #120: the item and its task text, read from the tracker before any agent exists and before the records exist.
    const taskRead = yield* start.task(config, ui);
    if (Result.isFailure(taskRead)) return yield* halted(taskRead.failure, null, yield* store(planned, []));
    const { task, tracker } = taskRead.success;

    const allocated = yield* Effect.exit(allocateRunRoot(project, planned).pipe(Effect.provide(wiring.platform)));
    if (Exit.isFailure(allocated)) {
      const error = Cause.findErrorOption(allocated.cause);
      if (Option.isNone(error)) return yield* Effect.die(Cause.squash(allocated.cause));
      return yield* halted(describe(error.value), null, yield* store(planned, []));
    }
    const records = yield* store(allocated.value, config.ignorePaths);
    const base = Layer.mergeAll(Layer.succeed(Store, records), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, config), Layer.succeed(Sdk, wiring.sdk));
    // Built once, so that the planner whose session id is printed is the one the run used.
    // Decision support (D3): the Decider runs its loops over the same services as the run.
    const context = yield* Layer.build(Layer.provideMerge(deciderLayer(task, decisionFormat), Layer.provideMerge(wiring.agents, base)));
    const sessionId = Context.get(context, Planner).sessionId;

    const interrupted = Effect.gen(function* () {
      yield* ui.say(`\nINTERRUPTED by the user. State is preserved in ${records.dir}.`);
      yield* records.converse("**Interrupted by the user.**\n").pipe(Effect.ignore);
      yield* tail(yield* sessionId, records);
    });
    // Issue #120: a refinement run is the question phase alone; an implementation run plans, executes and reviews.
    const body: Effect.Effect<RunOutcome, RunError> =
      start.mode === "refinement"
        ? tracker === null
          ? Effect.die(new Error("a refinement run is started from an item, with its tracker"))
          : refinementRun(task, start.item).pipe(Effect.provide(tracker), Effect.provide(context), Effect.as({ mode: "refinement" } as const))
        : run(task).pipe(Effect.provide(context), Effect.map((phases) => ({ mode: "implementation", phases }) as const));
    const exit = yield* body.pipe(Effect.onInterrupt(() => interrupted), Effect.exit);

    if (Exit.isSuccess(exit)) {
      if (exit.value.mode === "implementation") {
        yield* ui.say(taskFinishedLine(exit.value.phases));
        yield* ui.say(`Plan: ${records.plan}\nConversation record: ${records.dir}/conversation.md`);
      } else yield* ui.say(`Requirements: ${records.requirements}\nConversation record: ${records.dir}/conversation.md`);
      yield* tail(yield* sessionId, records);
      return 0;
    }
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isNone(error)) return yield* Effect.die(Cause.squash(exit.cause));
    // S24 (the user's decision at the stop of execution phase 1): End the run is an interruption, like Ctrl+C.
    if (error.value._tag === "UserStopped") {
      yield* interrupted;
      return 130;
    }
    return yield* halted(describe(error.value), yield* sessionId, records);
  });

/**
 * The code a run ends with, from the exit of its fiber: the program's own code, 130 when it was interrupted, 1 for
 * a defect (the program's error channel is empty).
 */
export const exitCodeOf = (exit: Exit.Exit<number>): number => {
  if (Exit.isSuccess(exit)) return exit.value;
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
};
