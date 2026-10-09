// The page's state (plan step 4.2): one pure reducer folds the server's messages into the two panels, the pending
// prompt with its widget, the activity line and the timeline rail. Replay and live events use the same fold.

import type { SubjectId } from "../../src/artifacts.ts";
import type { Asked, ListedItem, ServerMessage, Stamped } from "../../src/protocol.ts";
import { RUN_MODES, type RunMode } from "../../src/runMode.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import { usageLimitActivity, analysisProgressLine, clarificationProgress, cycleHeading, reconnectingActivity, retryActivity, cycleLine, interviewHelp, pagePromptText, progressLine, purposeLabel, stepLabel, stepOfPhase, planWrittenHeading, protocolErrorNotice, SERVER_CLOSED_NOTICE, SUMMARY_PROPOSED_HEADING } from "../../src/prompts.ts";
import { interviewSays, renderResponse, renderReview, subjectHeading } from "../../src/render.ts";
import { piecesText } from "../../src/pieces.ts";
import { correctionCount } from "../../src/issueLog.ts";
import { countOfKind, type LoopResult, type Phase, phaseName, type StepReport, type UiEvent } from "../../src/uiEvents.ts";
import type { Choice } from "../../src/userPrompts.ts";
import type { RecordedPlan, RecordedStep, StepStatus } from "../../src/schema.ts";
import { emptyUiState, newer, type RunUiState } from "../../src/uiState.ts";

export type Author = "program" | "user" | "codex" | "claude";
/**
 * One chat message. `markdown` is rendered and sanitised; a program's plain text is shown as it is. `time` is the ISO
 * time its event was published (issue #1); `showTime` whether the time is shown, or only given to assistive technology.
 */
/**
 * `question`: an answered question as it was presented (S26, S28; S12 of the task of issue #36), which the message shows
 * whole, its pieces carrying their explanations; its `body` is the question's words, for search and announcements.
 */
export type Message = Readonly<{ key: string; author: Author; heading: string | null; body: string; format: "text" | "markdown"; time: string; showTime: boolean; band: Band | null; question?: PresentedQuestion }>;
/**
 * The phase a message belongs to, as its panel shows it (issue #15): a band of one tone per kind of phase, opened by a
 * label with the phase's name and the time it began. `key` is unique per phase of a run; null before any phase.
 */
export type Band = Readonly<{ key: string; kind: Phase["kind"]; name: string; began: string }>;
/** Consecutive messages of one band, in order: how a panel renders its bands. */
export type BandGroup = Readonly<{ band: Band | null; messages: readonly Message[] }>;
/**
 * One cycle of a review loop (issue #14): the issues its review raised and the counted ones, null until the review
 * arrives; the ids of that review, against which a self-correction of the response is judged.
 */
/** `corrections`: those of the round's latest response; a corrective turn's reply replaces them (issue #30). */
export type Cycle = Readonly<{ round: number; raised: number | null; counted: number | null; reviewIds: readonly string[]; corrections?: number }>;
/**
 * The rounds of one review loop within a phase: its cycles, the corrections of its responses (accepted and partially
 * accepted dispositions, effective self-corrections), and how it ended (null while it runs; `done` with it).
 */
export type RoundGroup = Readonly<{ subject: SubjectId; heading: string; rounds: readonly Cycle[]; corrections: number; result: LoopResult | null; done: boolean }>;
/** A step of Gather Requirements (issue #21): its cycles and, for a clarification, the answered questions of the total. */
/**
 * The state of a phase or step (issue #6): foreseen and not yet begun ("ahead"), running, done, stopped, or never reached
 * because the run ended before it.
 */
export type TimelineState = "ahead" | "active" | "done" | "stopped" | "notReached";
/**
 * The state of a step: a phase's states, or "skipped", a step foreseen whose phase ended without needing it (the empty
 * agreed question list without a conversation). Not "notReached", which a halt gives a step the run still needed.
 */
export type StepState = TimelineState | "skipped";
/**
 * Issue #51 (Q4): the follow-up clarifications are one conversation with the clarification, so they fold into its step:
 * `base` holds the counts of the interviews before the current one, and `count` is `base` plus the current interview's.
 */
export type StepCount = Readonly<{ answered: number; total: number }>;
export type TimelineStep = Readonly<{ kind: "formulate" | "terms" | "clarification"; label: string; state: StepState; count: StepCount | null; base: StepCount; groups: readonly RoundGroup[] }>;
/**
 * The plan as an Implementation entry shows it (issue #54): its stages, each with a rendering `key` that is unique within
 * the entry (`current-<n>` for a stage of the current plan, `record-<n>` for one that holds only steps a revision removed).
 */
export type ShownStage = Readonly<{ key: string; number: number; title: string; steps: readonly RecordedStep[] }>;
export type ShownPlan = Readonly<{ stages: readonly ShownStage[] }>;
/**
 * A phase of the run in the timeline. `label` is numbered by the count of its kind in the timeline (issue #6), and is
 * renumbered when that count changes; `plan` is the current plan, on the Implementation entry that carries it out (Q5, Q9).
 */
export type TimelineEntry = Readonly<{
  phase: Phase;
  label: string;
  groups: readonly RoundGroup[];
  steps: readonly TimelineStep[];
  state: TimelineState;
  /** What the entry shows of the plan (issue #54): derived by `shownPlan` from the entry and the current plan, never set otherwise. */
  plan: ShownPlan | null;
  /** The publication times of the phase's PhaseBegan and of its end (PhaseEnded, or the run's Ended): null before (issue #50, Q2). */
  began: string | null;
  ended: string | null;
  /**
   * The step of the plan named by the latest 'started' report of the running execution call, while it is still started
   * (issue #53, G-R1-1); null otherwise. A step is current only on a report: another step's start or the call's end
   * clears it, and only a new report of the step makes it current again.
   */
  currentStep: string | null;
  /**
   * The step of the plan named by the latest 'started' report in this Implementation (issue #63, P1-R1-1, P1-R2-1): unlike
   * `currentStep`, neither the end of the execution call nor the end of the phase clears it, so that the rail can find the
   * stage the call was working on when the run halts or asks the user after the call. Null for every other phase.
   */
  lastStarted: string | null;
  /** The ids of the steps of the plan whose status changed, or that were reported, while the entry was active (issue #54, Q3). */
  acted: readonly string[];
  /** An ended Implementation's steps as they stood when it ended, those of `acted` alone (issue #54, Q3, Q6); null before its end. */
  record: RecordedPlan | null;
}>;
/** An agent call that runs; calls nest when a decision is taken inside an execution call (P1-R2-1). */
export type AgentCall = Readonly<{ agent: "claude" | "codex"; purpose: string; label: string; startedAt: string }>;
/** The prompt the run waits on, with every choice it offers (the catalog's and those of the preceding event). */
/** A pending prompt: the agent's options (an interview turn's numbered answers or a relayed question's options,
 * rendered as cards) apart from the catalog's fixed choices (buttons), issue #12. */
/**
 * S26: `question`, the question the prompt asks, as it was last presented, and `hint`, the prompt's text in the page's
 * words; neither is a transcript message while the prompt is pending. `presentedAt`, the time it was presented, or the prompt asked when it has no question.
 */
export type Widget = Readonly<{ asked: Asked; options: readonly Choice[]; choices: readonly Choice[]; question: PresentedQuestion | null; presentedAt: string | null; hint: string }>;

export type RunView = Readonly<{
  id: number;
  /** The run's mode and item from Started (issue #120); null before it. */
  mode: RunMode | null;
  item: Readonly<{ id: string; title: string }> | null;
  project: string;
  /** The project's identification from Started (issue #29): its host directory, or the path as given. */
  location: string;
  task: string;
  nextSeq: number;
  left: readonly Message[];
  right: readonly Message[];
  pending: Widget | null;
  /** The prompts answered so far, in order (finding 5): what a draft is reconciled against, live and after a replay. */
  answered: readonly number[];
  activity: string;
  /** Whether an agent call runs: `calls` is not empty. */
  busy: boolean;
  /** The agent calls that run, the innermost last (P1-R2-1). */
  calls: readonly AgentCall[];
  /**
   * The program's retry of a transport fault while it lasts (issue #26): shown on the activity line with the retried call
   * of its agent; every call's end clears it (W1-R1-3).
   */
  retry: Readonly<{ agent: "claude" | "codex"; text: string; wait: Countdown | null }> | null;
  /** A wait for a usage limit while it lasts (issue #68): from its start to its scheduled end, both known. */
  limitWait: LimitWait | null;
  timeline: readonly TimelineEntry[];
  ended: number | null;
  /** Internal to the fold: the lines said for the last interview turn still to absorb, and the options of the last question presented (S5). */
  absorb: readonly string[];
  questionOptions: readonly Choice[];
  /** The question presented last and not yet asked (S26), with the time it was presented. */
  presented: Readonly<{ question: PresentedQuestion; time: string }> | null;
  /** The band of the phase the next message belongs to (issue #15): set when a phase begins, kept until the next one. */
  phase: Band | null;
  /** The last time each panel displays, a message's or a band label's: what the next message's time is measured from. */
  lastShown: Readonly<{ left: string | null; right: string | null }>;
  /**
   * The analysis of the last decision (decision support), shown until the prompt asked again after it is answered:
   * `prompt` is that prompt's number, null until it is asked.
   */
  analysis: Readonly<{ event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; prompt: number | null }> | null;
  /** The analysis the last answer dismissed, until the next prompt: restored if the run rejects that answer (W3-R1-1). */
  dismissed: Readonly<{ event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; prompt: number | null }> | null;
  /** The current plan with its statuses and the phase that carries it out (issue #6, Q5 and Q9); null before the first. */
  plan: Readonly<{ phase: number; plan: RecordedPlan }> | null;
  /** The phases known of the run, begun or ahead (issue #6). */
  foreseen: readonly Phase[];
  /** The shared state of the page for this run (issue #87): which of its decisions' entries are open in every tab. */
  ui: RunUiState;
}>;

/** A tab's items (issue #120): not asked yet, being asked for, listed, or the notice of why the tracker could not list them. */
export type ItemsView = Readonly<{ _tag: "Unasked" }> | Readonly<{ _tag: "Loading" }> | Readonly<{ _tag: "Listed"; items: readonly ListedItem[] }> | Readonly<{ _tag: "Unavailable"; notice: string }>;
/**
 * What the page holds of one mode, the content of its tab (issue #120): the id of its run in progress on the server, its
 * newest run (in progress or ended) and the one before it, its items, and the refusal of its last action, which its next
 * items frame or Started clears.
 */
export type ModeView = Readonly<{ current: number | null; run: RunView | null; last: RunView | null; items: ItemsView; refusal: string | null }>;
const emptyMode: ModeView = { current: null, run: null, last: null, items: { _tag: "Unasked" }, refusal: null };
export type ViewState = Readonly<{
  connection: "connecting" | "open" | "reconnecting" | "failed";
  /** The identification of the server's working directory, the one project, from the last hello (issue #29); null before the first. */
  location: string | null;
  /** The server's incarnation from the last hello (finding 12); null before the first. */
  incarnation: string | null;
  /** Each mode's tab (issue #120). */
  modes: Readonly<Record<RunMode, ModeView>>;
  /** The tab shown. */
  selected: RunMode;
  /** The mode of every run the page has seen, from its Started (issue #120): where a later event of the run belongs. */
  runModes: Readonly<Record<number, RunMode>>;
  /** A seq that did not follow: the page must reconnect to receive the replay. */
  needsReconnect: boolean;
  /** Messages from the server or the page for the user that belong to no tab: notices, and refusals of no mode. */
  notices: readonly string[];
  /** The answers the page could not send and could not put back into the answer field, in order, until dismissed. */
  unsent: readonly string[];
}>;

export const initialState: ViewState = {
  connection: "connecting",
  location: null,
  incarnation: null,
  modes: { refinement: emptyMode, implementation: emptyMode },
  selected: "refinement",
  runModes: {},
  needsReconnect: false,
  notices: [],
  unsent: [],
};

/** The state with one mode's tab changed. */
const withMode = (state: ViewState, mode: RunMode, change: (m: ModeView) => ModeView): ViewState => ({ ...state, modes: { ...state.modes, [mode]: change(state.modes[mode]) } });
/** The tab the user shows (issue #120). */
export const selectMode = (state: ViewState, mode: RunMode): ViewState => ({ ...state, selected: mode });
/** A tab's items asked for: loading until the server's items frame. */
export const itemsRequested = (state: ViewState, mode: RunMode): ViewState => withMode(state, mode, (m) => ({ ...m, items: { _tag: "Loading" } }));
/** The run a mode's tab shows, its newest, and the server's incarnation: what the draft and the notifications key by. */
export type Shown = Readonly<{ incarnation: string | null; run: RunView | null }>;
export const shownRun = (state: ViewState, mode: RunMode = state.selected): Shown => ({ incarnation: state.incarnation, run: state.modes[mode].run });
/** The mode of a run's view, from its Started; null before it. */
const modeOfRun = (run: RunView): RunMode | null => run.mode;

const AGENT: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };
const sameSubject = (a: SubjectId, b: SubjectId): boolean => JSON.stringify(a) === JSON.stringify(b);
const isDecision = (subject: SubjectId): boolean => typeof subject === "object" && "decision" in subject;
const samePhase = (a: Phase, b: Phase): boolean => JSON.stringify(a) === JSON.stringify(b);

export const emptyRun = (id: number): RunView => ({
  id,
  mode: null,
  item: null,
  project: "",
  location: "",
  task: "",
  nextSeq: 0,
  left: [],
  right: [],
  pending: null,
  answered: [],
  activity: "",
  busy: false,
  calls: [],
  retry: null,
  limitWait: null,
  timeline: [],
  ended: null,
  absorb: [],
  questionOptions: [],
  presented: null,
  phase: null,
  lastShown: { left: null, right: null },
  analysis: null,
  dismissed: null,
  plan: null,
  foreseen: [],
  ui: emptyUiState,
});

/**
 * Decision Q3 of issue #1: consecutive messages of one author in one panel are grouped under one time. Issue #15: the
 * grouping ends when more than this lies since the last time the panel displayed, not since the message before.
 */
const GROUP_GAP_MS = 2 * 60 * 1000;

/** More than the grouping interval from `from` to `to`; a time that cannot be read counts as more (it is shown). */
const beyondGap = (from: string, to: string): boolean => {
  const gap = Date.parse(to) - Date.parse(from);
  return Number.isNaN(gap) || gap > GROUP_GAP_MS;
};
/** A message of `band` after `previous` opens the band in its panel: the band's label is displayed above it. */
const opensBand = (previous: Message | undefined, band: Band | null): band is Band => band !== null && previous?.band?.key !== band.key;

/**
 * Whether a message shows its time (issues #1 and #15). The first message of a band shows it only if more than two
 * minutes lie since the band's label, which displays the time the phase began, whoever wrote it (G-R1-1). Any other
 * message shows it when it is the first of its panel (only before any phase), when its author differs from the message
 * before it, or when more than two minutes lie since `lastShown`, the last time the panel displayed. A time that cannot
 * be read is shown rather than silently grouped. The gap may be negative for events published concurrently.
 */
export const showsTime = (previous: Message | undefined, lastShown: string | null, { author, band, time }: Readonly<{ author: Author; band: Band | null; time: string }>): boolean => {
  if (opensBand(previous, band)) return beyondGap(band.began, time);
  if (previous === undefined || previous.author !== author || lastShown === null) return true;
  return beyondGap(lastShown, time);
};

/** A message before it is placed in its panel, which decides whether it shows its time. */
type Unplaced = Omit<Message, "showTime">;
const message = (run: RunView, time: string, author: Author, body: string, format: Message["format"], heading: string | null = null): Unplaced => ({ key: `${run.id}-${run.nextSeq}`, author, heading, body, format, time, band: run.phase });
/** The run with the message placed in a panel, and the panel's last displayed time after it. */
const place = (run: RunView, side: "left" | "right", m: Unplaced): RunView => {
  const panel = run[side];
  const previous = panel[panel.length - 1];
  const last = run.lastShown[side];
  const showTime = showsTime(previous, last, m);
  const shownLast = showTime ? m.time : opensBand(previous, m.band) ? m.band.began : last;
  const next: readonly Message[] = [...panel, { ...m, showTime }];
  return side === "left" ? { ...run, left: next, lastShown: { ...run.lastShown, left: shownLast } } : { ...run, right: next, lastShown: { ...run.lastShown, right: shownLast } };
};
const withLeft = (run: RunView, m: Unplaced): RunView => place(run, "left", m);
const withRight = (run: RunView, m: Unplaced): RunView => place(run, "right", m);

/** The key of a phase: of its band, and of its entry in the rail. */
export const bandKey = (phase: Phase): string => (phase.kind === "questions" ? "questions" : `${phase.kind}-${phase.n}`);
/** The band of a phase that began at `time`. */
const bandOf = (phase: Phase, time: string, count: number): Band => ({ key: bandKey(phase), kind: phase.kind, name: phaseName(phase, count), began: time });
/** How many phases of the kind the run holds, begun or foreseen: the timeline holds both (issue #6). */
const countIn = (run: RunView, phase: Phase): number => Math.max(1, countOfKind(run.timeline.map((e) => e.phase), phase.kind));
/**
 * The run with every phase's name derived from the one count (issue #6): the timeline's labels and the bands of both
 * panels. Run after an event that adds a phase, so that "Planning" becomes "Planning 1" everywhere when Planning 2 appears.
 */
const relabel = (run: RunView): RunView => {
  const nameOf = (phase: Phase) => phaseName(phase, countIn(run, phase));
  const byKey = new Map(run.timeline.map((e) => [bandKey(e.phase), nameOf(e.phase)]));
  const band = (b: Band | null): Band | null => (b === null || byKey.get(b.key) === undefined || byKey.get(b.key) === b.name ? b : { ...b, name: byKey.get(b.key) ?? b.name });
  const messages = (list: readonly Message[]) => (list.some((m) => band(m.band) !== m.band) ? list.map((m) => ({ ...m, band: band(m.band) })) : list);
  return { ...run, timeline: run.timeline.map((e) => ({ ...e, label: nameOf(e.phase) })), left: messages(run.left), right: messages(run.right), phase: band(run.phase) };
};
const newEntry = (phase: Phase, state: TimelineState): TimelineEntry => ({
  phase,
  label: "",
  groups: [],
  steps: phase.kind === "questions" ? [newStep("formulate", null, state), ...(state === "ahead" ? [newStep("clarification", null, "ahead")] : [])] : [],
  state,
  plan: null,
  began: null,
  ended: null,
  currentStep: null,
  lastStarted: null,
  acted: [],
  record: null,
});
/** The index of the last element that satisfies `p`, or -1 (the page's library has no findLastIndex). */
const lastIndex = <T>(list: readonly T[], p: (t: T) => boolean): number => list.reduce((found, t, i) => (p(t) ? i : found), -1);
/** The entry that the run is in: the active one, else the last one begun. */
export const currentIndex = (timeline: readonly TimelineEntry[]): number => {
  const active = lastIndex(timeline, (e) => e.state === "active");
  return active >= 0 ? active : lastIndex(timeline, (e) => e.state !== "ahead" && e.state !== "notReached");
};
/** The step that an entry is in: the active one, else the last one begun. */
export const currentStepIndex = (steps: readonly TimelineStep[]): number => {
  const active = lastIndex(steps, (st) => st.state === "active");
  return active >= 0 ? active : lastIndex(steps, (st) => st.state !== "ahead" && st.state !== "notReached" && st.state !== "skipped");
};
/**
 * How a step of the plan shows in the rail (issue #6, G-R1-2; issue #53): current only when it is the entry's current step
 * (`currentPlanStep`); any other started step shows as unfinished.
 */
export const planStepState = (entry: Pick<TimelineEntry, "state" | "currentStep">, step: Readonly<{ id: string; status: StepStatus }>, executing: boolean): "done" | "current" | "unfinished" | "pending" =>
  step.status === "done" ? "done" : step.status === "started" ? (currentPlanStep(entry, executing) === step.id ? "current" : "unfinished") : step.status === "unfinished" ? "unfinished" : "pending";
/**
 * The plan an entry shows (issue #54). An ended Implementation shows its record: each step with the status it had at
 * the end, and the number, label, text and stage of the current plan while the step is in it (Q6), else as recorded
 * (a stage `record-<n>`). The Implementation that carries the current plan and has not ended shows it without the
 * steps done before it began. Any other entry shows nothing.
 */
export const shownPlan = (entry: TimelineEntry, current: RunView["plan"]): ShownPlan | null => {
  if (entry.phase.kind !== "execution") return null;
  const n = entry.phase.n;
  const stages: readonly ShownStage[] =
    entry.record !== null
      ? recordShown(entry.record, current?.plan ?? null)
      : current !== null && current.phase === n
        ? current.plan.stages.map((st) => ({ key: `current-${st.number}`, number: st.number, title: st.title, steps: st.steps.filter((x) => x.status !== "done" || entry.acted.includes(x.id)) }))
        : [];
  const shown = stages.filter((st) => st.steps.length > 0);
  return shown.length === 0 ? null : { stages: shown };
};
/** A record's steps placed as the current plan places them, the removed ones in their recorded stages after those. */
const recordShown = (record: RecordedPlan, current: RecordedPlan | null): readonly ShownStage[] => {
  const now = new Map((current?.stages ?? []).flatMap((st) => st.steps.map((x) => [x.id, { stage: st, step: x }] as const)));
  const placed = record.stages.flatMap((st) =>
    st.steps.map((x) => {
      const there = now.get(x.id);
      return there === undefined
        ? { key: `record-${st.number}`, number: st.number, title: st.title, step: x }
        : { key: `current-${there.stage.number}`, number: there.stage.number, title: there.stage.title, step: { ...there.step, status: x.status } };
    }),
  );
  const keys = placed.map((p) => p.key).filter((k, i, all) => all.indexOf(k) === i);
  const rank = (key: string) => (key.startsWith("current-") ? 0 : 1);
  // The page's library has no toSorted: each sort is over a fresh copy.
  const stages = keys.map((key) => {
    const members = placed.filter((p) => p.key === key);
    return { key, number: members[0].number, title: members[0].title, steps: [...members.map((p) => p.step)].sort((a, b) => a.number - b.number) };
  });
  return [...stages].sort((a, b) => a.number - b.number || rank(a.key) - rank(b.key));
};
/** The run with every entry's shown plan derived again (issue #54, P1-R2-1): after every event that changes the plan, an entry's state or its record. */
const reshow = (run: RunView): RunView => ({ ...run, timeline: run.timeline.map((e) => ({ ...e, plan: shownPlan(e, run.plan) })) });
const statusesOf = (plan: RecordedPlan | null): ReadonlyMap<string, StepStatus> => new Map((plan?.stages ?? []).flatMap((st) => st.steps.map((x) => [x.id, x.status] as const)));
/** The steps an active Implementation has acted on after a PlanChanged (issue #54, Q3): those whose status changed, and the step reported. */
const actedAfter = (acted: readonly string[], before: RecordedPlan | null, after: RecordedPlan, step: StepReport | null): readonly string[] => {
  const previous = statusesOf(before);
  const changed = after.stages.flatMap((st) => st.steps.filter((x) => previous.get(x.id) !== x.status).map((x) => x.id));
  const all = [...acted, ...changed, ...(step === null ? [] : [step.id])];
  return all.filter((id, i) => all.indexOf(id) === i);
};
/** An Implementation entry at its end, with the steps it acted on as they stand in the current plan (issue #54, Q3). */
const recorded = (e: TimelineEntry, current: RunView["plan"]): TimelineEntry => {
  if (e.phase.kind !== "execution") return e;
  const stages = (current?.plan.stages ?? []).map((st) => ({ ...st, steps: st.steps.filter((x) => e.acted.includes(x.id)) })).filter((st) => st.steps.length > 0);
  return { ...e, record: { stages } };
};
/** The step of the plan that is current in the entry (issue #53, G-R1-1): where the rail puts the running indicator; null when none. */
export const currentPlanStep = (entry: Pick<TimelineEntry, "state" | "currentStep">, executing: boolean): string | null => (entry.state === "active" && executing ? entry.currentStep : null);
/**
 * The current step after a PlanChanged of the entry's plan (issue #53, G-R1-1): a 'started' report makes its step current,
 * a 'done' report of the current step clears it, and a plan in which the current step is no longer started clears it.
 */
const currentAfter = (current: string | null, step: StepReport | null, plan: RecordedPlan): string | null => {
  if (step !== null && step.status === "started") return step.id;
  if (current === null) return null;
  const status = plan.stages.flatMap((st) => st.steps).find((st) => st.id === current)?.status;
  return status === "started" ? current : null;
};
/** The start of the innermost running call, which the elapsed time is measured from (issue #42, P1-R2-1); null when none runs. */
export const callStartedAt = (run: RunView): string | null => run.calls.at(-1)?.startedAt ?? null;
/** Whether an execution call runs, possibly with nested calls above it (P1-R2-1). */
export const executing = (run: RunView): boolean => run.calls.some((c) => c.purpose === "execution");

/** The messages of a panel grouped into their bands, in order; linear in the number of messages. */
export const bandsOf = (messages: readonly Message[]): readonly BandGroup[] => {
  const starts = messages.flatMap((m, i) => (i === 0 || messages[i - 1].band?.key !== m.band?.key ? [i] : []));
  return starts.map((start, j) => ({ band: messages[start].band, messages: messages.slice(start, starts[j + 1] ?? messages.length) }));
};

/** The half of a round as conversation.md has it, without its "### Codex" / "### Claude Code" heading, which the message's author shows. */
const withoutAuthorHeading = (markdown: string): string => markdown.replace(/^### [^\n]*\n+/, "").trim();

const freshCycle = (round: number): Cycle => ({ round, raised: null, counted: null, reviewIds: [] });
/** The groups with the round in the subject's open group, or in a new group when none is open. */
const withRound = (groups: readonly RoundGroup[], subject: SubjectId, round: number): readonly RoundGroup[] => {
  const open = groups.findIndex((g) => sameSubject(g.subject, subject) && !g.done);
  return open < 0
    ? [...groups, { subject, heading: subjectHeading(subject), rounds: [freshCycle(round)], corrections: 0, result: null, done: false }]
    : groups.map((g, i) => (i === open ? { ...g, rounds: [...g.rounds, freshCycle(round)] } : g));
};
/**
 * The timeline after a round began: the round in its subject's open group of the current entry, or of its last step
 * when the entry has steps (Gather Requirements, issue #21), so a follow-up clarification takes the later cycles.
 */
const roundBegan = (timeline: readonly TimelineEntry[], subject: SubjectId, round: number): readonly TimelineEntry[] => {
  // P1-R1-1: by state, not by position; with the phases ahead in the timeline, the last entry is not the current one.
  const index = currentIndex(timeline);
  const entry = timeline[index];
  if (entry === undefined) return timeline;
  const s = currentStepIndex(entry.steps);
  const next: TimelineEntry = s < 0 ? { ...entry, groups: withRound(entry.groups, subject, round) } : { ...entry, steps: entry.steps.map((st, i) => (i === s ? { ...st, groups: withRound(st.groups, subject, round) } : st)) };
  return timeline.map((e, i) => (i === index ? next : e));
};
/** The timeline with every open group of the subject, in the entries and in their steps, changed by `f`. */
const openGroups = (timeline: readonly TimelineEntry[], subject: SubjectId, f: (g: RoundGroup) => RoundGroup): readonly TimelineEntry[] => {
  const each = (groups: readonly RoundGroup[]) => groups.map((g) => (sameSubject(g.subject, subject) && !g.done ? f(g) : g));
  return timeline.map((e) => ({ ...e, groups: each(e.groups), steps: e.steps.map((st) => ({ ...st, groups: each(st.groups) })) }));
};
const NO_COUNT: StepCount = { answered: 0, total: 0 };
const newStep = (kind: TimelineStep["kind"], count: TimelineStep["count"], state: StepState = "active"): TimelineStep => ({ kind, label: stepLabel(kind), state, count, base: NO_COUNT, groups: [] });
/** The steps with the terms step active (S17): the active step before it done, the terms step placed before the clarification. */
const termsStep = (steps: readonly TimelineStep[]): readonly TimelineStep[] => {
  if (steps.some((st) => st.kind === "terms")) return steps;
  const ended = steps.map((st) => (st.state === "active" ? { ...st, state: "done" as const } : st));
  const at = ended.findIndex((st) => st.kind === "clarification");
  const step = newStep("terms", null);
  return at < 0 ? [...ended, step] : [...ended.slice(0, at), step, ...ended.slice(at)];
};
const plus = (a: StepCount, b: StepCount): StepCount => ({ answered: a.answered + b.answered, total: a.total + b.total });
/**
 * An entry when the run ends with `code`: the active one done or stopped; after a halt, what is ahead not reached (issue #6);
 * after success, the active one's steps never begun skipped (`endSteps`).
 */
const endEntry = (e: TimelineEntry, code: number, time: string): TimelineEntry => {
  const end = code === 0 ? "done" : "stopped";
  const unreached = (st: TimelineStep): TimelineStep => (code !== 0 && st.state === "ahead" ? { ...st, state: "notReached" } : st);
  if (e.state === "active") return endSteps({ ...e, state: end, steps: e.steps.map(unreached), ended: time, currentStep: null }, end);
  return code !== 0 && e.state === "ahead" ? { ...e, state: "notReached", steps: e.steps.map(unreached) } : e;
};
/** The entry with its active steps ended in `state`, and the steps it never began skipped: its phase is over. */
const endSteps = (e: TimelineEntry, state: "done" | "stopped"): TimelineEntry => ({ ...e, steps: e.steps.map((st) => (st.state === "active" ? { ...st, state } : st.state === "ahead" ? { ...st, state: "skipped" } : st)) });
/** The timeline with the last entry's steps changed by `f`, when it is the question phase. */
const inQuestionPhase = (timeline: readonly TimelineEntry[], f: (steps: readonly TimelineStep[]) => readonly TimelineStep[]): readonly TimelineEntry[] =>
  // P1-R1-1: Gather Requirements wherever it stands, while it runs.
  timeline.map((e) => (e.phase.kind === "questions" && e.state === "active" ? { ...e, steps: f(e.steps) } : e));
/** The group with the cycle of `round` changed by `f`. */
const inCycle = (g: RoundGroup, round: number, f: (c: Cycle) => Cycle): RoundGroup => ({ ...g, rounds: g.rounds.map((c) => (c.round === round ? f(c) : c)) });

/** A notified event of the run. */
const notifiedEvent = (run: RunView, event: UiEvent, time: string): RunView => {
  switch (event._tag) {
    case "PhaseBegan": {
      // Issue #6: the foreseen entry becomes active, with its first step; a phase not foreseen is appended.
      const foreseen = run.timeline.some((e) => samePhase(e.phase, event.phase));
      const begin = (e: TimelineEntry): TimelineEntry => ({ ...e, state: "active", began: time, steps: e.steps.map((st, i) => (i === 0 ? { ...st, state: "active" } : st)) });
      const timeline = foreseen ? run.timeline.map((e) => (samePhase(e.phase, event.phase) ? begin(e) : e)) : [...run.timeline, { ...newEntry(event.phase, "active"), began: time }];
      const next = { ...run, timeline };
      return reshow(relabel({ ...next, phase: bandOf(event.phase, time, countIn(next, event.phase)) }));
    }
    case "PhaseEnded":
      return reshow({ ...run, activity: "", busy: false, calls: [], retry: null, timeline: run.timeline.map((e) => (e.state === "active" && samePhase(e.phase, event.phase) ? recorded(endSteps({ ...e, state: "done", ended: time, currentStep: null }, "done"), run.plan) : e)) });
    case "RoundBegan":
      // A decision loop is a loop inside a phase that the progress panel does not show (D12 of the decision-support plan).
      // S17: the terms review's first round opens its own step of Gather Requirements, before the clarification.
      if (isDecision(event.subject)) return run;
      return { ...run, timeline: roundBegan(event.subject === "terms" ? inQuestionPhase(run.timeline, termsStep) : run.timeline, event.subject, event.round) };
    case "LoopFinished":
      return { ...run, timeline: openGroups(run.timeline, event.subject, (g) => ({ ...g, result: event.result, done: true })) };
    case "ReviewReceived": {
      const counts = (c: Cycle): Cycle => ({ ...c, raised: event.review.issues.length, counted: event.counted, reviewIds: event.review.issues.map((i) => i.id) });
      const timeline = openGroups(run.timeline, event.subject, (g) => inCycle(g, event.round, counts));
      const body = event.review.issues.length === 0 ? "No issue: the review has converged." : withoutAuthorHeading(renderReview(event.review));
      return withRight({ ...run, timeline }, message(run, time, "codex", body, "markdown", cycleHeading(subjectHeading(event.subject), event.round)));
    }
    case "ResponseReceived": {
      const response = event.response;
      const corrected = (g: RoundGroup): RoundGroup => {
        const cycle = g.rounds.find((c) => c.round === event.round);
        if (cycle === undefined) return g;
        const rounds = g.rounds.map((c) => (c.round === event.round ? { ...c, corrections: correctionCount(cycle.reviewIds, response) } : c));
        return { ...g, rounds, corrections: rounds.reduce((sum, c) => sum + (c.corrections ?? 0), 0) };
      };
      return withRight({ ...run, timeline: openGroups(run.timeline, event.subject, corrected) }, message(run, time, "claude", withoutAuthorHeading(renderResponse(event.response)), "markdown", cycleHeading(subjectHeading(event.subject), event.round)));
    }
    case "PlanWritten": {
      // Issue #46 (S19): the plan writer's questions are presented one by one after this message, never listed in it.
      const body = `**${planWrittenHeading(phaseName({ kind: "planning", n: event.phase }, countIn(run, { kind: "planning", n: event.phase })))}**${event.resultText === "" ? "" : `\n\n${event.resultText}`}`;
      return withLeft(run, message(run, time, "program", body, "markdown"));
    }
    case "InterviewTurn": {
      const turn = event.summary === null ? { kind: "continuing" as const, message: event.message } : { kind: "summary_proposed" as const, message: event.message, summary: event.summary };
      const body = event.summary === null ? event.message : `${event.message}\n\n**${SUMMARY_PROPOSED_HEADING}**\n\n${event.summary}`;
      // Issue #5: the interview's turns are Claude's words, so they are Claude's messages.
      // Issue #21: the turn's count is the active clarification step's.
      const count = { answered: event.answered, total: event.total };
      const timeline = inQuestionPhase(run.timeline, (steps) => steps.map((st) => (st.state === "active" && st.kind === "clarification" ? { ...st, count: plus(st.base, count) } : st)));
      return { ...withLeft({ ...run, timeline }, message(run, time, "claude", body, "markdown", event.heading)), absorb: interviewSays(turn) };
    }
    case "InterviewOpened": {
      // Issue #21: the step before ends, and the clarification opens as a step with its total.
      const fresh = { answered: 0, total: event.total };
      const step = newStep("clarification", fresh);
      // Issue #6: a foreseen Clarification becomes active. Issue #51: a follow-up reopens the Clarification begun before,
      // which keeps its cycles and adds the follow-up's counts to its own.
      const opened = (steps: readonly TimelineStep[]): readonly TimelineStep[] => {
        const begun = steps.findIndex((st) => st.kind === "clarification" && st.state !== "ahead");
        const ended = steps.map((st, i) => (st.state === "active" && i !== begun ? { ...st, state: "done" as const } : st));
        if (event.stage === "followUp" && begun >= 0) {
          return ended.map((st, i) => (i === begun ? { ...st, state: "active" as const, base: st.count ?? NO_COUNT, count: plus(st.count ?? NO_COUNT, fresh) } : st));
        }
        const ahead = ended.findIndex((st) => st.state === "ahead" && st.kind === "clarification");
        return ahead < 0 ? [...ended, step] : ended.map((st, i) => (i === ahead ? step : st));
      };
      const timeline = inQuestionPhase(run.timeline, opened);
      // The page's own help (finding 8).
      return withLeft({ ...run, timeline }, message(run, time, "program", interviewHelp(event.heading), "text"));
    }
    case "AgentCallStarted": {
      const label = `${AGENT[event.agent]} — ${purposeLabel(event.purpose)}`;
      // Issue #63: the retried call's start ends the wait before it; the retry's text stays with the call.
      return { ...run, limitWait: null, retry: run.retry === null ? null : { ...run.retry, wait: null }, calls: [...run.calls, { agent: event.agent, purpose: event.purpose, label, startedAt: time }], activity: run.retry === null || run.retry.agent !== event.agent ? label : `${label} — ${run.retry.text}`, busy: true };
    }
    case "ToolUsed":
      return { ...run, activity: `${run.calls.at(-1)?.label ?? AGENT[event.agent]} — ${event.tool}: ${event.target}`.replace(/: $/, "") };
    // Issue #26: the SDK's own reconnection during a call, and the program's retry while it lasts; neither is progress.
    case "AgentReconnecting":
      return { ...run, activity: `${run.calls.at(-1)?.label ?? AGENT[event.agent]} — ${reconnectingActivity(event.attempt, event.of, event.detail)}` };
    case "TransportRetrying": {
      const text = retryActivity(event.attempt, event.of, event.fault);
      return { ...run, retry: { agent: event.agent, text, wait: { fromMs: event.fromMs, untilMs: event.untilMs } }, activity: `${AGENT[event.agent]} — ${text}` };
    }
    case "TransportRecovered":
      return { ...run, retry: null, activity: run.calls.at(-1)?.label ?? "" };
    // Issue #68: a wait for a usage limit, whose end is known; the activity line shows it until it lifts.
    case "UsageLimitWaiting":
      return { ...run, limitWait: { agent: event.agent, limitType: event.limitType, fromMs: event.fromMs, untilMs: event.untilMs }, activity: `${AGENT[event.agent]} — ${usageLimitActivity(event.limitType, event.untilMs)}` };
    case "UsageLimitLifted":
      return { ...run, limitWait: null, activity: run.calls.at(-1)?.label ?? "" };
    case "AgentCallEnded": {
      // P1-R2-1: a nested call ends and the one it ran in is shown again.
      const ended = run.calls.at(-1);
      const calls = run.calls.slice(0, -1);
      const outer = calls.at(-1);
      const activity = outer !== undefined ? outer.label : `${ended?.label ?? AGENT[event.agent]} — ${event.ok ? "done" : "failed"}`;
      // Issue #53 (P1-R1-1): the end of the execution call itself, a retried attempt's included, leaves no step current;
      // the end of a call nested in it does not.
      const timeline = ended?.purpose === "execution" ? run.timeline.map((e) => (e.currentStep === null ? e : { ...e, currentStep: null })) : run.timeline;
      return { ...run, calls, activity, busy: calls.length > 0, retry: null, timeline };
    }
    case "ExecutionEnded":
      return run;
    case "QuestionPresented":
      // S5: every question in the one shape; its options with an exact answer are the next prompt's cards.
      // S26: the question stays out of the transcript until its prompt is answered.
      return {
        ...run,
        presented: { question: event.question, time },
        questionOptions: event.question.options.flatMap((o) => {
          const label = piecesText(o.label);
          const description = piecesText(o.description);
          return "token" in o.answer ? [{ label: description === "" ? label : `${label} — ${description}`, sends: o.answer.token }] : [];
        }),
      };
    case "AnalysisProgress": {
      // S21 (Q4): one plain status while the analysis is prepared, updated in place; the line said for it that
      // follows is absorbed.
      const text = analysisProgressLine(event.decision, event.question, event.check);
      const key = `${run.id}-analysis-${event.decision}`;
      const shown = run.left.some((m) => m.key === key)
        ? { ...run, left: run.left.map((m) => (m.key === key ? { ...m, body: text.trim() } : m)) }
        : withLeft(run, { ...message(run, time, "program", text.trim(), "text"), key });
      return { ...shown, absorb: [text] };
    }
    case "DecisionAnalyzed":
      return { ...run, analysis: { event, prompt: null } };
    case "AnswerRejected":
      // The question is asked again: the analysis its rejected answer dismissed goes to the next prompt.
      return run.dismissed === null ? run : { ...run, analysis: { ...run.dismissed, prompt: null }, dismissed: null };
    case "PhasesForeseen": {
      // Issue #6: every phase known and not yet in the timeline is added ahead; the labels follow the new counts.
      const added = event.phases.filter((p) => !run.timeline.some((e) => samePhase(e.phase, p)));
      return reshow(relabel({ ...run, foreseen: event.phases, timeline: [...run.timeline, ...added.map((p) => newEntry(p, "ahead"))] }));
    }
    case "PlanChanged": {
      // Q5, Q9: the plan on the Implementation of its phase. Issue #54: the active one records the steps it acts on.
      const carries = (e: TimelineEntry) => e.phase.kind === "execution" && e.phase.n === event.phase;
      const acting = (e: TimelineEntry): TimelineEntry => (e.state === "active" ? { ...e, acted: actedAfter(e.acted, run.plan?.plan ?? null, event.plan, event.step) } : e);
      const lastStarted = (e: TimelineEntry) => (e.state === "active" && event.step !== null && event.step.status === "started" ? event.step.id : e.lastStarted);
      const timeline = run.timeline.map((e) => (carries(e) ? { ...acting(e), currentStep: currentAfter(e.currentStep, event.step, event.plan), lastStarted: lastStarted(e) } : e));
      return reshow({ ...run, plan: { phase: event.phase, plan: event.plan }, timeline });
    }
    case "ClaudeSaid":
      // Issue #5: Claude's prose is attributed as data, not by a prefix in its text.
      return withLeft(run, message(run, time, "claude", event.text, "markdown"));
  }
};

/** One event of a run with its time, in its order. Pure; the replay folds the same function. */
export const foldEvent = (run: RunView, { time, event }: Stamped): RunView => {
  // The lines said for an interview turn or a relayed question are absorbed only while they follow it directly.
  if (event._tag === "Said" && run.absorb.length > 0 && run.absorb[0] === event.text) return { ...run, absorb: run.absorb.slice(1), nextSeq: run.nextSeq + 1 };
  const r: RunView = { ...run, absorb: [] };
  const next = ((): RunView => {
    switch (event._tag) {
      case "Started":
        return { ...r, project: event.project, location: event.location, task: event.task, mode: event.mode, item: event.item };
      case "Said":
        return event.text.trim() === "" ? r : withLeft(r, message(r, time, "program", event.text, "text"));
      case "Asked": {
        const extra = r.questionOptions;
        // Presented options belong to this prompt alone (P1-R1-2); an analysis waiting for its prompt gets this one.
        const analysis = r.analysis !== null && r.analysis.prompt === null ? { ...r.analysis, prompt: event.prompt } : r.analysis;
        const hint = pagePromptText(event.kind, event.text);
        return { ...r, pending: { asked: event, options: extra, choices: event.choices, question: r.presented?.question ?? null, presentedAt: r.presented?.time ?? time, hint }, questionOptions: [], presented: null, analysis, dismissed: null };
      }
      case "Answered": {
        const chosen = r.pending !== null && r.pending.asked.prompt === event.prompt ? [...r.pending.options, ...r.pending.choices].find((c) => c.sends === event.text) : undefined;
        const dismisses = r.analysis !== null && r.analysis.prompt === event.prompt;
        const analysis = dismisses ? null : r.analysis;
        const dismissed = dismisses ? r.analysis : r.dismissed;
        // S26: the question joins the transcript with its answer, as an ordinary exchange.
        const own = r.pending !== null && r.pending.asked.prompt === event.prompt ? r.pending : null;
        const asked = own === null ? r : own.question !== null ? withLeft(r, { ...message(r, own.presentedAt ?? time, "program", piecesText(own.question.question), "text"), key: `${r.id}-${r.nextSeq}-question`, question: own.question }) : withLeft(r, { ...message(r, own.presentedAt ?? time, "program", own.hint, "text"), key: `${r.id}-${r.nextSeq}-question` });
        return { ...withLeft(asked, message(asked, time, "user", chosen?.label ?? event.text, "markdown")), pending: r.pending?.asked.prompt === event.prompt ? null : r.pending, answered: [...r.answered, event.prompt], analysis, dismissed };
      }
      case "Notified":
        return notifiedEvent(r, event.event, time);
      case "Ended": {
        const ended: RunView = { ...r, ended: event.code, pending: null, activity: "", busy: false, calls: [], retry: null, limitWait: null, timeline: r.timeline.map((e) => (e.state === "active" ? recorded(endEntry(e, event.code, time), r.plan) : endEntry(e, event.code, time))) };
        return reshow(ended);
      }
    }
  })();
  return { ...next, nextSeq: run.nextSeq + 1 };
};

const foldRun = (id: number, events: readonly Stamped[]): RunView => events.reduce(foldEvent, emptyRun(id));

/** A notice for the user that the page itself produces (for example an action discarded after a reconnect). */
export const notice = (state: ViewState, text: string): ViewState => ({ ...state, notices: [...state.notices, text] });

/** A frame of the server the page could not read, the count-th in a row: one notice for a run of them (decision Q2). */
export const protocolError = (state: ViewState, reason: string, count: number): ViewState => (count === 1 ? notice(state, protocolErrorNotice(reason)) : state);
/** An answer not sent that could not go back to its field, kept for the user to copy (P1-R1-2). */
export const keepUnsent = (state: ViewState, text: string): ViewState => ({ ...state, unsent: [...state.unsent, text] });
/** The user dismisses one kept answer; the others stay. */
export const dismissUnsent = (state: ViewState, index: number): ViewState => ({ ...state, unsent: state.unsent.filter((_, i) => i !== index) });

/** The next state after a message of the server. Pure. */
export const reduce = (state: ViewState, message: ServerMessage): ViewState => {
  switch (message.type) {
    case "hello": {
      // Another start of the server: its run numbers restart, so the views of the earlier server's runs are dropped.
      const restarted = state.incarnation !== null && state.incarnation !== message.incarnation;
      const modes = Object.fromEntries(RUN_MODES.map((m) => [m, { ...state.modes[m], ...(restarted ? { run: null, last: null } : {}), current: message.current[m] }])) as Record<RunMode, ModeView>;
      return { ...state, modes, runModes: restarted ? {} : state.runModes, connection: "open", location: message.location, incarnation: message.incarnation, needsReconnect: false };
    }
    case "replay": {
      // Issue #87: each replayed run's shared state, held by the server beside its events. Issue #120: each run goes to the
      // mode its Started named, the newest of a mode its run and the one before it its last.
      const views = message.runs.map((r) => ({ ...foldRun(r.id, r.events), ui: message.ui.find((u) => u.run === r.id)?.state ?? emptyUiState })).sort((a, b) => a.id - b.id);
      const of = (mode: RunMode) => views.filter((v) => modeOfRun(v) === mode);
      const modes = Object.fromEntries(RUN_MODES.map((m) => [m, { ...state.modes[m], run: of(m).at(-1) ?? null, last: of(m).at(-2) ?? null }])) as Record<RunMode, ModeView>;
      const runModes = { ...state.runModes, ...Object.fromEntries(views.flatMap((v) => (v.mode === null ? [] : [[v.id, v.mode]]))) };
      return { ...state, modes, runModes };
    }
    case "items":
      return withMode(state, message.mode, (m) => ({ ...m, items: message.result, refusal: null }));
    case "refused":
      // Issue #120: a refusal goes to the tab whose action it was, whichever tab is shown; one of no mode is a notice.
      return message.mode === null ? notice(state, message.reason) : withMode(state, message.mode, (m) => ({ ...m, refusal: message.reason }));
    case "ui": {
      // Issue #87: the run's whole shared state; of two, the higher version stands, whatever their order of arrival.
      const apply = (view: RunView | null): RunView | null => (view !== null && view.id === message.run ? { ...view, ui: newer(view.ui, message.state) } : view);
      const mode = state.runModes[message.run];
      return mode === undefined ? state : withMode(state, mode, (m) => ({ ...m, run: apply(m.run), last: apply(m.last) }));
    }
    case "closing":
      // [visibility of system status] The socket's reconnection keeps trying; the page says why it is disconnected.
      // A failed page stays failed: it no longer reconnects, so it must not claim to.
      return notice({ ...state, connection: state.connection === "failed" ? "failed" : "reconnecting" }, SERVER_CLOSED_NOTICE);
    case "event": {
      // Issue #120: an event belongs to the mode its run's Started named.
      const mode = message.event._tag === "Started" ? message.event.mode : state.runModes[message.run];
      if (mode === undefined) return message.seq === 0 ? state : { ...state, needsReconnect: true };
      const tab = state.modes[mode];
      const current = message.event._tag === "Started" ? message.run : message.event._tag === "Ended" ? (tab.current === message.run ? null : tab.current) : tab.current;
      const runModes = message.event._tag === "Started" ? { ...state.runModes, [message.run]: mode } : state.runModes;
      const stamped = { time: message.time, event: message.event };
      if (tab.run !== null && message.run === tab.run.id) {
        if (message.seq !== tab.run.nextSeq) return { ...state, needsReconnect: true };
        return withMode({ ...state, runModes }, mode, (m) => ({ ...m, current, run: foldEvent(m.run!, stamped) }));
      }
      if (tab.run === null || message.run > tab.run.id) {
        if (message.seq !== 0) return { ...state, needsReconnect: true };
        // A run's Started clears its tab's refusal: the action it answers has succeeded.
        return withMode({ ...state, runModes }, mode, (m) => ({ ...m, current, last: m.run, run: foldEvent(emptyRun(message.run), stamped), refusal: message.event._tag === "Started" ? null : m.refusal }));
      }
      return state;
    }
  }
};

/** The one-line progress of a compact window: the active (or last) phase and its latest cycle (issue #14: no limit). */
export const progressOf = (run: RunView): string => {
  const entry = run.timeline[currentIndex(run.timeline)];
  if (entry === undefined) return progressLine(null, null);
  const latestCycle = (groups: readonly RoundGroup[]): string | null => {
    const rounds = groups[groups.length - 1]?.rounds ?? [];
    const latest = rounds[rounds.length - 1];
    return latest === undefined ? null : cycleLine(latest.round, null, null);
  };
  const step = entry.steps[currentStepIndex(entry.steps)];
  if (step === undefined) return progressLine(entry.label, latestCycle(entry.groups));
  // Issue #21: the active step, with its running review loop's latest cycle, or else its count.
  const running = step.groups.filter((g) => !g.done);
  const detail = running.length > 0 ? latestCycle(running) : step.count === null ? latestCycle(step.groups) : clarificationProgress(step.count.answered, step.count.total);
  return progressLine(stepOfPhase(entry.label, step.label), detail);
};

/** A wait whose start and end the program knows (issues #26 and #68): what a determinate indicator counts down. */
export type Countdown = Readonly<{ fromMs: number; untilMs: number }>;
/** A wait for a usage limit as the page holds it (issue #68). */
export type LimitWait = Countdown & Readonly<{ agent: "claude" | "codex"; limitType: string | null }>;

/**
 * A wait for a usage limit at an instant (issue #68): the percentage of it elapsed, 0 to 100 and never falling, and the
 * time remaining, none at or after its end. Pure: the component reads the clock.
 */
export const limitWaitView = (wait: Countdown, nowMs: number): Readonly<{ percent: number; remainingMs: number }> => {
  const span = wait.untilMs - wait.fromMs;
  const elapsed = Math.min(Math.max(nowMs - wait.fromMs, 0), span);
  return { percent: span <= 0 ? 100 : (elapsed / span) * 100, remainingMs: Math.max(wait.untilMs - nowMs, 0) };
};

/** A wait at an instant while it lasts, as `limitWaitView` gives it; null at and after its end, so nothing asserts a wait that is over. */
export const countdownView = (wait: Countdown, nowMs: number): Readonly<{ percent: number; remainingMs: number }> | null => (nowMs >= wait.untilMs ? null : limitWaitView(wait, nowMs));
