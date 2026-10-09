// The run manager of the web GUI (plan step 3.3): one run per mode at a time (issue #120), each started from an item of the
// project's tracker, answered and stopped from the page on its own; the events of each mode's current run and of its last
// finished one, broadcast to every connected tab.

import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Ref, Result, type Scope, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Platform } from "./platform.ts";
import { exitCodeOf, program, type RunStart, taskTextOf, type Wiring } from "./program.ts";
import { loadConfig } from "./config.ts";
import { describe, trackerFailureText } from "./errors.ts";
import { excerptOf, listedState, RUN_MODES, type RunMode } from "./runMode.ts";
import { ITEM_ID_EMPTY, itemMovedText, runInProgressText } from "./prompts.ts";
import { Tracker, type TrackerError, type TrackerShape } from "./services.ts";
import { itemIdOf } from "./tracker.ts";
import { identify, type MountTable } from "./hostDir.ts";
import type { ItemsResult, RunEvent, RunRecord, RunUi, Stamped } from "./protocol.ts";
import { emptyUiState, type RunUiState, type UiFlag, withFlag } from "./uiState.ts";
import { makeWebUi, type WebUi } from "./webUi.ts";

/** One event of a run as it is broadcast: the run's id, the event's sequence number in that run (from 0) and the time of its publication. */
export type EventBroadcast = Readonly<{ _tag: "event"; run: number; seq: number; time: string; event: RunEvent }>;
/** The shared state of the page for a run after a change (issue #87): the whole state, with its version. */
export type UiBroadcast = Readonly<{ _tag: "ui"; run: number; state: RunUiState }>;
/** What a listener receives, in the order of publication. */
export type Broadcast = EventBroadcast | UiBroadcast;
/** The snapshot a tab starts from: the runs' records and, beside them, their shared states (issue #87). */
export type Replay = Readonly<{ runs: readonly RunRecord[]; ui: readonly RunUi[] }>;
/** Why an action of the page was not carried out; shown to the user in the tab of its mode, or in none (issue #120). */
export type Refusal = Readonly<{ refused: string; mode: RunMode | null }>;
/** How the manager reaches the project's tracker (issue #120): the shared configuration file and the tracker it names. */
export type TrackerAccess = Readonly<{ sharedConfig: string; tracker: Wiring["tracker"] }>;

export type RunManager = Readonly<{
  /** The identification of the working directory, the one project (issue #29): its host directory, or the path as given. */
  location: string;
  /** This start of the server (finding 12): an action naming another incarnation is refused. */
  incarnation: string;
  /** Registers a listener for every event appended from now on, until the scope closes. */
  subscribe: (listener: (event: Broadcast) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  /** Each mode's last finished run and current one, as far as they exist, in the order of their ids, with all their events and their shared states, read in one step. */
  replay: Effect.Effect<Replay>;
  /** The id of each mode's run in progress, or null. */
  current: Effect.Effect<Readonly<Record<RunMode, number | null>>>;
  /** Starts a run of the mode in the project from the item with that id (issue #120); its id, or why not. */
  start: (mode: RunMode, item: string) => Effect.Effect<number | Refusal>;
  /** The items a mode's tab lists, or the notice of why the tracker cannot list them (issue #120). */
  listItems: (mode: RunMode) => Effect.Effect<ItemsResult>;
  /** Interrupts the run with that id of that incarnation, like Ctrl+C (behaviour 11). */
  stop: (incarnation: string, run: number) => Effect.Effect<Refusal | null>;
  /** The answer to a pending prompt of the run with that id of that incarnation. */
  answer: (incarnation: string, run: number, prompt: number, text: string) => Effect.Effect<Refusal | null>;
  /** Opens or closes one scope of the shared state of the run with that id of that incarnation, the current or the last one (issue #87). */
  setUi: (incarnation: string, run: number, flag: UiFlag) => Effect.Effect<Refusal | null>;
}>;

/** A subscriber of the broadcast. Its contract: it does not block (it offers to its own queue); slow delivery is its own fiber's. */
export type Listener<B> = (event: B) => Effect.Effect<void>;

/**
 * Publication (finding 11 of docs/gui-review.md): `record` computes the event and the next state in one Ref.modify,
 * and the event is offered to every listener, as one step that is serialized (so every listener receives the events
 * in the order in which they were recorded) and uninterruptible (so no event is recorded without being offered).
 * Listeners do not block, so the protected region stays short. Returns the event, or null when `record` produced none.
 */
export const makePublisher = <S, B>(state: Ref.Ref<S>, listeners: Ref.Ref<ReadonlySet<Listener<B>>>): Effect.Effect<(record: (s: S) => readonly [B | null, S]) => Effect.Effect<B | null>> =>
  Semaphore.make(1).pipe(
    Effect.map((serial) => (record: (s: S) => readonly [B | null, S]) =>
      Ref.modify(state, record).pipe(
        Effect.tap((b) => (b === null ? Effect.void : Ref.get(listeners).pipe(Effect.flatMap((set) => Effect.forEach([...set], (listener) => listener(b), { discard: true }))))),
        serial.withPermits(1),
        Effect.uninterruptible,
      ),
    ),
  );

/** A run: its events (the record), its web Ui and fiber, and beside the record the shared state of its page (issue #87). */
type Run = Readonly<{ id: number; events: readonly Stamped[]; ui: WebUi; fiber: Fiber.Fiber<number>; shared: RunUiState }>;
/** A mode's run in progress, and its last finished run (issue #120: one run per mode). */
type Slot = Readonly<{ current: Run | null; last: Run | null }>;
/** The next id (one sequence for the server, so that an id names one run in either mode) and each mode's slot. */
type State = Readonly<{ nextId: number; runs: Readonly<Record<RunMode, Slot>> }>;
const record = (r: Run): RunRecord => ({ id: r.id, events: r.events });
const EMPTY: Slot = { current: null, last: null };
/** The mode whose slot holds the run with that id as `which`, or null. */
const modeOf = (s: State, id: number, which: readonly ("current" | "last")[]): RunMode | null => RUN_MODES.find((m) => which.some((w) => s.runs[m][w]?.id === id)) ?? null;
const withSlot = (s: State, mode: RunMode, slot: Slot): State => ({ ...s, runs: { ...s.runs, [mode]: slot } });

/**
 * The manager over a wiring per run (the live one of src/web.ts with the run's web Ui; the run's mode, so that a test may script each mode). The state is one Ref: the
 * next id (never reused while the process lives) and, per mode, the run in progress and the last finished one
 * (issue #120). An event is appended in one step with its seq and then broadcast, so a listener registered before a
 * snapshot sees every event that the snapshot does not hold (P1-R1-2). The time of an event (issue #1) is read from the
 * Clock before that step, because the record function stays pure; so events published concurrently may carry times in a
 * slightly different order than their seq, and seq is the order.
 *
 * Issue #120 (the developer's answer to question Q1 of 9 Oct 2026): the project of both tabs is `cwd`, the directory the
 * server was started in. The tracker is reached through `access`: the configuration of `cwd` and the tracker it names.
 */
export const makeRunManager = (wiring: (ui: WebUi, mode: RunMode) => Wiring, cwd: string, mounts: MountTable, incarnation: string, access: TrackerAccess): Effect.Effect<RunManager, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = Layer.succeedContext(yield* Effect.context<Platform>());
    const state = yield* Ref.make<State>({ nextId: 1, runs: { refinement: EMPTY, implementation: EMPTY } });
    const listeners = yield* Ref.make<ReadonlySet<Listener<Broadcast>>>(new Set());
    const publish = yield* makePublisher(state, listeners);

    /** Appends an event to the run in progress with the given id and broadcasts it; nothing when no mode's current run has it. */
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    const append = (id: number, event: RunEvent): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          publish((s): readonly [Broadcast | null, State] => {
            const mode = modeOf(s, id, ["current"]);
            const run = mode === null ? null : s.runs[mode].current;
            if (mode === null || run === null) return [null, s];
            return [{ _tag: "event", run: id, seq: run.events.length, time, event }, withSlot(s, mode, { ...s.runs[mode], current: { ...run, events: [...run.events, { time, event }] } })];
          }),
        ),
        Effect.asVoid,
      );
    /** Appends Ended and makes the run its mode's last one, in the same step. */
    const end = (id: number, code: number): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          publish((s): readonly [Broadcast | null, State] => {
            const mode = modeOf(s, id, ["current"]);
            const run = mode === null ? null : s.runs[mode].current;
            if (mode === null || run === null) return [null, s];
            const event: RunEvent = { _tag: "Ended", code };
            return [{ _tag: "event", run: id, seq: run.events.length, time, event }, withSlot(s, mode, { current: null, last: { ...run, events: [...run.events, { time, event }] } })];
          }),
        ),
        Effect.asVoid,
      );

    /** One git command in a directory: its exit code and its standard output (-1 and "" when it cannot be spawned). */
    const git = (dir: string, args: readonly string[]): Effect.Effect<Readonly<{ code: number; out: string }>> =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", dir, ...args]));
          const [out] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.runDrain(handle.stderr)], { concurrency: "unbounded" });
          return { code: yield* handle.exitCode, out: out.trim() };
        }),
      ).pipe(Effect.catch(() => Effect.succeed({ code: -1, out: "" })));

    /**
     * Why the path cannot be a project, or null: it must be the top-level directory of a git worktree (finding 4 of
     * docs/gui-review.md). A subdirectory would be a different project scope than the baseline tree and the
     * exclusions assume, so it is refused with the root named rather than silently widened.
     */
    const invalidProject = (project: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const info = yield* Effect.exit(fs.stat(project));
        if (Exit.isFailure(info)) return `${project} does not exist or cannot be read`;
        if (info.value.type !== "Directory") return `${project} is not a directory`;
        const bare = yield* git(project, ["rev-parse", "--is-bare-repository"]);
        if (bare.code !== 0) return `${project} is not a git repository`;
        if (bare.out === "true") return `${project} is a bare repository; choose a directory with a working tree`;
        const top = yield* git(project, ["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) return `${project} is not in a git working tree`;
        const here = yield* fs.realPath(project).pipe(Effect.catch(() => Effect.succeed(project)));
        const root = yield* fs.realPath(top.out).pipe(Effect.catch(() => Effect.succeed(top.out)));
        return here === root ? null : `${project} is inside the git repository ${root}; choose its top-level directory, the project that Interloq reviews`;
      });

    /**
     * One operation of the project's tracker, from the configuration of `cwd` (issue #120): the server makes every tracker
     * call, never the page. Every failure is the text the page shows, which names a variable and never a credential.
     */
    const withTracker = <A>(use: (tracker: TrackerShape) => Effect.Effect<A, TrackerError>): Effect.Effect<Result.Result<A, string>> =>
      Effect.gen(function* () {
        const invalid = yield* invalidProject(cwd);
        if (invalid !== null) return Result.fail(invalid);
        const config = yield* Effect.result(loadConfig(cwd, access.sharedConfig).pipe(Effect.provide(platform)));
        if (Result.isFailure(config)) return Result.fail(describe(config.failure));
        const layer = access.tracker(config.success);
        if (Result.isFailure(layer)) return Result.fail(trackerFailureText(layer.failure));
        const used = yield* Effect.result(Effect.flatMap(Tracker, use).pipe(Effect.provide(layer.success)));
        return Result.mapError(used, trackerFailureText);
      });

    const listItems = (mode: RunMode): Effect.Effect<ItemsResult> =>
      withTracker((t) => t.list(listedState(mode))).pipe(
        Effect.map(
          Result.match({
            onFailure: (notice): ItemsResult => ({ _tag: "Unavailable", notice }),
            onSuccess: (items): ItemsResult => ({ _tag: "Listed", items: items.map((i) => ({ id: i.id, title: i.title, excerpt: excerptOf(i.body) })) }),
          }),
        ),
      );

    /** The run with that id, if it is a mode's run in progress, with its mode. */
    const currentRun = (id: number) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const mode = modeOf(s, id, ["current"]);
          return mode === null ? null : { mode, run: s.runs[mode].current as Run };
        }),
      );

    const start = (mode: RunMode, itemText: string): Effect.Effect<number | Refusal> =>
      Effect.gen(function* () {
        const refused = (text: string): Refusal => ({ refused: text, mode });
        // The refusals, in order (issue #120): they prevent errors and ask no confirmation (behavior 1).
        const id = itemIdOf(itemText);
        if (Result.isFailure(id)) return refused(ITEM_ID_EMPTY);
        const invalid = yield* invalidProject(cwd);
        if (invalid !== null) return refused(invalid);
        if ((yield* Ref.get(state)).runs[mode].current !== null) return refused(runInProgressText(mode));
        const read = yield* withTracker((t) => t.read(id.success));
        if (Result.isFailure(read)) return refused(read.failure);
        const item = read.success;
        if (item.state !== listedState(mode)) return refused(itemMovedText(item.id, listedState(mode), item.state));
        const gate = yield* Deferred.make<void>();
        // The ui's sink needs the id, and the id is taken with the reservation of the run.
        const idRef = yield* Ref.make(0);
        const ui = yield* makeWebUi((event) => Ref.get(idRef).pipe(Effect.flatMap((rid) => append(rid, event))));
        const runStart: RunStart = mode === "refinement" ? { mode, item: item.id, project: cwd } : { mode, item: item.id, project: cwd };
        // The ownership transfer (finding 11 of docs/gui-review.md) is one uninterruptible region: the fiber exists
        // before the run is reserved, the run is reserved with its fiber in one step, and the gate is released after
        // Started, so no interruption can leave a run reserved without a fiber or a fiber that never starts.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // The fiber outlives the request that started it; it waits for the gate. Started at once, so that its
            // onExit is in place before any stop can interrupt it; a run that was never reserved ends as a no-op
            // (idRef is 0, which is no run's id).
            const fiber = yield* Deferred.await(gate).pipe(
              Effect.andThen(Effect.scoped(program(runStart, wiring(ui, mode)))),
              Effect.onExit((exit: Exit.Exit<number>) => Ref.get(idRef).pipe(Effect.flatMap((rid) => end(rid, exitCodeOf(exit))))),
              Effect.forkDetach({ startImmediately: true }),
            );
            const reserved = yield* Ref.modify(state, (s): readonly [number | null, State] =>
              s.runs[mode].current !== null ? [null, s] : [s.nextId, withSlot({ ...s, nextId: s.nextId + 1 }, mode, { ...s.runs[mode], current: { id: s.nextId, events: [], ui, fiber, shared: emptyUiState } })],
            );
            if (reserved === null) {
              yield* Fiber.interrupt(fiber);
              return refused(runInProgressText(mode));
            }
            yield* Ref.set(idRef, reserved);
            yield* append(reserved, { _tag: "Started", project: cwd, location: identify(mounts, cwd), task: Result.getOrElse(taskTextOf(mode, item), () => item.title), mode, item: { id: item.id, title: item.title } });
            yield* Deferred.succeed(gate, undefined);
            return reserved;
          }),
        );
      });

    /** The refusal of an action naming a run that no mode holds now: it belongs to no tab. */
    const ended: Refusal = { refused: "that run has ended", mode: null };
    const earlier = (mode: RunMode | null): Refusal => ({ refused: "that run belongs to an earlier start of the server", mode });

    return {
      location: identify(mounts, cwd),
      incarnation,
      subscribe: (listener) =>
        Effect.acquireRelease(
          Ref.update(listeners, (set): ReadonlySet<Listener<Broadcast>> => new Set([...set, listener])),
          () => Ref.update(listeners, (set) => new Set([...set].filter((l) => l !== listener))),
        ).pipe(Effect.asVoid),
      replay: Ref.get(state).pipe(
        Effect.map((s) => {
          const runs = RUN_MODES.flatMap((m) => [s.runs[m].last, s.runs[m].current]).flatMap((r) => (r === null ? [] : [r])).sort((a, b) => a.id - b.id);
          return { runs: runs.map(record), ui: runs.map((r) => ({ run: r.id, state: r.shared })) };
        }),
      ),
      current: Ref.get(state).pipe(Effect.map((s) => ({ refinement: s.runs.refinement.current?.id ?? null, implementation: s.runs.implementation.current?.id ?? null }))),
      start,
      listItems,
      stop: (of, id) =>
        currentRun(id).pipe(
          Effect.flatMap((found) => {
            if (of !== incarnation) return Effect.succeed(earlier(found?.mode ?? null));
            if (found === null) return Effect.succeed(ended);
            return Fiber.interrupt(found.run.fiber).pipe(Effect.as(null));
          }),
        ),
      answer: (of, id, prompt, text) =>
        currentRun(id).pipe(
          Effect.flatMap((found) => {
            if (of !== incarnation) return Effect.succeed(earlier(found?.mode ?? null));
            if (found === null) return Effect.succeed(ended);
            return found.run.ui.answer(prompt, text).pipe(Effect.map((taken): Refusal | null => (taken ? null : { refused: "that question has already been answered", mode: found.mode })));
          }),
        ),
      // Issue #87: the change and its broadcast are one serialized, uninterruptible step of the publisher, so every tab
      // receives the states in the order of their versions, interleaved with the run's events as they were recorded.
      setUi: (of, id, flag) =>
        of !== incarnation
          ? Ref.get(state).pipe(Effect.map((s) => earlier(modeOf(s, id, ["current", "last"]))))
          : publish((s): readonly [Broadcast | null, State] => {
              const mode = modeOf(s, id, ["current", "last"]);
              if (mode === null) return [null, s];
              const slot = s.runs[mode];
              const change = (r: Run | null): Run | null => (r !== null && r.id === id ? { ...r, shared: withFlag(r.shared, flag) } : r);
              const [current, last] = [change(slot.current), change(slot.last)];
              const changed = current !== slot.current ? current : last;
              return changed === null ? [null, s] : [{ _tag: "ui", run: id, state: changed.shared }, withSlot(s, mode, { current, last })];
            }).pipe(Effect.map((b) => (b === null ? ended : null))),
    };
  });
