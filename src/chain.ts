// The chain (issue #147): the mode of the Implementation tab that starts the next refined item when an implementation
// run ends, so the machine is not idle while the developer is away. Pure: the whole state of the mode and every decision
// of it, as data and transitions, so that src/runManager.ts only executes the commands they return. No I/O, no Effect
// services; also imported by the browser (through src/protocol.ts and web/src/cutoff.ts).
import { type Brand, Effect, Result, Schema } from "effect";
import type { ItemId } from "./tracker.ts";
import type { RunRoot } from "./artifacts.ts";
import { PositiveInt } from "./schema.ts";

/** The number of runs a chain may hold, the developer's own first run included (requirements G-R1-2): a positive integer. */
export type RunLimit = Brand.Branded<number, "RunLimit">;
export type InvalidLimit = Readonly<{ _tag: "InvalidLimit"; value: number }>;
export const runLimitOf = (n: number): Result.Result<RunLimit, InvalidLimit> =>
  Number.isSafeInteger(n) && n >= 1 ? Result.succeed(n as RunLimit) : Result.fail({ _tag: "InvalidLimit", value: n });

/**
 * The moment after which no run of the chain starts (requirements G-R1-1), in epoch milliseconds. The page resolves the
 * developer's hour to it; the server keeps the instant, never the hour, so a restart cannot move it.
 */
export type Cutoff = Brand.Branded<number, "Cutoff">;
export type InvalidCutoff = Readonly<{ _tag: "InvalidCutoff"; text: string }>;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** An ISO-8601 instant with its zone (as `Date.toISOString` writes it) to its milliseconds. */
export const cutoffOf = (iso: string): Result.Result<Cutoff, InvalidCutoff> => {
  const ms = ISO_INSTANT.test(iso) ? Date.parse(iso) : Number.NaN;
  return Number.isSafeInteger(ms) ? Result.succeed(ms as Cutoff) : Result.fail({ _tag: "InvalidCutoff", text: iso });
};

const ItemIdSchema = Schema.String.pipe(Schema.brand("ItemId"));
const RunRootSchema = Schema.String.pipe(Schema.brand("RunRoot"));
const RunLimitSchema = PositiveInt.pipe(Schema.brand("RunLimit"));
const CutoffSchema = Schema.Int.pipe(Schema.brand("Cutoff"));
const Count = Schema.Int;

/** The mode's settings: on or off, and the two optional limits. No spending limit and no cost (requirements Q2). */
export type ChainSettings = Readonly<{ enabled: boolean; limits: Readonly<{ runs: RunLimit | null; cutoff: Cutoff | null }> }>;
const ChainSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  limits: Schema.Struct({ runs: Schema.NullOr(RunLimitSchema), cutoff: Schema.NullOr(CutoffSchema) }),
});
/** On by default (requirements Q5), both limits empty (Q8). */
export const DEFAULT_SETTINGS: ChainSettings = { enabled: true, limits: { runs: null, cutoff: null } };
/** The settings with the mode off, for the managers of tests and scenarios that run single runs. */
export const OFF_SETTINGS: ChainSettings = { enabled: false, limits: { runs: null, cutoff: null } };

/** What became of a halted run's work (requirements Q1): being parked, on its branch, nothing to keep, or not kept. */
export type ParkNote =
  | Readonly<{ _tag: "Pending" }>
  | Readonly<{ _tag: "Parked"; branch: string; commit: string }>
  | Readonly<{ _tag: "NothingParked" }>
  | Readonly<{ _tag: "ParkFailed"; message: string }>;
export const ParkNoteSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Pending") }),
  Schema.Struct({ _tag: Schema.Literal("Parked"), branch: Schema.String, commit: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("NothingParked") }),
  Schema.Struct({ _tag: Schema.Literal("ParkFailed"), message: Schema.String }),
]);

/** How a run of the chain ended (behavior 11): finished (0), stopped by the developer (130), or halted (1). */
/**
 * Issue #186: a run that sent its item back to refinement (0, its own parking), and a stopped run's own parking, if it
 * parked before the stop (null otherwise, and in a chain.json written before the field).
 */
export type ChainRunOutcome =
  | Readonly<{ _tag: "Finished" }>
  | Readonly<{ _tag: "SentBack"; park: ParkNote }>
  | Readonly<{ _tag: "Stopped"; park: ParkNote | null }>
  | Readonly<{ _tag: "Halted"; park: ParkNote }>;
const ChainRunOutcomeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Finished") }),
  Schema.Struct({ _tag: Schema.Literal("SentBack"), park: ParkNoteSchema }),
  Schema.Struct({ _tag: Schema.Literal("Stopped"), park: Schema.NullOr(ParkNoteSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))) }),
  Schema.Struct({ _tag: Schema.Literal("Halted"), park: ParkNoteSchema }),
]);

/**
 * Issue #192: whether a halted run's item, whose claimed parking kept nothing, was labeled refined again by the manager,
 * or why it could not be; null where the manager did not try.
 */
export type ItemReturnOutcome = Readonly<{ _tag: "Returned" }> | Readonly<{ _tag: "NotReturned"; cause: string }>;
const ItemReturnOutcomeSchema = Schema.Union([Schema.Struct({ _tag: Schema.Literal("Returned") }), Schema.Struct({ _tag: Schema.Literal("NotReturned"), cause: Schema.String })]);

/** One run of a chain, kept to show the developer when he returns, so he can find a parked branch. */
export type ChainEntry = Readonly<{ item: ItemId; title: string; root: RunRoot | null; outcome: ChainRunOutcome; returned: ItemReturnOutcome | null }>;
const ChainEntrySchema = Schema.Struct({
  item: ItemIdSchema,
  title: Schema.String,
  root: Schema.NullOr(RunRootSchema),
  outcome: ChainRunOutcomeSchema,
  // A chain.json written before issue #192 has no such field.
  returned: Schema.NullOr(ItemReturnOutcomeSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});

/** Why a chain ended, one variant per case of the requirements. */
export type ChainEndReason =
  | Readonly<{ _tag: "NoItems" }>
  | Readonly<{ _tag: "RunLimitReached"; limit: RunLimit }>
  | Readonly<{ _tag: "CutoffPassed"; cutoff: Cutoff }>
  | Readonly<{ _tag: "StoppedByDeveloper"; item: ItemId }>
  | Readonly<{ _tag: "HaltedTwice"; item: ItemId }>
  | Readonly<{ _tag: "ServerEnded"; item: ItemId }>
  | Readonly<{ _tag: "TurnedOff"; running: ItemId | null }>
  | Readonly<{ _tag: "StartRefused"; item: ItemId; reason: string }>
  | Readonly<{ _tag: "ParkFailed"; item: ItemId; message: string }>
  | Readonly<{ _tag: "SaveFailed"; message: string }>
  | Readonly<{ _tag: "Unreadable"; message: string }>
  | Readonly<{ _tag: "ChainChanged"; item: ItemId }>
  | Readonly<{ _tag: "ListingFailed"; message: string }>;
const ChainEndReasonSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NoItems") }),
  Schema.Struct({ _tag: Schema.Literal("RunLimitReached"), limit: RunLimitSchema }),
  Schema.Struct({ _tag: Schema.Literal("CutoffPassed"), cutoff: CutoffSchema }),
  Schema.Struct({ _tag: Schema.Literal("StoppedByDeveloper"), item: ItemIdSchema }),
  Schema.Struct({ _tag: Schema.Literal("HaltedTwice"), item: ItemIdSchema }),
  Schema.Struct({ _tag: Schema.Literal("ServerEnded"), item: ItemIdSchema }),
  Schema.Struct({ _tag: Schema.Literal("TurnedOff"), running: Schema.NullOr(ItemIdSchema) }),
  Schema.Struct({ _tag: Schema.Literal("StartRefused"), item: ItemIdSchema, reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ParkFailed"), item: ItemIdSchema, message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("SaveFailed"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Unreadable"), message: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("ChainChanged"), item: ItemIdSchema }),
  Schema.Struct({ _tag: Schema.Literal("ListingFailed"), message: Schema.String }),
]);

/** The halts of one item within one chain (the requirements' default: reset when a new chain begins). */
export type HaltCount = Readonly<{ item: ItemId; times: number }>;
/**
 * What every going chain has: its generation (a continuation computed for an earlier chain does nothing), the count of
 * its runs (the developer's own first run included, G-R1-2), the halts per item and its runs so far.
 */
type Common = Readonly<{ generation: number; count: number; halts: readonly HaltCount[]; history: readonly ChainEntry[] }>;
const commonFields = {
  generation: Count,
  count: Count,
  halts: Schema.Array(Schema.Struct({ item: ItemIdSchema, times: Count })),
  history: Schema.Array(ChainEntrySchema),
};

/**
 * Whether the chain has committed to parking the halt of its running run (issue #192): `Claimed` once the run asked,
 * after which turning the mode off no longer cancels the parking (`then` the end decided meanwhile).
 */
export type ParkClaim = Readonly<{ _tag: "Unclaimed" }> | Readonly<{ _tag: "Claimed"; then: ChainEndReason | null }>;
const UNCLAIMED: ParkClaim = { _tag: "Unclaimed" };
const ParkClaimSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Unclaimed") }),
  Schema.Struct({ _tag: Schema.Literal("Claimed"), then: Schema.NullOr(ChainEndReasonSchema) }),
]);

/**
 * The chain: none going (`Idle`, with the last chain's runs and why it ended, for display), a run of it in progress
 * (`Running`, `run` the run manager's id of it), a halted run's work being parked (`Parking`, `then` the end decided
 * meanwhile), its next start due (`Ready`), or a start asked of the manager (`Starting`).
 */
export type Chain =
  | Readonly<{ _tag: "Idle"; ended: ChainEndReason | null; history: readonly ChainEntry[] }>
  | (Readonly<{ _tag: "Running"; run: number; item: ItemId; title: string; claim: ParkClaim }> & Common)
  | (Readonly<{ _tag: "Parking"; item: ItemId; root: RunRoot; then: ChainEndReason | null }> & Common)
  | (Readonly<{ _tag: "Ready" }> & Common)
  | (Readonly<{ _tag: "Starting"; item: ItemId; title: string }> & Common);
const ChainSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Idle"), ended: Schema.NullOr(ChainEndReasonSchema), history: Schema.Array(ChainEntrySchema) }),
  Schema.Struct({
    _tag: Schema.Literal("Running"),
    run: Count,
    item: ItemIdSchema,
    title: Schema.String,
    // A chain.json written before issue #192 has no claim.
    claim: ParkClaimSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(UNCLAIMED))),
    ...commonFields,
  }),
  Schema.Struct({ _tag: Schema.Literal("Parking"), item: ItemIdSchema, root: RunRootSchema, then: Schema.NullOr(ChainEndReasonSchema), ...commonFields }),
  Schema.Struct({ _tag: Schema.Literal("Ready"), ...commonFields }),
  Schema.Struct({ _tag: Schema.Literal("Starting"), item: ItemIdSchema, title: Schema.String, ...commonFields }),
]);

/** The whole state of the mode: its settings, the chain, and the last generation given to a chain. */
export type ChainState = Readonly<{ settings: ChainSettings; chain: Chain; generation: number }>;
export const ChainStateSchema = Schema.Struct({ settings: ChainSettingsSchema, chain: ChainSchema, generation: Count });
/** `plan-review/chain.json`, as it is written (S9). */
export const ChainFileSchema = Schema.Struct({ version: Schema.Literal(2), state: ChainStateSchema });
export type ChainFile = typeof ChainFileSchema.Type;

/** What the manager does next for a chain, computed for its generation. */
export type Command =
  | Readonly<{ _tag: "Park"; item: ItemId; root: RunRoot }>
  | Readonly<{ _tag: "Due" }>
  | Readonly<{ _tag: "List" }>
  | Readonly<{ _tag: "Start"; item: ItemId }>;
export type ChainCommand = Readonly<{ generation: number; command: Command }>;
export type Step = readonly [ChainState, ChainCommand | null];

/** What the manager knows of a run's end: its code (behavior 11) and its records directory where one was allocated. */
/** Issue #186: `parked`, the parking the run did itself (a send-back's or a guard stop's), which the chain takes as given. */
export type RunEnd = Readonly<{ code: number; root: RunRoot | null; parked: ParkNote | null }>;

/** The first refined item of the listing, in the tracker's order. */
export type Listed = Readonly<{ item: ItemId; title: string }>;

export const initialState = (settings: ChainSettings): ChainState => ({ settings, chain: { _tag: "Idle", ended: null, history: [] }, generation: 0 });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T | undefined => undefined;
void same<Same<typeof ChainStateSchema.Type, ChainState>>();
void same<Same<typeof ChainSettingsSchema.Type, ChainSettings>>();
void same<Same<typeof ChainEndReasonSchema.Type, ChainEndReason>>();

// ---- transitions ----

const going = (chain: Chain): chain is Exclude<Chain, { _tag: "Idle" }> => chain._tag !== "Idle";
const ofGeneration = (state: ChainState, generation: number): boolean => going(state.chain) && state.chain.generation === generation;
const commonOf = (chain: Exclude<Chain, { _tag: "Idle" }>): Common => ({ generation: chain.generation, count: chain.count, halts: chain.halts, history: chain.history });
const idle = (state: ChainState, ended: ChainEndReason | null): ChainState => ({ ...state, chain: { _tag: "Idle", ended, history: state.chain.history } });
const ready = (state: ChainState, common: Common): Step => [{ ...state, chain: { _tag: "Ready", ...common } }, { generation: common.generation, command: { _tag: "Due" } }];
const limitReason = (state: ChainState, count: number, nowMs: number): ChainEndReason | null => {
  const { runs, cutoff } = state.settings.limits;
  return runs !== null && count >= runs ? { _tag: "RunLimitReached", limit: runs } : cutoff !== null && nowMs >= cutoff ? { _tag: "CutoffPassed", cutoff } : null;
};

/** A start the developer made from an item's button, reserved with id `run`: with the mode on it begins a new chain. */
export const begun = (state: ChainState, run: number, item: ItemId, title: string): ChainState => {
  if (!state.settings.enabled) return state;
  const generation = state.generation + 1;
  return { ...state, generation, chain: { _tag: "Running", run, item, title, claim: UNCLAIMED, generation, count: 1, halts: [], history: [] } };
};

/** The end of the run of id `run`; only the chain's own run counts, and a question inside a run never reaches here. */
export const ended = (state: ChainState, run: number, end: RunEnd): Step => {
  const chain = state.chain;
  if (chain._tag !== "Running" || chain.run !== run) return [state, null];
  // Issue #186: a run that parked its own work (a send-back, a guard stop) is taken as parked: no Park command follows.
  const own = end.parked;
  const outcome: ChainRunOutcome =
    end.code === 0
      ? own === null
        ? { _tag: "Finished" }
        : { _tag: "SentBack", park: own }
      : end.code === 130
        ? { _tag: "Stopped", park: own }
        : { _tag: "Halted", park: own ?? (end.root === null ? { _tag: "NothingParked" } : { _tag: "Pending" }) };
  const history = [...chain.history, { item: chain.item, title: chain.title, root: end.root, outcome, returned: null }];
  const common: Common = { ...commonOf(chain), history };
  // Issue #192: the end decided while a claimed parking kept the chain going (the mode turned off meanwhile).
  const pending = chain.claim._tag === "Claimed" ? chain.claim.then : null;
  // A send-back continues as a finished run and counts no halt, so an item sent back however many times (Q5) never ends the chain.
  if (outcome._tag === "Finished" || outcome._tag === "SentBack") return pending !== null ? [{ ...state, chain: { _tag: "Idle", ended: pending, history } }, null] : ready(state, common);
  if (outcome._tag === "Stopped") return [{ ...state, chain: { _tag: "Idle", ended: { _tag: "StoppedByDeveloper", item: chain.item }, history } }, null];
  // Issue #186 (requirements Q6): the run's own parking failed, its work where it was: the chain ends.
  if (own?._tag === "ParkFailed") return [{ ...state, chain: { _tag: "Idle", ended: { _tag: "ParkFailed", item: chain.item, message: own.message }, history } }, null];
  const times = (chain.halts.find((h) => h.item === chain.item)?.times ?? 0) + 1;
  const halts = [...chain.halts.filter((h) => h.item !== chain.item), { item: chain.item, times }];
  const endsAfter: ChainEndReason | null = times >= 2 ? { _tag: "HaltedTwice", item: chain.item } : pending;
  if (end.root !== null && own === null)
    return [
      { ...state, chain: { _tag: "Parking", item: chain.item, root: end.root, then: endsAfter, ...common, halts } },
      { generation: chain.generation, command: { _tag: "Park", item: chain.item, root: end.root } },
    ];
  return endsAfter !== null ? [{ ...state, chain: { _tag: "Idle", ended: endsAfter, history } }, null] : ready(state, { ...common, halts });
};

/** The parking of a halted run's work ended with `note`. */
export const parked = (state: ChainState, generation: number, note: ParkNote): Step => {
  const chain = state.chain;
  if (chain._tag !== "Parking" || chain.generation !== generation) return [state, null];
  const index = chain.history.reduce((found, e, i) => (e.item === chain.item && e.outcome._tag === "Halted" ? i : found), -1);
  const history = chain.history.map((e, i) => (i === index ? { ...e, outcome: { _tag: "Halted" as const, park: note } } : e));
  const common: Common = { ...commonOf(chain), history };
  if (note._tag === "ParkFailed") return [{ ...state, chain: { _tag: "Idle", ended: { _tag: "ParkFailed", item: chain.item, message: note.message }, history } }, null];
  if (chain.then !== null) return [{ ...state, chain: { _tag: "Idle", ended: chain.then, history } }, null];
  return ready(state, common);
};

/** Issue #192: the manager's return of a halted item whose parking kept nothing, on its newest halted entry of the generation. */
export const itemReturned = (state: ChainState, generation: number, item: ItemId, outcome: ItemReturnOutcome): ChainState => {
  const chain = state.chain;
  if (!ofGeneration(state, generation) || chain._tag === "Idle") return state;
  const index = chain.history.reduce((found, e, i) => (e.item === item && e.outcome._tag === "Halted" ? i : found), -1);
  if (index < 0) return state;
  return { ...state, chain: { ...chain, history: chain.history.map((e, i) => (i === index ? { ...e, returned: outcome } : e)) } };
};

/** The next start is due: the limits are checked here, so a restored `Ready` is checked again. */
export const due = (state: ChainState, generation: number, nowMs: number): Step => {
  const chain = state.chain;
  if (chain._tag !== "Ready" || chain.generation !== generation) return [state, null];
  const reason = limitReason(state, chain.count, nowMs);
  return reason !== null ? [idle(state, reason), null] : [state, { generation, command: { _tag: "List" } }];
};

/** The listing of refined items answered with its first item, in the tracker's order, or none. */
export const listed = (state: ChainState, generation: number, first: Listed | null): Step => {
  const chain = state.chain;
  if (chain._tag !== "Ready" || chain.generation !== generation) return [state, null];
  if (first === null) return [idle(state, { _tag: "NoItems" }), null];
  return [{ ...state, chain: { _tag: "Starting", item: first.item, title: first.title, ...commonOf(chain) } }, { generation, command: { _tag: "Start", item: first.item } }];
};

/** Checked in the step that reserves a chained start: null lets it go, a reason refuses it and ends the chain. */
export const startGuard = (state: ChainState, generation: number, item: ItemId, nowMs: number): ChainEndReason | null => {
  const chain = state.chain;
  if (!state.settings.enabled || chain._tag !== "Starting" || chain.generation !== generation || chain.item !== item) return { _tag: "ChainChanged", item };
  return limitReason(state, chain.count, nowMs);
};

/**
 * The halted run `run` asks the chain to park its uncommitted files (issue #192): granted, and recorded, exactly when the
 * chain is running that run, so the program's choice to keep the item implementing rests on the chain's own decision.
 */
export const claimParking = (state: ChainState, run: number): readonly [ChainState, boolean] => {
  const chain = state.chain;
  if (chain._tag !== "Running" || chain.run !== run) return [state, false];
  return [{ ...state, chain: { ...chain, claim: { _tag: "Claimed", then: chain.claim._tag === "Claimed" ? chain.claim.then : null } } }, true];
};

/** No implementation run is reserved while a halted run's work is being moved off the working branch. */
export const blocksImplementationStart = (state: ChainState): boolean => state.chain._tag === "Parking";

/** The chained start was reserved as run `run`. */
export const started = (state: ChainState, generation: number, run: number, item: ItemId, title: string): ChainState => {
  const chain = state.chain;
  if (chain._tag !== "Starting" || chain.generation !== generation) return state;
  return { ...state, chain: { _tag: "Running", run, item, title, claim: UNCLAIMED, ...commonOf(chain), count: chain.count + 1 } };
};

/** The chained start was refused: the chain ends with the reason. */
export const refused = (state: ChainState, generation: number, reason: ChainEndReason): ChainState =>
  ofGeneration(state, generation) && (state.chain._tag === "Starting" || state.chain._tag === "Ready") ? idle(state, reason) : state;

/**
 * The chain's state could not be saved: it stops rather than risk a start after a restart. A parking in progress keeps
 * `Parking`, so no implementation run is reserved beside its git writes (behavior 15), and the chain ends saying the state
 * could not be saved once the parking ends (`parked` applies `then`). A `Running` chain whose run's parking was claimed
 * is kept for the same reason (work review 1 of issue #192, W1-R1-1): the program has already kept the item implementing
 * on that claim, so the parking must still run; its claim ends with SaveFailed, which `ended` takes as the end after it.
 */
export const saveFailed = (state: ChainState, message: string): ChainState => {
  const reason: ChainEndReason = { _tag: "SaveFailed", message };
  const chain = state.chain;
  if (chain._tag === "Parking") return { ...state, chain: { ...chain, then: reason } };
  if (chain._tag === "Running" && chain.claim._tag === "Claimed") return { ...state, chain: { ...chain, claim: { _tag: "Claimed", then: reason } } };
  return idle(state, reason);
};

/** The save that must precede a parking failed, so no parking runs: the chain ends with the end decided, else SaveFailed. */
export const parkingAbandoned = (state: ChainState, generation: number): ChainState => {
  const chain = state.chain;
  return chain._tag === "Parking" && chain.generation === generation ? idle(state, chain.then ?? { _tag: "SaveFailed", message: "" }) : state;
};

/** Whether a command computed for a chain still applies to the chain as it is now (the manager drops a stale one). */
export const commandApplies = (state: ChainState, { generation, command }: ChainCommand): boolean => {
  const chain = state.chain;
  if (!ofGeneration(state, generation)) return false;
  switch (command._tag) {
    case "Park":
      return chain._tag === "Parking" && chain.item === command.item && chain.root === command.root;
    case "Due":
    case "List":
      return chain._tag === "Ready";
    case "Start":
      return chain._tag === "Starting" && chain.item === command.item;
  }
};

/** The developer changed the settings; `running` is the implementation run in progress, if any. */
export const configured = (state: ChainState, settings: ChainSettings, running: ItemId | null): ChainState => {
  const next = { ...state, settings };
  const chain = state.chain;
  if (!settings.enabled && state.settings.enabled) {
    const off: ChainEndReason = { _tag: "TurnedOff", running };
    if (chain._tag === "Parking") return { ...next, chain: { ...chain, then: off } };
    // Issue #192: a claimed parking is certain, so the chain stays until it, ending TurnedOff after it.
    if (chain._tag === "Running" && chain.claim._tag === "Claimed") return { ...next, chain: { ...chain, claim: { _tag: "Claimed", then: off } } };
    return idle(next, off);
  }
  if (settings.enabled && !state.settings.enabled && chain._tag === "Idle") return idle(next, null);
  return next;
};

/** What a server restart does (requirements Q4), with the command that resumes it. */
export const restored = (state: ChainState): Step => {
  const chain = state.chain;
  switch (chain._tag) {
    case "Running":
    case "Starting":
      return [idle(state, { _tag: "ServerEnded", item: chain.item }), null];
    case "Parking":
      return [state, { generation: chain.generation, command: { _tag: "Park", item: chain.item, root: chain.root } }];
    case "Ready":
      return [state, { generation: chain.generation, command: { _tag: "Due" } }];
    case "Idle":
      return [state, null];
  }
};
