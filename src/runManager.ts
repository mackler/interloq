// The run manager of the web GUI (plan step 3.3): one implementation run at a time and any number of refinement runs,
// each of a different item (issue #191; one run per mode since issue #120), each started from an item of the project's
// tracker, answered and stopped from the page on its own; the events of the runs in progress and of the ended ones kept
// for the replay, broadcast to every connected tab. Several refinement runs are safe beside each other and beside the
// implementation run: a refinement run builds no temporary git index (no baseline tree, no work-review diff) and compares
// no project snapshot (behavior 3), and each run has its own records directory, allocated exclusively.

import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Ref, Result, type Scope, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Platform } from "./platform.ts";
import { type Conclusion, exitCodeOf, type FaultSignal, makeFaultSignal, program, type RunStart, taskTextOf, type Wiring } from "./program.ts";
import { loadConfig } from "./config.ts";
import type { Config } from "./schema.ts";
import { describe, ServerFault, trackerFailureText } from "./errors.ts";
import { listedState, RUN_MODES, type RunMode } from "./runMode.ts";
import { ALREADY_ANSWERED_TEXT, answerExpiredText, limitAnswerExpiredText, chainEndedText, chainParkingText, chainSaveRefusedText, ITEM_ID_EMPTY, itemMovedText, itemNotReturnedLine, itemReturnedLine, TRANSPORT_ANSWERS, serverEndingText } from "./prompts.ts";
import { type StoreShape, Tracker, type TrackerError, type TrackerShape, type UiShape } from "./services.ts";
import { type TrackerRetryEnv, writeWithRetry } from "./trackerRetry.ts";
import { parkBranchOf } from "./park.ts";
import { type ItemId, itemIdOf } from "./tracker.ts";
import { identify, type MountTable } from "./hostDir.ts";
import type { CurrentRuns, ItemsAnswer, ItemsResult, RunEvent, StartRequest, RunRecord, RunUi, Stamped } from "./protocol.ts";
import { listedItemOf } from "./protocol.ts";
import { sentBackCount } from "./itemComments.ts";
import {
  type AbandonLabel, begun, blocksImplementationStart, claimParking, itemReturned, type ItemReturnOutcome, type ChainCommand, commandApplies, parkingAbandoned, type ChainSettings, type ChainState, configured, due, ended as chainEnded, listed as listedNext, parked, type ParkNote, refused as chainRefused, restored, saveFailed, started as chainStarted, startGuard,
} from "./chain.ts";
import { loadChain, removeChain, saveChain } from "./chainFile.ts";
import { makeStore } from "./store.ts";
import { EMPTY_SLOT, endedIn, refusalOf, reserved, runsOf, type Slot as RunSlot } from "./runSlots.ts";
import { parkHalted } from "./parking.ts";
import type { RunRoot } from "./artifacts.ts";
import { emptyUiState, type RunUiState, type UiFlag, withFlag } from "./uiState.ts";
import { type AnswerTiming, makeWebUi, type WebUi } from "./webUi.ts";

/** One event of a run as it is broadcast: the run's id, the event's sequence number in that run (from 0) and the time of its publication. */
export type EventBroadcast = Readonly<{ _tag: "event"; run: number; seq: number; time: string; event: RunEvent }>;
/** The shared state of the page for a run after a change (issue #87): the whole state, with its version. */
export type UiBroadcast = Readonly<{ _tag: "ui"; run: number; state: RunUiState }>;
/** The chain's whole state after a change (issue #147). */
export type ChainBroadcast = Readonly<{ _tag: "chain"; state: ChainState }>;
/** What a listener receives, in the order of publication. */
export type Broadcast = EventBroadcast | UiBroadcast | ChainBroadcast;
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
  /** The runs in progress: every refinement run's id, and the implementation run's or null (issue #191). */
  current: Effect.Effect<CurrentRuns>;
  /** Starts a run of the mode in the project from the item with that id (issue #120); its id, or why not. */
  start: (request: StartRequest) => Effect.Effect<number | Refusal>;
  /** The items a mode's tab lists, or the notice of why the tracker cannot list them (issue #120). */
  listItems: (mode: RunMode) => Effect.Effect<ItemsAnswer>;
  /** Interrupts the run with that id of that incarnation, like Ctrl+C (behaviour 11). */
  stop: (incarnation: string, run: number) => Effect.Effect<Refusal | null>;
  /** The answer to a pending prompt of the run with that id of that incarnation. */
  answer: (incarnation: string, run: number, prompt: number, text: string) => Effect.Effect<Refusal | null>;
  /**
   * Issue #185: the developer is working on a prompt of the run with that id of that incarnation: its countdown stops
   * for good. A prompt that no longer waits is not refused (the frame may cross its answer); it does nothing.
   */
  hold: (incarnation: string, run: number, prompt: number) => Effect.Effect<Refusal | null>;
  /** Opens or closes one scope of the shared state of the run with that id of that incarnation, the current or the last one (issue #87). */
  setUi: (incarnation: string, run: number, flag: UiFlag) => Effect.Effect<Refusal | null>;
  /**
   * Issue #158 (the user's decision Q1): after an error the server cannot trace to one run, refuses every later start
   * and halts every run in progress with ServerFault, each writing its record; returns once each has ended, or, past
   * the bounds, after publishing its end itself.
   */
  haltAll: (message: string) => Effect.Effect<HaltReport>;
  /** The chain's state (issue #147). */
  chain: Effect.Effect<ChainState>;
  /** Changes the chain's settings at once; turning the mode off ends a chain and never interrupts a run (issue #147). */
  setChain: (settings: ChainSettings) => Effect.Effect<ChainState>;
}>;

/**
 * How the chain's state is kept across a restart (issue #147, requirements Q4): plan-review/chain.json by default; a test
 * injects a save it holds or fails. A failure is its text.
 */
export type ChainPersistence = Readonly<{ save: (state: ChainState) => Effect.Effect<void, string>; remove: Effect.Effect<void, string> }>;

/**
 * The runs `haltAll` halted (issue #158): `halted`, those that ended with their halt record written; `unconfirmed`, every
 * other, whose record is not confirmed: one that ended without it, and one stuck past the bounds, whose end the manager
 * published itself.
 */
export type HaltReport = Readonly<{ halted: readonly number[]; unconfirmed: readonly number[] }>;
/** How long `haltAll` waits for the faulted runs to end, then for their interruption (issue #158). */
export type HaltBounds = Readonly<{ graceMs: number; interruptMs: number }>;
export const SERVER_FAULT_GRACE_MS = 10_000;
export const SERVER_FAULT_INTERRUPT_MS = 2_000;
const LIVE_BOUNDS: HaltBounds = { graceMs: SERVER_FAULT_GRACE_MS, interruptMs: SERVER_FAULT_INTERRUPT_MS };

/** A subscriber of the broadcast. Its contract: it does not block (it offers to its own queue); slow delivery is its own fiber's. */
export type Listener<B> = (event: B) => Effect.Effect<void>;

/**
 * Publication (finding 11 of docs/gui-review.md): `record` computes the event and the next state in one Ref.modify,
 * and the event is offered to every listener, as one step that is serialized (so every listener receives the events
 * in the order in which they were recorded) and uninterruptible (so no event is recorded without being offered).
 * Listeners do not block, so the protected region stays short. Returns the event, or null when `record` produced none.
 */
export const makePublisher = <S, B>(state: Ref.Ref<S>, listeners: Ref.Ref<ReadonlySet<Listener<B>>>): Effect.Effect<(record: (s: S) => readonly [B | null, S]) => Effect.Effect<B | null>> =>
  makeStepper(state, listeners).pipe(
    Effect.map((step) => (record: (s: S) => readonly [B | null, S]) =>
      step((s) => {
        const [b, next] = record(s);
        return [b, b === null ? [] : [b], next] as const;
      }),
    ),
  );

/**
 * The publisher's one serialized, uninterruptible step in its general form (issue #147): `record` returns a value for the
 * caller, the broadcasts to offer in order, and the next state, so that a run's end and the chain's transition it causes
 * are one step.
 */
export const makeStepper = <S, B>(state: Ref.Ref<S>, listeners: Ref.Ref<ReadonlySet<Listener<B>>>): Effect.Effect<<X>(record: (s: S) => readonly [X, readonly B[], S]) => Effect.Effect<X>> =>
  Semaphore.make(1).pipe(
    Effect.map((serial) => <X>(record: (s: S) => readonly [X, readonly B[], S]) =>
      Ref.modify(state, (s): readonly [readonly [X, readonly B[]], S] => {
        const [x, bs, next] = record(s);
        return [[x, bs], next];
      }).pipe(
        Effect.tap(([, bs]) => (bs.length === 0 ? Effect.void : Ref.get(listeners).pipe(Effect.flatMap((set) => Effect.forEach(bs, (b) => Effect.forEach([...set], (listener) => listener(b), { discard: true }), { discard: true }))))),
        Effect.map(([x]) => x),
        serial.withPermits(1),
        Effect.uninterruptible,
      ),
    ),
  );

/** A run: its events (the record), its web Ui and fiber, and beside the record the shared state of its page (issue #87). */
type Run = Readonly<{ id: number; item: ItemId; events: readonly Stamped[]; ui: WebUi; fiber: Fiber.Fiber<number>; shared: RunUiState; signal: FaultSignal }>;
/** A mode's runs in progress and its ended runs kept for the replay (issue #191, src/runSlots.ts). */
type Slot = RunSlot<Run>;
/**
 * The next id (one sequence for the server, so that an id names one run in either mode), each mode's slot, and whether
 * the server is ending after an error it could not trace to one run (issue #158), when no run is started.
 */
type State = Readonly<{ nextId: number; runs: Readonly<Record<RunMode, Slot>>; closing: boolean; chain: ChainState }>;
/** Who asked for a start: the page, or the chain of that generation (issue #147). */
type Origin = Readonly<{ _tag: "manual" }> | Readonly<{ _tag: "chain"; generation: number }>;
const MANUAL: Origin = { _tag: "manual" };
/** The chain's broadcast where a step changed it, none otherwise. */
const chainChange = (before: ChainState, after: ChainState): readonly ChainBroadcast[] => (before === after ? [] : [{ _tag: "chain", state: after }]);
/** What a save of the chain's state came to: saved; failed and the file removed; or failed and not removed either. */
type Saved = "saved" | "removed" | "lost";
const record = (r: Run): RunRecord => ({ id: r.id, events: r.events });
const EMPTY: Slot = EMPTY_SLOT;
/** The mode whose slot holds the run with that id as `which`, or null. */
const modeOf = (s: State, id: number, which: readonly ("current" | "last")[]): RunMode | null => RUN_MODES.find((m) => which.some((w) => s.runs[m][w].some((r) => r.id === id))) ?? null;
/** The run with that id held as `which` in that mode's slot, or null. */
const runIn = (s: State, mode: RunMode, id: number, which: "current" | "last"): Run | null => s.runs[mode][which].find((r) => r.id === id) ?? null;
/** The slot with the run of that id, wherever it is held, changed. */
const changedIn = (slot: Slot, id: number, change: (r: Run) => Run): Slot => {
  const each = (runs: readonly Run[]) => runs.map((r) => (r.id === id ? change(r) : r));
  return { current: each(slot.current), last: each(slot.last) };
};
const withSlot = (s: State, mode: RunMode, slot: Slot): State => ({ ...s, runs: { ...s.runs, [mode]: slot } });

/**
 * The manager over a wiring per run (the live one of src/web.ts with the run's web Ui; the run's mode, so that a test may script each mode). The state is one Ref: the
 * next id (never reused while the process lives) and, per mode, its slot (src/runSlots.ts): the implementation run in
 * progress and the last finished one (issue #120), the refinement runs in progress and the ended one of each item
 * (issue #191). An event is appended in one step with its seq and then broadcast, so a listener registered before a
 * snapshot sees every event that the snapshot does not hold (P1-R1-2). The time of an event (issue #1) is read from the
 * Clock before that step, because the record function stays pure; so events published concurrently may carry times in a
 * slightly different order than their seq, and seq is the order.
 *
 * Issue #120 (the developer's answer to question Q1 of 9 Oct 2026): the project of both tabs is `cwd`, the directory the
 * server was started in. The tracker is reached through `access`: the configuration of `cwd` and the tracker it names.
 */
export const makeRunManager = (
  wiring: (ui: WebUi, mode: RunMode) => Wiring,
  cwd: string,
  mounts: MountTable,
  incarnation: string,
  access: TrackerAccess,
  chainDefaults: ChainSettings,
  bounds: HaltBounds = LIVE_BOUNDS,
  persistence?: ChainPersistence,
  park: (store: StoreShape, item: ItemId) => Effect.Effect<ParkNote> = parkHalted,
): Effect.Effect<RunManager, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = Layer.succeedContext(yield* Effect.context<Platform>());
    const kept: ChainPersistence = persistence ?? {
      save: (chain) => saveChain(cwd, chain).pipe(Effect.provide(platform), Effect.mapError(describe)),
      remove: removeChain(cwd).pipe(Effect.provide(platform), Effect.mapError(describe)),
    };
    // Issue #147 (requirements Q4): the chain as the last server left it, through what a restart does to it.
    const loaded = yield* loadChain(cwd, chainDefaults).pipe(Effect.provide(platform));
    const [restoredChain, resume] = restored(loaded);
    const state = yield* Ref.make<State>({ nextId: 1, runs: { refinement: EMPTY, implementation: EMPTY }, closing: false, chain: restoredChain });
    const listeners = yield* Ref.make<ReadonlySet<Listener<Broadcast>>>(new Set());
    const step = yield* makeStepper(state, listeners);
    const publish = (record: (s: State) => readonly [Broadcast | null, State]): Effect.Effect<Broadcast | null> =>
      step((s) => {
        const [b, next] = record(s);
        return [b, b === null ? [] : [b], next] as const;
      });
    /** One transition of the chain as a step of the publisher, broadcast where it changed; its command. */
    const chainStep = (transition: (s: State) => readonly [ChainState, ChainCommand | null]): Effect.Effect<ChainCommand | null> =>
      step((s) => {
        const [chain, command] = transition(s);
        return [command, chainChange(s.chain, chain), { ...s, chain }] as const;
      });

    /** Appends an event to the run in progress with the given id and broadcasts it; nothing when no mode's current run has it. */
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    const append = (id: number, event: RunEvent): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          publish((s): readonly [Broadcast | null, State] => {
            const mode = modeOf(s, id, ["current"]);
            const run = mode === null ? null : runIn(s, mode, id, "current");
            if (mode === null || run === null) return [null, s];
            return [{ _tag: "event", run: id, seq: run.events.length, time, event }, withSlot(s, mode, changedIn(s.runs[mode], id, (r) => ({ ...r, events: [...r.events, { time, event }] })))];
          }),
        ),
        Effect.asVoid,
      );
    /**
     * Appends Ended and makes the run its mode's last one, in the same step; issue #147: in that step too the chain learns
     * of its run's end, unless the server is ending after a fault (issue #158), when the chain is left as it is, so that
     * the restart finds the run cut off and starts nothing.
     */
    /** Issue #186: `parked`, the run's own parking (its Conclusion), which the chain takes as given. */
    /** Issue #185: `abandoned`, the label of a run abandoned for want of an answer (its Conclusion). */
    const end = (id: number, code: number, root: RunRoot | null = null, parked: ParkNote | null = null, abandoned: AbandonLabel | null = null): Effect.Effect<void> =>
      now.pipe(
        Effect.flatMap((time) =>
          step((s): readonly [Readonly<{ changed: boolean; command: ChainCommand | null }>, readonly Broadcast[], State] => {
            const mode = modeOf(s, id, ["current"]);
            const run = mode === null ? null : runIn(s, mode, id, "current");
            if (mode === null || run === null) return [{ changed: false, command: null }, [], s];
            const event: RunEvent = { _tag: "Ended", code };
            const moved = withSlot(s, mode, endedIn(mode, s.runs[mode], id, (r) => ({ ...r, events: [...r.events, { time, event }] })));
            const [chain, command] = s.closing ? [s.chain, null] : chainEnded(s.chain, id, { code, root, parked, abandoned });
            return [{ changed: chain !== s.chain, command }, [{ _tag: "event", run: id, seq: run.events.length, time, event }, ...chainChange(s.chain, chain)], { ...moved, chain }];
          }).pipe(Effect.flatMap(({ changed, command }) => (changed ? settle(command) : Effect.void))),
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
    const withTracker = <A>(use: (tracker: TrackerShape, config: Config) => Effect.Effect<A, TrackerError>): Effect.Effect<Result.Result<A, string>> =>
      Effect.gen(function* () {
        const invalid = yield* invalidProject(cwd);
        if (invalid !== null) return Result.fail(invalid);
        const config = yield* Effect.result(loadConfig(cwd, access.sharedConfig).pipe(Effect.provide(platform)));
        if (Result.isFailure(config)) return Result.fail(describe(config.failure));
        const layer = access.tracker(config.success);
        if (Result.isFailure(layer)) return Result.fail(trackerFailureText(layer.failure));
        const used = yield* Effect.result(Effect.flatMap(Tracker, (t) => use(t, config.success)).pipe(Effect.provide(layer.success)));
        return Result.mapError(used, trackerFailureText);
      });

    /** Issue #142: the Refinement tab's listing carries the configured choice of terms, read with the configuration. */
    const listItems = (mode: RunMode): Effect.Effect<ItemsAnswer> =>
      // Issue #186 (F1): each item's comments read, the server's own requests (not repeated, as the listing is not), and
      // its send-backs counted; a failure of any of them answers the listing with its notice.
      withTracker((t, config) =>
        t.list(listedState(mode)).pipe(
          Effect.flatMap((items) => Effect.forEach(items, (item) => Effect.map(t.comments(item.id), (comments) => listedItemOf(item, sentBackCount(comments))), { concurrency: 4 })),
          Effect.map((items) => ({ items, terms: config.terms })),
        ),
      ).pipe(
        Effect.map((listed): ItemsAnswer => {
          const unavailable = (notice: string) => ({ _tag: "Unavailable", notice }) as const;
          if (mode === "refinement") return { mode, result: Result.isFailure(listed) ? unavailable(listed.failure) : { _tag: "Listed", ...listed.success } };
          return { mode, result: Result.isFailure(listed) ? unavailable(listed.failure) : ({ _tag: "Listed", items: listed.success.items } satisfies ItemsResult) };
        }),
      );

    // ---- issue #147: the chain ----
    // The git-index hazard recorded in CLAUDE.md stays out of reach: the chain is sequential, only an implementation run
    // builds the baseline and the work review's diff through a temporary index, and the parking runs after the run ended
    // while no implementation run can be reserved (blocksImplementationStart).
    // Each command is revalidated against the State after its persist (continueFrom), so a stale one is never executed.

    const writes = yield* Semaphore.make(1);
    const continuations = yield* Semaphore.make(1);
    const stderr = (text: string) => Effect.sync(() => void process.stderr.write(`${text}\n`));
    /**
     * Writes the chain as the State holds it at the moment of writing, never a snapshot taken at the change, under one
     * permit, so writes never interleave and whatever write completes last holds the newest state (P1-R3-3). A failed save
     * ends the chain (saveFailed, broadcast) and removes the file, since a missing file restores to an idle chain; where
     * the removal fails too, both failures go to stderr (P1-R1-5).
     */
    const persist: Effect.Effect<Saved> = writes.withPermits(1)(
      Effect.gen(function* () {
        const saved = yield* Effect.result(Effect.flatMap(Ref.get(state), (s) => kept.save(s.chain)));
        if (Result.isSuccess(saved)) return "saved" as const;
        yield* chainStep((s) => [saveFailed(s.chain, saved.failure), null]);
        const removed = yield* Effect.result(kept.remove);
        if (Result.isSuccess(removed)) return "removed" as const;
        yield* stderr(`Interloq: the chain's state could not be saved (${saved.failure}) nor its file removed (${removed.failure}).`);
        return "lost" as const;
      }),
    );

    /**
     * Issue #192 (S11): a chained halt whose claimed parking kept nothing gives its item back to refined, before the chain
     * leaves Parking, so no implementation run can label the item meanwhile. Work counts as kept, and the item stays
     * implementing, where there is no baseline, HEAD is not the start commit, the parking branch exists or parked.json says
     * Parked. Only an item still implementing is written, through the tracker retry; the outcome goes on the chain's entry
     * of the run and to its conversation.md. Never fails and never changes how the chain ends.
     */
    const returnUnparked = (generation: number, root: RunRoot, item: ItemId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = (store: StoreShape, outcome: ItemReturnOutcome) =>
          chainStep((s) => [itemReturned(s.chain, generation, item, outcome), null]).pipe(
            Effect.andThen(store.converse(`${outcome._tag === "Returned" ? itemReturnedLine(item) : itemNotReturnedLine(item, outcome.cause, null)}\n\n`).pipe(Effect.ignore)),
          );
        const config = yield* Effect.result(loadConfig(cwd, access.sharedConfig).pipe(Effect.provide(platform)));
        // W1-R1-2: without the configuration the run's store is not the one the run used, so it only writes the line.
        if (Result.isFailure(config)) {
          const bare = yield* makeStore(cwd, root, []).pipe(Effect.provide(platform));
          return yield* record(bare, { _tag: "NotReturned", cause: describe(config.failure) });
        }
        const store = yield* makeStore(cwd, root, config.success.ignorePaths).pipe(Effect.provide(platform));
        const kept = yield* Effect.result(
          Effect.gen(function* () {
            const baseline = yield* store.baseline();
            if (baseline === null || (yield* store.head()) !== baseline.start_commit) return true;
            const branch = parkBranchOf(item, root);
            if (Result.isSuccess(branch) && (yield* store.branchTip(branch.success)) !== null) return true;
            return (yield* store.loadParked())?._tag === "Parked";
          }),
        );
        if (Result.isFailure(kept)) return yield* record(store, { _tag: "NotReturned", cause: describe(kept.failure) });
        if (kept.success) return;
        const silent: UiShape = { say: () => Effect.void, notify: () => Effect.void, ask: () => Effect.succeed(""), askMessage: () => Effect.succeed(""), nextQuestion: Effect.succeed(0) };
        const env: TrackerRetryEnv = { ui: silent, settings: config.success, record: (markdown) => store.converse(markdown).pipe(Effect.ignore), ask: () => Effect.succeed(TRANSPORT_ANSWERS.stop), exhausted: "ask" };
        const written = yield* withTracker((t) =>
          t.read(item).pipe(
            Effect.flatMap((read): Effect.Effect<ItemReturnOutcome | null> =>
              read.state !== "implementing"
                ? Effect.succeed(null)
                : writeWithRetry(t, { kind: "setState", item, state: listedState("implementation") }, env).pipe(
                    Effect.as<ItemReturnOutcome>({ _tag: "Returned" }),
                    Effect.catch((e) => Effect.succeed<ItemReturnOutcome>({ _tag: "NotReturned", cause: e._tag === "TrackerWriteFailed" ? trackerFailureText(e.error) : describe(e) })),
                  ),
            ),
          ),
        );
        const outcome: ItemReturnOutcome | null = Result.isFailure(written) ? { _tag: "NotReturned", cause: written.failure } : written.success;
        if (outcome !== null) yield* record(store, outcome);
      });

    /** Runs one command of the chain, for the generation it was computed for; the next command, or none. */
    const execute = ({ generation, command }: ChainCommand): Effect.Effect<ChainCommand | null> => {
      switch (command._tag) {
        case "Park":
          return Effect.gen(function* () {
            const config = yield* Effect.result(loadConfig(cwd, access.sharedConfig).pipe(Effect.provide(platform)));
            const store = Result.isFailure(config)
              ? Result.fail(describe(config.failure))
              : yield* Effect.result(makeStore(cwd, command.root, config.success.ignorePaths).pipe(Effect.provide(platform)));
            const note: ParkNote = Result.isFailure(store) ? { _tag: "ParkFailed", message: typeof store.failure === "string" ? store.failure : describe(store.failure) } : yield* park(store.success, command.item);
            if (note._tag !== "Parked") yield* returnUnparked(generation, command.root, command.item);
            return yield* chainStep((s) => parked(s.chain, generation, note));
          });
        case "Due":
          return Clock.currentTimeMillis.pipe(Effect.flatMap((nowMs) => chainStep((s) => due(s.chain, generation, nowMs))));
        case "List":
          return withTracker((t) => t.list(listedState("implementation"))).pipe(
            Effect.flatMap((listed) =>
              chainStep((s) =>
                Result.isFailure(listed)
                  ? [chainRefused(s.chain, generation, { _tag: "ListingFailed", message: listed.failure }), null]
                  : listedNext(s.chain, generation, listed.success.map((i) => ({ item: i.id, title: i.title }))),
              ),
            ),
          );
        case "Start":
          return start({ mode: "implementation", item: command.item }, { _tag: "chain", generation }).pipe(
            Effect.flatMap((result) =>
              typeof result === "number" ? Effect.succeed(null) : chainStep((s) => [chainRefused(s.chain, generation, { _tag: "StartRefused", item: command.item, reason: result.refused }), null]),
            ),
          );
      }
    };
    /**
     * Persists the chain, then runs its commands one after another; nothing once the server is ending. The State is read
     * again after the persist, which may have waited on the write permit: a server that began ending meanwhile executes
     * nothing, a parking whose save failed is abandoned, and a command the chain has since left behind is dropped
     * (commandApplies), so only a command of the chain as it now is reaches its effect (W1-R1-5).
     */
    const continueFrom = (command: ChainCommand | null): Effect.Effect<void> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(state)).closing) return;
        const saved = yield* persist;
        if (command === null) return;
        const now = yield* Ref.get(state);
        if (now.closing) return;
        if (saved !== "saved") {
          if (command.command._tag === "Park") {
            yield* returnUnparked(command.generation, command.command.root, command.command.item);
            yield* chainStep((s) => [parkingAbandoned(s.chain, command.generation), null]);
          }
          return;
        }
        if (!commandApplies(now.chain, command)) return;
        yield* continueFrom(yield* execute(command));
      });
    /** After a change of the chain: its persistence and its commands, in a detached fiber under one permit (P1-R3-1). */
    const settle = (command: ChainCommand | null): Effect.Effect<void> => Effect.asVoid(Effect.forkDetach(continuations.withPermits(1)(continueFrom(command))));

    /**
     * Issue #185 (requirements Q2): a question counts down only while its run is the chain's running implementation run,
     * read at each prompt and at its deadline, so a run started with the mode off never counts down and turning the
     * mode off lets a waiting question wait as before.
     */
    const answerTimingOf = (mode: RunMode, seconds: number, idRef: Ref.Ref<number>): AnswerTiming => ({
      limitMs: Effect.all([Ref.get(idRef), Ref.get(state)]).pipe(
        Effect.map(([rid, s]) => (mode === "implementation" && s.chain.settings.enabled && s.chain.chain._tag === "Running" && s.chain.chain.run === rid ? seconds * 1000 : null)),
      ),
    });

    /** The run with that id, if it is a mode's run in progress, with its mode. */
    const currentRun = (id: number) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const mode = modeOf(s, id, ["current"]);
          const run = mode === null ? null : runIn(s, mode, id, "current");
          return mode === null || run === null ? null : { mode, run };
        }),
      );

    const start = (request: StartRequest, origin: Origin = MANUAL): Effect.Effect<number | Refusal> =>
      Effect.gen(function* () {
        const { mode, item: itemText } = request;
        const refused = (text: string): Refusal => ({ refused: text, mode });
        // The refusals, in order (issue #120): they prevent errors and ask no confirmation (behavior 1).
        const id = itemIdOf(itemText);
        if (Result.isFailure(id)) return refused(ITEM_ID_EMPTY);
        const invalid = yield* invalidProject(cwd);
        if (invalid !== null) return refused(invalid);
        const before = yield* Ref.get(state);
        if (before.closing) return refused(serverEndingText);
        // Issue #191: before the tracker is read, so a refused start contacts no tracker; repeated in the reservation.
        const busy = refusalOf(mode, before.runs[mode], id.success);
        if (busy !== null) return refused(busy);
        // Issue #185: the configuration the read already loads gives the wait of the run's questions.
        const read = yield* withTracker((t, config) => t.read(id.success).pipe(Effect.map((item) => ({ item, seconds: config.answerTimeoutSeconds }))));
        if (Result.isFailure(read)) return refused(read.failure);
        const { item, seconds } = read.success;
        if (item.state !== listedState(mode)) return refused(itemMovedText(item.id, listedState(mode), item.state));
        const gate = yield* Deferred.make<void>();
        const signal = yield* makeFaultSignal;
        // The ui's sink needs the id, and the id is taken with the reservation of the run.
        const idRef = yield* Ref.make(0);
        // Issue #147: the run's records directory once allocated, which the chain needs at the run's end, however it ends.
        const allocated = yield* Ref.make<Option.Option<RunRoot>>(Option.none());
        // W2-R1-1 of issue #192: the code the program computed, which a Stop task during its uninterruptible ending
        // cannot overrule; a run ended before its records or by a defect leaves it empty, and exitCodeOf decides.
        const concluded = yield* Ref.make(Option.none<Conclusion>());
        const ui = yield* makeWebUi((event) => Ref.get(idRef).pipe(Effect.flatMap((rid) => append(rid, event))), answerTimingOf(mode, seconds, idRef));
        // Issue #192: a halted run asks the chain to park its leftovers in one serialized step, so the program's choice
        // to keep its item implementing rests on the chain's own decision; while closing nothing is granted.
        const claim = Ref.get(idRef).pipe(
          Effect.flatMap((rid) =>
            step((s): readonly [boolean, readonly Broadcast[], State] => {
              if (s.closing) return [false, [], s];
              const [chain, granted] = claimParking(s.chain, rid);
              return [granted, chainChange(s.chain, chain), { ...s, chain }];
            }),
          ),
        );
        // Issue #142: the run takes the choice the page sent, which is what its control showed.
        const runStart: RunStart = request.mode === "refinement" ? { mode: request.mode, item: item.id, project: cwd, terms: request.terms } : { mode: request.mode, item: item.id, project: cwd };
        // The ownership transfer (finding 11 of docs/gui-review.md) is one uninterruptible region: the fiber exists
        // before the run is reserved, the run is reserved with its fiber in one step, and the gate is released after
        // Started, so no interruption can leave a run reserved without a fiber or a fiber that never starts.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // The fiber outlives the request that started it; it waits for the gate. Started at once, so that its
            // onExit is in place before any stop can interrupt it; a run that was never reserved ends as a no-op
            // (idRef is 0, which is no run's id).
            const fiber = yield* Deferred.await(gate).pipe(
              Effect.andThen(Effect.scoped(program(runStart, wiring(ui, mode), signal, allocated, claim, concluded))),
              // A run halted by the server's fault ends with 1 (issue #158), even when haltAll had to interrupt it.
              Effect.onExit((exit: Exit.Exit<number>) =>
                Effect.all([Ref.get(idRef), Deferred.isDone(signal.fault), Ref.get(allocated), Ref.get(concluded)]).pipe(
                  Effect.flatMap(([rid, faulted, root, conclusion]) =>
                    end(rid, faulted ? 1 : Option.getOrElse(Option.map(conclusion, (c) => c.code), () => exitCodeOf(exit)), Option.getOrNull(root), Option.getOrNull(Option.map(conclusion, (c) => c.parked))),
                  ),
                ),
              ),
              Effect.forkDetach({ startImmediately: true }),
            );
            // The reservation is the one atomic check of closing (issue #158): a start that waited on the tracker while
            // haltAll ran is refused here. Issue #147: in the same step, an implementation start is refused while a halted
            // run's work is being parked, the chain's own start is checked against its limits at this moment (startGuard,
            // the Clock read just before), and the chain learns of the start, so it is Running with the run's id before
            // the gate exists to release (P1-R3-2).
            const nowMs = yield* Clock.currentTimeMillis;
            const reservation = yield* step((s): readonly [number | string, readonly Broadcast[], State] => {
              if (s.closing) return [serverEndingText, [], s];
              // Issue #191: the same check as before the read, in the one atomic step, so two starts of one item cannot both succeed.
              const busy = refusalOf(mode, s.runs[mode], item.id);
              if (busy !== null) return [busy, [], s];
              if (mode === "implementation" && blocksImplementationStart(s.chain)) return [chainParkingText(s.chain.chain._tag === "Parking" ? s.chain.chain.item : item.id), [], s];
              const guard = origin._tag === "chain" ? startGuard(s.chain, origin.generation, item.id, nowMs) : null;
              if (guard !== null) {
                const chain = chainRefused(s.chain, origin._tag === "chain" ? origin.generation : 0, guard);
                return [chainEndedText(guard, (iso) => iso), chainChange(s.chain, chain), { ...s, chain }];
              }
              const id = s.nextId;
              const chain = mode !== "implementation" ? s.chain : origin._tag === "chain" ? chainStarted(s.chain, origin.generation, id, item.id, item.title) : begun(s.chain, id, item.id, item.title);
              const next = withSlot({ ...s, nextId: id + 1, chain }, mode, reserved(mode, s.runs[mode], { id, item: item.id, events: [], ui, fiber, shared: emptyUiState, signal }));
              return [id, chainChange(s.chain, chain), next];
            });
            if (typeof reservation !== "number") {
              yield* Fiber.interrupt(fiber);
              return refused(reservation);
            }
            const runId = reservation;
            // The chain's Running is saved before the run's gate is released (P1-R1-5), so a server that ends during the
            // run finds it cut off after the restart and starts nothing. Where neither the save nor the removal of the old
            // file succeeded, the run is not started: its slot is freed in one step and its fiber, whose id is still 0, interrupted.
            const chainOf = (yield* Ref.get(state)).chain.chain;
            if (mode === "implementation" && chainOf._tag === "Running" && chainOf.run === runId) {
              const saved = yield* persist;
              if (saved === "lost") {
                yield* step((s) => [null, [], withSlot(s, mode, { ...s.runs[mode], current: s.runs[mode].current.filter((r) => r.id !== runId) })] as const);
                yield* Fiber.interrupt(fiber);
                return refused(chainSaveRefusedText("the file system refused both"));
              }
            }
            yield* Ref.set(idRef, runId);
            yield* append(runId, { _tag: "Started", project: cwd, location: identify(mounts, cwd), task: Result.getOrElse(taskTextOf(mode, item, []), () => item.title), mode, item: { id: item.id, title: item.title } });
            yield* Deferred.succeed(gate, undefined);
            return runId;
          }),
        );
      });

    /**
     * Issue #158 (the user's decision Q1). The closing and the snapshot of the runs are one step, so no run is reserved
     * after the snapshot. Each run's fault is failed and its fiber awaited for `graceMs`; a fiber still running is then
     * interrupted by a detached fiber that is never awaited, because an interruption waits for the run's uninterruptible
     * regions and finalizers, which after an uncaught exception need not end. A run still in its slot after
     * `interruptMs` more is published as ended with 1 by the manager. A run is reported halted only when its fiber ended
     * and its record was written (its signal's `recorded`); every other is unconfirmed, a stuck one and one that ended
     * without its record alike (P2-R1-1).
     */
    const haltAll = (message: string): Effect.Effect<HaltReport> =>
      Effect.gen(function* () {
        const runs = yield* Ref.modify(state, (s): readonly [readonly Run[], State] => [RUN_MODES.flatMap((m) => s.runs[m].current), { ...s, closing: true }]);
        yield* Effect.forEach(runs, (r) => Deferred.fail(r.signal.fault, new ServerFault({ message })), { discard: true });
        const within = (ms: number) => (r: Run) => Fiber.await(r.fiber).pipe(Effect.timeoutOption(`${ms} millis`), Effect.map(Option.isSome));
        const graced = yield* Effect.forEach(runs, within(bounds.graceMs), { concurrency: "unbounded" });
        const late = runs.filter((_, i) => !graced[i]);
        yield* Effect.forEach(late, (r) => Effect.forkDetach(Fiber.interrupt(r.fiber)), { discard: true });
        const interrupted = yield* Effect.forEach(late, within(bounds.interruptMs), { concurrency: "unbounded" });
        const stuck = late.filter((_, i) => !interrupted[i]);
        // Every tab sees a stuck run ended; its own onExit, if it ever comes, then finds no run to end.
        yield* Effect.forEach(stuck, (r) => end(r.id, 1), { discard: true });
        // A run is halted only when it ended and its record was written (P2-R1-1); read once its fiber ended.
        const recorded = yield* Effect.forEach(runs, (r) => (stuck.includes(r) ? Effect.succeed(false) : Deferred.isDone(r.signal.recorded)));
        return { halted: runs.filter((_, i) => recorded[i]).map((r) => r.id), unconfirmed: runs.filter((_, i) => !recorded[i]).map((r) => r.id) };
      });

    // Issue #147 (Q4): a restored Parking chain is parked again, a restored Ready one started at once if no limit is reached.
    if (resume !== null || restoredChain !== loaded) yield* settle(resume);

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
          const runs = RUN_MODES.flatMap((m) => runsOf(s.runs[m])).sort((a, b) => a.id - b.id);
          return { runs: runs.map(record), ui: runs.map((r) => ({ run: r.id, state: r.shared })) };
        }),
      ),
      current: Ref.get(state).pipe(Effect.map((s): CurrentRuns => ({ refinement: s.runs.refinement.current.map((r) => r.id), implementation: s.runs.implementation.current[0]?.id ?? null }))),
      start: (request) => start(request),
      listItems,
      haltAll,
      chain: Ref.get(state).pipe(Effect.map((s) => s.chain)),
      // The change and its save are one uninterruptible region (work review 1 of 28 Oct 2026, W1-R1-2), as start's
      // reservation, persist of Running and gate release are: the server forks setChain in the tab's scope, and a tab
      // closed meanwhile must not leave settings applied and broadcast but missing from plan-review/chain.json. persist
      // never fails, so the region always ends, and an interruption waits for at most one save of a small file.
      setChain: (settings) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* chainStep((s) => [configured(s.chain, settings, s.runs.implementation.current[0]?.item ?? null), null]);
            yield* persist;
            return (yield* Ref.get(state)).chain;
          }),
        ),
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
            return found.run.ui.answer(prompt, text).pipe(
              Effect.map((taken): Refusal | null =>
                taken === "taken" ? null : { refused: taken === "notWaiting" ? ALREADY_ANSWERED_TEXT : taken.then === "abandon" ? answerExpiredText : limitAnswerExpiredText, mode: found.mode },
              ),
            );
          }),
        ),
      hold: (of, id, prompt) =>
        currentRun(id).pipe(
          Effect.flatMap((found) => {
            if (of !== incarnation) return Effect.succeed(earlier(found?.mode ?? null));
            if (found === null) return Effect.succeed(ended);
            return found.run.ui.hold(prompt).pipe(Effect.as(null));
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
              const slot = changedIn(s.runs[mode], id, (r) => ({ ...r, shared: withFlag(r.shared, flag) }));
              const changed = slot.current.find((r) => r.id === id) ?? slot.last.find((r) => r.id === id);
              return changed === undefined ? [null, s] : [{ _tag: "ui", run: id, state: changed.shared }, withSlot(s, mode, slot)];
            }).pipe(Effect.map((b) => (b === null ? ended : null))),
    };
  });
