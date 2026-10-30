// The program: arguments, configuration, the live services, the run, and what is printed at the
// end. The run manager runs it for the page (src/runManager.ts); the tests run it with scripted services.

import { type Brand, Cause, Clock, Context, Data, Deferred, Effect, Exit, FileSystem, Layer, Option, Ref, Result, type Scope } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckCommandInvalid, ConfigInvalid, DecisionFormatUnreadable, describe, FileSystemError, type RunError, type ServerFault, type NoTracker, type TrackerCredentialMissing, trackerFailureText, type UserStopped, type NoAnswer, type SendBackUnanswered } from "./errors.ts";
import { heldTrackerEnv, readCommentsWithRetry, readWithRetry, type TrackerRetryEnv, writeWithRetry } from "./trackerRetry.ts";
import { itemReturnOf, type Parking, type ReturnFacts, type RunEnding } from "./itemReturn.ts";
import { ABANDONED_EXIT_CODE, abandonAfterSendBackLine, abandonedRecord, blankItemText, defectRecord, haltRecord, itemNotReturnedLine, itemReturnedLine, itemStartedLine, TRANSPORT_ANSWERS, serverFaultRecord, sessionsLine, sectionMalformedText, taskFinishedLine } from "./prompts.ts";
import { type ImplementationEnd, implementationRun, refinementRun, run } from "./run.ts";
import type { AgentSdk } from "./sdk.ts";
import { Planner, type Reviewer, RunConfig, RunKind, Sdk, Store, type StoreShape, SuiteRunner, type SuiteRunnerShape, Tracker, type TrackerError, type TrackerShape, Ui, type UiShape } from "./services.ts";
import { type Config, NO_STEP_CHECKS, stepChecksOf, type TermsMode } from "./schema.ts";
import { fileOf, loadSourcedConfig } from "./config.ts";
import { listedCommands, manifestProblems, manifestScriptsOf } from "./manifestCheck.ts";
import type { Platform } from "./platform.ts";
import { allocateRunRoot, makeStore } from "./store.ts";
import type { AbandonLabel, ParkNote } from "./chain.ts";
import { abandonedAfterFailure, abandonRun, parkedNoteOf } from "./abandon.ts";
import { pathOf, recordPath, type RunRoot, runRootOf } from "./artifacts.ts";
import { deciderLayer } from "./decision.ts";
import { renderUsage, summarizeUsage } from "./usage.ts";
import type { ItemComment, ItemId, TrackerItem } from "./tracker.ts";
import { commentsTaskText } from "./itemComments.ts";
import { listedState, type RunMode } from "./runMode.ts";
import { readRefinement, type Refinement, type SectionMalformed, withoutRefinement } from "./refinement.ts";

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
  /** The runner of the project's whole suite after the review of the work finds nothing left to correct (issue #162; live: suiteRunner of src/suiteExec.ts). */
  suite: SuiteRunnerShape;
  /** A test's wrapper of every store the run opens (issue #186, W1-R1-3: a parking held while Stop task arrives); none live. */
  store?: (store: StoreShape) => StoreShape;
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
  | Readonly<{ mode: "refinement"; item: ItemId; project: string; terms: TermsMode }>
  | Readonly<{ mode: "implementation"; item: ItemId; project: string }>;

/**
 * The task text of a run from its item: the title, a blank line, and the body. A refinement run takes the body without
 * its `Refined using Interloq` section, since the run writes a new one, and then the item's comments (issue #186,
 * requirements Q3: what an earlier send-back found missing, and what the developer answered), as `commentsTaskText`
 * gives them; an implementation run takes the whole body, the section included, and no comments. A malformed section
 * is SectionMalformed; a blank text BlankTask.
 */
export const taskTextOf = (mode: RunMode, item: TrackerItem, comments: readonly ItemComment[]): Result.Result<Task, BlankTask | SectionMalformed> => {
  const body = mode === "refinement" ? withoutRefinement(item.body) : Result.succeed(item.body);
  const commented = mode === "refinement" ? commentsTaskText(comments) : "";
  return Result.flatMap(body, (text) => {
    const parts = [item.title, text.trim() === "" ? "" : text, commented].filter((part) => part !== "");
    return taskOf(parts.join("\n\n"));
  });
};
/** What a run starts with until the program reads its item (S5 of issue #120 replaces it with RunStart). */
export type TaskStart = Readonly<{ task: Task; project: string }>;

const TRACKER_ERROR_TAGS: ReadonlySet<string> = new Set<TrackerError["_tag"]>(["TrackerUnreachable", "TrackerRequestRefused", "TrackerAuthRefused", "TrackerItemNotFound", "TrackerBodyInvalid", "TrackerStateAmbiguous"]);
export const isTrackerError = (error: TrackerError | RunError): error is TrackerError => TRACKER_ERROR_TAGS.has(error._tag);

/** The developer's format of the representation of a decision (docs/decision-making.md), beside the program. */
export const DECISION_FORMAT = fileURLToPath(new URL("../docs/decision-making.md", import.meta.url));

/** How a run ended when it finished: a refinement run, or an implementation run with its number of execution phases. */
type RunOutcome = Readonly<{ mode: "refinement" }> | Readonly<{ mode: "implementation"; end: ImplementationEnd }>;
/** How a run is started: from an item (RunStart), or, until the run manager starts runs from items (S10 of issue #120), from a task. */
type Started = Readonly<{ project: string; kind: StartedKind; item: ItemId; task: (config: Config, ui: UiShape) => Effect.Effect<Result.Result<Readied, Unready>, UserStopped> }>;
/**
 * Why a run could not read its task (issue #193): the halt's reason, and the records of the first read's repeats
 * (issue #171) collected before it, written to conversation.md before the halt's record.
 */
/**
 * Why a run is not ready, with the first read's held records: a halt's reason, or (issue #185) a question of the first
 * read that went unanswered within its wait.
 */
type Unready = Readonly<{ _tag: "Halt"; reason: string; held: readonly string[] }> | Readonly<{ _tag: "NoAnswer"; error: NoAnswer; held: readonly string[] }>;
/**
 * The mode of a started run with what only that mode carries (issue #142): a refinement run's choice of how the agreed
 * questions' terms are explained; an implementation run has no question phase, so it carries no choice.
 */
type StartedKind = Readonly<{ mode: "refinement"; terms: TermsMode }> | Readonly<{ mode: "implementation" }>;
/**
 * What a run has read before its records exist: its task, and its tracker (none for a run started from a task); and
 * `held`, the records of the first read's repeats (issue #171), written to conversation.md once the run creates it.
 */
type Readied = Readonly<{ task: Task; tracker: Layer.Layer<Tracker> | null; requirements: Refinement | null; held: readonly string[] }>;

/**
 * The server's fault as a run sees it (issue #158): `fault` is failed with ServerFault when the server meets an error it
 * cannot trace to one run, and `recorded` is succeeded by the program once it has written `serverFaultRecord` to the
 * run's conversation.md, so that the run manager knows which halts were recorded.
 */
export type FaultSignal = Readonly<{ fault: Deferred.Deferred<never, ServerFault>; recorded: Deferred.Deferred<void> }>;
/** A fresh signal; its fault comes only if someone fails it. */
export const makeFaultSignal: Effect.Effect<FaultSignal> = Effect.all({ fault: Deferred.make<never, ServerFault>(), recorded: Deferred.make<void>() });

/**
 * Runs the program and returns the code the run ends with (behavior 11); everything else is said through the Ui.
 * Issue #120: the run reads its item from the project's tracker, before any agent call, and its task text is the item's
 * (taskTextOf); a tracker that is not configured or cannot be reached, an item it cannot read, a malformed section or a
 * blank text halts the run with 1 before any agent exists. Issue #171: the read is repeated like every tracker request,
 * and an unreachable tracker halts only when the developer answers Stop to the question its exhausted repeats ask.
 * A typed error of the run says HALTED and gives 1; UserStopped (End the run: q, /quit, the page's button) says
 * INTERRUPTED and gives 130 (S24). An interruption (Stop task) says INTERRUPTED from a finalizer and leaves the
 * fiber interrupted; `exitCodeOf` turns that into 130. In every case the main Claude Code session id and the usage
 * summary are said last.
 */
/**
 * `allocated` (issue #147): where the run's records directory is kept once allocated, given by the run manager so that it
 * learns the directory of a run however it ended, a halt or a defect included.
 */
/**
 * `claimParking` (issue #192) asks the chain to commit to parking this run's halt, and answers whether it did; the run
 * manager gives it as one step of its publisher. Without a chain nothing parks the run.
 */
/**
 * What a run concluded once its records exist (issue #186): its exit code, and the parking the run did itself (a
 * send-back's or a guard stop's, src/sendBack.ts), which the chain then takes as given; null where the run parked nothing.
 */
/** Issue #185: `abandoned`, what an abandonment for want of an answer did to the item's label; null for every other ending. */
export type Conclusion = Readonly<{ code: number; parked: ParkNote | null; abandoned: AbandonLabel | null }>;
/**
 * `concluded` (work review 2 of issue #192, W2-R1-1) receives the code the run computed once its records exist, with its
 * own parking since issue #186. The run's
 * ending is uninterruptible, so a Stop task during it leaves the fiber interrupted when it ends although the program
 * computed its code; the caller reads the code here rather than from the fiber's exit.
 */
export const program = (
  start: RunStart,
  wiring: Wiring,
  signal?: FaultSignal,
  allocated?: Ref.Ref<Option.Option<RunRoot>>,
  claimParking: Effect.Effect<boolean> = Effect.succeed(false),
  concluded?: Ref.Ref<Option.Option<Conclusion>>,
): Effect.Effect<number, never, Scope.Scope> =>
  programWith(
    {
      project: start.project,
      kind: start.mode === "refinement" ? { mode: "refinement", terms: start.terms } : { mode: "implementation" },
      item: start.item,
      task: (config, ui) =>
        Effect.gen(function* () {
          const layer = wiring.tracker(config);
          if (Result.isFailure(layer)) return Result.fail({ _tag: "Halt", reason: trackerFailureText(layer.failure), held: [] });
          // Issue #171 (requirements Q3): the first read is repeated like every tracker request; its records are held
          // until conversation.md exists, and its question carries no Help me decide (the developer's decision of 15 Oct 2026).
          const held = yield* Ref.make<readonly string[]>([]);
          const env = heldTrackerEnv(ui, config, held);
          /** A read of the run's before its records: a failure for good is the halt's reason; End the run is UserStopped. */
          const heldRead = <A>(read: (t: TrackerShape) => Effect.Effect<A, TrackerError | RunError>): Effect.Effect<Result.Result<A, Unready>, UserStopped> =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(Effect.flatMap(Tracker, read).pipe(Effect.provide(layer.success)));
              if (Exit.isSuccess(exit)) return Result.succeed(exit.value);
              const error = Cause.findErrorOption(exit.cause);
              if (Option.isNone(error)) return yield* Effect.die(Cause.squash(exit.cause));
              const failure = error.value;
              if (failure._tag === "UserStopped") return yield* Effect.fail(failure);
              if (failure._tag === "NoAnswer") return Result.fail({ _tag: "NoAnswer", error: failure, held: yield* Ref.get(held) });
              return Result.fail({ _tag: "Halt", reason: isTrackerError(failure) ? trackerFailureText(failure) : describe(failure), held: yield* Ref.get(held) });
            });
          const read = yield* heldRead((t) => readWithRetry(t, start.item, env));
          if (Result.isFailure(read)) return Result.fail(read.failure);
          // Issue #186 (requirements Q3): a refinement reads the item's comments, repeated and held as the first read is.
          const comments = start.mode === "refinement" ? yield* heldRead((t) => readCommentsWithRetry(t, start.item, env)) : Result.succeed<readonly ItemComment[]>([]);
          if (Result.isFailure(comments)) return Result.fail(comments.failure);
          const item = read.success;
          const heldRecords = yield* Ref.get(held);
          yield* ui.say(itemStartedLine(start.mode, item.id, item.title));
          // An implementation run's requirements are the item's section, where it has one (S7).
          const section = readRefinement(item.body);
          if (Result.isFailure(section)) return Result.fail({ _tag: "Halt", reason: sectionMalformedText(item.id, section.failure.reason), held: heldRecords });
          return Result.mapBoth(taskTextOf(start.mode, item, comments.success), {
            onFailure: (e): Unready => ({ _tag: "Halt", reason: e._tag === "BlankTask" ? blankItemText(item.id) : sectionMalformedText(item.id, e.reason), held: heldRecords }),
            onSuccess: (task): Readied => ({ task, tracker: layer.success, requirements: Option.getOrNull(section.success), held: heldRecords }),
          });
        }),
    },
    wiring,
    signal,
    allocated,
    claimParking,
    concluded,
  );

/** The program started from a task, as the run manager starts it until S10 of issue #120 (removed there). */
export const programOfTask = (start: TaskStart, wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  programWith({ project: start.project, kind: { mode: "implementation" }, item: "task" as ItemId, task: () => Effect.succeed(Result.succeed<Readied>({ task: start.task, tracker: null, requirements: null, held: [] })) }, wiring);

/**
 * The signal's fault fails when the server meets an error it cannot trace to one run (issue #158): every stage of the
 * run, from the configuration to the body, is raced with it, so the run halts with ServerFault and its record wherever
 * it is. Without a signal, the run makes one that no one fails.
 */
const programWith = (
  start: Started,
  wiring: Wiring,
  given?: FaultSignal,
  allocated?: Ref.Ref<Option.Option<RunRoot>>,
  claimParking: Effect.Effect<boolean> = Effect.succeed(false),
  concluded?: Ref.Ref<Option.Option<Conclusion>>,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const signal = given ?? (yield* makeFaultSignal);
    const fault = Deferred.await(signal.fault);
    const project = path.resolve(start.project);
    const mode = start.kind.mode;
    const ui = yield* wiring.ui;
    // Issue #120: the run's records directory, named by its start time, mode and item; allocated after the configuration
    // and the item are read. Issue #193: a halt before that allocates it to record the halt there (haltedBeforeRecords).
    const planned = runRootOf(mode, start.item, new Date(yield* Clock.currentTimeMillis).toISOString());
    const store = (root: RunRoot, ignorePaths: readonly string[]) => makeStore(project, root, ignorePaths).pipe(Effect.map(wiring.store ?? ((s: StoreShape) => s)), Effect.provide(wiring.platform));

    /** The last two lines of every ending. */
    const tail = (sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(sessionsLine(records.root, mode, sessionId));
        const usage = yield* records.usageLines().pipe(Effect.map(summarizeUsage), Effect.map((s) => renderUsage(s, recordPath(records.root, { kind: "usage" }))), Effect.catch((e) => Effect.succeed(`unavailable: ${describe(e)}`)));
        yield* ui.say(`Usage: ${usage}`);
      });
    /** What the page is told of a halt: HALTED, its reason and the records' directory, then the last two lines. */
    const sayHalt = (reason: string, sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`\nHALTED: ${reason}\nState is preserved in ${records.dir}.`);
        yield* tail(sessionId, records);
        return 1;
      });
    /**
     * Issue #193: a halt of a run whose records exist: its record in conversation.md first, so that it is on disk when the
     * run's end is published, then what the page is told. A write that fails is ignored, so a halt never becomes a defect.
     */
    const halted = (reason: string, sessionId: string | null, records: StoreShape) =>
      records.converse(haltRecord(reason)).pipe(Effect.ignore, Effect.andThen(sayHalt(reason, sessionId, records)));
    /** Issue #185: what the page is told of a run that got no answer: NO ANSWER, the reason and the records, then the last two lines. */
    const sayAbandoned = (reason: string, sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`\nNO ANSWER: ${reason}\nState is preserved in ${records.dir}.`);
        yield* tail(sessionId, records);
        return ABANDONED_EXIT_CODE;
      });
    /** Issue #185: the record of the abandonment in conversation.md, then what the page is told; 2. */
    const abandonedEnding = (error: NoAnswer | SendBackUnanswered, sessionId: string | null, records: StoreShape) =>
      records.converse(abandonedRecord(describe(error))).pipe(Effect.ignore, Effect.andThen(sayAbandoned(describe(error), sessionId, records)));

    /**
     * Issue #193: any directory this run allocated, the setup's (which rootRef names too) or one allocated for a halt
     * before the records exist (which rootRef does not, so that the chain treats that run as one that halted before setup).
     */
    const recordsRoot = yield* Ref.make<Option.Option<RunRoot>>(Option.none());
    /**
     * Issue #193: a halt before the run's records exist. The run's directory is allocated (in one uninterruptible step with
     * recordsRoot, so a server fault racing it finds the same directory), the first read's held records and the halt's
     * record are written there, and the page is told; where the allocation fails, the page alone.
     */
    const haltedBeforeRecords = (reason: string, held: readonly string[]) => endedBeforeRecords(held, (records) => halted(reason, null, records), (records) => sayHalt(reason, null, records));
    /**
     * Issue #185: a question of the first read that went unanswered: the same directory with the held records and the
     * abandonment's record, and 2. Nothing was committed and no label set, so the item keeps the label refined.
     */
    const abandonedBeforeRecords = (error: NoAnswer, held: readonly string[]) =>
      endedBeforeRecords(held, (records) => abandonedEnding(error, null, records), (records) => sayAbandoned(describe(error), null, records));
    /** The directory of an ending before the records exist, its held records, then `ended`; where it fails, `said` alone. */
    const endedBeforeRecords = (held: readonly string[], ended: (records: StoreShape) => Effect.Effect<number>, said: (records: StoreShape) => Effect.Effect<number>) =>
      Effect.gen(function* () {
        const root = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const known = yield* Ref.get(recordsRoot);
            if (Option.isSome(known)) return Exit.succeed(known.value);
            const made = yield* Effect.exit(allocateRunRoot(project, planned).pipe(Effect.provide(wiring.platform)));
            if (Exit.isSuccess(made)) yield* Ref.set(recordsRoot, Option.some(made.value));
            return made;
          }),
        );
        if (Exit.isFailure(root)) return yield* said(yield* store(planned, []));
        const records = yield* store(root.value, []);
        yield* Effect.forEach(held, (markdown) => records.converse(markdown), { discard: true }).pipe(Effect.ignore);
        return yield* ended(records);
      });

    /**
     * What the run reads before its records exist (issue #158): the configuration, the format and the item. A halt here
     * is said at once and its code returned. Raced with the server's fault, which may come while the tracker's read
     * hangs; the records directory is allocated after it, so a fault never leaves the run two directories.
     */
    const prepare = Effect.gen(function* () {
      // The configuration, before any agent exists and before the records are initialised (Q4).
      const configExit = yield* Effect.exit(loadSourcedConfig(project, wiring.sharedConfig).pipe(Effect.provide(wiring.platform)));
      if (Exit.isFailure(configExit)) {
        const error = Cause.findErrorOption(configExit.cause);
        if (Option.isNone(error)) return yield* Effect.die(Cause.squash(configExit.cause));
        return yield* haltedBeforeRecords(describe(error.value), []);
      }
      const sourced = configExit.value;
      const config = sourced.config;

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
        return yield* haltedBeforeRecords(describe(new DecisionFormatUnreadable({ file: formatFile, message: error.value.message })), []);
      }
      const decisionFormat = formatExit.value;

      // Issue #120: the item and its task text, read from the tracker before any agent exists and before the records exist.
      const taskExit = yield* Effect.exit(start.task(config, ui));
      if (Exit.isFailure(taskExit)) {
        const error = Cause.findErrorOption(taskExit.cause);
        if (Option.isNone(error)) return yield* Effect.die(Cause.squash(taskExit.cause));
        // Issue #171: End the run at the first read's question, before the run has records.
        yield* ui.say("\nINTERRUPTED by the user.");
        yield* tail(null, yield* store(planned, []));
        return 130;
      }
      const taskRead = taskExit.value;
      if (Result.isFailure(taskRead))
        return yield* taskRead.failure._tag === "NoAnswer" ? abandonedBeforeRecords(taskRead.failure.error, taskRead.failure.held) : haltedBeforeRecords(taskRead.failure.reason, taskRead.failure.held);
      const { task, tracker, requirements, held } = taskRead.success;

      // Issue #162: an implementation run decodes its check commands and checks their npm scripts against the project's
      // package.json; a refinement run reads neither setting, so a malformed value never refuses it.
      if (mode === "refinement") return { config, decisionFormat, task, tracker, requirements, held, checks: NO_STEP_CHECKS } as const;
      const checks = stepChecksOf(config);
      if (Result.isFailure(checks)) {
        const { key, path: inside, message } = checks.failure;
        const invalid = new ConfigInvalid({ file: fileOf(sourced, key) ?? "the default configuration", path: `${key}${inside}`, message });
        return yield* haltedBeforeRecords(describe(invalid), held);
      }
      const manifest = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = path.join(project, "package.json");
        return (yield* fs.exists(file)) ? Option.some(manifestScriptsOf(yield* fs.readFileString(file))) : Option.none();
      }).pipe(Effect.provide(wiring.platform), Effect.exit);
      if (Exit.isFailure(manifest)) {
        const error = Cause.findErrorOption(manifest.cause);
        if (Option.isNone(error)) return yield* Effect.die(Cause.squash(manifest.cause));
        return yield* haltedBeforeRecords(describe(new FileSystemError({ operation: "read", path: path.join(project, "package.json"), message: error.value.message })), held);
      }
      const problems = manifestProblems(listedCommands(checks.success), manifest.value);
      if (problems.length > 0) return yield* haltedBeforeRecords(describe(new CheckCommandInvalid({ problems })), held);
      return { config, decisionFormat, task, tracker, requirements, held, checks: checks.success } as const;
    });
    // Issue #158: the run's directory once allocated, so that a fault after the allocation records its halt there.
    const rootRef = allocated ?? (yield* Ref.make<Option.Option<RunRoot>>(Option.none()));
    /** The server's fault if it has come, without waiting for it. */
    const faultCome = Deferred.isDone(signal.fault).pipe(
      Effect.flatMap((done) => (done ? Effect.flip(fault).pipe(Effect.map(Option.some)) : Effect.succeed(Option.none<ServerFault>()))),
    );
    /** Writes the server-fault record and marks it written; a write that fails leaves it unmarked. */
    const recordFault = (records: StoreShape, message: string) =>
      records.converse(serverFaultRecord(message)).pipe(Effect.andThen(Deferred.succeed(signal.recorded, undefined)), Effect.ignore);
    /**
     * The halt of a fault that came before the body: recorded in the run's directory if it was allocated, otherwise in
     * one allocated now, so that the halt is recorded; the planned store if that allocation fails.
     */
    const faultHalted = (error: ServerFault, ignorePaths: readonly string[]) =>
      Effect.gen(function* () {
        const known = yield* Ref.get(recordsRoot);
        const root = Option.isSome(known) ? Exit.succeed(known.value) : yield* Effect.exit(allocateRunRoot(project, planned).pipe(Effect.provide(wiring.platform)));
        const faultRecords = yield* store(Exit.isSuccess(root) ? root.value : planned, ignorePaths);
        if (Exit.isSuccess(root)) yield* recordFault(faultRecords, error.message);
        return yield* sayHalt(describe(error), null, faultRecords);
      });
    /**
     * The fault's halt, or the defect, from a stage's failed exit. Issue #193 (Q2): a defect is recorded in the directory
     * this run allocated, where there is one, before the fiber dies with it.
     */
    const stageFailed = (cause: Cause.Cause<ServerFault>, ignorePaths: readonly string[]) =>
      Effect.gen(function* () {
        const error = Cause.findErrorOption(cause);
        if (Option.isNone(error)) {
          const known = yield* Ref.get(recordsRoot);
          if (Option.isSome(known) && !Cause.hasInterruptsOnly(cause)) {
            yield* store(known.value, ignorePaths).pipe(Effect.flatMap((records) => records.converse(defectRecord(defectMessage(Cause.squash(cause))))), Effect.ignore);
          }
          return yield* Effect.die(Cause.squash(cause));
        }
        return yield* faultHalted(error.value, ignorePaths);
      });

    /**
     * A stage raced with the server's fault: its own value, or the fault (W1-R1-1 of issue #158). A faulted stage
     * interrupted from outside, which haltAll does to a run that has not ended within its grace, records the fault's halt
     * (W1-S1-1); an interruption without a fault (Stop task) says nothing here, as before.
     */
    const orFault = <A, R>(stage: Effect.Effect<A, never, R>, ignorePaths: readonly string[]): Effect.Effect<Exit.Exit<A, ServerFault>, never, R> =>
      Effect.exit(Effect.raceFirst(stage, fault)).pipe(
        Effect.onInterrupt(() => faultCome.pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (error) => Effect.asVoid(faultHalted(error, ignorePaths)) })))),
      );

    const prepared = yield* orFault(prepare, []);
    if (Exit.isFailure(prepared)) return yield* stageFailed(prepared.cause, []);
    if (typeof prepared.value === "number") return prepared.value;
    const { config, decisionFormat, task, tracker, requirements, held, checks } = prepared.value;

    /**
     * The run's directory, its store and its services, raced with the fault (W1-R1-1 of issue #158). The allocation
     * and the setting of rootRef are one uninterruptible step, so a fault never leaves a directory rootRef does not
     * name. Layer.build acquires into the program's scope, which releases what it acquired when the run ends.
     */
    const setup = Effect.gen(function* () {
      const allocated = yield* Effect.uninterruptible(
        Effect.exit(allocateRunRoot(project, planned).pipe(Effect.provide(wiring.platform))).pipe(
          Effect.tap((exit) => (Exit.isSuccess(exit) ? Ref.set(rootRef, Option.some(exit.value)).pipe(Effect.andThen(Ref.set(recordsRoot, Option.some(exit.value)))) : Effect.void)),
        ),
      );
      if (Exit.isFailure(allocated)) {
        const error = Cause.findErrorOption(allocated.cause);
        if (Option.isNone(error)) return yield* Effect.die(Cause.squash(allocated.cause));
        return yield* sayHalt(describe(error.value), null, yield* store(planned, []));
      }
      const records = yield* store(allocated.value, config.ignorePaths);
      const base = Layer.mergeAll(Layer.succeed(Store, records), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, config), Layer.succeed(RunKind, { mode }), Layer.succeed(Sdk, wiring.sdk), Layer.succeed(SuiteRunner, wiring.suite));
      // Built once, so that the planner whose session id is printed is the one the run used.
      // Decision support (D3): the Decider runs its loops over the same services as the run.
      const context = yield* Layer.build(Layer.provideMerge(deciderLayer(task, decisionFormat), Layer.provideMerge(wiring.agents, base)));
      return { records, context } as const;
    });
    const built = yield* orFault(setup, config.ignorePaths);
    if (Exit.isFailure(built)) return yield* stageFailed(built.cause, config.ignorePaths);
    if (typeof built.value === "number") return built.value;
    const { records, context } = built.value;
    const sessionId = Context.get(context, Planner).sessionId;

    /**
     * Issue #192 (decision Q5): an implementation run that ends halted or stopped having made no commit labels its item
     * refined again, through the tracker retry, with no question (the run is already ending), saying and writing the
     * outcome; nothing here changes the run's exit code. A halt asks the chain to claim the parking of its uncommitted
     * files, and a claimed parking keeps the item implementing. `bounded`, after the server's fault, gives the write 5 s.
     */
    const returnItem = (ending: RunEnding, bounded: boolean): Effect.Effect<void> =>
      mode !== "implementation" || tracker === null
        ? Effect.void
        : Effect.gen(function* () {
            const say = (line: string) => ui.say(line).pipe(Effect.andThen(records.converse(`${line}\n\n`).pipe(Effect.ignore)));
            const facts = yield* Effect.gen(function* () {
              const baseline = yield* records.baseline();
              if (baseline === null) return NO_BASELINE;
              const head = yield* records.head();
              const startCommit = baseline.start_commit;
              // Issue #186: the run's own send-back or guard stop wrote parked.json; its item is never returned.
              if ((yield* records.loadParked()) !== null) return baselineFacts(startCommit, head, PARKED_BY_RUN);
              if (head !== startCommit) return baselineFacts(startCommit, head, NOT_PARKED);
              // The chain parks a halt alone, and only one that left files uncommitted; after the server's fault the
              // chain is left as it is (behavior 15), so no claim is asked.
              if (ending !== "halted" || bounded) return baselineFacts(startCommit, head, NOT_PARKED);
              const check = yield* records.uncommittedSinceStart();
              const claimed = check._tag === "Uncommitted" && (yield* claimParking);
              return baselineFacts(startCommit, head, claimed ? PARKING_CLAIMED : NOT_PARKED);
            }).pipe(Effect.result);
            if (Result.isFailure(facts)) return yield* say(itemNotReturnedLine(start.item, describe(facts.failure), null));
            if (itemReturnOf(facts.success)._tag !== "Return") return;
            // Its waits and read-back recorded as any tracker write's, a record that fails ignored so it cuts no retry short.
            const env: TrackerRetryEnv = { ui, settings: config, record: (markdown) => records.converse(markdown).pipe(Effect.ignore), ask: () => Effect.succeed(TRANSPORT_ANSWERS.stop), exhausted: "ask" };
            const write = Effect.flatMap(Tracker, (t) => writeWithRetry(t, { kind: "setState", item: start.item, state: listedState("implementation") }, env)).pipe(Effect.provide(tracker));
            const outcome = yield* (bounded ? write.pipe(Effect.timeoutOption(`${RETURN_AFTER_FAULT_MS} millis`)) : write.pipe(Effect.map(Option.some))).pipe(Effect.exit);
            if (Exit.isSuccess(outcome)) {
              return yield* say(Option.isSome(outcome.value) ? itemReturnedLine(start.item) : itemNotReturnedLine(start.item, `no answer within ${RETURN_AFTER_FAULT_MS / 1000} s`, null));
            }
            const error = Cause.findErrorOption(outcome.cause);
            const failure = Option.getOrNull(error);
            const [cause, check] =
              failure === null ? [Cause.pretty(outcome.cause), null] : failure._tag === "TrackerWriteFailed" ? [trackerFailureText(failure.error), failure.check] : [describe(failure), null];
            return yield* say(itemNotReturnedLine(start.item, cause, check));
          });

    /**
     * W2-R1-1: the code the run computed, kept for the caller in `concluded` and returned. Issue #186: with the run's own
     * parking, given where the ending carries it and otherwise read from parked.json, so an interruption after a
     * completed parking tells the chain the work is parked.
     */
    const conclude = (code: number, given?: ParkNote | null, abandoned: AbandonLabel | null = null): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (concluded === undefined) return code;
        const parked = given !== undefined ? given : parkedNoteOf(yield* records.loadParked().pipe(Effect.orElseSucceed(() => null)));
        yield* Ref.set(concluded, Option.some({ code, parked, abandoned }));
        return code;
      });
    /**
     * Issue #185: what an abandonment did to the work and the label. A send-back that had begun keeps its parking and
     * sets no label; an implementation run with its tracker parks and sets the label to refined; a run without one
     * (a refinement, which never counts down, or the tests' run) touches neither.
     */
    const abandonment = (failure: NoAnswer | SendBackUnanswered): Effect.Effect<Readonly<{ park: ParkNote | null; label: AbandonLabel }>> =>
      Effect.gen(function* () {
        if (failure._tag === "SendBackUnanswered") {
          const line = abandonAfterSendBackLine(failure.item, failure.park._tag === "Parked" ? failure.park.branch : null, failure.step);
          yield* ui.say(line);
          yield* records.converse(`${line}\n\n`).pipe(Effect.ignore);
          return { park: failure.park, label: { _tag: "SendBackUnfinished", step: failure.step } as const };
        }
        if (mode !== "implementation" || tracker === null) return { park: null, label: { _tag: "Unchanged" } as const };
        const done = yield* Effect.result(abandonRun(start.item).pipe(Effect.provide(tracker), Effect.provide(context)));
        if (Result.isSuccess(done)) return done.success;
        // A failure of the abandonment is said; W1-R1-2: its outcome is read from parked.json as it stands.
        const cause = describe(done.failure);
        yield* ui.say(cause);
        return abandonedAfterFailure(yield* records.loadParked().pipe(Effect.orElseSucceed(() => null)), cause);
      });
    const interrupted = Effect.gen(function* () {
      yield* ui.say(`\nINTERRUPTED by the user. State is preserved in ${records.dir}.`);
      yield* records.converse("**Interrupted by the user.**\n").pipe(Effect.ignore);
      yield* tail(yield* sessionId, records);
    });
    /** The halt of the server's fault once the records and the services exist: its record, then HALTED. */
    const bodyFaulted = (error: ServerFault) =>
      Effect.gen(function* () {
        yield* recordFault(records, error.message);
        yield* returnItem("halted", true);
        return yield* sayHalt(describe(error), yield* sessionId, records);
      });
    /**
     * An interruption of the whole run from outside: the server's fault's halt if the fault has come (W1-S1-1 of issue
     * #158: haltAll interrupts a faulted run whose body did not end within the grace), otherwise the user's (Stop task).
     */
    const interruptedFromOutside = faultCome.pipe(
      Effect.flatMap(Option.match({ onNone: () => returnItem("stopped", false).pipe(Effect.andThen(interrupted), Effect.as(130)), onSome: bodyFaulted })),
      Effect.flatMap((code) => conclude(code)),
    );
    // Issue #120: a refinement run is the question phase alone; an implementation run plans, executes and reviews.
    const kind = start.kind;
    const body: Effect.Effect<RunOutcome, RunError> =
      kind.mode === "refinement"
        ? tracker === null
          ? Effect.die(new Error("a refinement run is started from an item, with its tracker"))
          : refinementRun(task, start.item, kind.terms, held).pipe(Effect.provide(tracker), Effect.provide(context), Effect.as({ mode: "refinement" } as const))
        : (tracker === null ? run(task, checks) : implementationRun(task, start.item, requirements, checks, held).pipe(Effect.provide(tracker))).pipe(
            Effect.provide(context),
            Effect.map((end) => ({ mode: "implementation", end }) as const),
          );
    // The race with the server's fault is inside onInterrupt, so a body ended by the fault does not say INTERRUPTED;
    // only an interruption of the whole run (Stop task) does. W2-R1-1 of issue #192: the body alone is interruptible;
    // everything after it (the item's return, the records of the ending, what is said) runs uninterruptibly, so a Stop
    // task during it cannot leave the item unreturned or a claimed parking unparked, and the code computed is concluded.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const exit = yield* restore(Effect.raceFirst(body, fault)).pipe(Effect.onInterrupt(() => interruptedFromOutside), Effect.exit);
        if (Exit.isSuccess(exit)) {
          if (exit.value.mode === "implementation") {
            const end = exit.value.end;
            // Issue #186: a send-back is the run doing what it was asked, so it ends with 0; its line was said by sendBack.
            if (end._tag === "Finished") {
              yield* ui.say(taskFinishedLine(end.phases));
              yield* ui.say(`Plan: ${records.plan}\nConversation record: ${records.dir}/conversation.md`);
            } else yield* ui.say(`Verdict: ${records.dir}/${pathOf({ kind: "verdict", verdict: end.verdict })}\nConversation record: ${records.dir}/conversation.md`);
          } else yield* ui.say(`Requirements: ${records.requirements}\nConversation record: ${records.dir}/conversation.md`);
          yield* tail(yield* sessionId, records);
          return yield* conclude(0, exit.value.mode === "implementation" && exit.value.end._tag === "SentBack" ? exit.value.end.park : null);
        }
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isNone(error)) {
          // An interruption from outside was ended by interruptedFromOutside, which concluded its code.
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
          // Issue #193 (Q2): a defect of the run is recorded before the fiber dies with it.
          yield* records.converse(defectRecord(defectMessage(Cause.squash(exit.cause)))).pipe(Effect.ignore);
          return yield* Effect.die(Cause.squash(exit.cause));
        }
        // S24 (the user's decision at the stop of execution phase 1): End the run is an interruption, like Ctrl+C.
        if (error.value._tag === "UserStopped") {
          yield* returnItem("stopped", false);
          yield* interrupted;
          return yield* conclude(130);
        }
        if (error.value._tag === "ServerFault") return yield* bodyFaulted(error.value).pipe(Effect.flatMap((code) => conclude(code)));
        // Issue #185: no answer came within the wait: the run's work moved to the item's branch and the label set to
        // refined (abandonRun), or, where a send-back had begun, its undone step said and no label set.
        if (error.value._tag === "NoAnswer" || error.value._tag === "SendBackUnanswered") {
          const failure = error.value;
          const { park, label } = yield* abandonment(failure);
          const code = yield* abandonedEnding(failure, yield* sessionId, records);
          return yield* conclude(code, park, label);
        }
        // Issue #186: the guard's stop keeps the item implementing (requirements Q5), and a parking that failed or a
        // send-back left incomplete keeps it too (Q6): the item is not returned, and the ending's parking is concluded.
        const failure = error.value;
        const parkedEnding = failure._tag === "NotRefinedStopped" || failure._tag === "SendBackNotParked" || failure._tag === "SendBackIncomplete" ? failure : null;
        if (parkedEnding === null) yield* returnItem("halted", false);
        const code = yield* halted(describe(failure), yield* sessionId, records);
        return yield* conclude(code, parkedEnding === null ? undefined : parkedEnding.park);
      }),
    );
  });

/**
 * Issue #192: how long the relabeling of an item may take after the server's fault, half of SERVER_FAULT_GRACE_MS (10 s),
 * after which the manager interrupts the run; the first attempt and its read-back fit, the first retry's wait does not.
 */
export const RETURN_AFTER_FAULT_MS = 5_000;
const NOT_PARKED: Parking = { _tag: "NotParked" };
const PARKING_CLAIMED: Parking = { _tag: "ParkingClaimed" };
const PARKED_BY_RUN: Parking = { _tag: "ParkedByRun" };
const NO_BASELINE: ReturnFacts = { _tag: "NoBaseline" };
const baselineFacts = (startCommit: string | null, head: string | null, parking: Parking): ReturnFacts => ({ _tag: "Baseline", startCommit, head, parking });

/** Issue #193 (Q2): the message of a defect, an error of Interloq that is not a typed error, for its record. */
export const defectMessage = (defect: unknown): string => (defect instanceof Error ? defect.message : String(defect));

/**
 * The code a run ends with, from the exit of its fiber: the program's own code, 130 when it was interrupted, 1 for
 * a defect (the program's error channel is empty).
 */
export const exitCodeOf = (exit: Exit.Exit<number>): number => {
  if (Exit.isSuccess(exit)) return exit.value;
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
};
