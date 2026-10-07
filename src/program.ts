// The program: arguments, configuration, the live services, the run, and what is printed at the
// end. The run manager runs it for the page (src/runManager.ts); the tests run it with scripted services.

import { type Brand, Cause, Context, Data, Effect, Exit, FileSystem, Layer, Option, Result, type Scope } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionFormatUnreadable, describe } from "./errors.ts";
import { taskFinishedLine } from "./prompts.ts";
import { run } from "./run.ts";
import type { AgentSdk } from "./sdk.ts";
import { Planner, type Reviewer, RunConfig, Sdk, Store, type StoreShape, Ui, type UiShape } from "./services.ts";
import { loadConfig } from "./config.ts";
import type { Platform } from "./platform.ts";
import { makeStore } from "./store.ts";
import { deciderLayer } from "./decision.ts";
import { renderUsage, summarizeUsage } from "./usage.ts";

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
  /** The format of a decision analysis, read before the run (D7); by default docs/decision-making.md of this repository. */
  decisionFormat?: string;
}>;

/** The task of a run: a text with at least one character other than whitespace (issue #88). */
export type Task = Brand.Branded<string, "Task">;
/** A task that is empty or whitespace alone, which no run is started with. */
export class BlankTask extends Data.TaggedError("BlankTask")<{}> {}
/** The task, or BlankTask; the text is kept unchanged. */
export const taskOf = (text: string): Result.Result<Task, BlankTask> => (text.trim() === "" ? Result.fail(new BlankTask()) : Result.succeed(text as Task));
/** What a run starts with: its task and its project directory. */
export type RunStart = Readonly<{ task: Task; project: string }>;

/** The developer's format of the representation of a decision (docs/decision-making.md), beside the program. */
export const DECISION_FORMAT = fileURLToPath(new URL("../docs/decision-making.md", import.meta.url));

/**
 * Runs the program and returns the code the run ends with (behavior 11); everything else is said through the Ui.
 * A typed error of the run says HALTED and gives 1; UserStopped (End the run: q, /quit, the page's button) says
 * INTERRUPTED and gives 130 (S24). An interruption (Stop task) says INTERRUPTED from a finalizer and leaves the
 * fiber interrupted; `exitCodeOf` turns that into 130. In every case the Claude Code session id and the usage
 * summary are said last.
 */
export const program = (start: RunStart, wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { task } = start;
    const project = path.resolve(start.project);
    const dir = path.join(project, "plan-review");
    const ui = yield* wiring.ui;
    const store = (ignorePaths: readonly string[]) => makeStore(project, ignorePaths).pipe(Effect.provide(wiring.platform));

    /** The last two lines of every ending. */
    const tail = (sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`Claude Code session id: ${sessionId ?? "none"}`);
        const usage = yield* records.usageLines().pipe(Effect.map(summarizeUsage), Effect.map(renderUsage), Effect.catch((e) => Effect.succeed(`unavailable: ${describe(e)}`)));
        yield* ui.say(`Usage: ${usage}`);
      });
    const halted = (reason: string, sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`\nHALTED: ${reason}\nState is preserved in ${dir}.`);
        yield* tail(sessionId, records);
        return 1;
      });

    // The configuration, before any agent exists and before the records are initialised (Q4).
    const configExit = yield* Effect.exit(loadConfig(project, wiring.sharedConfig).pipe(Effect.provide(wiring.platform)));
    if (Exit.isFailure(configExit)) {
      const error = Cause.findErrorOption(configExit.cause);
      if (Option.isNone(error)) return yield* Effect.die(Cause.squash(configExit.cause));
      return yield* halted(describe(error.value), null, yield* store([]));
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
      return yield* halted(describe(new DecisionFormatUnreadable({ file: formatFile, message: error.value.message })), null, yield* store([]));
    }
    const decisionFormat = formatExit.value;

    const records = yield* store(config.ignorePaths);
    const base = Layer.mergeAll(Layer.succeed(Store, records), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, config), Layer.succeed(Sdk, wiring.sdk));
    // Built once, so that the planner whose session id is printed is the one the run used.
    // Decision support (D3): the Decider runs its loops over the same services as the run.
    const context = yield* Layer.build(Layer.provideMerge(deciderLayer(task, decisionFormat), Layer.provideMerge(wiring.agents, base)));
    const sessionId = Context.get(context, Planner).sessionId;

    const interrupted = Effect.gen(function* () {
      yield* ui.say(`\nINTERRUPTED by the user. State is preserved in ${dir}.`);
      yield* records.converse("**Interrupted by the user.**\n").pipe(Effect.ignore);
      yield* tail(yield* sessionId, records);
    });
    const exit = yield* run(task).pipe(Effect.provide(context), Effect.onInterrupt(() => interrupted), Effect.exit);

    if (Exit.isSuccess(exit)) {
      yield* ui.say(taskFinishedLine(exit.value));
      yield* ui.say(`Plan: ${records.plan}\nConversation record: ${records.dir}/conversation.md`);
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
