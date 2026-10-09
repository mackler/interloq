// The run manager of the web GUI (plan step 3.3): one run at a time, started, answered and stopped from the page;
// the events of the current run and of the last finished one, broadcast to every connected tab.

import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Ref, Result, type Scope, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Platform } from "./platform.ts";
import { exitCodeOf, programOfTask, taskOf, type Wiring } from "./program.ts";
import { identify, type MountTable } from "./hostDir.ts";
import type { RunEvent, RunRecord, RunUi, Stamped } from "./protocol.ts";
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
/** Why an action of the page was not carried out; shown to the user. */
export type Refusal = Readonly<{ refused: string }>;

export type RunManager = Readonly<{
  /** The server's working directory: where the page's directory browser starts. */
  cwd: string;
  /** The identification of the working directory (issue #29): its host directory, or the path as given. */
  location: string;
  /** This start of the server (finding 12): an action naming another incarnation is refused. */
  incarnation: string;
  /** Registers a listener for every event appended from now on, until the scope closes. */
  subscribe: (listener: (event: Broadcast) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  /** The last finished run and the current one, as far as they exist, with all their events and their shared states, read in one step. */
  replay: Effect.Effect<Replay>;
  /** The id of the run in progress, or null. */
  current: Effect.Effect<number | null>;
  /** Starts a run of the program in the project with the task; its id, or why not. */
  start: (project: string, task: string) => Effect.Effect<number | Refusal>;
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
type State = Readonly<{ nextId: number; current: Run | null; last: Run | null }>;
const record = (r: Run): RunRecord => ({ id: r.id, events: r.events });
const ENDED: Refusal = { refused: "that run has ended" };
const EARLIER: Refusal = { refused: "that run belongs to an earlier start of the server" };

/**
 * The manager over a wiring per run (the live one of src/web.ts with the run's web Ui). The state is one Ref: the
 * next id (never reused while the process lives), the current run and the last finished one. An event is
 * appended in one step with its seq and then broadcast, so a listener registered before a snapshot sees every
 * event that the snapshot does not hold (P1-R1-2). The time of an event (issue #1) is read from the Clock before
 * that step, because the record function stays pure; so events published concurrently may carry times in a slightly
 * different order than their seq, and seq is the order.
 */
export const makeRunManager = (wiring: (ui: WebUi) => Wiring, cwd: string, mounts: MountTable, incarnation: string): Effect.Effect<RunManager, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const state = yield* Ref.make<State>({ nextId: 1, current: null, last: null });
    const listeners = yield* Ref.make<ReadonlySet<Listener<Broadcast>>>(new Set());
    const publish = yield* makePublisher(state, listeners);

    /** Appends an event to the current run with the given id and broadcasts it; nothing when that run is not current. */
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    const append = (id: number, event: RunEvent): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          publish((s): readonly [Broadcast | null, State] => {
            if (s.current === null || s.current.id !== id) return [null, s];
            return [{ _tag: "event", run: id, seq: s.current.events.length, time, event }, { ...s, current: { ...s.current, events: [...s.current.events, { time, event }] } }];
          }),
        ),
        Effect.asVoid,
      );
    /** Appends Ended and makes the run the last one, in the same step. */
    const end = (id: number, code: number): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          publish((s): readonly [Broadcast | null, State] => {
            if (s.current === null || s.current.id !== id) return [null, s];
            const event: RunEvent = { _tag: "Ended", code };
            return [{ _tag: "event", run: id, seq: s.current.events.length, time, event }, { ...s, current: null, last: { ...s.current, events: [...s.current.events, { time, event }] } }];
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

    /** The run with that id, if it is the current one. */
    const currentRun = (id: number) => Ref.get(state).pipe(Effect.map((s) => (s.current !== null && s.current.id === id ? s.current : null)));

    const start = (project: string, task: string): Effect.Effect<number | Refusal> =>
      Effect.gen(function* () {
        // Issue #88: a run never lacks a task; a blank one is refused before the project is examined.
        const checked = taskOf(task);
        if (Result.isFailure(checked)) return { refused: "the task is empty" };
        const invalid = yield* invalidProject(project);
        if (invalid !== null) return { refused: invalid };
        const gate = yield* Deferred.make<void>();
        // The ui's sink needs the id, and the id is taken with the reservation of the run.
        const idRef = yield* Ref.make(0);
        const ui = yield* makeWebUi((event) => Ref.get(idRef).pipe(Effect.flatMap((id) => append(id, event))));
        // The ownership transfer (finding 11 of docs/gui-review.md) is one uninterruptible region: the fiber exists
        // before the run is reserved, the run is reserved with its fiber in one step, and the gate is released after
        // Started, so no interruption can leave a run reserved without a fiber or a fiber that never starts.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // The fiber outlives the request that started it; it waits for the gate. Started at once, so that its
            // onExit is in place before any stop can interrupt it; a run that was never reserved ends as a no-op
            // (idRef is 0, which is no run's id).
            const fiber = yield* Deferred.await(gate).pipe(
              Effect.andThen(Effect.scoped(programOfTask({ task: checked.success, project }, wiring(ui)))),
              Effect.onExit((exit: Exit.Exit<number>) => Ref.get(idRef).pipe(Effect.flatMap((id) => end(id, exitCodeOf(exit))))),
              Effect.forkDetach({ startImmediately: true }),
            );
            const reserved = yield* Ref.modify(state, (s): readonly [number | null, State] =>
              s.current !== null ? [null, s] : [s.nextId, { ...s, nextId: s.nextId + 1, current: { id: s.nextId, events: [], ui, fiber, shared: emptyUiState } }],
            );
            if (reserved === null) {
              yield* Fiber.interrupt(fiber);
              return { refused: "a run is in progress; stop it or wait for its end" };
            }
            yield* Ref.set(idRef, reserved);
            yield* append(reserved, { _tag: "Started", project, location: identify(mounts, project), task });
            yield* Deferred.succeed(gate, undefined);
            return reserved;
          }),
        );
      });

    return {
      cwd,
      location: identify(mounts, cwd),
      incarnation,
      subscribe: (listener) =>
        Effect.acquireRelease(
          Ref.update(listeners, (set): ReadonlySet<Listener<Broadcast>> => new Set([...set, listener])),
          () => Ref.update(listeners, (set) => new Set([...set].filter((l) => l !== listener))),
        ).pipe(Effect.asVoid),
      replay: Ref.get(state).pipe(
        Effect.map((s) => {
          const runs = [s.last, s.current].flatMap((r) => (r === null ? [] : [r]));
          return { runs: runs.map(record), ui: runs.map((r) => ({ run: r.id, state: r.shared })) };
        }),
      ),
      current: Ref.get(state).pipe(Effect.map((s) => s.current?.id ?? null)),
      start,
      stop: (of, id) =>
        of !== incarnation ? Effect.succeed(EARLIER) : currentRun(id).pipe(
          Effect.flatMap((r) => {
            if (r === null) return Effect.succeed(ENDED);
            return Fiber.interrupt(r.fiber).pipe(Effect.as(null));
          }),
        ),
      answer: (of, id, prompt, text) =>
        of !== incarnation ? Effect.succeed(EARLIER) : currentRun(id).pipe(
          Effect.flatMap((r) => {
            if (r === null) return Effect.succeed(ENDED);
            return r.ui.answer(prompt, text).pipe(Effect.map((taken): Refusal | null => (taken ? null : { refused: "that question has already been answered" })));
          }),
        ),
      // Issue #87: the change and its broadcast are one serialized, uninterruptible step of the publisher, so every tab
      // receives the states in the order of their versions, interleaved with the run's events as they were recorded.
      setUi: (of, id, flag) =>
        of !== incarnation
          ? Effect.succeed(EARLIER)
          : publish((s): readonly [Broadcast | null, State] => {
              const change = (r: Run | null): Run | null => (r !== null && r.id === id ? { ...r, shared: withFlag(r.shared, flag) } : r);
              const [current, last] = [change(s.current), change(s.last)];
              const changed = current !== s.current ? current : last !== s.last ? last : null;
              return changed === null ? [null, s] : [{ _tag: "ui", run: id, state: changed.shared }, { ...s, current, last }];
            }).pipe(Effect.map((b) => (b === null ? ENDED : null))),
    };
  });
