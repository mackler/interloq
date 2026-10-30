import { PREPARATION_VIEW_OFF, type PreparationStatus, type PreparationView } from "../../src/preparationSwitch.ts";
import type { ListedItem } from "../../src/protocol.ts";
import fc from "fast-check";
import type { SubjectId } from "../../src/artifacts.ts";
import { shownOf } from "./test-setup.ts";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { chainSettingsOf, decodeServer, type RunEvent, type ServerMessage, type Stamped } from "../../src/protocol.ts";
import { foreseenPhases, iterationsOf, type Phase, phaseName, type UiEvent } from "../../src/uiEvents.ts";
/** The phases of a run of Gather Requirements followed by planning, as runs had them before issue #120 separated the modes. */
const phasesOf = (questions: boolean, iterations: number): readonly Phase[] => [...(questions ? foreseenPhases("refinement", iterationsOf(1)) : []), ...foreseenPhases("implementation", iterationsOf(iterations))];
import { emptyUiState, type UiFlag, type UiScope, withFlag } from "../../src/uiState.ts";
import { conditionOf, type Disclosure, disclosureStateOf, type NodeView, PLAIN, railView, stageGlyph } from "./rail.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { attachedOf, type PresentedQuestion, shownExplanations } from "../../src/question.ts";
import { Result } from "effect";
import { piecesText, plainBlocks, plainPieces } from "../../src/pieces.ts";
import { RUN_MODES, type RunMode } from "../../src/runMode.ts";
import { refreshSent, shownMark, abandonedInChain, closeRun, focusList, focusRun, modeWaiting, presented, refinementInProgress, runTabs, startableOf, startRequested, shownRun, emptyDashboard, lastAnswer, type RunView, statusText, chainSent, chainShown, chainUnsent, chooseTerms, shownTerms, type ItemsView as ItemsViewOf, itemsRequested, selectMode, bandKey, countdownView, emptyRun, type TimelineEntry, limitWaitView, type ShownPlan, shownPlan, type Band, bandsOf, callStartedAt, currentPlanStep, dismissUnsent, executing, initialState, keepUnsent, planStepState, progressOf, protocolError, reduce, showsTime, type ViewState } from "./state.ts";
import { helloChain } from "./testChain.ts";
import { begun, type ChainState, configured, ended, OFF_SETTINGS } from "../../src/chain.ts";
import type { ItemId } from "../../src/tracker.ts";

// Plan step 4.2: the page's reducer.
/** The run a mode's tab shows (issue #191: the implementation tab its newest run, the Refinement tab its focused run). */
const runOf = (s: ViewState, mode: RunMode): RunView | null => shownRun(s, mode).run;
/** The run before a mode's newest that the page holds. */
const lastOf = (s: ViewState, mode: RunMode): RunView | null => s.modes[mode].runs.at(-2) ?? null;
const hello = (current: number | null = 1): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: current }, incarnation: "a" });
const started: RunEvent = { _tag: "Started", project: "/p", location: "/p", task: "the task", mode: "implementation", item: { id: "1", title: "the task" } };
const said = (text: string): RunEvent => ({ _tag: "Said", text });
const notified = (event: UiEvent): RunEvent => ({ _tag: "Notified", event });
const asked = (prompt: number, text: string): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(text), countdown: null, deciding: null });
/** A question presented to the user (S5), with its options numbered as the run numbers them. */
const presentedEvent = (question: string, options: readonly { label: string; description: string }[], origin: PresentedQuestion["origin"] = { kind: "relayed" }): UiEvent => ({
  _tag: "QuestionPresented",
  question: { number: 1, origin, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: plainPieces(question), options: options.map((o, i) => ({ label: plainPieces(o.label), description: plainPieces(o.description), answer: { token: String(i + 1) } })), attached: null, decision: null },
});
const presentedOf = (event: UiEvent): PresentedQuestion => (event._tag === "QuestionPresented" ? event.question : (undefined as never));
/** The time of publication of an event: by default one second per seq from 14:00:00 UTC; `times` gives it in seconds. */
const BASE = Date.UTC(2026, 8, 27, 14, 0, 0);
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();
const stamp = (events: readonly RunEvent[], times?: readonly number[]): Stamped[] => events.map((event, seq) => ({ time: at(times?.[seq] ?? seq), event }));
/** The live messages of one run: hello, an empty replay, then the events with seq from 0. */
const live = (events: readonly RunEvent[], run = 1, times?: readonly number[]): ServerMessage[] => [hello(run), { type: "replay", ui: [], runs: [] }, ...stamp(events, times).map(({ time, event }, seq): ServerMessage => ({ type: "event", run, seq, time, event }))];
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const replayed = (events: readonly RunEvent[], run = 1, current: number | null = run, times?: readonly number[]): ViewState => fold([hello(current), { type: "replay", ui: [], runs: [{ id: run, events: stamp(events, times) }] }]);
/** A shown plan without its stages' rendering keys: the plan it shows. */
const bare = (p: ShownPlan | null) => (p === null ? null : { stages: p.stages.map(({ key: _key, ...st }) => st) });
/** The dashboard's status line of the implementation tab's run, as its text (issue #22). */
const statusOf = (s: ViewState | RunView | null | undefined): string | undefined => {
  const run = s === null || s === undefined ? undefined : "modes" in s ? runOf(s, "implementation") : s;
  return run === null || run === undefined ? undefined : statusText(run.dashboard.status);
};
/** The dashboard's latest message of Claude Code, and the last answer, of the implementation tab's run (issue #22). */
const claudeOf = (s: ViewState) => runOf(s, "implementation")?.dashboard.claude;
const lastAnswerOf = (s: ViewState) => {
  const d = runOf(s, "implementation")?.dashboard;
  return d === undefined ? undefined : lastAnswer(d);
};

describe("the dashboard (issue #22)", () => {
  test("a fresh run and a run after Started hold the empty dashboard", () => {
    expect(emptyRun(3).dashboard).toEqual(emptyDashboard);
    expect(runOf(fold(live([started])), "implementation")?.dashboard).toEqual(emptyDashboard);
    expect(emptyDashboard).toEqual({ models: { claude: null, codex: null }, status: { _tag: "Idle" }, claude: null, interviewHelp: null, answers: [] });
    expect(statusText(emptyDashboard.status)).toBe("");
    expect(lastAnswer(emptyDashboard)).toBe(null);
  });
});

describe("the status line (issue #22)", () => {
  const call = notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" });
  const tool = notified({ _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff", callId: "codex-1" });
  const phaseEnded = notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" });
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a Said sets the status and the next Said replaces it; its outer line breaks are removed", () => {
    for (const s of both([started, said("first")])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Interloq", text: "first" });
    for (const s of both([started, said("first"), said("\nHALTED: second\n")])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Interloq", text: "HALTED: second" });
  });

  test("a blank Said and an absorbed one change nothing", () => {
    for (const s of both([started, said("first"), said("  \n")])) expect(statusOf(s)).toBe("first");
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 });
    for (const s of both([started, said("first"), turn, said("\nHi\n")])) expect(statusOf(s)).toBe("first");
  });

  test("a tool use replaces Interloq's line, and Interloq's next line replaces the activity", () => {
    for (const s of both([started, said("first"), call, tool])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Activity", text: "Codex — review — command: git diff" });
    for (const s of both([started, call, tool, said("next")])) expect(statusOf(s)).toBe("next");
  });

  test("PhaseEnded keeps Interloq's line and turns an activity into Idle", () => {
    for (const s of both([started, call, said("kept"), phaseEnded])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Interloq", text: "kept" });
    for (const s of both([started, said("old"), call, tool, phaseEnded])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Idle" });
  });

  test("after Ended the run's last line of Interloq stays the status", () => {
    for (const s of both([started, call, said("Usage: Claude Code 3 calls"), { _tag: "Ended", code: 0 }])) expect(runOf(s, "implementation")?.dashboard.status).toEqual({ _tag: "Interloq", text: "Usage: Claude Code 3 calls" });
  });

  test("a retry's and a usage limit's wait give the status the activity line's text", () => {
    const retrying = notified({ _tag: "TransportRetrying", agent: "codex", purpose: "review", attempt: 1, of: 3, delaySeconds: 5, fault: "stream disconnected", fromMs: 0, untilMs: 5000 });
    for (const s of both([started, call, retrying])) expect(statusOf(s)).toBe("Codex — connection lost, retry 1 of 3 (stream disconnected)");
    const waiting = notified({ _tag: "UsageLimitWaiting", agent: "claude", purpose: "planning", limitType: "five_hour", basis: { kind: "reset" }, fromMs: 0, untilMs: 60_000 });
    for (const s of both([started, waiting])) expect(statusOf(s)).toBe(`Claude — ${prompts.usageLimitActivity("five_hour", { kind: "reset" }, 60_000)}`);
  });

  test("property: the status follows the last line or activity, and the replay folds as the live page does", () => {
    type Step = Readonly<{ _tag: "say"; text: string }> | Readonly<{ _tag: "tool"; target: string }> | Readonly<{ _tag: "start" }> | Readonly<{ _tag: "end" }> | Readonly<{ _tag: "phaseEnd" }>;
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ _tag: fc.constant("say" as const), text: fc.constantFrom("a", "b", "\nc\n", " ", "") }),
      fc.record({ _tag: fc.constant("tool" as const), target: fc.constantFrom("x", "y") }),
      fc.constant({ _tag: "start" as const }),
      fc.constant({ _tag: "end" as const }),
      fc.constant({ _tag: "phaseEnd" as const }),
    );
    const eventOf = (st: Step): RunEvent => {
      switch (st._tag) {
        case "say": return said(st.text);
        case "tool": return notified({ _tag: "ToolUsed", agent: "codex", tool: "Read", target: st.target, callId: "codex-1" });
        case "start": return call;
        case "end": return notified({ _tag: "AgentCallEnded", agent: "codex", ok: true, callId: "codex-1" });
        case "phaseEnd": return phaseEnded;
      }
    };
    fc.assert(fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      const events = [started, ...steps.map(eventOf)];
      // The reference: the activity text the page computed before the dashboard, and the last non-blank line.
      const model = steps.reduce<{ tag: "Idle" | "Activity" | "Interloq"; text: string; calls: number }>((m, st) => {
        switch (st._tag) {
          case "say": return st.text.trim() === "" ? m : { ...m, tag: "Interloq", text: st.text.replace(/^[\r\n]+|[\r\n]+$/g, "") };
          case "tool": return { ...m, tag: "Activity", text: `${m.calls > 0 ? "Codex — review" : "Codex"} — Read: ${st.target}` };
          case "start": return { tag: "Activity", text: "Codex — review", calls: m.calls + 1 };
          case "end": return m.calls === 0 ? m : { tag: "Activity", text: m.calls > 1 ? "Codex — review" : "Codex — review — done", calls: m.calls - 1 };
          case "phaseEnd": return { ...(m.tag === "Activity" ? { tag: "Idle" as const, text: "" } : m), calls: 0 };
        }
      }, { tag: "Idle", text: "", calls: 0 });
      const liveView = fold(live(events));
      expect(statusOf(liveView)).toBe(model.text);
      expect(runOf(liveView, "implementation")?.dashboard.status._tag).toBe(model.tag);
      expect(runOf(replayed(events), "implementation")?.dashboard).toEqual(runOf(liveView, "implementation")?.dashboard);
    }), { numRuns: 150 });
  });
});

describe("ordering and the panels", () => {
  test("Interloq's line is the status, a blank say changes nothing, and an answered prompt is no longer pending", () => {
    const s = fold(live([started, said("Planning phase 1 ..."), said("\n"), asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" }]));
    expect(statusOf(s)).toBe("Planning phase 1 ...");
    expect(runOf(s, "implementation")?.pending).toBe(null);
  });

  test("a pending prompt carries the catalog's choices; the question's options are apart (issue #12, S5)", () => {
    const decision = fold(live([started, asked(1, prompts.decisionPrompt)]));
    expect(runOf(decision, "implementation")?.pending?.choices.map((c) => c.label)).toEqual([prompts.CONTINUE_WITHOUT_DECIDING, prompts.END_RUN_LABEL]);
    expect(runOf(decision, "implementation")?.pending?.options).toEqual([]);
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?", summary: null, answered: 0, total: 1 };
    const interview = fold(live([started, notified(turn), said("\nWhich database?\n"), notified(presentedEvent("Which database?", [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }], { kind: "clarification", id: "Q1" })), asked(1, prompts.interviewMessagePrompt)]));
    expect(runOf(interview, "implementation")?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["PostgreSQL=1", "SQLite=2"]);
    expect(runOf(interview, "implementation")?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_CLARIFICATION}=/done`, `${prompts.END_RUN_LABEL}=/quit`]);
    const relayed = fold(live([started, notified(presentedEvent("A or B?", [{ label: "A", description: "a" }, { label: "B", description: "b" }])), asked(1, prompts.optionOrTextPrompt)]));
    expect(runOf(relayed, "implementation")?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A — a=1", "B — b=2"]);
    expect(runOf(relayed, "implementation")?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_RUN_LABEL}=q`]);
  });

  test("an answer to an interview shows the chosen option, or the fixed choice's label (issue #12, Q2)", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?", summary: null, answered: 0, total: 1 };
    const presented = presentedEvent("Which database?", [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }], { kind: "clarification", id: "Q1" });
    const answered = (text: string) => fold(live([started, notified(turn), notified(presented), asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text }]));
    expect(lastAnswerOf(answered("2"))?.answer).toBe("SQLite");
    expect(lastAnswerOf(answered("/done"))?.answer).toBe(prompts.END_CLARIFICATION);
  });

  test("an answer that is a choice shows the choice's label", () => {
    const permission: UiEvent = { _tag: "QuestionPresented", question: { ...presentedOf(presentedEvent("Allow?", [])), options: [{ label: plainPieces("Allow"), description: [], answer: { token: "y" } }, { label: plainPieces("Deny"), description: [], answer: { token: "n" } }] } };
    const s = fold(live([started, notified(permission), asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }]));
    expect(lastAnswerOf(s)?.answer).toBe("Allow");
  });

  test("an interview turn and a proposed summary are Claude's latest message in turn, and the lines said for them are absorbed", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null, answered: 0, total: 1 };
    const summary: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R", answered: 0, total: 1 };
    const first: RunEvent[] = [started, notified(turn), said("\nHello\n")];
    for (const s of [fold(live(first)), replayed(first)]) expect(claudeOf(s)).toEqual({ heading: "Interview", body: "Hello" });
    const events: RunEvent[] = [...first, notified(summary), said("\nDone.\n"), said("Summary proposed by Claude Code:\n\n# R\n"), said("\nHello\n")];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(claudeOf(s)).toEqual({ heading: "Interview", body: `Done.\n\n**${prompts.SUMMARY_PROPOSED_HEADING}**\n\n# R` });
      // The line said after the absorbed ones is Interloq's, the status.
      expect(statusOf(s)).toBe("Hello");
    }
  });

  // Issue #46 (S19): a question of the plan writer reaches the user once, as its presented question; the plan's result
  // text is Claude Code's latest message, and the plan itself has its place in the rail.
  test("a plan write's result text is Claude Code's latest message under the plan's heading; an empty one changes nothing", () => {
    const events: RunEvent[] = [started, notified({ _tag: "PlanWritten", phase: 1, resultText: "I wrote the plan." })];
    for (const s of [fold(live(events)), replayed(events)]) {
      // Issue #6: the run holds one planning phase, so it carries no number.
      expect(claudeOf(s)).toEqual({ heading: prompts.planWrittenHeading("Planning"), body: "I wrote the plan." });
    }
    const claudeSaid = notified({ _tag: "ClaudeSaid", text: "before" });
    expect(claudeOf(fold(live([started, claudeSaid, notified({ _tag: "PlanWritten", phase: 1, resultText: "" })])))).toEqual({ heading: null, body: "before" });
  });

  test("reviews and responses go to the right panel as Codex and Claude Code messages", () => {
    const review = { issues: [{ id: "A", severity: "major" as const, location: "l", problem: "p", evidence: "e" }] };
    const response = { dispositions: [{ id: "A", action: "accepted" as const, rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
    const s = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 2, review, counted: 1 }), notified({ _tag: "ResponseReceived", subject: { plan: 1 }, round: 2, response, resultText: "" })]));
    expect(runOf(s, "implementation")?.right.map((m) => [m.author, m.heading])).toEqual([["codex", "Planning phase 1, cycle 2"], ["claude", "Planning phase 1, cycle 2"]]);
    expect(runOf(s, "implementation")?.right[0].body).toMatch(/\*\*\[A\]\*\*/);
    // The author is the message's; the body does not repeat it (aesthetic and minimalist design).
    expect(runOf(s, "implementation")?.right.map((m) => m.body)).not.toContainEqual(expect.stringMatching(/^### /));
    const none = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 3, review: { issues: [] }, counted: 0 })]));
    expect(runOf(none, "implementation")?.right[0].body).toBe("No issue: the review has converged.");
  });
});

// Issue #5: what Claude Code writes is attributed to Claude, as data; the page names it "Claude". Issue #22: it is the
// dashboard's latest message of Claude Code, replaced by the next.
describe("Claude Code's latest message and the answers on the dashboard (issue #22)", () => {
  const claudeSaid = (text: string) => notified({ _tag: "ClaudeSaid", text });
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("Claude's prose is Claude Code's latest message, without a prefix, and a newer one replaces it", () => {
    for (const s of both([started, claudeSaid("**done**")])) expect(claudeOf(s)).toEqual({ heading: null, body: "**done**" });
    for (const s of both([started, claudeSaid("first"), claudeSaid("second")])) expect(claudeOf(s)).toEqual({ heading: null, body: "second" });
    // Nothing of Claude Code's prose goes to the right panel.
    for (const s of both([started, claudeSaid("first")])) expect(runOf(s, "implementation")?.right).toEqual([]);
  });

  test("the activity line and the page's prompts say Claude", () => {
    const s = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-1" })]));
    expect(statusOf(s)).toBe("Claude — planning");
    const tool = fold(live([started, notified({ _tag: "ToolUsed", agent: "claude", tool: "Read", target: "x", callId: "claude-1" })]));
    expect(statusOf(tool)).toBe("Claude — Read: x");
  });

  test("a presented question is held with its options by the pending prompt, live and after a replay (S5, S26)", () => {
    const question: UiEvent = presentedEvent("A or **B**?", [{ label: "A", description: "a" }, { label: "B", description: "b" }]);
    const events: RunEvent[] = [started, notified(question), asked(1, prompts.optionOrTextPrompt)];
    for (const s of both(events)) {
      // S26: while pending, the question is the widget's; no answer is recorded yet.
      expect(runOf(s, "implementation")?.dashboard.answers).toEqual([]);
      expect(runOf(s, "implementation")?.pending?.question).toEqual(presentedOf(question));
      expect(runOf(s, "implementation")?.pending?.options.map((c) => c.sends)).toEqual(["1", "2"]);
    }
  });

  test("an answer records the question as it was presented, or the prompt's hint, or nothing for a prompt never pending here", () => {
    const question: UiEvent = presentedEvent("A or B?", [{ label: "A", description: "a" }, { label: "B", description: "b" }]);
    const withQuestion: RunEvent[] = [started, notified(question), asked(1, prompts.optionOrTextPrompt), { _tag: "Answered", prompt: 1, text: "use **x**" }];
    for (const s of both(withQuestion)) {
      expect(lastAnswerOf(s)).toEqual({ key: "1-3", asked: { _tag: "Question", question: presentedOf(question) }, answer: "use **x**" });
    }
    const withHint: RunEvent[] = [started, asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" }];
    for (const s of both(withHint)) {
      expect(lastAnswerOf(s)).toEqual({ key: "1-2", asked: { _tag: "Hint", hint: prompts.pagePromptText("decision", prompts.decisionPrompt) }, answer: prompts.CONTINUE_WITHOUT_DECIDING });
    }
    const notShown: RunEvent[] = [started, { _tag: "Answered", prompt: 4, text: "late" }];
    for (const s of both(notShown)) expect(lastAnswerOf(s)?.asked).toEqual({ _tag: "NotShown" });
  });

  test("the interview's help is shown from its opening until the review after it, a decision's rounds leaving it", () => {
    const opened = notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 });
    const help = prompts.interviewHelp("Interview");
    for (const s of both([started, opened])) expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(help);
    const decisionRound = notified({ _tag: "RoundBegan", subject: { decision: 1 }, round: 1, limit: 5 });
    for (const s of both([started, opened, decisionRound])) expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(help);
    const reviewRound = notified({ _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 });
    for (const s of both([started, opened, reviewRound])) expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(null);
    const phaseEnded = notified({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "done" });
    for (const s of both([started, opened, phaseEnded])) expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(null);
    for (const s of both([started, opened, { _tag: "Ended", code: 130 }])) expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(null);
  });

  test("ModelNamed sets the agent's model line, and a later model of that agent replaces it", () => {
    const named = (model: prompts.NamedModel) => notified({ _tag: "ModelNamed", model });
    const events: RunEvent[] = [started, named({ agent: "codex", name: null }), named({ agent: "claude", name: "a" }), named({ agent: "claude", name: "b" })];
    for (const s of both(events)) {
      expect(runOf(s, "implementation")?.dashboard.models).toEqual({ claude: prompts.modelLine({ agent: "claude", name: "b" }), codex: prompts.modelLine({ agent: "codex", name: null }) });
    }
  });

  test("property: the answers are the Answered events in order, lastAnswer the last, and the replay folds as the live page does", () => {
    type Step = Readonly<{ _tag: "answer"; text: string }> | Readonly<{ _tag: "ask" }> | Readonly<{ _tag: "claude"; text: string }> | Readonly<{ _tag: "turn"; text: string }> | Readonly<{ _tag: "open" }> | Readonly<{ _tag: "review" }> | Readonly<{ _tag: "model"; name: string }>;
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ _tag: fc.constant("answer" as const), text: fc.constantFrom("1", "x", "") }),
      fc.constant({ _tag: "ask" as const }),
      fc.record({ _tag: fc.constant("claude" as const), text: fc.constantFrom("a", "b") }),
      fc.record({ _tag: fc.constant("turn" as const), text: fc.constantFrom("t", "u") }),
      fc.constant({ _tag: "open" as const }),
      fc.constant({ _tag: "review" as const }),
      fc.record({ _tag: fc.constant("model" as const), name: fc.constantFrom("m", "n") }),
    );
    fc.assert(fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      const events: RunEvent[] = [started];
      let prompt = 0;
      for (const st of steps) {
        switch (st._tag) {
          case "answer": events.push({ _tag: "Answered", prompt, text: st.text }); break;
          case "ask": prompt += 1; events.push(asked(prompt, prompts.interviewMessagePrompt)); break;
          case "claude": events.push(claudeSaid(st.text)); break;
          case "turn": events.push(notified({ _tag: "InterviewTurn", heading: "I", message: st.text, summary: null, answered: 0, total: 1 })); break;
          case "open": events.push(notified({ _tag: "InterviewOpened", heading: "I", stage: "clarification", total: 1 })); break;
          case "review": events.push(notified({ _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 })); break;
          case "model": events.push(notified({ _tag: "ModelNamed", model: { agent: "claude", name: st.name } })); break;
        }
      }
      const liveView = fold(live(events));
      const answers = runOf(liveView, "implementation")?.dashboard.answers ?? [];
      expect(answers.map((e) => e.key)).toEqual(events.flatMap((e, seq) => (e._tag === "Answered" ? [`1-${seq}`] : [])));
      const d = runOf(liveView, "implementation")?.dashboard;
      expect(d === undefined ? null : lastAnswer(d)).toEqual(answers.at(-1) ?? null);
      expect(runOf(replayed(events), "implementation")?.dashboard).toEqual(d);
    }), { numRuns: 150 });
  });
});

// Plan step 4.7 (the review against the heuristics): the page states a prompt without the hint's key
// conventions, which the buttons replace [match between the system and the real world].
test("every prompt is shown in the page's words, without the hint's key conventions", () => {
  const texts = [prompts.decisionPrompt, prompts.limitPrompt, prompts.limitNoProceedPrompt, prompts.optionOrTextPrompt, prompts.permissionPrompt, prompts.interviewMessagePrompt];
  for (const text of texts) {
    const body = runOf(fold(live([started, asked(1, text)])), "implementation")?.pending?.hint ?? "";
    expect(body, text).not.toMatch(/>\s*$|\bq = quit|Enter =|= stop|p = /);
    expect(body.trim(), text).not.toBe("");
  }
  expect(runOf(fold(live([started, asked(1, "Something new > ")])), "implementation")?.pending?.hint).toBe("Something new");
});

describe("activity and timeline", () => {
  test("the activity line shows the last agent event and is cleared at the end of a phase", () => {
    const s1 = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" }), notified({ _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff", callId: "codex-1" })]));
    expect(statusOf(s1)).toBe("Codex — review — command: git diff");
    expect(runOf(s1, "implementation")?.busy).toBe(true);
    const s2 = fold([{ type: "event", run: 1, seq: 3, time: at(3), event: notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" }) }], s1);
    expect(statusOf(s2)).toBe("");
  });

  test("the activity line names a call's purpose in the user's words: clarification and implementation (issues #14, #21)", () => {
    const of = (purpose: string) => statusOf(fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose, callId: "claude-1" })])));
    expect(of("interview")).toBe("Claude — clarification");
    expect(of("execution")).toBe("Claude — implementation");
    expect(of("planning")).toBe("Claude — planning");
    expect(of("review")).toBe("Claude — review");
  });

  test("the question phase stays active through its review loops until PhaseEnded; each loop has its own group; replay agrees", () => {
    const q = { kind: "questions" as const };
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhaseBegan", phase: q }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 }),
      notified({ _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 }),
    ];
    const during = fold(live(events));
    const entry = runOf(during, "implementation")?.timeline[0];
    expect(entry?.state).toBe("active");
    expect(entry?.steps.flatMap((st) => st.groups.map((g) => [g.heading, g.done]))).toEqual([["Question review", true], ["Requirements review", false]]);
    const after = fold(live([...events, notified({ _tag: "LoopFinished", subject: "requirements", result: "converged" }), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })]));
    expect(runOf(after, "implementation")?.timeline[0].state).toBe("done");
    expect(runOf(replayed(events), "implementation")?.timeline).toEqual(runOf(during, "implementation")?.timeline);
  });

  test("phases appear in order with their rounds; an interrupted run stops the active phase", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 }), { _tag: "Ended", code: 130 }]));
    expect(runOf(s, "implementation")?.timeline.map((e) => [e.label, e.state])).toEqual([["Planning", "stopped"]]);
    expect(runOf(s, "implementation")?.timeline[0].groups[0].rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(runOf(s, "implementation")?.ended).toBe(130);
  });
});

// Issue #14 (Q1, Q2, G-R1-1): a review's counts and a response's corrections reach the timeline, and the loop's result.
describe("the cycles of a review loop in the timeline", () => {
  const plan = { plan: 1 };
  const issueOf = (id: string, severity: "major" | "minor" = "major") => ({ id, severity, location: "l", problem: "p", evidence: "e" });
  const disposition = (id: string, action: "accepted" | "partially_accepted" | "rejected" | "no_change_needed" | "clarification_requested") => ({ id, action, rationale: "r", duplicate_of: "", reverses: "" });
  const events: RunEvent[] = [
    started,
    notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }),
    notified({ _tag: "RoundBegan", subject: plan, round: 1, limit: 5 }),
    notified({ _tag: "ReviewReceived", subject: plan, round: 1, review: { issues: [issueOf("A"), issueOf("B"), issueOf("C", "minor")] }, counted: 2 }),
    notified({
      _tag: "ResponseReceived",
      subject: plan,
      round: 1,
      response: { dispositions: [disposition("A", "accepted"), disposition("B", "partially_accepted"), disposition("C", "rejected")], self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }, { id: "C", new_action: "accepted", explanation: "x" }], reviewer_feedback: "", questions_for_user: [] },
      resultText: "",
    }),
    notified({ _tag: "RoundBegan", subject: plan, round: 2, limit: 5 }),
  ];
  const groupOf = (s: ViewState) => runOf(s, "implementation")?.timeline[0].groups[0];

  test("a cycle carries the issues its review raised and the counted ones; a cycle without its review has none yet", () => {
    const s = fold(live(events));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, null, null]]);
    expect(groupOf(s)?.corrections).toBe(3);
    expect(groupOf(s)?.result).toBe(null);
    expect(runOf(replayed(events), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  test("LoopFinished records the loop's result; the corrections of every cycle are summed", () => {
    const finished = [...events, notified({ _tag: "ReviewReceived", subject: plan, round: 2, review: { issues: [] }, counted: 0 }), notified({ _tag: "LoopFinished", subject: plan, result: "converged" })];
    const s = fold(live(finished));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, 0, 0]]);
    expect([groupOf(s)?.result, groupOf(s)?.done, groupOf(s)?.corrections]).toEqual(["converged", true, 3]);
    expect(runOf(replayed(finished), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  // Issue #30 (P1-R2-2): a corrective turn's reply is a second ResponseReceived of the same round; it replaces the
  // round's contribution instead of adding to it.
  test("a second response of the same round replaces that round's corrections", () => {
    const response = (action: "accepted" | "rejected") => notified({ _tag: "ResponseReceived", subject: plan, round: 1, response: { dispositions: [disposition("A", action)], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" });
    const head = [started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: plan, round: 1, limit: 5 }), notified({ _tag: "ReviewReceived", subject: plan, round: 1, review: { issues: [issueOf("A")] }, counted: 1 })];
    for (const [second, expected] of [["accepted", 1], ["rejected", 0]] as const) {
      const all = [...head, response("accepted"), response(second)];
      expect(groupOf(fold(live(all)))?.corrections).toBe(expected);
      expect(groupOf(replayed(all))?.corrections).toBe(expected);
    }
  });

  test("property: any number of responses of one round leave the corrections of the last one", () => {
    const head = [started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: plan, round: 1, limit: 5 }), notified({ _tag: "ReviewReceived", subject: plan, round: 1, review: { issues: [issueOf("A"), issueOf("B")] }, counted: 2 })];
    const actionArb = fc.constantFrom("accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested" as const);
    const responseArb = fc.tuple(actionArb, actionArb).map(([a, b]) => notified({ _tag: "ResponseReceived", subject: plan, round: 1, response: { dispositions: [disposition("A", a), disposition("B", b)], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" }));
    fc.assert(
      fc.property(fc.array(responseArb, { minLength: 1, maxLength: 5 }), (responses) => {
        const lastOne = responses.at(-1)!;
        const expected = groupOf(fold(live([...head, lastOne])))?.corrections;
        expect(groupOf(fold(live([...head, ...responses])))?.corrections).toBe(expected);
        expect(groupOf(replayed([...head, ...responses]))?.corrections).toBe(expected);
      }),
    );
  });

  test("a work review that leaves for a revision keeps its count of corrections due, even 0", () => {
    const work = { work: 1 };
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "work", n: 1 } }), notified({ _tag: "RoundBegan", subject: work, round: 1, limit: 5 }), notified({ _tag: "ReviewReceived", subject: work, round: 1, review: { issues: [issueOf("W1-R1-1")] }, counted: 1 }), notified({ _tag: "LoopFinished", subject: work, result: "revise" })]));
    expect([groupOf(s)?.result, groupOf(s)?.corrections]).toEqual(["revise", 0]);
  });
});

// Issue #21 (Q5, Q6, Q7): Gather Requirements is one phase with its steps: Identify choices (issue #33), Clarification and any
// Follow-up clarification, each done, active or stopped, with its cycles and the clarification's count.
describe("the steps of Gather Requirements", () => {
  const q = { kind: "questions" as const };
  const turn = (answered: number, total: number, summary: string | null = null) => notified({ _tag: "InterviewTurn", heading: prompts.clarificationHeading("clarification"), message: "Hi", summary, answered, total });
  const opened = (stage: "clarification" | "followUp", total: number) => notified({ _tag: "InterviewOpened", heading: prompts.clarificationHeading("clarification"), stage, total });
  const round = (subject: "questions" | "requirements", n: number) => notified({ _tag: "RoundBegan", subject, round: n, limit: 5 });
  const finished = (subject: "questions" | "requirements") => notified({ _tag: "LoopFinished", subject, result: "converged" });
  const steps = (s: ViewState) => runOf(s, "implementation")?.timeline[0].steps.map((st) => [st.label, st.state, st.count === null ? null : `${st.count.answered}/${st.count.total}`, st.groups.map((g) => `${g.heading}:${g.rounds.map((c) => c.round).join(",")}`).join(";")]);
  const through = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("clarification", 7), turn(0, 7), turn(3, 7)];

  test("the question phase begins with its first step, which holds the question review's cycles", () => {
    const s = fold(live(through.slice(0, 3)));
    expect(steps(s)).toEqual([[prompts.stepLabel("formulate"), "active", null, "Question review:1"]]);
    expect(runOf(s, "implementation")?.timeline[0].groups).toEqual([]);
  });

  // S17: the explanations of the terms are a step of their own, between identifying the choices and the clarification,
  // which holds the terms review's cycles; the clarification then ends it.
  test("the terms review opens its own step after the first, with its cycles; the clarification ends it", () => {
    const terms = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), notified({ _tag: "RoundBegan", subject: "terms", round: 1, limit: 5 })];
    expect(steps(fold(live(terms)))).toEqual([
      [prompts.stepLabel("formulate"), "done", null, "Question review:1"],
      [prompts.stepLabel("terms"), "active", null, "Terms review:1"],
    ]);
    const clarified = fold(live([...terms, notified({ _tag: "LoopFinished", subject: "terms", result: "converged" }), opened("clarification", 2), turn(1, 2)]));
    expect(steps(clarified)?.map((st) => [st[0], st[1], st[2]])).toEqual([
      [prompts.stepLabel("formulate"), "done", null],
      [prompts.stepLabel("terms"), "done", null],
      [prompts.stepLabel("clarification"), "active", "1/2"],
    ]);
  });

  // Issue #142: terms written before the first question without a review open their step by TermsBegan; a review after it
  // adds its cycles to the same step.
  test("TermsBegan opens the terms step after the first; a terms review then adds its cycles to that one step", () => {
    const begun = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), notified({ _tag: "TermsBegan" })];
    expect(steps(fold(live(begun)))).toEqual([
      [prompts.stepLabel("formulate"), "done", null, "Question review:1"],
      [prompts.stepLabel("terms"), "active", null, ""],
    ]);
    expect(steps(fold(live([...begun, notified({ _tag: "RoundBegan", subject: "terms", round: 1, limit: 5 })])))).toEqual([
      [prompts.stepLabel("formulate"), "done", null, "Question review:1"],
      [prompts.stepLabel("terms"), "active", null, "Terms review:1"],
    ]);
  });

  // Issue #113, the seam: the heading above the conversation and the rail's step name one activity, from one source.
  test("the conversation's heading and the rail's step name one activity, User Decisions", () => {
    const heading = prompts.clarificationHeading("clarification");
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: q }), notified({ _tag: "InterviewOpened", heading, stage: "clarification", total: 1 })]));
    const step = runOf(s, "implementation")?.timeline[0].steps.find((st) => st.kind === "clarification");
    expect([heading, step?.label]).toEqual([prompts.USER_DECISIONS, prompts.USER_DECISIONS]);
  });

  test("InterviewOpened ends the first step and opens Clarification with its total; each turn updates the count", () => {
    const s = fold(live(through));
    expect(steps(s)).toEqual([[prompts.stepLabel("formulate"), "done", null, "Question review:1"], [prompts.stepLabel("clarification"), "active", "3/7", ""]]);
    expect(runOf(replayed(through), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  // Issue #184: Interloq counts the answers as they are given, between Claude Code's replies.
  test("InterviewCounted sets the clarification's count, adds no message and leaves the pending prompt", () => {
    const counted = (answered: number, total: number) => notified({ _tag: "InterviewCounted", answered, total });
    const base = [...through, asked(1, prompts.interviewMessagePrompt)];
    const before = fold(live(base));
    const s = fold(live([...base, counted(4, 7)]));
    expect(steps(s)?.at(-1)).toEqual([prompts.stepLabel("clarification"), "active", "4/7", ""]);
    expect(runOf(s, "implementation")?.dashboard).toEqual(runOf(before, "implementation")?.dashboard);
    expect(runOf(s, "implementation")?.pending?.asked.prompt).toBe(1);
    const followUp = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 2), counted(1, 2)];
    expect(steps(fold(live(followUp)))?.at(-1)).toEqual([prompts.stepLabel("clarification"), "active", "8/9", "Requirements review:1"]);
  });

  test("a pending prompt survives a call that starts and ends after it (the interview's request beside a question)", () => {
    const s = fold(live([...through, asked(1, prompts.interviewMessagePrompt), notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "interview", callId: "claude-1" }), notified({ _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-1" })]));
    expect(runOf(s, "implementation")?.pending?.asked.prompt).toBe(1);
  });

  // Issue #51 (Q4): the follow-up clarifications are one conversation with the clarification, so they fold into its
  // step: the counts are summed, and the requirements review is one group of cycles under it.
  test("a follow-up clarification folds into the Clarification step: counts summed, one group of the requirements review", () => {
    const followUp = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 2)];
    expect(steps(fold(live(followUp)))?.at(-1)).toEqual([prompts.stepLabel("clarification"), "active", "7/9", "Requirements review:1"]);
    expect(steps(fold(live([...followUp, turn(1, 2)])))?.at(-1)).toEqual([prompts.stepLabel("clarification"), "active", "8/9", "Requirements review:1"]);
    const events = [...followUp, turn(1, 2), turn(2, 2, "# R2"), round("requirements", 2), finished("requirements"), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })];
    const s = fold(live(events));
    expect(steps(s)).toEqual([
      [prompts.stepLabel("formulate"), "done", null, "Question review:1"],
      [prompts.stepLabel("clarification"), "done", "9/9", "Requirements review:1,2"],
    ]);
    expect(runOf(s, "implementation")?.timeline[0].steps[1].groups.length).toBe(1);
    expect(runOf(s, "implementation")?.timeline[0].steps[1].groups[0].result).toBe("converged");
    expect(runOf(s, "implementation")?.timeline[0].state).toBe("done");
    expect(runOf(replayed(events), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  test("every further follow-up folds in the same way", () => {
    const events = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 1), turn(1, 1, "# R2"), round("requirements", 2), opened("followUp", 3), turn(2, 3), round("requirements", 3), finished("requirements")];
    const s = fold(live(events));
    expect(steps(s)?.map((st) => st[0])).toEqual([prompts.stepLabel("formulate"), prompts.stepLabel("clarification")]);
    expect(steps(s)?.at(-1)).toEqual([prompts.stepLabel("clarification"), "active", "10/11", "Requirements review:1,2,3"]);
    expect(runOf(replayed(events), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  test("a run that ends during a clarification stops that step with its phase; the earlier steps stay done", () => {
    const events = [...through, { _tag: "Ended", code: 130 } as RunEvent];
    const s = fold(live(events));
    expect(runOf(s, "implementation")?.timeline[0].state).toBe("stopped");
    expect(steps(s)?.map((st) => st[1])).toEqual(["done", "stopped"]);
    expect(runOf(replayed(events), "implementation")?.timeline).toEqual(runOf(s, "implementation")?.timeline);
  });

  test("the other phases have no steps", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } })]));
    expect(runOf(s, "implementation")?.timeline[0].steps).toEqual([]);
  });

  test("the compact progress line names the active step and its count, or its latest cycle", () => {
    expect(progressOf(runOf(fold(live(through)), "implementation")!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("clarification")), prompts.clarificationProgress(3, 7)));
    expect(progressOf(runOf(fold(live(through.slice(0, 3))), "implementation")!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("formulate")), "cycle 1"));
    expect(progressOf(runOf(fold(live([...through, turn(7, 7, "# R"), round("requirements", 1)])), "implementation")!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("clarification")), "cycle 1"));
  });
});

// Issue #14: the compact window's progress line names the latest cycle, without a limit.
describe("the compact progress line", () => {
  test("the active phase and its latest cycle; none before any phase", () => {
    const planning = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 })]));
    expect(progressOf(runOf(planning, "implementation")!)).toBe("Progress: Planning, cycle 2");
    expect(progressOf(runOf(fold(live([started])), "implementation")!)).toBe("Progress: no phase has begun");
    const execution = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } })]));
    expect(progressOf(runOf(execution, "implementation")!)).toBe("Progress: Implementation");
  });
});

describe("runs, replay and gaps", () => {
  test("a seq that does not follow sets the reconnect flag; a new run's Started at seq 0 after Ended is not a gap", () => {
    const one = fold(live([started, { _tag: "Ended", code: 0 }]));
    expect(one.needsReconnect).toBe(false);
    const two = fold([{ type: "event", run: 2, seq: 0, time: at(0), event: started }], one);
    expect(two.needsReconnect).toBe(false);
    expect([runOf(two, "implementation")?.id, lastOf(two, "implementation")?.id]).toEqual([2, 1]);
    const gap = fold([{ type: "event", run: 2, seq: 5, time: at(5), event: said("x") }], two);
    expect(gap.needsReconnect).toBe(true);
    const badStart = fold([{ type: "event", run: 3, seq: 4, time: at(4), event: started }], two);
    expect(badStart.needsReconnect).toBe(true);
  });

  // Issue #120: a refusal goes to the tab whose action it was, whichever tab is shown; one of no mode is a notice.
  test("a refusal of a mode goes to that mode's tab alone, whichever tab is shown; one of no mode becomes a notice", () => {
    const shown = selectMode(fold([hello(null)]), "implementation");
    const s = fold([{ type: "refused", mode: "refinement", reason: "a refinement run is in progress" }], shown);
    expect([s.modes.refinement.refusal, s.modes.implementation.refusal, s.notices]).toEqual(["a refinement run is in progress", null, []]);
    expect(s.connection).toBe("open");
    const none = fold([{ type: "refused", mode: null, reason: "not a message" }], s);
    expect(none.notices).toEqual(["not a message"]);
    expect(none.modes.refinement.refusal).toBe("a refinement run is in progress");
  });

  test("a hello turns a mode's Loading items Unasked and leaves a listed mode as it is (S16)", () => {
    const items = [{ id: "120", title: "Two modes", excerpt: "Make the page two tabs.", url: null, sentBack: 0, preparation: null }];
    const listed = fold([hello(null), { type: "items", mode: "refinement", result: { _tag: "Listed", items, terms: "unchecked" } }]);
    const s = fold([hello(null)], itemsRequested(listed, "implementation"));
    expect(s.modes.implementation.items).toEqual({ _tag: "Unasked" });
    expect(s.modes.refinement.items).toEqual({ _tag: "Listed", items, terms: "unchecked" });
  });

  // W3-R1-1 of work review 3: a tracker id of one server names nothing in another, which may serve another project.
  const helloAt = (location: string, incarnation: string): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location, current: { refinement: [], implementation: null }, incarnation });
  const listedItems = [{ id: "120", title: "Two modes", excerpt: "Make the page two tabs.", url: null, sentBack: 0, preparation: null }];

  test("a hello of another incarnation drops a listed mode's items, so the tab asks the new server (W3-R1-1)", () => {
    const s = fold([helloAt("/projects/old", "a"), { type: "items", mode: "refinement", result: { _tag: "Listed", items: listedItems, terms: "unchecked" } }, helloAt("/projects/new", "b")]);
    expect(s.modes.refinement.items).toEqual({ _tag: "Unasked" });
    expect(s.location).toBe("/projects/new");
  });

  test("a hello of another incarnation drops a mode's tracker notice (W3-R1-1)", () => {
    const s = fold([helloAt("/projects/old", "a"), { type: "items", mode: "implementation", result: { _tag: "Unavailable", notice: "no tracker" } }, helloAt("/projects/new", "b")]);
    expect(s.modes.implementation.items).toEqual({ _tag: "Unasked" });
  });

  test("a hello of another incarnation drops a mode's refusal (W3-R1-1)", () => {
    const s = fold([helloAt("/projects/old", "a"), { type: "refused", mode: "implementation", reason: "a refinement run is in progress" }, helloAt("/projects/new", "b")]);
    expect(s.modes.implementation.refusal).toBeNull();
  });

  test("a hello of the same incarnation, a reconnection, keeps the items, the notice and the refusal (W3-R1-1)", () => {
    const before = fold([
      helloAt("/p", "a"),
      { type: "items", mode: "refinement", result: { _tag: "Listed", items: listedItems, terms: "unchecked" } },
      { type: "items", mode: "implementation", result: { _tag: "Unavailable", notice: "no tracker" } },
      { type: "refused", mode: "implementation", reason: "r" },
    ]);
    const s = fold([helloAt("/p", "a")], before);
    expect([s.modes.refinement.items, s.modes.implementation.items, s.modes.implementation.refusal]).toEqual([{ _tag: "Listed", items: listedItems, terms: "unchecked" }, { _tag: "Unavailable", notice: "no tracker" }, "r"]);
  });

  // Each listed item's id names the incarnation it was received under, so a read under another one is visible.
  type Step = Readonly<{ k: "hello"; incarnation: string }> | Readonly<{ k: "listed"; mode: RunMode; count: number }> | Readonly<{ k: "unavailable"; mode: RunMode }> | Readonly<{ k: "refused"; mode: RunMode }> | Readonly<{ k: "request"; mode: RunMode }>;
  const modeArb = fc.constantFrom<RunMode>("refinement", "implementation");
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.constantFrom("a", "b", "c").map((incarnation): Step => ({ k: "hello", incarnation })),
    fc.record({ mode: modeArb, count: fc.integer({ min: 0, max: 2 }) }).map(({ mode, count }): Step => ({ k: "listed", mode, count })),
    modeArb.map((mode): Step => ({ k: "unavailable", mode })),
    modeArb.map((mode): Step => ({ k: "refused", mode })),
    modeArb.map((mode): Step => ({ k: "request", mode })),
  );
  const applyStep = (state: ViewState, step: Step): ViewState => {
    switch (step.k) {
      case "hello":
        return reduce(state, helloAt(`/projects/${step.incarnation}`, step.incarnation));
      case "listed":
      {
        const items = Array.from({ length: step.count }, (_, n) => ({ id: `${state.incarnation}:${n}`, title: "t", excerpt: "e", url: null, sentBack: 0, preparation: null }));
        return reduce(state, step.mode === "refinement" ? { type: "items", mode: step.mode, result: { _tag: "Listed", items, terms: "unchecked" } } : { type: "items", mode: step.mode, result: { _tag: "Listed", items } });
      }
      case "unavailable":
        return reduce(state, step.mode === "refinement" ? { type: "items", mode: step.mode, result: { _tag: "Unavailable", notice: `${state.incarnation}` } } : { type: "items", mode: step.mode, result: { _tag: "Unavailable", notice: `${state.incarnation}` } });
      case "refused":
        return reduce(state, { type: "refused", mode: step.mode, reason: "r" });
      case "request":
        return itemsRequested(state, step.mode);
    }
  };
  test("property: no listed item received under one incarnation is readable under another (W3-R1-1)", () => {
    fc.assert(
      fc.property(fc.constantFrom("a", "b", "c"), fc.array(stepArb, { minLength: 1, maxLength: 20 }), (first, steps) => {
        steps.reduce((state, step) => {
          const next = applyStep(state, step);
          for (const m of RUN_MODES) {
            const items = next.modes[m].items;
            if (items._tag === "Listed") expect(items.items.every((i) => i.id.startsWith(`${next.incarnation}:`))).toBe(true);
            if (items._tag === "Unavailable") expect(items.notice).toBe(next.incarnation);
            if (state.incarnation !== next.incarnation) expect([items, next.modes[m].refusal]).toEqual([{ _tag: "Unasked" }, null]);
          }
          return next;
        }, applyStep(initialState, { k: "hello", incarnation: first }));
      }),
      { numRuns: 200 },
    );
  });

  test("after any hello, no mode's items is Loading (S16)", () => {
    const itemsArb = fc.constantFrom<ItemsViewOf>({ _tag: "Unasked" }, { _tag: "Loading" }, { _tag: "Listed", items: [] }, { _tag: "Unavailable", notice: "n" });
    fc.assert(
      fc.property(itemsArb, itemsArb, fc.constantFrom("a", "b"), (r, i, incarnation) => {
        const base = fold([hello(null)]);
        const state: ViewState = { ...base, modes: { refinement: { ...base.modes.refinement, items: r }, implementation: { ...base.modes.implementation, items: i } } };
        const s = reduce(state, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation });
        expect([s.modes.refinement.items._tag, s.modes.implementation.items._tag]).not.toContain("Loading");
      }),
      { numRuns: 50 },
    );
  });

  test("an items frame sets its mode's items alone and clears its refusal; a request shows the tab loading", () => {
    const items = [{ id: "120", title: "Two modes", excerpt: "Make the page two tabs.", url: null, sentBack: 0, preparation: null }];
    const loading = itemsRequested(fold([hello(null), { type: "refused", mode: "implementation", reason: "r" }]), "implementation");
    expect(loading.modes.implementation.items).toEqual({ _tag: "Loading" });
    const s = fold([{ type: "items", mode: "implementation", result: { _tag: "Listed", items } }], loading);
    expect([s.modes.implementation.items, s.modes.implementation.refusal, s.modes.refinement.items]).toEqual([{ _tag: "Listed", items }, null, { _tag: "Unasked" }]);
    const unavailable = fold([{ type: "items", mode: "refinement", result: { _tag: "Unavailable", notice: "no tracker" } }], s);
    expect(unavailable.modes.refinement.items).toEqual({ _tag: "Unavailable", notice: "no tracker" });
    expect(unavailable.modes.implementation.items).toEqual({ _tag: "Listed", items });
  });

  const tagged = <T extends RunEvent["_tag"]>(tag: T) => fc.constant(tag);
  const eventArb: fc.Arbitrary<RunEvent> = fc.oneof(
    fc.string({ maxLength: 8 }).map(said),
    fc.constant(notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 })),
    tagged("Asked").chain(() => fc.constantFrom(prompts.permissionPrompt, prompts.interviewMessagePrompt, prompts.decisionPrompt).map((t) => asked(1, t))),
    fc.constantFrom("", "y", "2").map((text): RunEvent => ({ _tag: "Answered", prompt: 1, text })),
    fc.constantFrom<UiEvent>(
      { _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } },
      { _tag: "PhaseBegan", phase: { kind: "questions" } },
      { _tag: "InterviewOpened", heading: prompts.clarificationHeading("clarification"), stage: "clarification", total: 2 },
      { _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 },
      { _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }, counted: 1 },
      { _tag: "ResponseReceived", subject: { plan: 1 }, round: 1, response: { dispositions: [{ id: "A", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" },
      { _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" },
      { _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 },
      { _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-1" },
      { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "a", callId: "claude-1" },
      // Issue #6: the phases ahead, the plan, and nested calls.
      { _tag: "PhasesForeseen", phases: phasesOf(true, 1) },
      { _tag: "PhasesForeseen", phases: phasesOf(true, 2) },
      { _tag: "PlanChanged", phase: 1, plan: { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "x", status: "started" }] }] }, step: null },
      { _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } },
      { _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-1" },
    ).map(notified),
    fc.constant(said("\nHi\n")),
  );
  // Issue #1: each event with a time, a gap of 0 to 300 s after the one before, so that the grouping of both panels is
  // covered by the property too.
  const timed = (events: readonly RunEvent[], gaps: readonly number[]): Stamped[] =>
    events.map((event, i) => ({ time: at(gaps.slice(0, i + 1).reduce((sum, g) => sum + g, 0)), event }));
  const gapsArb = fc.array(fc.nat({ max: 300 }), { minLength: 14, maxLength: 14 });
  test("property: the replay of two runs equals their incremental folding", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 12 }), fc.array(eventArb, { maxLength: 12 }), gapsArb, gapsArb, (a, b, gapsA, gapsB) => {
        const first = timed([started, ...a, { _tag: "Ended", code: 0 }], gapsA);
        const second = timed([started, ...b], gapsB);
        const incremental = fold([hello(null), { type: "replay", ui: [], runs: [] }, ...first.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 1, seq, time, event })), ...second.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 2, seq, time, event }))]);
        const replay = fold([hello(2), { type: "replay", ui: [], runs: [{ id: 1, events: first }, { id: 2, events: second }] }]);
        expect(runOf(replay, "implementation")).toEqual(runOf(incremental, "implementation"));
        expect(lastOf(replay, "implementation")).toEqual(lastOf(incremental, "implementation"));
        expect(incremental.needsReconnect).toBe(false);
        // Every phase that began has ended by Ended(0), and has retired the steps it never began.
        expect(lastOf(incremental, "implementation")?.timeline.filter((e) => e.state !== "ahead").flatMap((e) => e.steps.filter((st) => st.state === "ahead"))).toEqual([]);
      }),
      // A phase that began and a step of it that never did, always among the cases rather than only when drawn.
      { examples: [[[notified({ _tag: "PhasesForeseen", phases: phasesOf(true, 1) }), notified({ _tag: "PhaseBegan", phase: { kind: "questions" } })], [], Array(14).fill(0), Array(14).fill(0)]] },
    );
  });
});

// Finding 12 of docs/gui-review.md: a hello from another incarnation clears the view of the earlier server's runs.
describe("a server restart", () => {
  test("a hello with a new incarnation clears the old run's view; the same incarnation keeps it", () => {
    const withRun = reduce(reduce(initialState, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/w", current: { refinement: [], implementation: 3 }, incarnation: "a" }), { type: "replay", ui: [], runs: [{ id: 3, events: [{ time: at(0), event: started }] }] });
    expect(runOf(withRun, "implementation")?.id).toBe(3);
    expect(withRun.incarnation).toBe("a");
    expect(runOf(reduce(withRun, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/w", current: { refinement: [], implementation: 3 }, incarnation: "a" }), "implementation")?.id).toBe(3);
    const restarted = reduce(withRun, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/w", current: { refinement: [], implementation: null }, incarnation: "b" });
    expect([runOf(restarted, "implementation"), lastOf(restarted, "implementation"), restarted.incarnation]).toEqual([null, null, "b"]);
    const next = reduce(restarted, { type: "event", run: 1, seq: 0, time: at(0), event: { ...started, task: "u" } as RunEvent });
    expect(runOf(next, "implementation")?.id).toBe(1);
  });
});

// Finding 15 of docs/gui-review.md: the server tells the page that it is ending.
describe("the server closing", () => {
  test("closing sets the connection to reconnecting and says so", () => {
    const next = reduce(reduce(initialState, hello()), { type: "closing" });
    expect(next.connection).toBe("reconnecting");
    expect(next.notices.at(-1)).toBe(prompts.SERVER_CLOSED_NOTICE);
  });
});

// Finding 5 of docs/gui-review.md: the view keeps the prompts that were answered, live and after a replay alike.
describe("answered prompts", () => {
  test("answered lists the prompts of the Answered events in order, equal between the live fold and the replay", () => {
    const events: RunEvent[] = [started, asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" }, asked(2, prompts.decisionPrompt), { _tag: "Answered", prompt: 2, text: "a" }, asked(3, prompts.decisionPrompt)];
    const liveRun = runOf(fold(live(events)), "implementation");
    expect(liveRun?.answered).toEqual([1, 2]);
    expect(runOf(replayed(events), "implementation")?.answered).toEqual(liveRun?.answered);
  });
});

// Finding 8 of docs/gui-review.md: the page renders the interview's help without a """ convention.
describe("the interview's opening help", () => {
  test("the dashboard's help names /done, /quit and Shift+Enter, and has no triple quotes", () => {
    const s = fold(live([started, notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 })]));
    const body = runOf(s, "implementation")?.dashboard.interviewHelp ?? "";
    expect(body).toBe(prompts.interviewHelp("Interview"));
    expect(body).toMatch(/Shift\+Enter/);
    expect(body).toMatch(/\/done/);
    expect(body).not.toMatch(/"""/);
  });
});

// Defect B of docs/page-question-phase-defects.md: one notice per run of frames the page could not read (Q2), a failed
// page that stays failed, and the answers not sent kept apart from the notices (P1-R1-2).
describe("a frame the page could not read", () => {
  test("the first of a run adds the notice with its reason; the second and third add none", () => {
    const s = [1, 2, 3].reduce((acc, n) => protocolError(acc, `reason ${n}`, n), fold([hello()]));
    expect(s.notices).toEqual([prompts.protocolErrorNotice("reason 1")]);
    const long = protocolError(initialState, "z".repeat(500), 1);
    expect(long.notices[0].endsWith(`${"z".repeat(200)}…`)).toBe(true);
  });

  test("the server's closing does not turn a failed page into a reconnecting one", () => {
    const next = reduce({ ...fold([hello()]), connection: "failed" }, { type: "closing" });
    expect(next.connection).toBe("failed");
  });

  test("the answers not sent are kept in order, and one is dismissed alone", () => {
    const s = keepUnsent(keepUnsent(initialState, "A"), "C");
    expect(s.unsent).toEqual(["A", "C"]);
    expect(dismissUnsent(s, 0).unsent).toEqual(["C"]);
    expect(dismissUnsent(s, 1).unsent).toEqual(["A"]);
    expect(initialState.unsent).toEqual([]);
  });
});

// The scenario whose absence let defect A of docs/page-question-phase-defects.md through: a replay, as the server sends
// it, of a question phase with a review, Claude Code's response with the amended list, and the interview's first turn.
describe("a replay of a question phase", () => {
  test("decoded as the socket decodes it, it yields the right panel, the dashboard and the pending interview prompt", () => {
    const events: RunEvent[] = [
      started,
      // Issue #22: the model named as the run names it, encoded with the protocol's schema below.
      notified({ _tag: "ModelNamed", model: { agent: "codex", name: null } }),
      notified({ _tag: "PhaseBegan", phase: { kind: "questions" } }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "ReviewReceived", subject: "questions", round: 1, review: { issues: [{ id: "Q-R1-1", severity: "major", location: "Q1", problem: "The list does not ask for the database.", evidence: "e" }] }, counted: 1 }),
      notified({
        _tag: "ResponseReceived",
        subject: "questions",
        round: 1,
        response: {
          dispositions: [{ id: "Q-R1-1", action: "accepted", rationale: "Added the database question.", duplicate_of: "", reverses: "", task_dispute: false }],
          self_corrections: [],
          reviewer_feedback: "",
          questions_for_user: [],
          questions: [{ id: "Q1", context: plainBlocks("c"), history: [], question: plainPieces("Which database?"), reason: plainBlocks("r"), proposed_answers: [{ label: plainPieces("PostgreSQL"), description: plainPieces("p") }, { label: plainPieces("SQLite"), description: plainPieces("s") }], default_answer: "PostgreSQL", skip_if: null }],
        },
        resultText: "",
      }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Which database should the service use?\n1. PostgreSQL\n2. SQLite", summary: null, answered: 0, total: 1 }),
      said("\nWhich database should the service use?\n1. PostgreSQL\n2. SQLite\n"),
      notified(presentedEvent("Which database should the service use?", [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }], { kind: "clarification", id: "Q1" })),
      asked(1, prompts.interviewMessagePrompt),
    ];
    const frames = [JSON.stringify(hello()), JSON.stringify({ type: "replay", ui: [], runs: [{ id: 1, events: stamp(events) }] })];
    const messages = frames.map((f) => {
      const d = decodeServer(f);
      if (d._tag !== "Success") throw new Error(`not decoded: ${d.failure}`);
      return d.success;
    });
    const s = fold(messages);
    const right = runOf(s, "implementation")?.right.map((m) => `${m.author}:${m.body}`) ?? [];
    expect(right.length).toBe(2);
    expect(right[0]).toMatch(/^codex:.*The list does not ask for the database\./s);
    expect(right[1]).toMatch(/^claude:.*\[Q-R1-1\]\*\* accepted: Added the database question\./s);
    expect(runOf(s, "implementation")?.dashboard.interviewHelp).toBe(prompts.interviewHelp("Interview"));
    expect(claudeOf(s)).toEqual({ heading: "Interview", body: "Which database should the service use?\n1. PostgreSQL\n2. SQLite" });
    expect(runOf(s, "implementation")?.dashboard.models).toEqual({ claude: null, codex: prompts.modelLine({ agent: "codex", name: null }) });
    expect(runOf(s, "implementation")?.pending?.asked.kind).toBe("interviewMessage");
    expect(runOf(s, "implementation")?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["PostgreSQL=1", "SQLite=2"]);
    expect(runOf(s, "implementation")?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_CLARIFICATION}=/done`, `${prompts.END_RUN_LABEL}=/quit`]);
  });
});

// Issue #1: each message carries the time its event was published; a time is shown when the author changes or more
// than 2 minutes lie between a message and the one before it in the panel (decision Q3). Issue #22: the dashboard has
// no timed list, so this is the "Claude and Codex" panel's.
describe("the time of a message", () => {
  const review = notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 });
  const response = notified({ _tag: "ResponseReceived", subject: { plan: 1 }, round: 1, response: { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" });
  const shown = (s: ViewState) => runOf(s, "implementation")?.right.map((m) => m.showTime) ?? [];

  test("a message carries its event's time, live and after a replay, and the first of a panel shows it", () => {
    for (const s of [fold(live([started, review], 1, [0, 5])), replayed([started, review], 1, 1, [0, 5])]) {
      expect(runOf(s, "implementation")?.right[0]?.time).toBe(at(5));
      expect(runOf(s, "implementation")?.right[0]?.showTime).toBe(true);
    }
  });

  test("the same author within 2 minutes is grouped; exactly 2 minutes too; more than 2 minutes shows the time", () => {
    expect(shown(fold(live([started, review, review], 1, [0, 0, 60])))).toEqual([true, false]);
    expect(shown(fold(live([started, review, review], 1, [0, 0, 120])))).toEqual([true, false]);
    expect(shown(fold(live([started, review, review], 1, [0, 0, 121])))).toEqual([true, true]);
  });

  test("another author shows the time, however close", () => {
    const s = fold(live([started, review, response, review], 1, [0, 0, 1, 2]));
    expect(runOf(s, "implementation")?.right.map((m) => m.author)).toEqual(["codex", "claude", "codex"]);
    expect(shown(s)).toEqual([true, true, true]);
  });

  // Issue #15: the gap is measured from the last time shown in the panel, so no long span goes unmarked.
  test("thirty messages 90 s apart show a time whenever more than 2 minutes lie since the last time shown", () => {
    const reviews = Array.from({ length: 30 }, () => review);
    const times = [0, ...reviews.map((_, i) => i * 90)];
    const expected = reviews.map((_, i) => i % 2 === 0);
    expect(shown(fold(live([started, ...reviews], 1, times)))).toEqual(expected);
    expect(shown(replayed([started, ...reviews], 1, 1, times))).toEqual(expected);
  });

  test("a message just inside 2 minutes of the last time shown stays grouped", () => {
    expect(shown(fold(live([started, review, review, review], 1, [0, 0, 60, 119])))).toEqual([true, false, false]);
  });

  test("an event that makes no message there (a line of Interloq, Ended) does not count as the message before", () => {
    const between = fold(live([started, review, said("a"), review], 1, [0, 0, 60, 170]));
    expect(shown(between)).toEqual([true, true]);
    const ended = fold(live([started, review, { _tag: "Ended", code: 0 }], 1, [0, 0, 500]));
    expect(runOf(ended, "implementation")?.right.map((m) => [m.time, m.showTime])).toEqual([[at(0), true]]);
  });

  test("a tab that joins late or reconnects folds the replay to the same messages, times and grouping as a live tab", () => {
    const events = [started, review, said("a"), review, asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" } as RunEvent, response];
    const times = [0, 1, 2, 30, 200, 210, 400];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    const again = fold([hello(1), { type: "replay", ui: [], runs: [{ id: 1, events: stamp(events, times) }] }], late);
    for (const s of [late, again]) expect(runOf(s, "implementation")?.right).toEqual(runOf(liveView, "implementation")?.right);
    expect(runOf(liveView, "implementation")?.right.map((m) => [m.time, m.showTime])).toEqual([[at(1), true], [at(30), false], [at(400), true]]);
  });

  test("showsTime: no message before, another author, more than 120 s since the last time shown, or a time that cannot be read", () => {
    const m = { key: "1-1", author: "codex" as const, heading: null, body: "a", format: "markdown" as const, time: at(0), showTime: true, band: null };
    const next = (author: "codex" | "claude", time: string, band: Band | null = null) => ({ author, band, time });
    expect(showsTime(undefined, null, next("codex", at(0)))).toBe(true);
    expect(showsTime(m, at(0), next("claude", at(1)))).toBe(true);
    expect(showsTime(m, at(0), next("codex", at(120)))).toBe(false);
    expect(showsTime(m, at(0), next("codex", at(121)))).toBe(true);
    // Measured from the last time shown, not from the message just before (issue #15).
    expect(showsTime({ ...m, time: at(100) }, at(0), next("codex", at(121)))).toBe(true);
    expect(showsTime(m, at(0), next("codex", "not a time"))).toBe(true);
    expect(showsTime(m, "not a time", next("codex", at(1)))).toBe(true);
    // The first message of a band: measured from the band's label, whoever wrote it (G-R1-1).
    const band: Band = { key: "planning-1", kind: "planning", name: "Planning 1", began: at(100) };
    expect(showsTime(m, at(0), next("claude", at(130), band))).toBe(false);
    expect(showsTime(undefined, null, next("claude", at(221), band))).toBe(true);
    expect(showsTime({ ...m, band, time: at(130), showTime: false }, at(100), next("codex", at(200), band))).toBe(false);
  });
});

// Issue #15: each phase is a band in the "Claude and Codex" panel where it places a message, opened by a label with its
// name and the time it began; the label's time counts as shown (G-R1-1). Issue #22: the dashboard has no bands.
describe("phase bands", () => {
  const began = (phase: UiEvent extends infer E ? (E extends { _tag: "PhaseBegan"; phase: infer P } ? P : never) : never): RunEvent => notified({ _tag: "PhaseBegan", phase });
  const planning = (n: number) => began({ kind: "planning", n });
  const execution = (n: number) => began({ kind: "execution", n });
  const reviewOf = (subject: SubjectId) => notified({ _tag: "ReviewReceived", subject, round: 1, review: { issues: [] }, counted: 0 });
  const review = reviewOf({ plan: 1 });
  const response = notified({ _tag: "ResponseReceived", subject: { plan: 1 }, round: 1, response: { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" });
  const views = (events: readonly RunEvent[], times: readonly number[]) => [fold(live(events, 1, times)), replayed(events, 1, 1, times)];
  const shown = (s: ViewState) => runOf(s, "implementation")?.right.map((m) => m.showTime) ?? [];

  test("a message before any phase has no band and shows its time as the first of its panel", () => {
    for (const s of views([started, review], [0, 5])) {
      expect(runOf(s, "implementation")?.right.map((m) => [m.band, m.showTime])).toEqual([[null, true]]);
    }
  });

  test("the first message after a label shows no time within 2 minutes of it, although it is the first of its panel", () => {
    for (const s of views([started, planning(1), review, review, review], [0, 100, 130, 200, 260])) {
      expect(runOf(s, "implementation")?.right[0]?.band).toEqual({ key: "planning-1", kind: "planning", name: "Planning", began: at(100) });
      expect(shown(s)).toEqual([false, false, true]);
    }
  });

  test("the first message after a label shows its time more than 2 minutes after it, whoever wrote it", () => {
    for (const s of views([started, review, planning(1), review], [0, 0, 10, 131])) {
      expect(shown(s)).toEqual([true, true]);
    }
    for (const s of views([started, review, planning(1), review, response], [0, 0, 10, 20, 30])) {
      // The review is exempt from the change of author, being the band's first; the response after it is not.
      expect(shown(s)).toEqual([true, false, true]);
    }
  });

  test("a phase without a message in the panel makes no band there", () => {
    for (const s of views([started, planning(1), said("a"), review, execution(1), said("x")], [0, 0, 1, 300, 310, 311])) {
      expect(runOf(s, "implementation")?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["planning-1", true]]);
      expect(bandsOf(runOf(s, "implementation")?.right ?? []).map((g) => g.band?.key)).toEqual(["planning-1"]);
    }
  });

  test("the messages after a phase ends stay in its band until the next phase begins", () => {
    const ended = notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" });
    for (const s of views([started, planning(1), review, ended, review], [0, 0, 1, 2, 3])) {
      expect(runOf(s, "implementation")?.right.map((m) => m.band?.key)).toEqual(["planning-1", "planning-1"]);
    }
  });

  test("bandsOf groups consecutive messages of a band: before any phase, a work review, planning, a work review", () => {
    const work = (k: number) => began({ kind: "work", n: k });
    const events = [started, review, work(1), reviewOf({ work: 1 }), planning(2), reviewOf({ plan: 2 }), reviewOf({ plan: 2 }), work(2), reviewOf({ work: 2 })];
    for (const s of views(events, events.map((_, i) => i))) {
      const groups = bandsOf(runOf(s, "implementation")?.right ?? []);
      expect(groups.map((g) => [g.band?.kind ?? null, g.messages.length])).toEqual([
        [null, 1],
        ["work", 1],
        ["planning", 2],
        ["work", 1],
      ]);
    }
  });

  test("a tab that joins late folds the bands and their times as a live tab does", () => {
    const events = [started, said("a"), began({ kind: "questions" }), said("b"), review, planning(1), said("c"), review];
    const times = [0, 1, 2, 3, 4, 200, 201, 202];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    expect(runOf(late, "implementation")?.right).toEqual(runOf(liveView, "implementation")?.right);
    expect(runOf(liveView, "implementation")?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["questions", false], ["planning-1", false]]);
  });
});

// Decision support, plan step 3.6.
describe("decision support", () => {
  const positions = [{ label: "Follow Codex", description: "the issue" }, { label: "Follow Claude", description: "the rationale" }];
  const presented: UiEvent = presentedEvent("Should Codex's position or Claude Code's position stand?", positions, { kind: "pause", heading: "Planning phase 1", pause: "reraised", id: "A" });
  const analysis = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const analyzed = (decision: number): UiEvent => ({ _tag: "DecisionAnalyzed", decision, question: "issue A", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, history: [], explanations: [], question: plainPieces("Q?"), options: [], attached: null, decision: null }, options: positions, analysis });

  test("presented options become the cards of the next decision prompt; the offer is a choice", () => {
    const s = fold(live([started, notified(presented), asked(1, prompts.withOffer(prompts.decisionPrompt))]));
    expect(runOf(s, "implementation")?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["Follow Codex — the issue=1", "Follow Claude — the rationale=2"]);
    expect(runOf(s, "implementation")?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.CONTINUE_WITHOUT_DECIDING}=`, `${prompts.HELP_ME_DECIDE}=/decide`, `${prompts.END_RUN_LABEL}=q`]);
    expect(runOf(s, "implementation")?.dashboard.answers).toEqual([]);
    expect(runOf(s, "implementation")?.pending?.hint).toBe(prompts.pagePromptText("decision", prompts.decisionPrompt));
    const helped = fold([{ type: "event", run: 1, seq: 3, time: at(3), event: { _tag: "Answered", prompt: 1, text: "/decide" } }], s);
    expect(lastAnswerOf(helped)).toEqual({ key: "1-3", asked: { _tag: "Question", question: presentedOf(presented) }, answer: prompts.HELP_ME_DECIDE });
  });

  test("options never outlive their prompt: a pause without options after one with options shows no cards", () => {
    const s = fold(live([started, notified(presented), asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "1" }, asked(2, prompts.decisionPrompt)]));
    expect(runOf(s, "implementation")?.pending?.options).toEqual([]);
  });

  test("after a nested decision the outer question's options are presented again (P1-R1-3)", () => {
    const outer: UiEvent = presentedEvent("A or B?", [{ label: "A", description: "" }, { label: "B", description: "" }]);
    const inner: UiEvent = presentedEvent("C or D?", [{ label: "C", description: "" }, { label: "D", description: "" }]);
    const s = fold(live([
      started,
      notified(outer),
      asked(1, prompts.withOffer(prompts.optionOrTextPrompt)),
      { _tag: "Answered", prompt: 1, text: "/decide" },
      notified(inner),
      asked(2, prompts.withOffer(prompts.optionOrTextPrompt)),
      { _tag: "Answered", prompt: 2, text: "1" },
      notified(analyzed(1)),
      notified(outer),
      asked(3, prompts.withOffer(prompts.optionOrTextPrompt)),
    ]));
    expect(runOf(s, "implementation")?.pending?.options.map((c) => c.label)).toEqual(["A", "B"]);
  });

  // S21 (Q4): while the analysis is prepared, one plain status message, updated in place at every check.
  test("the analysis's progress is the status, replaced in place, live and after a replay; the line said for it is absorbed", () => {
    const progress = (check: number): RunEvent => notified({ _tag: "AnalysisProgress", decision: 1, question: 3, check });
    const line = (check: number): RunEvent => said(prompts.analysisProgressLine(1, 3, check));
    const events: RunEvent[] = [started, said("a"), progress(0), line(0), progress(1), line(1), said("b")];
    for (const s of [fold(live(events)), replayed(events)]) expect(statusOf(s)).toBe("b");
    const last: RunEvent[] = [...events, progress(2), line(2)];
    for (const s of [fold(live(last)), replayed(last)]) {
      expect(statusOf(s)).toBe(prompts.analysisProgressLine(1, 3, 2).trim());
      expect(runOf(s, "implementation")?.dashboard.status._tag).toBe("Interloq");
    }
  });

  test("an analysis is kept for the reasked prompt and cleared by its answer; a decision loop adds nothing to the rail", () => {
    const loop: RunEvent[] = [
      notified({ _tag: "RoundBegan", subject: { decision: 1 }, round: 1, limit: 5 }),
      notified({ _tag: "ReviewReceived", subject: { decision: 1 }, round: 1, review: { issues: [] }, counted: 0 }),
      notified({ _tag: "LoopFinished", subject: { decision: 1 }, result: "converged" }),
    ];
    const before = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), asked(1, prompts.withOffer(prompts.decisionPrompt)), { _tag: "Answered", prompt: 1, text: "/decide" }]));
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), asked(1, prompts.withOffer(prompts.decisionPrompt)), { _tag: "Answered", prompt: 1, text: "/decide" }, ...loop, notified(analyzed(1)), asked(2, prompts.withOffer(prompts.decisionPrompt))]));
    expect(runOf(s, "implementation")?.timeline).toEqual(runOf(before, "implementation")?.timeline);
    expect(progressOf(runOf(s, "implementation")!)).toBe(progressOf(runOf(before, "implementation")!));
    expect(runOf(s, "implementation")?.analysis?.event.decision).toBe(1);
    expect(runOf(s, "implementation")?.analysis?.prompt).toBe(2);
    const answered = fold([{ type: "event", run: 1, seq: 9, time: at(9), event: { _tag: "Answered", prompt: 2, text: "1" } }], s);
    expect(runOf(answered, "implementation")?.analysis).toBe(null);
    // A replay folds alike.
    expect(runOf(replayed([started, notified(analyzed(3)), asked(1, prompts.withOffer(prompts.decisionPrompt))]), "implementation")?.analysis?.event.decision).toBe(3);
  });
});

// W1-R1-2: a relayed question presented again before the retry of a blank answer keeps its cards.
test("a blank answer to a relayed question, then the question presented again: the retry keeps both cards", () => {
  const question: UiEvent = presentedEvent("A or B?", [{ label: "A", description: "a" }, { label: "B", description: "b" }]);
  const s = fold(live([started, notified(question), asked(1, prompts.withOffer(prompts.optionOrTextPrompt)), { _tag: "Answered", prompt: 1, text: "" }, notified(question), asked(2, prompts.withOffer(prompts.optionOrTextPrompt))]));
  expect(runOf(s, "implementation")?.pending?.asked.prompt).toBe(2);
  expect(runOf(s, "implementation")?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A — a=1", "B — b=2"]);
});

// W2-R1-1: a decision's response (with its amended analysis) folds into one Claude message; the rail is unchanged.
test("a decision's ResponseReceived is one Claude message in the right panel, live and replayed, and adds nothing to the rail", () => {
  const analysisOf = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const response = { dispositions: [{ id: "D1-R1-1", action: "accepted" as const, rationale: "amended", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [], analysis: analysisOf };
  const phase = notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } });
  const events: RunEvent[] = [started, phase, notified({ _tag: "ResponseReceived", subject: { decision: 1 }, round: 1, response, resultText: "" })];
  const before = fold(live([started, phase]));
  for (const s of [fold(live(events)), replayed(events)]) {
    expect(runOf(s, "implementation")?.right.map((m) => m.author)).toEqual(["claude"]);
    expect(runOf(s, "implementation")?.right[0].body).toMatch(/D1-R1-1/);
    expect(runOf(s, "implementation")?.timeline).toEqual(runOf(before, "implementation")?.timeline);
  }
  // The message decodes from the wire as well.
  const wire: ServerMessage = { type: "event", run: 1, seq: 2, time: at(2), event: events[2] };
  expect(decodeServer(JSON.stringify(wire))._tag).toBe("Success");
});

// W3-R1-1: a reply the run rejects (a blank answer where one is required) keeps the analysis for the prompt asked again.
test("a rejected blank reply keeps the analysis for the retry; an accepted empty answer and the retry's answer dismiss it", () => {
  const options = [{ label: "A", description: "" }, { label: "B", description: "" }];
  const analyzedEvent: UiEvent = { _tag: "DecisionAnalyzed", decision: 1, question: "A or B?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, history: [], explanations: [], question: plainPieces("Q?"), options: [], attached: null, decision: null }, options, analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } };
  const question: UiEvent = presentedEvent("A or B?", options);
  const rejected: RunEvent[] = [
    started,
    notified(analyzedEvent),
    asked(2, prompts.withOffer(prompts.optionOrTextPrompt)),
    { _tag: "Answered", prompt: 2, text: "" },
    notified({ _tag: "AnswerRejected" }),
    notified(question),
    asked(3, prompts.withOffer(prompts.optionOrTextPrompt)),
  ];
  for (const s of [fold(live(rejected)), replayed(rejected)]) expect(runOf(s, "implementation")?.analysis?.prompt).toBe(3);
  const answered = fold(live([...rejected, { _tag: "Answered", prompt: 3, text: "1" }]));
  expect(runOf(answered, "implementation")?.analysis).toBe(null);
  const accepted = fold(live([started, notified(analyzedEvent), asked(2, prompts.withOffer(prompts.decisionPrompt)), { _tag: "Answered", prompt: 2, text: "" }, asked(3, prompts.decisionPrompt)]));
  expect(runOf(accepted, "implementation")?.analysis).toBe(null);
});

// Issue #6 (Q5, Q9): the reducer keeps the current plan with the phase that carries it out; every write replaces it.
describe("the plan", () => {
  const planOf = (id: string, status: "pending" | "done") => ({ stages: [{ number: 1, title: "t", steps: [{ id, number: 1, label: "l", text: "x", status }] }] });
  test("PlanChanged keeps the latest plan and its phase, live and after a replay", () => {
    const events = [started, notified({ _tag: "PlanChanged", phase: 1, plan: planOf("S1", "pending"), step: null }), notified({ _tag: "PlanChanged", phase: 2, plan: planOf("S2", "done"), step: null })];
    const s = fold(live(events));
    expect(runOf(s, "implementation")?.plan).toEqual({ phase: 2, plan: planOf("S2", "done") });
    expect(runOf(replayed(events), "implementation")?.plan).toEqual(runOf(s, "implementation")?.plan);
  });
});

// Issue #6: the whole run in the timeline, numbered by the count of each kind, the plan under the Implementation that
// carries it out, and the current step only while an execution call runs (G-R1-2), nested calls included (P1-R2-1).
describe("the whole run in the timeline", () => {
  const foreseen = (questions: boolean, iterations: number) => notified({ _tag: "PhasesForeseen", phases: phasesOf(questions, iterations) });
  const began = (phase: Parameters<typeof phaseName>[0]) => notified({ _tag: "PhaseBegan", phase });
  const entries = (s: ViewState) => runOf(s, "implementation")?.timeline.map((e) => [e.label, e.state]) ?? [];
  const recorded = (id: string, status: "pending" | "started" | "done" | "unfinished") => ({ stages: [{ number: 1, title: "t", steps: [{ id, number: 1, label: "l", text: "x", status }] }] });

  test("the entries foreseen at the start, with and without the question phase", () => {
    const withQuestions = fold(live([started, foreseen(true, 1)]));
    expect(entries(withQuestions)).toEqual([["Gather Requirements", "ahead"], ["Planning", "ahead"], ["Implementation", "ahead"], ["Code review", "ahead"]]);
    expect(runOf(withQuestions, "implementation")?.timeline[0].steps.map((st) => [st.label, st.state])).toEqual([[prompts.stepLabel("formulate"), "ahead"], [prompts.stepLabel("clarification"), "ahead"]]);
    expect(entries(fold(live([started, foreseen(false, 1)])))).toEqual([["Planning", "ahead"], ["Implementation", "ahead"], ["Code review", "ahead"]]);
  });

  test("the seam of the labels: Planning becomes Planning 1 in the rail and in its band the moment Planning 2 is foreseen", () => {
    const before = [started, foreseen(false, 1), began({ kind: "planning", n: 1 }), notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 })];
    const one = fold(live(before));
    expect([runOf(one, "implementation")?.timeline[0].label, runOf(one, "implementation")?.right[0].band?.name]).toEqual([phaseName({ kind: "planning", n: 1 }, 1), phaseName({ kind: "planning", n: 1 }, 1)]);
    for (const s of [fold(live([...before, foreseen(false, 2)])), replayed([...before, foreseen(false, 2)])]) {
      expect(runOf(s, "implementation")?.timeline[0].label).toBe(phaseName({ kind: "planning", n: 1 }, 2));
      expect(runOf(s, "implementation")?.right[0].band?.name).toBe(runOf(s, "implementation")?.timeline[0].label);
      expect(entries(s).map(([label]) => label)).toEqual(["Planning 1", "Implementation 1", "Code review 1", "Planning 2", "Implementation 2", "Code review 2"]);
    }
  });

  test("a phase that begins turns its entry active; a run that halts leaves the phases ahead not reached", () => {
    const s = fold(live([started, foreseen(false, 1), began({ kind: "planning", n: 1 }), { _tag: "Ended", code: 1 }]));
    expect(entries(s)).toEqual([["Planning", "stopped"], ["Implementation", "notReached"], ["Code review", "notReached"]]);
    const finished = fold(live([started, foreseen(false, 1), began({ kind: "planning", n: 1 }), { _tag: "Ended", code: 0 }]));
    expect(entries(finished)[1]).toEqual(["Implementation", "ahead"]);
  });

  // A foreseen step that never began is retired when its phase ends: "skipped", not "ahead", and not "notReached",
  // which a halt gives. The states are compared as strings.
  const stepStates = (s: ViewState) => runOf(s, "implementation")?.timeline.map((e) => e.steps.map((st) => [st.kind, st.state as string])) ?? [];
  const noStepAhead = (s: ViewState) => runOf(s, "implementation")?.timeline.every((e) => e.steps.every((st) => (st.state as string) !== "ahead")) ?? false;
  const q = { kind: "questions" as const };
  const phaseDone = (phase: Parameters<typeof phaseName>[0]): RunEvent[] => [began(phase), notified({ _tag: "PhaseEnded", phase, result: "converged" })];

  test("an empty agreed question list without a conversation: Clarification is retired when Gather Requirements ends, and no step is ahead after the run", () => {
    const questionPhase: RunEvent[] = [
      started,
      foreseen(true, 1),
      began(q),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "PhaseEnded", phase: q, result: "no conversation" }),
    ];
    const afterPhase = fold(live(questionPhase));
    expect(stepStates(afterPhase)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    const events: RunEvent[] = [...questionPhase, ...phaseDone({ kind: "planning", n: 1 }), ...phaseDone({ kind: "execution", n: 1 }), ...phaseDone({ kind: "work", n: 1 }), { _tag: "Ended", code: 0 }];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(noStepAhead(s)).toBe(true);
      expect(stepStates(s)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    }
  });

  test("a phase that ends while a later step of it never began retires that step; a halt still leaves it not reached", () => {
    const prefix: RunEvent[] = [started, foreseen(true, 1), began(q)];
    const ended = fold(live([...prefix, notified({ _tag: "PhaseEnded", phase: q, result: "converged" })]));
    expect(runOf(ended, "implementation")?.timeline[0].steps.every((st) => (st.state as string) !== "ahead")).toBe(true);
    expect(stepStates(ended)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    const finished = fold(live([...prefix, { _tag: "Ended", code: 0 }]));
    expect(stepStates(finished)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    const halted = fold(live([...prefix, { _tag: "Ended", code: 1 }]));
    expect(stepStates(halted)[0]).toEqual([["formulate", "stopped"], ["clarification", "notReached"]]);
    const skippedThenHalted = fold(live([...prefix, notified({ _tag: "PhaseEnded", phase: q, result: "converged" }), { _tag: "Ended", code: 1 }]));
    expect(stepStates(skippedThenHalted)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
  });

  // Issue #120, S6: a refinement run foresees Gather Requirements alone, so a finished refinement run leaves no phase not
  // reached (which means a halt) and none ahead; the events are those of src/run.ts's refinementRun.
  test("a finished refinement run: Gather Requirements alone, done, and no entry not reached or ahead", () => {
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhasesForeseen", phases: foreseenPhases("refinement", iterationsOf(1)) }),
      began(q),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "PhaseEnded", phase: q, result: "converged" }),
      { _tag: "Ended", code: 0 },
    ];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(entries(s)).toEqual([["Gather Requirements", "done"]]);
      expect(runOf(s, "implementation")?.timeline.some((e) => (e.state as string) === "notReached" || (e.state as string) === "ahead")).toBe(false);
    }
  });

  test("the plan hangs under the Implementation of its phase, and a revision moves it there (Q5, Q9)", () => {
    const first = [started, foreseen(false, 1), began({ kind: "planning", n: 1 }), notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "pending"), step: null })];
    const plans = (x: ViewState) => runOf(x, "implementation")?.timeline.map((e) => bare(e.plan));
    const one = fold(live(first));
    expect(plans(one)).toEqual([null, recorded("S1", "pending"), null]);
    const revised = fold(live([...first, foreseen(false, 2), notified({ _tag: "PlanChanged", phase: 2, plan: recorded("S2", "pending"), step: null })]));
    expect(plans(revised)).toEqual([null, null, null, null, recorded("S2", "pending"), null]);
    // A phase that was not foreseen (a replay of an older run) takes the plan when it begins.
    const late = fold(live([started, notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "pending"), step: null }), began({ kind: "execution", n: 1 })]));
    expect(bare(runOf(late, "implementation")?.timeline[0].plan ?? null)).toEqual(recorded("S1", "pending"));
  });

  test("a started step is current only when it is the entry's current step, its phase is active and an execution call runs", () => {
    const active = { state: "active" as const, currentStep: "S1" };
    expect(planStepState(active, { id: "S1", status: "started" }, true)).toBe("current");
    expect(planStepState(active, { id: "S1", status: "started" }, false)).toBe("unfinished");
    expect(planStepState(active, { id: "S2", status: "started" }, true)).toBe("unfinished");
    expect(planStepState({ state: "done", currentStep: "S1" }, { id: "S1", status: "started" }, true)).toBe("unfinished");
    expect(planStepState(active, { id: "S1", status: "unfinished" }, true)).toBe("unfinished");
    expect(planStepState({ state: "ahead", currentStep: null }, { id: "S1", status: "pending" }, false)).toBe("pending");
    expect(planStepState(active, { id: "S1", status: "done" }, true)).toBe("done");
    expect(currentPlanStep(active, true)).toBe("S1");
    expect(currentPlanStep(active, false)).toBe(null);
    expect(currentPlanStep({ state: "done", currentStep: "S1" }, true)).toBe(null);
  });

  test("a decision nested in an execution call: the step stays current, busy stays, and the activity returns to the execution", () => {
    const call = (agent: "claude" | "codex", purpose: string) => notified({ _tag: "AgentCallStarted", agent, purpose, callId: `${agent}-1` });
    const end = (agent: "claude" | "codex") => notified({ _tag: "AgentCallEnded", agent, ok: true, callId: `${agent}-1` });
    const prefix = [started, foreseen(false, 1), began({ kind: "execution", n: 1 }), call("claude", "execution"), notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "started"), step: null })];
    const executing = fold(live(prefix));
    const nested = fold(live([...prefix, call("claude", "planning"), call("codex", "review")]));
    const resumed = fold(live([...prefix, call("claude", "planning"), call("codex", "review"), end("codex"), end("claude")]));
    for (const s of [executing, nested, resumed]) {
      expect(runOf(s, "implementation")?.busy).toBe(true);
      expect(runOf(s, "implementation")?.calls.some((c) => c.purpose === "execution")).toBe(true);
    }
    expect(statusOf(nested)).toBe("Codex — review");
    expect(statusOf(resumed)).toBe(statusOf(executing));
    expect(runOf(resumed, "implementation")?.calls.at(-1)?.startedAt).toBe(runOf(executing, "implementation")?.calls.at(-1)?.startedAt);
    const ended = fold(live([...prefix, end("claude")]));
    expect([runOf(ended, "implementation")?.busy, runOf(ended, "implementation")?.calls.length]).toEqual([false, 0]);
  });

  test("with the whole run foreseen, cycles and counts attach to the active phase and step, and the progress line names them", () => {
    const events: RunEvent[] = [
      started,
      foreseen(true, 1),
      began({ kind: "questions" }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
    ];
    const formulate = fold(live(events));
    expect(runOf(formulate, "implementation")?.timeline[0].steps[0].groups[0].rounds.length).toBe(1);
    expect(runOf(formulate, "implementation")?.timeline.slice(1).every((e) => e.groups.length === 0)).toBe(true);
    expect(progressOf(runOf(formulate, "implementation")!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("formulate")), "cycle 1"));
    const interview = fold(live([...events, notified({ _tag: "InterviewOpened", heading: prompts.clarificationHeading("clarification"), stage: "clarification", total: 3 }), notified({ _tag: "InterviewTurn", heading: prompts.clarificationHeading("clarification"), message: "Q?", summary: null, answered: 1, total: 3 })]));
    expect(runOf(interview, "implementation")?.timeline[0].steps.map((st) => [st.kind, st.state, st.count])).toEqual([["formulate", "done", null], ["clarification", "active", { answered: 1, total: 3 }]]);
    expect(progressOf(runOf(interview, "implementation")!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("clarification")), prompts.clarificationProgress(1, 3)));
    const planning = fold(live([...events, notified({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "done" }), began({ kind: "planning", n: 1 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 })]));
    expect(runOf(planning, "implementation")?.timeline[1].groups[0].rounds.length).toBe(1);
    expect(runOf(planning, "implementation")?.timeline[3].groups).toEqual([]);
    expect(progressOf(runOf(planning, "implementation")!)).toBe(prompts.progressLine("Planning", "cycle 1"));
  });
});

// Issue #42 (Q7, P1-R2-1): the start time the elapsed time is measured from is the innermost call's, then the outer's again.
test("the elapsed time's start: the nested call's while it runs, the outer call's after it", () => {
  const events: RunEvent[] = [started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution", callId: "claude-1" }), notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" })];
  const nested = fold(live(events, 1, [0, 10, 70]));
  expect(callStartedAt(runOf(nested, "implementation")!)).toBe(at(70));
  const after = fold(live([...events, notified({ _tag: "AgentCallEnded", agent: "codex", ok: true, callId: "codex-1" })], 1, [0, 10, 70, 80]));
  expect(callStartedAt(runOf(after, "implementation")!)).toBe(at(10));
  expect(callStartedAt(runOf(fold(live([started])), "implementation")!)).toBe(null);
});

// Issue #26 (S21): the retry of a transport fault on the activity line, live and replayed alike.
describe("transport retries on the activity line", () => {
  const call: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" };
  const failed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false, callId: "codex-1" };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", purpose: "review", attempt: 2, of: 3, delaySeconds: 10, fault: "stream disconnected", fromMs: 0, untilMs: 10_000 };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a retry shows the agent, the attempt of the retries and the fault, and the retried call keeps it", () => {
    for (const s of both([started, notified(call), notified(failed), notified(retrying)])) expect(statusOf(s)).toBe("Codex — connection lost, retry 2 of 3 (stream disconnected)");
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call)])) expect(statusOf(s)).toBe("Codex — review — connection lost, retry 2 of 3 (stream disconnected)");
  });

  test("the retry clears when the call recovers or a call ends well", () => {
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call), notified({ _tag: "TransportRecovered", agent: "codex" })])) expect(statusOf(s)).toBe("Codex — review");
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call), notified({ _tag: "AgentCallEnded", agent: "codex", ok: true, callId: "codex-1" }), notified(call)])) expect(statusOf(s)).toBe("Codex — review");
  });

  test("the SDK's own reconnection during a call is shown on the activity line", () => {
    const reconnecting: UiEvent = { _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: 2, of: 10, delayMs: 1500, detail: "status 503, server_error", callId: "claude-1" };
    for (const s of both([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-1" }), notified(reconnecting)])) {
      expect(statusOf(s)).toBe("Claude — planning — reconnecting 2 of 10 (status 503, server_error)");
    }
  });

  // W3-R2-1 of issue #184: calls overlap, so a tool event or a reconnection is labeled by the call whose id it carries,
  // not by the call started last.
  const interview: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "clarification", callId: "claude-1" };
  const review: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" };
  const labelOf = (events: readonly RunEvent[]) => statusOf(fold(live(events)));

  test("a tool event of an earlier call that still runs is labeled by that call", () => {
    const interviewLabel = labelOf([started, notified(interview)]);
    const read: UiEvent = { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "src/example.ts", callId: "claude-1" };
    for (const s of both([started, notified(interview), notified(review), notified(read)])) {
      expect(statusOf(s)).toBe(`${interviewLabel} — Read: src/example.ts`);
    }
  });

  test("a tool event of the latest call is labeled by it, and one of no running call by its agent alone", () => {
    const command: UiEvent = { _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff", callId: "codex-1" };
    expect(labelOf([started, notified(interview), notified(review), notified(command)])).toBe("Codex — review — command: git diff");
    const stray: UiEvent = { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "x", callId: "claude-9" };
    expect(labelOf([started, notified(interview), notified(review), notified(stray)])).toBe("Claude — Read: x");
  });

  test("a reconnection of an earlier call that still runs is labeled by that call", () => {
    const codexFirst: UiEvent = { _tag: "AgentReconnecting", agent: "codex", by: "sdk", attempt: null, of: null, delayMs: null, detail: "stream lost", callId: "codex-1" };
    const reviewLabel = labelOf([started, notified(review)]);
    for (const s of both([started, notified(review), notified(interview), notified(codexFirst)])) {
      expect(statusOf(s)).toBe(`${reviewLabel} — reconnecting (stream lost)`);
    }
  });
});

// W1-R1-3: the retry belongs to its agent and ends with every call's end.
describe("the retry state after the retries are exhausted", () => {
  const codexCall: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" };
  const codexFailed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false, callId: "codex-1" };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", purpose: "review", attempt: 1, of: 1, delaySeconds: 5, fault: "stream disconnected", fromMs: 0, untilMs: 5000 };
  const claudeCall: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-1" };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a Claude call of Help me decide after the exhausted Codex retries shows no retry text", () => {
    for (const s of both([started, notified(codexCall), notified(codexFailed), notified(retrying), notified(codexCall), notified(codexFailed), notified(claudeCall)])) {
      expect(statusOf(s)).toBe("Claude — planning");
    }
  });

  test("a retried call that fails again: the next call of the same agent shows no retry text either", () => {
    for (const s of both([started, notified(codexCall), notified(codexFailed), notified(retrying), notified(codexCall), notified(codexFailed), notified(codexCall)])) {
      expect(statusOf(s)).toBe("Codex — review");
    }
  });
});

// Issue #50 (Q2): each phase's begin and end from its events' publication times, for the rail's duration.
describe("phase times", () => {
  const foreseen = (questions: boolean, iterations: number) => notified({ _tag: "PhasesForeseen", phases: phasesOf(questions, iterations) });
  const planning = { kind: "planning" as const, n: 1 };
  const times = (s: ViewState) => runOf(s, "implementation")?.timeline.map((e) => [e.label, e.began, e.ended]) ?? [];

  test("PhaseBegan and PhaseEnded stamp the entry; an entry ahead has neither; live and replay agree", () => {
    const events: RunEvent[] = [started, foreseen(false, 1), notified({ _tag: "PhaseBegan", phase: planning }), notified({ _tag: "PhaseEnded", phase: planning, result: "converged" })];
    const seconds = [0, 1, 10, 670];
    for (const s of [fold(live(events, 1, seconds)), replayed(events, 1, 1, seconds)]) {
      expect(times(s)).toEqual([["Planning", at(10), at(670)], ["Implementation", null, null], ["Code review", null, null]]);
    }
  });

  test("a run that ends while a phase is active ends that phase at the time of Ended; the phases not reached keep none", () => {
    const events: RunEvent[] = [started, foreseen(false, 1), notified({ _tag: "PhaseBegan", phase: planning }), { _tag: "Ended", code: 130 }];
    const seconds = [0, 1, 10, 95];
    for (const s of [fold(live(events, 1, seconds)), replayed(events, 1, 1, seconds)]) {
      expect(times(s)).toEqual([["Planning", at(10), at(95)], ["Implementation", null, null], ["Code review", null, null]]);
    }
  });

  test("a phase not foreseen is stamped when it begins", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: planning })], 1, [0, 7]));
    expect(times(s)).toEqual([["Planning", at(7), null]]);
  });
});

// Issue #53 (G-R1-1): at most one step of the plan is current, the one named by the latest 'started' report of the
// running execution call while it is still started; nothing but a report makes a step current again.
describe("the current step of the plan", () => {
  const foreseen = notified({ _tag: "PhasesForeseen", phases: foreseenPhases("implementation", iterationsOf(1)) });
  const began = notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } });
  const call = (purpose = "execution") => notified({ _tag: "AgentCallStarted", agent: "claude", purpose, callId: "claude-1" });
  const callEnded = (ok = true) => notified({ _tag: "AgentCallEnded", agent: "claude", ok, callId: "claude-1" });
  type Status = "pending" | "started" | "done" | "unfinished";
  const ids = ["S1", "S2", "S3"];
  /** The events of the reports in order, each PlanChanged carrying the plan as recorded after it. */
  const reports = (list: readonly (readonly [string, "started" | "done"])[], from: Record<string, Status> = {}): RunEvent[] => {
    const statuses: Record<string, Status> = { ...from };
    return list.map(([id, status]) => {
      statuses[id] = status;
      const plan = { stages: [{ number: 1, title: "t", steps: ids.map((sid, i) => ({ id: sid, number: i + 1, label: sid, text: sid, status: statuses[sid] ?? ("pending" as const) })) }] };
      return notified({ _tag: "PlanChanged", phase: 1, plan, step: { id, status } });
    });
  };
  const prefix: RunEvent[] = [started, foreseen, began, call()];
  const implementation = (s: ViewState) => runOf(s, "implementation")!.timeline.find((e) => e.phase.kind === "execution")!;
  /** The state of each step as the rail derives it, in the order of the plan. */
  const states = (s: ViewState) => {
    const entry = implementation(s);
    return (runOf(s, "implementation")!.plan?.plan.stages[0].steps ?? []).map((st) => `${st.id}:${planStepState(entry, st, executing(runOf(s, "implementation")!))}`);
  };
  const both = (events: RunEvent[]) => [fold(live(events)), replayed(events)];

  test("two steps started: the later is current, the earlier unfinished; live and replay agree", () => {
    for (const s of both([...prefix, ...reports([["S1", "started"], ["S2", "started"]])])) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:current", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(runOf(s, "implementation")!))).toBe("S2");
    }
  });

  test("the current step done while an earlier one is open: no step is current, until the earlier one is reported started again", () => {
    const done = [...prefix, ...reports([["S1", "started"], ["S2", "started"], ["S2", "done"]])];
    for (const s of both(done)) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:done", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(runOf(s, "implementation")!))).toBe(null);
    }
    const resumed = [...prefix, ...reports([["S1", "started"], ["S2", "started"], ["S2", "done"], ["S1", "started"]])];
    for (const s of both(resumed)) expect(states(s)).toEqual(["S1:current", "S2:done", "S3:pending"]);
  });

  test("a transport retry of the execution call: the step is not current until it is reported again", () => {
    const retried = [...prefix, ...reports([["S1", "started"]]), callEnded(false), call()];
    for (const s of both(retried)) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:pending", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(runOf(s, "implementation")!))).toBe(null);
    }
    for (const s of both([...retried, ...reports([["S1", "started"]], { S1: "started" })])) expect(states(s)[0]).toBe("S1:current");
  });

  test("a call nested in the execution call leaves the current step", () => {
    for (const s of both([...prefix, ...reports([["S1", "started"]]), call("planning"), callEnded()])) expect(states(s)[0]).toBe("S1:current");
  });

  test("the end of the phase or of the run leaves no step current", () => {
    const events = [...prefix, ...reports([["S1", "started"]])];
    for (const end of [notified({ _tag: "PhaseEnded", phase: { kind: "execution", n: 1 }, result: "aborted" }), { _tag: "Ended", code: 1 } as RunEvent]) {
      for (const s of both([...events, end])) expect(implementation(s).currentStep).toBe(null);
    }
  });

  test("the end's PlanChanged, which names no report, clears a current step that is no longer started", () => {
    const [ended] = reports([["S1", "started"]]);
    const plan = ended._tag === "Notified" && ended.event._tag === "PlanChanged" ? ended.event.plan : null;
    const unfinished = { stages: plan!.stages.map((st) => ({ ...st, steps: st.steps.map((x) => (x.id === "S1" ? { ...x, status: "unfinished" as const } : x)) })) };
    const s = fold(live([...prefix, ended, notified({ _tag: "PlanChanged", phase: 1, plan: unfinished, step: null })]));
    expect(implementation(s).currentStep).toBe(null);
  });

  test("property: for any sequence of reports at most one step is current, and it is the latest started one still started", () => {
    const report = fc.tuple(fc.constantFrom(...ids), fc.constantFrom("started" as const, "done" as const));
    fc.assert(
      fc.property(fc.array(report, { maxLength: 12 }), (list) => {
        const s = fold(live([...prefix, ...reports(list)]));
        const current = states(s).filter((x) => x.endsWith(":current"));
        expect(current.length).toBeLessThanOrEqual(1);
        const last = list.at(-1);
        if (last !== undefined && last[1] === "started") expect(current).toEqual([`${last[0]}:current`]);
      }),
    );
  });
});

// Issue #54 (Q3, Q6): an ended Implementation keeps the steps it acted on; a surviving step follows later revisions, a
// removed one stays as it was at the phase's end; the next Implementation shows what remains. Derived by the fold alone.
describe("the steps an Implementation acted on", () => {
  type Status = "pending" | "started" | "done" | "unfinished";
  type Step = Readonly<{ id: string; label: string; status: Status }>;
  const planOf = (stages: readonly (readonly [string, readonly Step[]])[]) => ({
    stages: stages.map(([title, steps], i) => ({ number: i + 1, title, steps: steps.map((x, j) => ({ id: x.id, number: j + 1, label: x.label, text: `text of ${x.label}`, status: x.status })) })),
  });
  const planChanged = (phase: number, plan: ReturnType<typeof planOf>, step: StepReportLike = null) => notified({ _tag: "PlanChanged", phase, plan, step });
  type StepReportLike = Readonly<{ id: string; status: "started" | "done" }> | null;
  const phase = (kind: "planning" | "execution" | "work", n: number) => ({ kind, n });
  const begin = (kind: "planning" | "execution" | "work", n: number) => notified({ _tag: "PhaseBegan", phase: phase(kind, n) });
  const end = (kind: "planning" | "execution" | "work", n: number, result = "converged") => notified({ _tag: "PhaseEnded", phase: phase(kind, n), result });
  const call = notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution", callId: "claude-1" });
  const callEnded = notified({ _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-1" });

  // The plan of Planning 1: stage A with S1 and S3, stage B with S4 and S2 (S2 never touched).
  const v1 = (s: Record<string, Status> = {}) => planOf([["A", [{ id: "S1", label: "one", status: s.S1 ?? "pending" }, { id: "S3", label: "three", status: s.S3 ?? "pending" }]], ["B", [{ id: "S4", label: "four", status: s.S4 ?? "pending" }, { id: "S2", label: "two", status: s.S2 ?? "pending" }]]]);
  // The revision of Planning 2: S1 removed; stage 1 is now "B'" with S5, S4 (renumbered, relabeled) and S2; S3 done in stage 2 "A'".
  const v2 = (s: Record<string, Status> = {}) => planOf([["B'", [{ id: "S5", label: "five", status: s.S5 ?? "pending" }, { id: "S4", label: "four revised", status: s.S4 ?? "unfinished" }, { id: "S2", label: "two", status: s.S2 ?? "pending" }]], ["A'", [{ id: "S3", label: "three", status: "done" }]]]);

  const implementation1: RunEvent[] = [
    started,
    notified({ _tag: "PhasesForeseen", phases: foreseenPhases("implementation", iterationsOf(1)) }),
    begin("planning", 1),
    planChanged(1, v1()),
    end("planning", 1),
    begin("execution", 1),
    call,
    planChanged(1, v1({ S1: "started" }), { id: "S1", status: "started" }),
    planChanged(1, v1({ S1: "started", S3: "started" }), { id: "S3", status: "started" }),
    planChanged(1, v1({ S1: "started", S3: "done" }), { id: "S3", status: "done" }),
    planChanged(1, v1({ S1: "started", S3: "done", S4: "started" }), { id: "S4", status: "started" }),
    callEnded,
    // The end of the call turns the started steps unfinished while the entry is still active (src/run.ts).
    planChanged(1, v1({ S1: "unfinished", S3: "done", S4: "unfinished" })),
    end("execution", 1, "aborted"),
  ];
  const revision: RunEvent[] = [begin("work", 1), end("work", 1), notified({ _tag: "PhasesForeseen", phases: foreseenPhases("implementation", iterationsOf(2)) }), begin("planning", 2), planChanged(2, v2()), end("planning", 2)];
  const implementation2: RunEvent[] = [begin("execution", 2), call, planChanged(2, v2({ S4: "started" }), { id: "S4", status: "started" }), planChanged(2, v2({ S4: "done" }), { id: "S4", status: "done" }), callEnded, end("execution", 2, "finished")];

  const entry = (s: ViewState, label: string) => runOf(s, "implementation")!.timeline.find((e) => e.label === label)!;
  /** An entry's shown plan: per stage its key and title, per step its id, number, label, text and status. */
  const shown = (s: ViewState, label: string) => entry(s, label).plan?.stages.map((st) => [st.key, st.title, st.steps.map((x) => `${x.id} ${x.number} ${x.label} (${x.text}) ${x.status}`)]) ?? null;
  const both = (events: RunEvent[]) => [fold(live(events)), replayed(events)];

  test("right after its end, an Implementation shows only the steps it acted on", () => {
    for (const s of both(implementation1)) {
      expect(shown(s, "Implementation")).toEqual([
        ["current-1", "A", ["S1 1 one (text of one) unfinished", "S3 2 three (text of three) done"]],
        ["current-2", "B", ["S4 1 four (text of four) unfinished"]],
      ]);
    }
  });

  test("after a revision, the ended Implementation keeps its steps: a surviving one follows the revision, a removed one stays as it was", () => {
    for (const s of both([...implementation1, ...revision])) {
      expect(shown(s, "Implementation 1")).toEqual([
        ["current-1", "B'", ["S4 2 four revised (text of four revised) unfinished"]],
        ["record-1", "A", ["S1 1 one (text of one) unfinished"]],
        ["current-2", "A'", ["S3 1 three (text of three) done"]],
      ]);
      // The next Implementation shows what remains: not the done S3, not the removed S1.
      expect(shown(s, "Implementation 2")).toEqual([["current-1", "B'", ["S5 1 five (text of five) pending", "S4 2 four revised (text of four revised) unfinished", "S2 3 two (text of two) pending"]]]);
    }
  });

  test("a step worked in two phases appears under both, each with the status it had there", () => {
    for (const s of both([...implementation1, ...revision, ...implementation2])) {
      expect(shown(s, "Implementation 1")?.[0]).toEqual(["current-1", "B'", ["S4 2 four revised (text of four revised) unfinished"]]);
      expect(shown(s, "Implementation 2")).toEqual([["current-1", "B'", ["S4 2 four revised (text of four revised) done"]]]);
    }
  });

  test("a step done in an earlier phase is not repeated in a later phase's record, nor a step it never touched", () => {
    const s = fold(live([...implementation1, ...revision, ...implementation2]));
    const ids = (label: string) => entry(s, label).record?.stages.flatMap((st) => st.steps.map((x) => x.id));
    expect(ids("Implementation 1")).toEqual(["S1", "S3", "S4"]);
    expect(ids("Implementation 2")).toEqual(["S4"]);
  });

  test("a halted Implementation keeps its acted steps right after Ended", () => {
    const halted = [...implementation1.slice(0, -1), { _tag: "Ended", code: 1 } as RunEvent];
    for (const s of both(halted)) expect(shown(s, "Implementation")?.flatMap(([, , steps]) => steps)).toEqual(["S1 1 one (text of one) unfinished", "S3 2 three (text of three) done", "S4 1 four (text of four) unfinished"]);
  });

  test("shownPlan of an entry that is not an Implementation is null", () => {
    const s = fold(live(implementation1));
    expect(shownPlan(entry(s, "Planning"), runOf(s, "implementation")!.plan)).toBe(null);
  });
});

// S26: the question the run waits on is the widget's until it is answered; then the question and the answer are the
// dashboard's last answer (issue #22). Replay and live events fold alike.
describe("the pending question", () => {
  const presented = presentedEvent("Which database?", [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "" }]);
  const pendingEvents: RunEvent[] = [started, said("a"), notified(presented), asked(1, prompts.withOffer(prompts.optionOrTextPrompt))];
  test("while pending, neither the question nor the prompt's text is an answer on the dashboard; the widget holds both", () => {
    for (const s of [fold(live(pendingEvents)), replayed(pendingEvents)]) {
      expect(runOf(s, "implementation")?.dashboard.answers).toEqual([]);
      expect(statusOf(s)).toBe("a");
      expect(runOf(s, "implementation")?.pending?.question).toEqual(presentedOf(presented));
      expect(runOf(s, "implementation")?.pending?.hint).toBe(prompts.pagePromptText("optionOrText", prompts.withOffer(prompts.optionOrTextPrompt)));
    }
  });
  test("when answered, the question and the answer are the dashboard's last answer", () => {
    const events: RunEvent[] = [...pendingEvents, { _tag: "Answered", prompt: 1, text: "1" }];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(lastAnswerOf(s)).toEqual({ key: "1-4", asked: { _tag: "Question", question: presentedOf(presented) }, answer: "SQLite — a file" });
      expect(runOf(s, "implementation")?.pending).toBe(null);
    }
  });
  test("a question presented again after a rejected answer is the next prompt's question", () => {
    const again = presentedEvent("Which database, again?", []);
    const s = fold(live([...pendingEvents, { _tag: "Answered", prompt: 1, text: "" }, notified({ _tag: "AnswerRejected" }), notified(again), asked(2, prompts.optionOrTextPrompt)]));
    expect(piecesText(runOf(s, "implementation")?.pending?.question?.question ?? [])).toBe("Which database, again?");
  });
  test("property: while a prompt is pending, its question is in no answer of the dashboard", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }).map((t) => said(`s ${t}`)), { maxLength: 4 }), fc.string({ minLength: 3, maxLength: 12 }), (before, text) => {
        const q = presentedEvent(`Q? ${text}`, []);
        const s = fold(live([started, ...before, notified(q), asked(1, prompts.optionOrTextPrompt)]));
        return (runOf(s, "implementation")?.dashboard.answers ?? []).length === 0 && runOf(s, "implementation")?.pending?.question?.question[0]?.text === `Q? ${text}`;
      }),
    );
  });
});

// S28, S12 of the task of issue #36: an answered question is kept whole, as it was presented, so that its pieces keep
// referring to their explanations on the dashboard (issue #22).
test("the question of an answer is the presented question, whole", () => {
  const question: PresentedQuestion = {
    ...presentedOf(presentedEvent("Which zod?", [{ label: "A", description: "a" }])),
    question: [{ text: "Which ", ref: "", code: false }, { text: "zod", ref: "z", code: false }, { text: "?", ref: "", code: false }],
    explanations: [shownOf({ id: "z", term: "zod", senses: ["A library."] })],
    attached: { kind: "request", blocks: [{ kind: "code", text: "npm i zod" }, { kind: "document", markdown: "# Doc" }] },
  };
  const s = fold(live([started, notified({ _tag: "QuestionPresented", question }), asked(1, prompts.optionOrTextPrompt), { _tag: "Answered", prompt: 1, text: "x" }]));
  expect(lastAnswerOf(s)).toEqual({ key: "1-3", asked: { _tag: "Question", question }, answer: "x" });
});

test("property: an answered question is kept exactly as it was presented", () => {
  const piece = fc.record({ text: fc.string({ maxLength: 6 }), ref: fc.constantFrom("", "a"), code: fc.boolean() });
  const block = fc.oneof(
    fc.record({ kind: fc.constant("paragraph" as const), pieces: fc.array(piece, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant("list" as const), items: fc.array(fc.record({ level: fc.nat(2), pieces: fc.array(piece, { maxLength: 2 }) }), { maxLength: 2 }) }),
    fc.record({ kind: fc.constant("code" as const), text: fc.string({ maxLength: 6 }) }),
    fc.record({ kind: fc.constant("document" as const), markdown: fc.string({ maxLength: 6 }) }),
  );
  fc.assert(
    fc.property(fc.array(block, { maxLength: 3 }), fc.array(piece, { minLength: 1, maxLength: 3 }), fc.array(block, { maxLength: 2 }), (context, text, details) => {
      const question: PresentedQuestion = { ...presentedOf(presentedEvent("q", [])), context: { blocks: context, by: "agent" }, history: [], question: text, attached: attachedOf("reviewFacts", details), explanations: [shownOf({ id: "a", term: "t", senses: ["e"] })] };
      const s = fold(live([started, notified({ _tag: "QuestionPresented", question }), asked(1, prompts.optionOrTextPrompt), { _tag: "Answered", prompt: 1, text: "x" }]));
      const entry = lastAnswerOf(s);
      return entry?.asked._tag === "Question" && JSON.stringify(entry.asked.question) === JSON.stringify(question);
    }),
    { numRuns: 100 },
  );
});

// Issue #87 (decision G-R1-1): the run's shared state of the page, kept by the version the server gave it.
describe("the shared state of a run's page", () => {
  const scope = (decision: number, entry: string) => ({ _tag: "DecisionEntry" as const, decision, entry });
  const state = (version: number, ...open: ReturnType<typeof scope>[]) => ({ version, choices: open.map((sc) => ({ scope: sc, open: true })) });
  test("a ui frame applies to the run it names, and one of a lower version is ignored", () => {
    const s = fold([...live([started]), { type: "ui", run: 1, state: state(2, scope(1, "e1")) }]);
    expect(runOf(s, "implementation")?.ui).toEqual(state(2, scope(1, "e1")));
    expect(runOf(fold([{ type: "ui", run: 1, state: state(1) }], s), "implementation")?.ui).toEqual(state(2, scope(1, "e1")));
    expect(runOf(fold([{ type: "ui", run: 1, state: state(3) }], s), "implementation")?.ui).toEqual(state(3));
  });
  test("the replay sets each replayed run's state", () => {
    const s = fold([hello(2), { type: "replay", runs: [{ id: 1, events: stamp([started]) }, { id: 2, events: stamp([started]) }], ui: [{ run: 1, state: state(1, scope(1, "a")) }, { run: 2, state: state(4, scope(2, "b")) }] }]);
    expect(lastOf(s, "implementation")?.ui).toEqual(state(1, scope(1, "a")));
    expect(runOf(s, "implementation")?.ui).toEqual(state(4, scope(2, "b")));
  });
  test("a ui frame for the last run applies to it", () => {
    const s = fold([hello(2), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started]) }, { id: 2, events: stamp([started]) }] }, { type: "ui", run: 1, state: state(1, scope(1, "a")) }]);
    expect(lastOf(s, "implementation")?.ui).toEqual(state(1, scope(1, "a")));
    expect(runOf(s, "implementation")?.ui).toEqual(state(0));
  });
  test("a hello of another incarnation drops the state with the runs", () => {
    const s = fold([...live([started]), { type: "ui", run: 1, state: state(2, scope(1, "e1")) }, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation: "b" }]);
    expect(runOf(s, "implementation")).toBe(null);
  });
  test("after any order of the server's states, the view holds the state of the highest version", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat({ max: 3 }), fc.string({ maxLength: 2 })), { minLength: 1, maxLength: 6 }), fc.integer(), (scopes, seed) => {
        const states = scopes.map(([d, e], i) => state(i + 1, scope(d, e)));
        const order = fc.sample(fc.shuffledSubarray(states, { minLength: states.length }), { numRuns: 1, seed })[0];
        const s = fold([...live([started]), ...order.map((st): ServerMessage => ({ type: "ui", run: 1, state: st }))]);
        expect(runOf(s, "implementation")?.ui).toEqual(states.at(-1));
      }),
      { numRuns: 50, seed: 20261006 },
    );
  });
});

// Issue #68: a wait for a usage limit, from its start to its scheduled end, shown with what is waited for and until when.
describe("a wait for a usage limit", () => {
  const FROM = Date.UTC(2026, 8, 30, 5, 32);
  const UNTIL = FROM + 9_060_000;
  const call: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-1" };
  const failed: UiEvent = { _tag: "AgentCallEnded", agent: "claude", ok: false, callId: "claude-1" };
  const waitingFor: UiEvent = { _tag: "UsageLimitWaiting", agent: "claude", purpose: "planning", limitType: "five_hour", basis: { kind: "reset" }, fromMs: FROM, untilMs: UNTIL };
  const lifted: UiEvent = { _tag: "UsageLimitLifted", agent: "claude", waitedMs: 9_060_000 };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("the wait sets limitWait, and the activity line names the limit and the instant it lifts", () => {
    for (const s of both([started, notified(call), notified(failed), notified(waitingFor)])) {
      expect(runOf(s, "implementation")?.limitWait).toEqual({ agent: "claude", purpose: "planning", limitType: "five_hour", basis: { kind: "reset" }, fromMs: FROM, untilMs: UNTIL });
      expect(statusOf(s)).toBe(`Claude — ${prompts.usageLimitActivity("five_hour", { kind: "reset" }, UNTIL)}`);
      expect(statusOf(s)).toContain("five-hour session limit");
      expect(statusOf(s)).toContain("08:03 UTC");
    }
  });

  // Issue #170: the activity line of each basis is the prompts' text for that basis (one event gives both sides).
  test("the activity line of each basis is usageLimitActivity for it", () => {
    for (const basis of [{ kind: "reset" }, { kind: "pastReset", namedMs: FROM - 60_000 }, { kind: "noKnownEnd", attempt: 2 }] as const) {
      const event: UiEvent = { _tag: "UsageLimitWaiting", agent: "claude", purpose: "planning", limitType: null, basis, fromMs: FROM, untilMs: UNTIL };
      for (const s of both([started, notified(call), notified(failed), notified(event)])) expect(statusOf(s)).toBe(`Claude — ${prompts.usageLimitActivity(event.limitType, event.basis, event.untilMs)}`);
    }
  });

  test("the lift, the run's end, and the next call's start each clear it", () => {
    for (const s of both([started, notified(call), notified(failed), notified(waitingFor), notified(lifted)])) expect(runOf(s, "implementation")?.limitWait).toBe(null);
    for (const s of both([started, notified(call), notified(failed), notified(waitingFor), { _tag: "Ended", code: 130 }])) expect(runOf(s, "implementation")?.limitWait).toBe(null);
    for (const s of both([started, notified(call), notified(failed), notified(waitingFor), notified(lifted), notified(call)])) expect(statusOf(s)).toBe("Claude — planning");
  });

  test("limitWaitView: the fraction elapsed and the time remaining at an instant", () => {
    const wait = { agent: "claude" as const, limitType: "five_hour", fromMs: FROM, untilMs: UNTIL };
    expect(limitWaitView(wait, FROM)).toEqual({ percent: 0, remainingMs: 9_060_000 });
    expect(limitWaitView(wait, FROM + 4_530_000)).toEqual({ percent: 50, remainingMs: 4_530_000 });
    expect(limitWaitView(wait, UNTIL + 5000)).toEqual({ percent: 100, remainingMs: 0 });
  });

  test("property: percent lies in [0, 100] and does not fall as time passes; 0 at or before the start, 100 with nothing left at or after the end", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: -1e9, max: 2e9 }), fc.nat(1e9), (fromMs, span, t, later) => {
        const wait = { agent: "claude" as const, limitType: null, fromMs, untilMs: fromMs + span };
        const a = limitWaitView(wait, fromMs + t);
        const b = limitWaitView(wait, fromMs + t + later);
        expect(a.percent).toBeGreaterThanOrEqual(0);
        expect(a.percent).toBeLessThanOrEqual(100);
        expect(b.percent).toBeGreaterThanOrEqual(a.percent);
        if (t <= 0) expect(a.percent).toBe(0);
        if (t >= span) expect(a).toEqual({ percent: 100, remainingMs: 0 });
      }),
      { numRuns: 300, seed: 20261007 },
    );
  });
});

// Issue #63: the rail collapses. Everything is collapsed at the start and opened by the run as it arrives; the user's
// choice wins over the automatic opening; a branch is held open while something inside it needs the user; a collapsed
// row carries the running step's label, its condition in one word and its tally of steps.
describe("the rail as a tree that collapses", () => {
  const foreseen = (questions: boolean, iterations: number) => notified({ _tag: "PhasesForeseen", phases: phasesOf(questions, iterations) });
  const began = (phase: Phase) => notified({ _tag: "PhaseBegan", phase });
  const ended = (phase: Phase, result = "converged") => notified({ _tag: "PhaseEnded", phase, result } as UiEvent);
  const call = (purpose = "execution") => notified({ _tag: "AgentCallStarted", agent: "claude", purpose, callId: "claude-1" });
  const callEnded = notified({ _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-1" });
  type Status = "pending" | "started" | "done" | "unfinished";
  const layout = [["S1", "S2", "S3"], ["S4"]] as const;
  const planWith = (statuses: Record<string, Status>) => ({
    stages: layout.map((ids, s) => ({ number: s + 1, title: `stage ${s + 1}`, steps: ids.map((id) => ({ id, number: Number(id.slice(1)), label: `step ${id}`, text: id, status: statuses[id] ?? ("pending" as const) })) })),
  });
  /** The reports in order, each PlanChanged carrying the plan as recorded after it. */
  const reports = (list: readonly (readonly [string, "started" | "done"])[], from: Record<string, Status> = {}): RunEvent[] => {
    const statuses: Record<string, Status> = { ...from };
    return list.map(([id, status]) => {
      statuses[id] = status;
      return notified({ _tag: "PlanChanged", phase: 1, plan: planWith(statuses), step: { id, status } });
    });
  };
  const planning: Phase = { kind: "planning", n: 1 };
  const implementation: Phase = { kind: "execution", n: 1 };
  const flags = (...list: readonly UiFlag[]): ServerMessage => ({ type: "ui", run: 1, state: list.reduce(withFlag, emptyUiState) });
  const phaseScope = (phase: Phase): UiScope => ({ _tag: "RailPhase", phase: bandKey(phase) });
  const stageScope = (n: number): UiScope => ({ _tag: "RailBranch", phase: bandKey(implementation), branch: `stage:current-${n}` });
  const viewOf = (s: ViewState) => railView(runOf(s, "implementation")!, executing(runOf(s, "implementation")!), runOf(s, "implementation")!.busy);
  /** Issue #110: a row with children is a disclosure; the tests of its open state read it through this, which fails on a plain row. */
  const disclosure = (node: NodeView | undefined): Disclosure => {
    expect(node?._tag).toBe("Disclosure");
    return node as Disclosure;
  };
  const rawPhase = (s: ViewState, phase: Phase) => viewOf(s).phases.find((p) => samePhaseKey(p.entry.phase, phase))!.node;
  const phaseNode = (s: ViewState, phase: Phase) => disclosure(rawPhase(s, phase));
  const samePhaseKey = (a: Phase, b: Phase) => bandKey(a) === bandKey(b);
  const rawBranch = (s: ViewState, phase: Phase, key: string) => viewOf(s).phases.find((p) => samePhaseKey(p.entry.phase, phase))!.branches.get(key);
  const branch = (s: ViewState, phase: Phase, key: string) => disclosure(rawBranch(s, phase, key));
  /** A row's open state, or "plain" for a row with nothing to disclose. */
  const openOf = (node: NodeView | undefined) => (node?._tag === "Disclosure" ? node.open : "plain");
  const planned = notified({ _tag: "PlanChanged", phase: 1, plan: planWith({}), step: null });
  /** The first cycle of planning phase 1: Planning's first child, which makes its row a disclosure (issue #110). */
  const planRound = notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 });
  const executingS1: RunEvent[] = [started, foreseen(false, 1), began(planning), planRound, planned, ended(planning), began(implementation), call(), ...reports([["S1", "started"]])];

  test("everything is collapsed at the start", () => {
    const s = fold(live([started, foreseen(true, 1), planned]));
    // Gather Requirements holds its foreseen steps and Implementation its plan; Planning and the code review hold nothing yet.
    expect(viewOf(s).phases.map((p) => [p.entry.phase.kind, openOf(p.node)])).toEqual([["questions", false], ["planning", "plain"], ["execution", false], ["work", "plain"]]);
    for (const p of viewOf(s).phases) for (const b of p.branches.values()) expect(openOf(b)).toBe(p.entry.phase.kind === "questions" ? "plain" : false);
    expect([...(viewOf(s).phases.find((p) => p.entry.phase.kind === "execution")?.branches.keys() ?? [])]).toEqual(["stage:current-1", "stage:current-2"]);
  });

  test("a phase opens when it begins and stays open when it ends; a stage opens when one of its steps begins", () => {
    const s = fold(live([started, foreseen(false, 1), began(planning), planRound]));
    expect(phaseNode(s, planning).open).toBe(true);
    expect(rawPhase(s, implementation)).toEqual(PLAIN);
    const after = fold(live(executingS1));
    expect(phaseNode(after, planning).open).toBe(true);
    expect(phaseNode(after, implementation).open).toBe(true);
    expect(branch(after, implementation, "stage:current-1")?.open).toBe(true);
    expect(branch(after, implementation, "stage:current-2")?.open).toBe(false);
  });

  test("a step of Gather Requirements opens when it begins", () => {
    const s = fold(live([started, foreseen(true, 1), began({ kind: "questions" }), notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 })]));
    expect(branch(s, { kind: "questions" }, "step:formulate")?.open).toBe(true);
    expect(rawBranch(s, { kind: "questions" }, "step:clarification")).toEqual(PLAIN);
  });

  test("a phase the user closed stays closed when it begins; one he opened stays open; one he never touched follows the run", () => {
    const closed = fold([...live([started, foreseen(false, 1)]), flags({ scope: phaseScope(planning), open: false }), ...live([began(planning), planRound]).slice(2).map((m, i) => (m.type === "event" ? { ...m, seq: 2 + i } : m))]);
    expect(phaseNode(closed, planning).open).toBe(false);
    const opened = fold([...live([started, foreseen(false, 1), planned]), flags({ scope: phaseScope(implementation), open: true })]);
    expect(phaseNode(opened, implementation).open).toBe(true);
    expect(rawPhase(opened, planning)).toEqual(PLAIN);
    const untouched = fold([...live([started, foreseen(false, 1), began(planning), planRound]), flags({ scope: phaseScope(implementation), open: true })]);
    expect(phaseNode(untouched, planning).open).toBe(true);
  });

  test("a closed phase is held open by a prompt inside it, and returns to the user's choice once the prompt is answered", () => {
    const close = flags({ scope: phaseScope(planning), open: false });
    const waiting = fold([...live([started, foreseen(false, 1), began(planning), planRound, asked(1, prompts.decisionPrompt)]), close]);
    expect(phaseNode(waiting, planning)).toMatchObject({ open: true, held: true });
    const answered = fold([...live([started, foreseen(false, 1), began(planning), planRound, asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" }]), close]);
    expect(phaseNode(answered, planning)).toMatchObject({ open: false, held: false });
  });

  test("a halt holds the stopped phase open", () => {
    const s = fold([...live([started, foreseen(false, 1), began(planning), planRound, { _tag: "Ended", code: 1 }]), flags({ scope: phaseScope(planning), open: false })]);
    expect(phaseNode(s, planning)).toMatchObject({ open: true, held: true });
  });

  // P1-R1-1: after a halt, the stage of the step the halted execution call was working on.
  test("a halt after the execution call ended holds the phase and the stage of the step last reported running", () => {
    const events: RunEvent[] = [started, foreseen(false, 1), began(planning), planRound, planned, ended(planning), began(implementation), call(), ...reports([["S4", "started"], ["S4", "done"], ["S1", "started"]]), callEnded, { _tag: "Ended", code: 1 }];
    const s = fold([...live(events), flags({ scope: phaseScope(implementation), open: false }, { scope: stageScope(1), open: false }, { scope: stageScope(2), open: false })]);
    const entry = runOf(s, "implementation")!.timeline.find((e) => e.phase.kind === "execution")!;
    expect(entry.currentStep).toBe(null);
    expect(entry.lastStarted).toBe("S1");
    expect(phaseNode(s, implementation)).toMatchObject({ open: true, held: true });
    expect(branch(s, implementation, "stage:current-1")).toMatchObject({ open: true, held: true });
    expect(branch(s, implementation, "stage:current-2")).toMatchObject({ open: false, held: false });
  });

  // P1-R2-1: the question asked after the execution call ended needing the user's input.
  test("the question after an execution call that needs the user holds the phase and the stage until it is answered", () => {
    const close = flags({ scope: phaseScope(implementation), open: false }, { scope: stageScope(1), open: false });
    const prefix: RunEvent[] = [...executingS1, callEnded, notified({ _tag: "ExecutionEnded", phase: 1, outcome: { status: "needs_input", question: "Which?", summary: "" } } as UiEvent), ended(implementation, "needs_input"), asked(1, prompts.decisionPrompt)];
    const waiting = fold([...live(prefix), close]);
    expect(phaseNode(waiting, implementation)).toMatchObject({ open: true, held: true });
    expect(branch(waiting, implementation, "stage:current-1")).toMatchObject({ open: true, held: true });
    const answered = fold([...live([...prefix, { _tag: "Answered", prompt: 1, text: "go on" }]), close]);
    expect(phaseNode(answered, implementation)).toMatchObject({ open: false, held: false });
    expect(branch(answered, implementation, "stage:current-1")).toMatchObject({ open: false, held: false });
    const later = fold([...live([...prefix, { _tag: "Answered", prompt: 1, text: "go on" }, began({ kind: "planning", n: 2 }), asked(2, prompts.decisionPrompt)]), close]);
    expect(phaseNode(later, implementation).held).toBe(false);
    expect(branch(later, implementation, "stage:current-1")?.held).toBe(false);
  });

  // W1-R1-1: a halt while the question after the execution call waits, when no phase is active any more.
  test("a halt after the phase has ended holds the phase and the stage of the step last reported running", () => {
    const close = flags({ scope: phaseScope(implementation), open: false }, { scope: stageScope(1), open: false }, { scope: stageScope(2), open: false });
    const events: RunEvent[] = [...executingS1, callEnded, notified({ _tag: "ExecutionEnded", phase: 1, outcome: { status: "needs_input", question: "Which?", summary: "" } } as UiEvent), ended(implementation, "needs_input"), asked(1, prompts.decisionPrompt), { _tag: "Ended", code: 1 }];
    const s = fold([...live(events), close]);
    expect(phaseNode(s, implementation)).toMatchObject({ open: true, held: true });
    expect(branch(s, implementation, "stage:current-1")).toMatchObject({ open: true, held: true });
    // An ended Implementation shows only the steps it acted on, so stage 2 is not shown at all; it is not held.
    const shown2 = rawBranch(s, implementation, "stage:current-2");
    expect(shown2?._tag === "Disclosure" && shown2.held).toBe(false);
    const planningHalt = fold([...live([started, foreseen(false, 1), began(planning), planRound, ended(planning), { _tag: "Ended", code: 1 }]), flags({ scope: phaseScope(planning), open: false })]);
    expect(phaseNode(planningHalt, planning)).toMatchObject({ open: true, held: true });
  });

  test("a collapsed phase and stage carry the running step's label while it runs", () => {
    const s = fold(live(executingS1));
    expect(phaseNode(s, implementation).collapsed.running).toBe(`${prompts.stageHeading(1, "stage 1")} — ${prompts.planStepLabel(1, "step S1")}`);
    expect(branch(s, implementation, "stage:current-1")?.collapsed.running).toBe(prompts.planStepLabel(1, "step S1"));
    expect(branch(s, implementation, "stage:current-2")?.collapsed.running).toBe(null);
    expect(phaseNode(fold(live([...executingS1, callEnded])), implementation).collapsed.running).toBe(null);
    const gather = fold(live([started, foreseen(true, 1), began({ kind: "questions" }), call("questions")]));
    expect(phaseNode(gather, { kind: "questions" }).collapsed.running).toBe(prompts.stepLabel("formulate"));
  });

  test("the condition in each of its three cases, and a step begun and never finished leaves the branch partially completed", () => {
    const none = fold(live([started, foreseen(false, 1), planned]));
    expect(branch(none, implementation, "stage:current-1")?.collapsed.condition).toBe("notStarted");
    const partial = fold(live([...executingS1, callEnded]));
    expect(branch(partial, implementation, "stage:current-1")?.collapsed.condition).toBe("partial");
    expect(phaseNode(partial, implementation).collapsed.condition).toBe("partial");
    const complete = fold(live([...executingS1, ...reports([["S4", "started"], ["S4", "done"]], { S1: "started" })]));
    expect(branch(complete, implementation, "stage:current-2")?.collapsed.condition).toBe("completed");
    expect(rawPhase(fold(live([started, foreseen(false, 1)])), planning)).toEqual(PLAIN);
  });

  test("the tally counts the steps complete of the steps hidden", () => {
    const s = fold(live([...executingS1, ...reports([["S1", "done"]], { S1: "started" })]));
    expect(branch(s, implementation, "stage:current-1")?.collapsed.tally).toEqual({ done: 1, total: 3 });
    expect(phaseNode(s, implementation).collapsed.tally).toEqual({ done: 1, total: 4 });
  });

  // Issue #110: a row is a disclosure exactly when it has something beneath it.
  test("a row is plain exactly when it has nothing to disclose, and gains its disclosure with its first child", () => {
    const bare = fold(live([started, foreseen(true, 1), began({ kind: "questions" })]));
    expect(rawBranch(bare, { kind: "questions" }, "step:formulate")).toEqual(PLAIN);
    expect(rawPhase(bare, planning)).toEqual(PLAIN);
    const withRound = fold(live([started, foreseen(true, 1), began({ kind: "questions" }), notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 })]));
    expect(branch(withRound, { kind: "questions" }, "step:formulate").open).toBe(true);
    const planningBare = fold(live([started, foreseen(false, 1), began(planning)]));
    expect(rawPhase(planningBare, planning)).toEqual(PLAIN);
    expect(phaseNode(fold(live([started, foreseen(false, 1), began(planning), planRound])), planning).open).toBe(true);
  });

  test("railView's rows follow the table of what has children, for any timeline entry", () => {
    const group = { subject: { plan: 1 }, heading: "h", rounds: [], corrections: 0, result: null, done: false } as const;
    const recorded = (id: string) => ({ id, number: 1, label: id, text: id, status: "pending" as const });
    const arbEntry = fc.record({
      groups: fc.integer({ min: 0, max: 2 }),
      steps: fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 2 }),
      plan: fc.option(fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }), { nil: null }),
    });
    fc.assert(
      fc.property(arbEntry, ({ groups, steps, plan }) => {
        const base = emptyRun(1);
        const kinds = ["formulate", "terms", "clarification"] as const;
        const entry: TimelineEntry = {
          phase: { kind: "execution", n: 1 }, label: "Implementation", state: "active" as const, began: null, ended: null, currentStep: null, lastStarted: null, acted: [], record: null, result: null,
          groups: Array.from({ length: groups }, () => group),
          steps: steps.map((g, i) => ({ kind: kinds[i], label: kinds[i], state: "done" as const, count: null, base: { answered: 0, total: 0 }, groups: Array.from({ length: g }, () => group) })),
          plan: plan === null ? null : { stages: plan.map((n, k) => ({ key: `current-${k + 1}`, number: k + 1, title: `t${k}`, steps: Array.from({ length: n }, (_, j) => recorded(`S${k}-${j}`)) })) },
        };
        const view = railView({ ...base, timeline: [entry] }, false, false).phases[0];
        expect(view.node._tag).toBe(groups > 0 || steps.length > 0 || plan !== null ? "Disclosure" : "Plain");
        steps.forEach((g, i) => expect(view.branches.get(`step:${kinds[i]}`)?._tag).toBe(g > 0 ? "Disclosure" : "Plain"));
        (plan ?? []).forEach((n, k) => expect(view.branches.get(`stage:current-${k + 1}`)?._tag).toBe(n > 0 ? "Disclosure" : "Plain"));
      }),
      { numRuns: 200 },
    );
  });

  // Issue #115: the three states a disclosure row shows, derived from its open and held flags; held implies open.
  test("disclosureStateOf: held when held, open when open and not held, closed otherwise", () => {
    const scope: UiScope = { _tag: "RailPhase", phase: "planning-1" };
    const collapsed = { running: null, condition: null, tally: null };
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (held, chosenOpen) => {
        const node: Disclosure = { _tag: "Disclosure", scope, open: held || chosenOpen, held, collapsed };
        expect(disclosureStateOf(node)).toBe(held ? "held" : chosenOpen ? "open" : "closed");
      }),
      { numRuns: 50 },
    );
  });

  test("disclosureStateOf over railView: untouched and not begun is closed, opened by the user is open, held by a prompt is held", () => {
    const notBegun = fold(live([started, foreseen(false, 1), planned]));
    expect(disclosureStateOf(phaseNode(notBegun, implementation))).toBe("closed");
    const opened = fold([...live([started, foreseen(false, 1), planned]), flags({ scope: phaseScope(implementation), open: true })]);
    expect(disclosureStateOf(phaseNode(opened, implementation))).toBe("open");
    const waiting = fold([...live([started, foreseen(false, 1), began(planning), planRound, asked(1, prompts.decisionPrompt)]), flags({ scope: phaseScope(planning), open: false })]);
    expect(disclosureStateOf(phaseNode(waiting, planning))).toBe("held");
  });

  // Issue #114: a stage's glyph in the vocabulary of its steps' marks.
  test("stageGlyph: not begun, begun and not finished, done", () => {
    expect([stageGlyph("notStarted"), stageGlyph("partial"), stageGlyph("completed")]).toEqual(["○", "◐", "✓"]);
  });

  test("conditionOf: not started when none started, completed when all finished, partially completed otherwise", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }).chain((total) => fc.integer({ min: 0, max: total }).chain((started) => fc.tuple(fc.constant(total), fc.constant(started), fc.integer({ min: 0, max: started })))), ([total, started, finished]) => {
        const expected = started === 0 ? "notStarted" : finished === total ? "completed" : "partial";
        expect(conditionOf(started, finished, total)).toBe(expected);
      }),
      { numRuns: 200 },
    );
    expect(conditionOf(0, 0, 0)).toBe(null);
  });
});

// Issue #63: the wait before a retry is known exactly, so the page counts it down; the retried call's start ends it.
describe("the countdown of a retry's wait", () => {
  const call: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" };
  const failed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false, callId: "codex-1" };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", purpose: "review", attempt: 1, of: 3, delaySeconds: 5, fault: "stream disconnected", fromMs: 1000, untilMs: 6000 };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];
  test("a TransportRetrying sets the wait; the retried call's start and the recovery clear it", () => {
    for (const s of both([started, notified(call), notified(failed), notified(retrying)])) expect(runOf(s, "implementation")?.retry?.wait).toEqual({ fromMs: 1000, untilMs: 6000 });
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call)])) {
      expect(runOf(s, "implementation")?.retry?.wait).toBe(null);
      expect(statusOf(s)).toBe("Codex — review — connection lost, retry 1 of 3 (stream disconnected)");
    }
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified({ _tag: "TransportRecovered", agent: "codex" })])) expect(runOf(s, "implementation")?.retry).toBe(null);
  });
  // Issue #171: a tracker request's repeat is counted down the same way, named by its tracker.
  test("a TrackerRetrying sets the wait and an activity naming the tracker; TrackerRecovered clears it", () => {
    const trackerRetrying: UiEvent = { _tag: "TrackerRetrying", tracker: "GitHub", what: "reading item 155", attempt: 2, of: 5, delaySeconds: 30, fault: "no answer", fromMs: 1000, untilMs: 31_000 };
    for (const s of both([started, notified(trackerRetrying)])) {
      expect(runOf(s, "implementation")?.retry).toEqual({ agent: "tracker", purpose: null, text: "connection lost, retry 2 of 5 (no answer)", wait: { fromMs: 1000, untilMs: 31_000 } });
      expect(statusOf(s)).toBe("GitHub — connection lost, retry 2 of 5 (no answer)");
    }
    for (const s of both([started, notified(call), notified(trackerRetrying), notified({ _tag: "TrackerRecovered", tracker: "GitHub" })])) {
      expect(runOf(s, "implementation")?.retry).toBe(null);
      expect(statusOf(s)).toBe("Codex — review");
    }
  });
  test("countdownView: the fraction elapsed and the time remaining while the wait lasts, nothing at and after its end", () => {
    expect(countdownView({ fromMs: 1000, untilMs: 6000 }, 1000)).toEqual({ percent: 0, remainingMs: 5000 });
    expect(countdownView({ fromMs: 1000, untilMs: 6000 }, 3500)).toEqual({ percent: 50, remainingMs: 2500 });
    expect(countdownView({ fromMs: 1000, untilMs: 6000 }, 5999)).not.toBe(null);
    expect(countdownView({ fromMs: 1000, untilMs: 6000 }, 6000)).toBe(null);
    expect(countdownView({ fromMs: 1000, untilMs: 6000 }, 9000)).toBe(null);
  });
  test("countdownView never falls in percentage nor rises in time remaining as the instant advances", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1e9 }), fc.integer({ min: 1, max: 1e7 }), fc.integer({ min: -1e7, max: 2e7 }), fc.nat({ max: 1e7 }), (fromMs, span, t, later) => {
        const wait = { fromMs, untilMs: fromMs + span };
        const a = countdownView(wait, fromMs + t);
        const b = countdownView(wait, fromMs + t + later);
        if (a === null) expect(b).toBe(null);
        if (a !== null && b !== null) {
          expect(b.percent).toBeGreaterThanOrEqual(a.percent);
          expect(b.remainingMs).toBeLessThanOrEqual(a.remainingMs);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// Issue #120, S11: one run, its last run, its items and its refusal per mode; a run's events go to the mode its Started named.
describe("two modes", () => {
  const startedIn = (mode: "refinement" | "implementation", id: string): RunEvent => ({ ...started, mode, item: { id, title: `item ${id}` } } as RunEvent);
  const events = (run: number, list: readonly RunEvent[]): ServerMessage[] => stamp(list).map(({ time, event }, seq): ServerMessage => ({ type: "event", run, seq, time, event }));
  const helloBoth: ServerMessage = { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [1], implementation: 2 }, incarnation: "a" };
  const refinement = [startedIn("refinement", "11"), said("refining"), asked(1, prompts.interviewMessagePrompt)];
  const implementation = [startedIn("implementation", "1"), said("implementing"), notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), asked(1, prompts.decisionPrompt)];

  test("property: interleaved events of two runs fold to the two modes' views of each run folded alone", () => {
    const a = events(1, refinement);
    const b = events(2, implementation);
    const alone = (messages: readonly ServerMessage[]) => fold([helloBoth, { type: "replay", ui: [], runs: [] }, ...messages]);
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: a.length + b.length, maxLength: a.length + b.length }), (picks) => {
        const [qa, qb] = [[...a], [...b]];
        const merged = picks.map((first) => ((first && qa.length > 0) || qb.length === 0 ? qa.shift()! : qb.shift()!));
        const both = alone(merged);
        expect(runOf(both, "refinement")).toEqual(runOf(alone(a), "refinement"));
        expect(runOf(both, "implementation")).toEqual(runOf(alone(b), "implementation"));
      }),
      { numRuns: 50 },
    );
  });

  test("a replay of four runs places each run in its mode, the newest its run and the one before its last", () => {
    const run = (id: number, mode: "refinement" | "implementation") => ({ id, events: stamp([startedIn(mode, `${id}`), { _tag: "Ended", code: 0 } as RunEvent]) });
    const s = fold([helloBoth, { type: "replay", ui: [], runs: [run(1, "refinement"), run(2, "implementation"), run(3, "refinement"), run(4, "implementation")] }]);
    expect([runOf(s, "refinement")?.id, lastOf(s, "refinement")?.id, runOf(s, "implementation")?.id, lastOf(s, "implementation")?.id]).toEqual([3, 1, 4, 2]);
    expect(s.modes.refinement.current).toEqual([1]);
  });

  test("a prompt pending in one mode leaves the other mode's prompt null", () => {
    const s = fold([helloBoth, { type: "replay", ui: [], runs: [] }, ...events(1, refinement), ...events(2, [startedIn("implementation", "1"), said("implementing")])]);
    expect(runOf(s, "refinement")?.pending?.asked.prompt).toBe(1);
    expect(runOf(s, "implementation")?.pending).toBe(null);
  });
});

describe("the tab shown before the user chooses one", () => {
  const startedIn = (mode: "refinement" | "implementation"): RunEvent => ({ ...started, mode, item: { id: "1", title: "t" } } as RunEvent);
  const helloImpl: ServerMessage = { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: 1 }, incarnation: "a" };
  const replayOf = (mode: "refinement" | "implementation", more: readonly RunEvent[] = []): ServerMessage => ({ type: "replay", ui: [], runs: [{ id: 1, events: stamp([startedIn(mode), ...more]) }] });

  test("a replay shows the tab of a run in progress; a choice of the user stands", () => {
    expect(fold([helloImpl, replayOf("implementation")]).selected).toBe("implementation");
    expect(fold([helloImpl, replayOf("implementation", [{ _tag: "Ended", code: 0 }])]).selected).toBe("refinement");
    expect(fold([replayOf("implementation")], selectMode(fold([helloImpl]), "refinement")).selected).toBe("refinement");
  });
});

// Issue #142 (requirements Q3): the Refinement tab's control shows the configured choice of terms until the user changes
// it; his choice applies to the next refinement alone, and the next shows the configured value again.
describe("the choice of terms", () => {
  const items = [{ id: "11", title: "t", excerpt: "e", url: null, sentBack: 0, preparation: null }];
  const listed = (terms: "checked" | "unchecked" | "onRequest"): ServerMessage => ({ type: "items", mode: "refinement", result: { _tag: "Listed", items, terms } });
  const helloAt = (incarnation: string): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation });
  const startedRefinement: RunEvent = { ...started, mode: "refinement", item: { id: "11", title: "t" } } as RunEvent;

  test("the listing's value is shown; a choice replaces it, survives a Refresh, and a refinement's Started resets it", () => {
    expect(shownTerms(fold([helloAt("a")]))).toBe(null);
    const s = fold([helloAt("a"), listed("checked")]);
    expect(shownTerms(s)).toBe("checked");
    const chosen = chooseTerms(s, "onRequest");
    expect(shownTerms(chosen)).toBe("onRequest");
    expect(shownTerms(fold([listed("checked")], chosen))).toBe("onRequest");
    const afterStart = fold([{ type: "replay", ui: [], runs: [] }, { type: "event", run: 1, seq: 0, time: "2026-10-13T00:00:00.000Z", event: startedRefinement }], chosen);
    expect(shownTerms(afterStart)).toBe("checked");
  });

  // W1-R1-2 of work review 1: a refinement whose Started the page first sees in a replay used the choice like one seen live.
  test("a replay revealing a new refinement resets the choice; a replay of a refinement already known keeps it", () => {
    const replayRun = (id: number): ServerMessage => ({ type: "replay", ui: [], runs: [{ id, events: stamp([startedRefinement]) }] });
    const chosen = chooseTerms(fold([helloAt("a"), { type: "replay", ui: [], runs: [] }, listed("unchecked")]), "onRequest");
    expect(shownTerms(fold([helloAt("a"), replayRun(1)], chosen))).toBe("unchecked");
    const known = fold([{ type: "event", run: 1, seq: 0, time: "2026-10-13T00:00:00.000Z", event: startedRefinement }], chosen);
    const choosing = chooseTerms(known, "onRequest");
    expect(shownTerms(fold([helloAt("a"), replayRun(1)], choosing))).toBe("onRequest");
  });

  test("a hello of another incarnation drops the choice with the items; the implementation tab's items carry none", () => {
    const chosen = chooseTerms(fold([helloAt("a"), listed("unchecked")]), "checked");
    expect(shownTerms(fold([helloAt("a")], chosen))).toBe("checked");
    expect(shownTerms(fold([helloAt("b")], chosen))).toBe(null);
    const impl = fold([helloAt("a"), { type: "items", mode: "implementation", result: { _tag: "Listed", items } }]);
    expect(impl.modes.implementation.items).toEqual({ _tag: "Listed", items });
    expect(shownTerms(impl)).toBe(null);
  });
});

// Issue #142 (S15): "/terms" answers the prompt a decision's analysis belongs to, yet the same question is asked again
// with its explanations; the analysis stays for the next prompt, and its question is the explained one.
describe("an analysis across the request for terms", () => {
  const options = [{ label: "A", description: "" }, { label: "B", description: "" }];
  const plainQuestion = presentedOf(presentedEvent("A or B?", options));
  const explained: PresentedQuestion = { ...plainQuestion, explanations: Result.getOrThrow(shownExplanations([{ id: "t", term: "A", senses: ["the first"] }])) };
  const analyzedEvent: UiEvent = { _tag: "DecisionAnalyzed", decision: 1, question: "A or B?", presented: plainQuestion, options, analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } };
  const offered = prompts.withTermsOffer(prompts.withOffer(prompts.optionOrTextPrompt));
  const upTo = (again: PresentedQuestion): RunEvent[] => [
    started,
    notified({ _tag: "QuestionPresented", question: plainQuestion }),
    asked(1, offered),
    { _tag: "Answered", prompt: 1, text: "/decide" },
    notified(analyzedEvent),
    notified({ _tag: "QuestionPresented", question: plainQuestion }),
    asked(2, prompts.withTermsOffer(prompts.optionOrTextPrompt)),
    { _tag: "Answered", prompt: 2, text: "/terms" },
    notified({ _tag: "QuestionExplained", question: again }),
    notified({ _tag: "QuestionPresented", question: again }),
    asked(3, prompts.optionOrTextPrompt),
  ];

  test("the analysis is held for the prompt after the request, with the explained question", () => {
    for (const s of [fold(live(upTo(explained))), replayed(upTo(explained))]) {
      const analysis = runOf(s, "implementation")?.analysis;
      expect(analysis?.prompt).toBe(3);
      expect(analysis?.event.presented.explanations).toEqual(explained.explanations);
    }
  });

  test("a QuestionExplained of another question restores nothing", () => {
    const other = { ...explained, number: 2 };
    expect(runOf(fold(live(upTo(other))), "implementation")?.analysis).toBe(null);
  });

  // W2-R1-1 of work review 2: the request's call may ask a pause of its own (its retries exhausted) before it succeeds;
  // the pause's prompts must not lose the analysis the request set aside.
  const pauseQuestion: PresentedQuestion = { ...presentedOf(presentedEvent("Retry or stop?", options)), number: 2 };
  const pauseAnalysis: UiEvent = { ...analyzedEvent, decision: 2, question: "Retry or stop?", presented: pauseQuestion } as UiEvent;
  const requested = upTo(explained).slice(0, 8);
  const explainedAt = (prompt: number): RunEvent[] => [
    notified({ _tag: "QuestionExplained", question: explained }),
    notified({ _tag: "QuestionPresented", question: explained }),
    asked(prompt, prompts.optionOrTextPrompt),
  ];
  const heldFor = (events: readonly RunEvent[], prompt: number): void => {
    for (const s of [fold(live(events)), replayed(events)]) {
      const analysis = runOf(s, "implementation")?.analysis;
      expect(analysis?.prompt).toBe(prompt);
      expect(analysis?.event.presented.number).toBe(1);
      expect(analysis?.event.presented.explanations).toEqual(explained.explanations);
    }
  };

  test("a pause asked during the request keeps the analysis for the question explained after it", () => {
    heldFor([
      ...requested,
      notified({ _tag: "QuestionPresented", question: pauseQuestion }),
      asked(3, prompts.optionOrTextPrompt),
      { _tag: "Answered", prompt: 3, text: "1" },
      ...explainedAt(4),
    ], 4);
  });

  test("a pause with an analysis of its own still gives back the outer question's analysis", () => {
    heldFor([
      ...requested,
      notified({ _tag: "QuestionPresented", question: pauseQuestion }),
      asked(3, prompts.withOffer(prompts.optionOrTextPrompt)),
      { _tag: "Answered", prompt: 3, text: "/decide" },
      notified(pauseAnalysis),
      notified({ _tag: "QuestionPresented", question: pauseQuestion }),
      asked(4, prompts.optionOrTextPrompt),
      { _tag: "Answered", prompt: 4, text: "1" },
      ...explainedAt(5),
    ], 5);
  });
});

// Issue #162: the whole suite Interloq runs after the review of the work finds nothing left to correct is a phase of the timeline, numbered by the
// run's suite runs, with its result.
describe("the Full test suite phase (issue #162)", () => {
  const begin = (phase: Phase) => notified({ _tag: "PhaseBegan", phase });
  const end = (phase: Phase, result: string) => notified({ _tag: "PhaseEnded", phase, result });
  const iteration = (n: number, suite: number): RunEvent[] => [
    begin({ kind: "planning", n }), end({ kind: "planning", n }, "converged"),
    begin({ kind: "execution", n }), end({ kind: "execution", n }, "finished"),
    begin({ kind: "work", n }), end({ kind: "work", n }, "converged"),
    begin({ kind: "suite", n: suite }),
  ];
  const events: RunEvent[] = [
    started,
    notified({ _tag: "PhasesForeseen", phases: foreseenPhases("implementation", [{ suites: [1] }]) }),
    ...iteration(1, 1),
    end({ kind: "suite", n: 1 }, "failed"),
    notified({ _tag: "PhasesForeseen", phases: foreseenPhases("implementation", [{ suites: [1] }, { suites: [2] }]) }),
    ...iteration(2, 2),
    end({ kind: "suite", n: 2 }, "passed"),
  ];
  test("a failed suite run and a passed one are two entries, numbered, each with its result and its times", () => {
    for (const s of [fold(live(events)), replayed(events)]) {
      const suites = runOf(s, "implementation")!.timeline.filter((e) => e.phase.kind === "suite");
      expect(suites.map((e) => [e.label, e.state, e.result])).toEqual([
        ["Full test suite 1", "done", "failed"],
        ["Full test suite 2", "done", "passed"],
      ]);
      for (const e of suites) expect(e.began !== null && e.ended !== null).toBe(true);
      expect(runOf(s, "implementation")!.timeline.filter((e) => e.phase.kind !== "suite").every((e) => e.result === null)).toBe(true);
    }
  });
  test("a suite run ahead is foreseen, and one under way is active with no result", () => {
    const s = fold(live(events.slice(0, 2 + iteration(1, 1).length)));
    const suite = runOf(s, "implementation")!.timeline.find((e) => e.phase.kind === "suite")!;
    expect([suite.label, suite.state, suite.result]).toEqual(["Full test suite", "active", null]);
    const ahead = fold(live(events.slice(0, 2)));
    expect(runOf(ahead, "implementation")!.timeline.find((e) => e.phase.kind === "suite")?.state).toBe("ahead");
  });
});

// Issue #184 (S13): the interview's request runs beside a terms request, a decision or a context call, and either may end
// first; the page removes the call that ended, by its id.
describe("calls that overlap", () => {
  const start = (callId: string, purpose: string) => notified({ _tag: "AgentCallStarted", agent: "claude", purpose, callId });
  const end = (callId: string) => notified({ _tag: "AgentCallEnded", agent: "claude", ok: true, callId });
  const runAfter = (events: readonly RunEvent[]) => runOf(fold(live([started, ...events])), "implementation");
  test("two overlapping calls ending in either order each leave the other running and named", () => {
    const first = runAfter([start("claude-1", "interview"), start("claude-2", "planning"), end("claude-1")]);
    expect(first?.calls.map((c) => c.purpose)).toEqual(["planning"]);
    expect(statusOf(first)).toBe(`Claude — ${prompts.purposeLabel("planning")}`);
    const second = runAfter([start("claude-1", "interview"), start("claude-2", "planning"), end("claude-2")]);
    expect(second?.calls.map((c) => c.purpose)).toEqual(["interview"]);
    expect(statusOf(second)).toBe(`Claude — ${prompts.purposeLabel("interview")}`);
  });
  test("a nested call's end restores the outer one, and an end of no running call changes nothing", () => {
    expect(runAfter([start("claude-1", "execution"), start("claude-2", "decision"), end("claude-2")])?.calls.map((c) => c.purpose)).toEqual(["execution"]);
    expect(runAfter([start("claude-1", "execution"), end("claude-9")])?.calls.map((c) => c.purpose)).toEqual(["execution"]);
  });
  test("only the execution call's end clears the current step", () => {
    const plan = notified({ _tag: "PlanChanged", plan: { stages: [{ number: 1, title: "S", steps: [{ id: "S1", number: 1, label: "one", text: "t", status: "started" }] }] }, phase: 1, step: { id: "S1", status: "started" } });
    const base = [notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } }), start("claude-1", "execution"), plan, start("claude-2", "interview")];
    const step = (events: readonly RunEvent[]) => runAfter(events)?.timeline.find((e) => e.phase.kind === "execution")?.currentStep ?? null;
    expect(step([...base, end("claude-2")])).not.toBe(null);
    expect(step([...base, end("claude-1")])).toBe(null);
  });
});

// W4-R2-1 of issue #184: the interview's request may wait (a usage limit, a backoff) while other calls start and end
// (Help me decide, a terms request); only the waited call, named by its agent and purpose, ends the wait.
describe("a wait outlives calls other than the one it waits for", () => {
  const FROM = Date.UTC(2026, 9, 20, 9, 0);
  const UNTIL = FROM + 600_000;
  const interviewCall: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "interview", callId: "claude-1" };
  const interviewFailed: UiEvent = { _tag: "AgentCallEnded", agent: "claude", ok: false, callId: "claude-1" };
  const interviewAgain: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "interview", callId: "claude-3" };
  const interviewAgainEnded: UiEvent = { _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-3" };
  const reviewCall: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId: "codex-1" };
  const reviewEnded: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: true, callId: "codex-1" };
  const termsCall: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId: "claude-2" };
  const termsEnded: UiEvent = { _tag: "AgentCallEnded", agent: "claude", ok: true, callId: "claude-2" };
  const limited: UiEvent = { _tag: "UsageLimitWaiting", agent: "claude", purpose: "interview", limitType: "five_hour", basis: { kind: "reset" }, fromMs: FROM, untilMs: UNTIL };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "claude", purpose: "interview", attempt: 1, of: 3, delaySeconds: 5, fault: "socket hang up", fromMs: FROM, untilMs: FROM + 5000 };
  const limitText = `Claude — ${prompts.usageLimitActivity("five_hour", { kind: "reset" }, UNTIL)}`;
  const retryText = "Claude — connection lost, retry 1 of 3 (socket hang up)";
  const before = [started, notified(interviewCall), notified(interviewFailed)];
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a Codex review's start and end leave a usage-limit wait, and the activity line shows the wait again", () => {
    for (const s of both([...before, notified(limited), notified(reviewCall)])) expect(runOf(s, "implementation")?.limitWait?.untilMs).toBe(UNTIL);
    for (const s of both([...before, notified(limited), notified(reviewCall), notified(reviewEnded)])) {
      expect(runOf(s, "implementation")?.limitWait?.untilMs).toBe(UNTIL);
      expect(statusOf(s)).toBe(limitText);
    }
  });

  test("a Codex review's start and end leave a retry's wait, and the activity line shows the retry again", () => {
    for (const s of both([...before, notified(retrying), notified(reviewCall), notified(reviewEnded)])) {
      expect(runOf(s, "implementation")?.retry?.wait).toEqual({ fromMs: FROM, untilMs: FROM + 5000 });
      expect(statusOf(s)).toBe(retryText);
    }
    for (const s of both([...before, notified(retrying), notified(reviewCall)])) expect(statusOf(s)).toBe("Codex — review");
  });

  test("a Claude call of another purpose leaves the waits too", () => {
    for (const s of both([...before, notified(limited), notified(termsCall), notified(termsEnded)])) {
      expect(runOf(s, "implementation")?.limitWait?.untilMs).toBe(UNTIL);
      expect(statusOf(s)).toBe(limitText);
    }
    for (const s of both([...before, notified(retrying), notified(termsCall), notified(termsEnded)])) {
      expect(runOf(s, "implementation")?.retry?.wait).toEqual({ fromMs: FROM, untilMs: FROM + 5000 });
      expect(statusOf(s)).toBe(retryText);
    }
  });

  test("the waited call's next attempt clears the wait at its start, and its end clears the retry", () => {
    for (const s of both([...before, notified(limited), notified(reviewCall), notified(reviewEnded), notified(interviewAgain)])) expect(runOf(s, "implementation")?.limitWait).toBe(null);
    for (const s of both([...before, notified(retrying), notified(reviewCall), notified(reviewEnded), notified(interviewAgain)])) {
      expect(runOf(s, "implementation")?.retry?.wait).toBe(null);
      expect(statusOf(s)).toBe("Claude — clarification — connection lost, retry 1 of 3 (socket hang up)");
    }
    for (const s of both([...before, notified(retrying), notified(interviewAgain), notified(interviewAgainEnded)])) expect(runOf(s, "implementation")?.retry).toBe(null);
  });

  test("the lift and the recovery still clear the waits", () => {
    for (const s of both([...before, notified(limited), notified(reviewCall), notified({ _tag: "UsageLimitLifted", agent: "claude", waitedMs: 600_000 })])) expect(runOf(s, "implementation")?.limitWait).toBe(null);
    for (const s of both([...before, notified(retrying), notified(reviewCall), notified({ _tag: "TransportRecovered", agent: "claude" })])) expect(runOf(s, "implementation")?.retry).toBe(null);
  });
});

// Issue #147 (S11): the chain's state from the hello and from every chain frame.
describe("the chain", () => {
  test("the hello sets it, a chain frame replaces it, and a hello of another incarnation replaces it again", () => {
    expect(initialState.chain).toBeNull();
    const hello = (incarnation: string, chain: ChainState): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain, location: "/p", current: { refinement: [], implementation: null }, incarnation });
    const first = reduce(initialState, hello("a", helloChain));
    expect(first.chain).toEqual(helloChain);
    const changed = configured(helloChain, OFF_SETTINGS, null);
    const second = reduce(first, { type: "chain", state: changed });
    expect(second.chain).toEqual(changed);
    expect(reduce(second, hello("b", helloChain)).chain).toEqual(helloChain);
  });
});

// Issue #147 (S12): what the chain control shows, through the texts of src/prompts.ts.
describe("chainShown", () => {
  const time = (iso: string) => `<${iso}>`;
  const withChain = (chain: ChainState): ViewState => ({ ...initialState, chain });
  test("null before the first hello", () => {
    expect(chainShown(initialState, time)).toBeNull();
  });
  test("each chain gives its status, and an ended chain its reason and its runs", () => {
    const running = begun(helloChain, 4, "7" as ItemId, "seven");
    expect(chainShown(withChain(running), time)).toEqual({ settings: running.settings, effective: { enabled: running.settings.enabled, runs: running.settings.limits.runs, cutoff: null }, reset: { version: 0, fields: [] }, status: prompts.chainStatusText(running), ended: null, runs: [] });
    const [stopped] = ended(running, 4, { code: 130, root: null, parked: null, abandoned: null });
    const shown = chainShown(withChain(stopped), time);
    expect(shown?.ended).toBe(prompts.chainEndedText({ _tag: "StoppedByDeveloper", item: "7" as ItemId }, time));
    expect(shown?.runs).toEqual([prompts.chainEntryText({ item: "7" as ItemId, title: "seven", root: null, outcome: { _tag: "Stopped", park: null }, returned: null })]);
    expect(chainShown(withChain(helloChain), time)?.ended).toBeNull();
  });
});

// Issue #147, the work review of 21 Oct 2026 (W1-R1-1), S29: the frames not yet acknowledged held by the page.
describe("chain pending", () => {
  const CUTOFF = "2026-10-21T07:00:00.000Z";
  const helloOf = (incarnation: string, chain: ChainState = helloChain): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain, location: "/p", current: { refinement: [], implementation: null }, incarnation });
  const open = reduce(initialState, helloOf("a"));
  const shownOf = (view: ViewState) => chainShown(view, (iso) => iso)!;
  const server = helloChain.settings;
  const runs3 = { ...shownOf(open).effective, runs: 3 };
  // The server's settings for a run limit, by the server's own decoding of a frame.
  const withSettings = (runs: number | null): ChainState => configured(helloChain, Result.getOrThrow(chainSettingsOf({ enabled: server.enabled, runs, cutoff: null })), null);

  test("chain pending: chainSent appends, counting a queued frame", () => {
    const one = chainSent(open, runs3, false);
    expect(one.chainPending).toEqual([runs3]);
    expect(one.chainQueued).toBe(0);
    const two = chainSent(one, { ...runs3, runs: 4 }, true);
    expect(two.chainPending).toEqual([runs3, { ...runs3, runs: 4 }]);
    expect(two.chainQueued).toBe(1);
  });
  test("chain pending: a chain frame of equal settings keeps the list, as does a run event", () => {
    const one = chainSent(open, runs3, false);
    expect(reduce(one, { type: "chain", state: helloChain }).chainPending).toEqual([runs3]);
    expect(reduce(one, { type: "chain", state: begun(helloChain, 4, "7" as ItemId, "seven") }).chainPending).toEqual([runs3]);
  });
  test("chain pending: the first of two frames acknowledged leaves the second, effective carrying both", () => {
    const second = { ...runs3, cutoff: CUTOFF };
    const two = chainSent(chainSent(open, runs3, false), second, false);
    const acked = reduce(two, { type: "chain", state: withSettings(3) });
    expect(acked.chainPending).toEqual([second]);
    expect(shownOf(acked).effective).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
  });
  test("chain pending: another tab's change empties the list, and effective is the server's", () => {
    const acked = reduce(chainSent(open, runs3, false), { type: "chain", state: withSettings(7) });
    expect(acked.chainPending).toEqual([]);
    expect(shownOf(acked).effective).toEqual({ enabled: true, runs: 7, cutoff: null });
  });
  test("chain pending: a hello of the same incarnation with unchanged settings keeps the list", () => {
    expect(reduce(chainSent(open, runs3, false), helloOf("a")).chainPending).toEqual([runs3]);
  });
  test("chain pending: a hello of another incarnation drops the frames sent and keeps the queued ones", () => {
    const queued = { ...runs3, runs: 5 };
    const s = reduce(chainSent(chainSent(open, runs3, false), queued, true), helloOf("b"));
    expect(s.chainPending).toEqual([queued]);
    expect(s.chainQueued).toBe(0);
  });
  test("chain pending: a run limit queued while disconnected survives a restart, and the next frame carries it", () => {
    const disconnected = reduce(open, { type: "closing" });
    const s = reduce(chainSent(disconnected, runs3, true), helloOf("b"));
    expect(shownOf(s).effective.runs).toBe(3);
    expect(s.chainQueued).toBe(0);
    expect({ ...shownOf(s).effective, cutoff: CUTOFF }).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
  });
  test("chain pending: a run limit sent, then a restart without it: dropped, and the runs field reset", () => {
    const s = reduce(chainSent(open, runs3, false), helloOf("b"));
    expect(s.chainPending).toEqual([]);
    expect(shownOf(s).effective.runs).toBeNull();
    expect(s.chainReset).toEqual({ version: 1, fields: ["runs"] });
  });
  test("chain pending: a hello of the same incarnation carrying another tab's change keeps a queued frame", () => {
    const s = reduce(chainSent(open, runs3, true), helloOf("a", withSettings(7)));
    expect(s.chainPending).toEqual([runs3]);
    expect(s.chainQueued).toBe(0);
  });
  test("chain pending: chainUnsent withdraws the frame and resets its fields, and counts a frame never recorded", () => {
    const s = chainUnsent(chainSent(open, runs3, true), runs3);
    expect(s.chainPending).toEqual([]);
    expect(s.chainQueued).toBe(0);
    expect(s.chainReset).toEqual({ version: 1, fields: ["runs"] });
    const never = chainUnsent(open, runs3);
    expect(never.chainPending).toEqual([]);
    expect(never.chainReset.version).toBe(1);
    expect(never.chainReset.fields).toEqual(["runs"]);
  });
});

// Issue #191: any number of refinement runs in the Refinement tab, a second row of tabs choosing between them.
describe("several refinement runs", () => {
  const refining = (item: string): RunEvent => ({ ...started, mode: "refinement", item: { id: item, title: `item ${item}` } } as RunEvent);
  const eventsOf = (run: number, list: readonly RunEvent[], from = 0): ServerMessage[] => stamp(list).map(({ time, event }, i): ServerMessage => ({ type: "event", run, seq: from + i, time, event }));
  const helloOf = (refinement: readonly number[]): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement, implementation: null }, incarnation: "a" });
  const empty = fold([helloOf([]), { type: "replay", ui: [], runs: [] }]);
  const a = [refining("11"), said("refining 11"), asked(1, prompts.interviewMessagePrompt)];
  const b = [refining("12"), said("refining 12"), asked(1, prompts.interviewMessagePrompt)];

  test("two runs are both held, each folded by its own events, and current lists both", () => {
    const s = fold([...eventsOf(1, a), ...eventsOf(2, b)], empty);
    expect(s.modes.refinement.runs.map((r) => r.id)).toEqual([1, 2]);
    expect(s.modes.refinement.current).toEqual([1, 2]);
    expect(s.modes.refinement.runs.map((r) => r.pending?.asked.prompt)).toEqual([1, 1]);
    expect(refinementInProgress(s)).toEqual(["11", "12"]);
  });

  test("a seq gap is checked per run", () => {
    const s = fold([...eventsOf(1, a), ...eventsOf(2, b)], empty);
    expect(fold(eventsOf(1, [said("x")], 3), s).needsReconnect).toBe(false);
    expect(fold(eventsOf(2, [said("x")], 5), s).needsReconnect).toBe(true);
  });

  test("the first run's Started focuses it; a second run's Started or prompt leaves the focus on the first", () => {
    const one = fold(eventsOf(1, a), empty);
    expect(one.modes.refinement.focus).toEqual({ _tag: "Run", run: 1 });
    const two = fold([...eventsOf(2, b), ...eventsOf(2, [asked(2, prompts.interviewMessagePrompt)], 3)], one);
    expect(two.modes.refinement.focus).toEqual({ _tag: "Run", run: 1 });
    expect(runOf(two, "refinement")?.id).toBe(1);
  });

  test("the user's choice of a run or of the list; a start this page asked for moves the focus to its run", () => {
    const two = fold([...eventsOf(1, a), ...eventsOf(2, b)], empty);
    expect(runOf(focusRun(two, "refinement", 2), "refinement")?.id).toBe(2);
    expect(focusRun(two, "refinement", 2).chosen).toBe(true);
    const list = focusList(two, "refinement");
    expect(list.modes.refinement.focus).toEqual({ _tag: "List" });
    expect(runOf(list, "refinement")).toBe(null);
    const asked3 = startRequested(focusRun(two, "refinement", 1), "refinement", "13");
    expect(asked3.modes.refinement.starting).toBe("13");
    const third = fold(eventsOf(3, [refining("13")]), asked3);
    expect(third.modes.refinement.focus).toEqual({ _tag: "Run", run: 3 });
    expect(third.modes.refinement.starting).toBe(null);
    const refused = reduce(asked3, { type: "refused", mode: "refinement", reason: "no" });
    expect(refused.modes.refinement.starting).toBe(null);
  });

  test("closeRun removes an ended run and the list is shown; a later replay does not bring it back", () => {
    const one = fold([...eventsOf(1, a), ...eventsOf(1, [{ _tag: "Ended", code: 130 }], 3), ...eventsOf(2, b)], empty);
    expect(closeRun(one, 2)).toBe(one);
    const closed = closeRun(one, 1);
    expect(closed.modes.refinement.runs.map((r) => r.id)).toEqual([2]);
    expect(closed.modes.refinement.focus).toEqual({ _tag: "List" });
    expect(closed.closed).toEqual([1]);
    const replay: ServerMessage = { type: "replay", ui: [], runs: [{ id: 1, events: stamp([...a, { _tag: "Ended", code: 130 }]) }, { id: 2, events: stamp(b) }] };
    expect(reduce(closed, replay).modes.refinement.runs.map((r) => r.id)).toEqual([2]);
    expect(reduce(reduce(closed, helloOf([2])), replay).modes.refinement.runs.map((r) => r.id)).toEqual([2]);
    expect(reduce(closed, { type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation: "b" }).closed).toEqual([]);
  });

  test("a newer refinement of the same item replaces the held ended one", () => {
    const one = fold([...eventsOf(1, a), ...eventsOf(1, [{ _tag: "Ended", code: 130 }], 3), ...eventsOf(2, b)], empty);
    const again = fold(eventsOf(3, a), one);
    expect(again.modes.refinement.runs.map((r) => r.id)).toEqual([2, 3]);
  });

  test("W1-R1-3: the focused ended run replaced by another page's start of its item moves the focus to the replacing run", () => {
    const ended = fold([...eventsOf(1, a), ...eventsOf(1, [{ _tag: "Ended", code: 130 }], 3)], empty);
    const viewing = focusRun(ended, "refinement", 1);
    expect(viewing.modes.refinement.starting).toBe(null);
    const replaced = fold(eventsOf(2, a), viewing);
    expect(replaced.modes.refinement.focus).toEqual({ _tag: "Run", run: 2 });
    expect(runOf(replaced, "refinement")?.id).toBe(2);
    const values = runTabs(replaced, "refinement").map((t) => t.value);
    expect(values).toContain("run-2");
    expect(values).not.toContain("run-1");
  });

  test("W1-R1-3: a focused running run of another item keeps the focus when the ended run of an item is replaced", () => {
    const s = fold([...eventsOf(1, a), ...eventsOf(1, [{ _tag: "Ended", code: 130 }], 3), ...eventsOf(2, b)], empty);
    const viewing = focusRun(s, "refinement", 2);
    const replaced = fold(eventsOf(3, a), viewing);
    expect(replaced.modes.refinement.focus).toEqual({ _tag: "Run", run: 2 });
    expect(runOf(replaced, "refinement")?.id).toBe(2);
  });

  test("a replay before the user chooses shows the Refinement tab and focuses the waiting run", () => {
    const replay: ServerMessage = { type: "replay", ui: [], runs: [{ id: 1, events: stamp([refining("11"), said("x")]) }, { id: 2, events: stamp(b) }] };
    const s = fold([helloOf([1, 2]), replay]);
    expect(s.selected).toBe("refinement");
    expect(s.modes.refinement.focus).toEqual({ _tag: "Run", run: 2 });
    const chosen = reduce(focusRun(s, "refinement", 1), replay);
    expect(chosen.modes.refinement.focus).toEqual({ _tag: "Run", run: 1 });
  });

  test("a ui frame applies to its run alone", () => {
    const two = fold([...eventsOf(1, a), ...eventsOf(2, b)], empty);
    const ui = withFlag(emptyUiState, { scope: { _tag: "DashboardAnswers" }, open: true });
    const s = reduce(two, { type: "ui", run: 2, state: ui });
    expect(s.modes.refinement.runs.map((r) => r.ui.version)).toEqual([0, 1]);
  });

  test("property: any interleaving of two runs' events folds each run as its own stream alone", () => {
    const ea = eventsOf(1, [...a, said("more"), { _tag: "Ended", code: 0 }]);
    const eb = eventsOf(2, [...b, said("other")]);
    const alone = (messages: readonly ServerMessage[], id: number) => fold(messages, empty).modes.refinement.runs.find((r) => r.id === id);
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: ea.length + eb.length, maxLength: ea.length + eb.length }), (picks) => {
        const [qa, qb] = [[...ea], [...eb]];
        const merged = picks.map((first) => ((first && qa.length > 0) || qb.length === 0 ? qa.shift()! : qb.shift()!));
        const both = fold(merged, empty);
        expect(both.modes.refinement.runs.find((r) => r.id === 1)).toEqual(alone(ea, 1));
        expect(both.modes.refinement.runs.find((r) => r.id === 2)).toEqual(alone(eb, 2));
      }),
      { numRuns: 50 },
    );
  });
});

// Issue #191: what App presents of the runs: one key per run, the waiting marks, the second row and the startable items.
describe("the presented runs", () => {
  const refining = (item: string): RunEvent => ({ ...started, mode: "refinement", item: { id: item, title: `item ${item}` } } as RunEvent);
  const eventsOf = (run: number, list: readonly RunEvent[], from = 0): ServerMessage[] => stamp(list).map(({ time, event }, i): ServerMessage => ({ type: "event", run, seq: from + i, time, event }));
  const empty = fold([{ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation: "a" }, { type: "replay", ui: [], runs: [] }]);
  const two = fold([...eventsOf(1, [refining("11"), said("x")]), ...eventsOf(2, [refining("12"), asked(1, prompts.interviewMessagePrompt)])], empty);

  test("presented: the implementation tab's run under one key, and each refinement run under its own, in start order", () => {
    const withImpl = fold(eventsOf(3, [started]), two);
    expect(presented(withImpl).map((p) => [p.key, p.mode, p.shown.run?.id])).toEqual([["implementation", "implementation", 3], ["refinement-1", "refinement", 1], ["refinement-2", "refinement", 2]]);
    expect(presented(empty).map((p) => p.key)).toEqual(["implementation"]);
  });

  test("modeWaiting: the Refinement tab is marked while any of its runs waits", () => {
    expect(modeWaiting(two, "refinement")).toBe(true);
    expect(modeWaiting(focusRun(two, "refinement", 1), "refinement")).toBe(true);
    expect(modeWaiting(two, "implementation")).toBe(false);
    expect(modeWaiting(fold(eventsOf(2, [{ _tag: "Ended", code: 130 }], 2), two), "refinement")).toBe(false);
  });

  test("runTabs: the items first, then each run named by its item, a waiting run's name marked", () => {
    expect(runTabs(two, "refinement")).toEqual([
      { value: "list", name: prompts.LIST_TAB },
      { value: "run-1", name: prompts.runTabName({ id: "11", title: "item 11" }) },
      { value: "run-2", name: prompts.waitingTabName(prompts.runTabName({ id: "12", title: "item 12" })) },
    ]);
  });

  test("startableOf: implementation none while a run is in progress; refinement every item but those being refined", () => {
    expect(startableOf(two, "refinement")).toEqual({ _tag: "Except", items: ["11", "12"] });
    expect(startableOf(empty, "implementation")).toEqual({ _tag: "Except", items: [] });
    expect(startableOf(fold(eventsOf(3, [started]), two), "implementation")).toEqual({ _tag: "None" });
  });
});

// Issue #185: the countdown of a question, its hold and its expiry by kind, the abandoned items' mark.
describe("the countdown of a question (issue #185)", () => {
  const counting = (prompt: number, then: "abandon" | "extend"): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt), countdown: { fromMs: 1000, untilMs: 121_000, then }, deciding: null });
  test("an Asked with a countdown sets it on the pending prompt; CountdownStopped clears it and marks it held", () => {
    const s = fold(live([started, counting(1, "abandon")]));
    expect(runOf(s, "implementation")?.pending?.countdown).toEqual({ fromMs: 1000, untilMs: 121_000, then: "abandon" });
    expect(runOf(s, "implementation")?.pending?.held).toBe(false);
    const held = fold(live([started, counting(1, "abandon"), { _tag: "CountdownStopped", prompt: 1, reason: "held" }]));
    expect(runOf(held, "implementation")?.pending?.countdown).toBe(null);
    expect(runOf(held, "implementation")?.pending?.held).toBe(true);
  });
  test("an expiry that abandons clears the prompt and keeps the expiry; Ended marks the run over with its word", () => {
    const events = [started, counting(1, "abandon"), { _tag: "AnswerExpired", prompt: 1, seconds: 120, then: "abandon" } as RunEvent, { _tag: "Ended", code: 2 } as RunEvent];
    const run = runOf(fold(live(events)), "implementation");
    expect(run?.pending).toBe(null);
    expect(run?.expired).toEqual({ prompt: 1, seconds: 120, then: "abandon" });
    expect(run?.ended).toBe(2);
    expect(prompts.endedOutcome(2)).toBe("abandoned");
    // A replay of the same events folds alike.
    expect(runOf(replayed(events), "implementation")?.expired).toEqual(run?.expired);
  });
  test("an expiry that extends a review leaves the run going, and the next round clears it", () => {
    const expired = [started, counting(1, "extend"), { _tag: "AnswerExpired", prompt: 1, seconds: 120, then: "extend" } as RunEvent];
    const run = runOf(fold(live(expired)), "implementation");
    expect(run?.expired?.then).toBe("extend");
    expect(run?.ended).toBe(null);
    const next = runOf(fold(live([...expired, notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 2 })])), "implementation");
    expect(next?.expired).toBe(null);
  });
  // Work review 1 of issue #185 (W1-R1-5): the analysis belongs to the prompt that expired, so it goes with it.
  for (const then of ["abandon", "extend"] as const) {
    test(`an expiry that ${then}s drops the analysis prepared for its prompt`, () => {
      const analyzed = notified({ _tag: "DecisionAnalyzed", decision: 1, question: "A or B?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, history: [], explanations: [], question: plainPieces("Q?"), options: [], attached: null, decision: null }, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } });
      const events = [started, analyzed, counting(1, then), { _tag: "AnswerExpired", prompt: 1, seconds: 120, then } as RunEvent];
      const before = runOf(fold(live(events.slice(0, 3))), "implementation");
      expect(before?.analysis?.prompt).toBe(1);
      const run = runOf(fold(live(events)), "implementation");
      expect(run?.analysis).toBe(null);
      expect(run?.expired).toEqual({ prompt: 1, seconds: 120, then });
      expect(runOf(replayed(events), "implementation")?.analysis).toBe(null);
    });
  }
  test("abandonedInChain lists the items the chain's history records as abandoned", () => {
    const begunChain = begun(helloChain, 4, "7" as ItemId, "seven");
    const [abandoned] = ended(begunChain, 4, { code: 2, root: null, parked: null, abandoned: { _tag: "SetRefined" } });
    expect([...abandonedInChain(abandoned)]).toEqual(["7"]);
    expect([...abandonedInChain(helloChain)]).toEqual([]);
  });
});

// Issue #153 (requirements Q1, G-R1-1): the question stays on the page while its decision's analysis is prepared.
describe("a question kept while its analysis is prepared", () => {
  const OFFERED = prompts.withOffer(prompts.optionOrTextPrompt);
  const questionNumbered = (number: number, text: string): UiEvent => {
    const e = presentedEvent(text, [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }]);
    return e._tag === "QuestionPresented" ? { ...e, question: { ...e.question, number } } : e;
  };
  const q1 = questionNumbered(1, "Which database?");
  const q2 = questionNumbered(2, "More cycles?");
  const frame = (prompt: number, question: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: question });
  const answered = (prompt: number, text: string): RunEvent => ({ _tag: "Answered", prompt, text });
  const analyzedOf = (number: number): UiEvent => ({ _tag: "DecisionAnalyzed", decision: 1, question: "Which database?", presented: { ...presentedOf(q1), number }, options: [], analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } });
  const runAfter = (events: readonly RunEvent[]) => runOf(fold(live([started, ...events])), "implementation");
  const decided = [notified(q1), asked(1, OFFERED), answered(1, "/decide")];
  const helpMeDecide = (r: RunView | null | undefined) => r?.pending?.choices.some((c) => c.label === prompts.HELP_ME_DECIDE);

  test("Help me decide keeps the question as starting, with the same question and cards", () => {
    const before = runAfter([notified(q1), asked(1, OFFERED)]);
    const r = runAfter(decided);
    expect(r?.pending?.decision).toBe("starting");
    expect(r?.pending?.question?.number).toBe(1);
    expect(r?.pending?.options).toEqual(before?.pending?.options);
    expect(r?.deciding).toEqual([{ question: 1, widget: before?.pending, prompt: null }]);
    expect(r?.followed).toEqual([{ prompt: 1, question: 1 }]);
  });

  test("the frame's Asked: preparing, the question kept, no Help me decide; a foreground question replaces it and it returns", () => {
    const preparing = runAfter([...decided, frame(2, 1)]);
    expect(preparing?.pending?.decision).toBe("preparing");
    expect(preparing?.pending?.asked.prompt).toBe(2);
    expect(preparing?.pending?.question?.number).toBe(1);
    expect(helpMeDecide(preparing)).toBe(false);
    const foreground = runAfter([...decided, frame(2, 1), notified(q2), asked(3, prompts.optionOrTextPrompt)]);
    expect(foreground?.pending?.decision).toBe("none");
    expect(foreground?.pending?.question?.number).toBe(2);
    expect(runAfter([...decided, frame(2, 1), notified(q2), asked(3, prompts.optionOrTextPrompt), answered(3, "1")])?.pending).toBeNull();
    const back = runAfter([...decided, frame(2, 1), notified(q2), asked(3, prompts.optionOrTextPrompt), answered(3, "1"), frame(2, 1)]);
    expect(back?.pending?.question?.number).toBe(1);
    expect(back?.pending?.decision).toBe("preparing");
    const done = runAfter([...decided, frame(2, 1), answered(2, "2")]);
    expect(done?.pending).toBeNull();
    expect(done?.deciding).toEqual([]);
    const last = done?.dashboard.answers.at(-1);
    expect(last?.asked._tag === "Question" ? last.asked.question.number : null).toBe(1);
    expect(last?.answer).toBe("PostgreSQL — a server");
  });

  test("PromptWithdrawn then DecisionAnalyzed: the frame goes, its prompt followed, the analysis kept for the next prompt", () => {
    const r = runAfter([...decided, frame(2, 1), { _tag: "PromptWithdrawn", prompt: 2 }, notified(analyzedOf(1))]);
    expect(r?.pending).toBeNull();
    expect(r?.deciding).toEqual([]);
    expect(r?.followed).toEqual([{ prompt: 1, question: 1 }, { prompt: 2, question: 1 }]);
    expect(r?.analysis?.event.decision).toBe(1);
  });

  test("DecisionAnalyzed with no frame published clears the starting question", () => {
    const r = runAfter([...decided, notified(analyzedOf(1))]);
    expect(r?.pending).toBeNull();
    expect(r?.deciding).toEqual([]);
  });

  test("/decide where no offer stands is an ordinary answer: pending cleared, nothing deciding or followed", () => {
    const noOffer = runAfter([notified(q1), asked(1, prompts.optionOrTextPrompt), answered(1, "/decide")]);
    expect(noOffer?.pending).toBeNull();
    expect(noOffer?.deciding).toEqual([]);
    expect(noOffer?.followed).toEqual([]);
  });

  test("a nested question's analysis dismissed by its answer is not restored by a rejection of the outer frame", () => {
    const r = runAfter([...decided, frame(2, 1), notified(q2), asked(3, prompts.withOffer(prompts.optionOrTextPrompt)), notified(analyzedOf(2)), notified(q2), asked(4, prompts.optionOrTextPrompt), answered(4, "1"), frame(2, 1), answered(2, ""), notified({ _tag: "AnswerRejected" })]);
    expect(r?.analysis).toBeNull();
  });

  test("a run whose question is being analyzed does not wait for the developer", () => {
    const s = fold(live([started, ...decided, frame(2, 1)]));
    expect(modeWaiting(s, "implementation")).toBe(false);
    expect(modeWaiting(fold(live([started, notified(q1), asked(1, OFFERED)])), "implementation")).toBe(true);
  });

  test("a replay gives the view the live events give", () => {
    const events = [started, ...decided, frame(2, 1), notified(q2), asked(3, prompts.optionOrTextPrompt), answered(3, "1"), frame(2, 1)];
    const a = runOf(fold(live(events)), "implementation");
    const b = runOf(replayed(events), "implementation");
    expect(b?.pending).toEqual(a?.pending);
    expect(b?.deciding).toEqual(a?.deciding);
  });

  test("property: whenever the pending prompt is the frame's, its question is the question answered Help me decide", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("frame", "foreground", "answer"), { maxLength: 12 }), (steps) => {
        let events: RunEvent[] = [started, ...decided];
        let prompt = 3;
        let open: number | null = null;
        for (const step of steps) {
          if (step === "frame" && open === null) events = [...events, frame(2, 1)];
          else if (step === "foreground" && open === null) {
            open = prompt++;
            events = [...events, notified(q2), asked(open, prompts.optionOrTextPrompt)];
          } else if (step === "answer" && open !== null) {
            events = [...events, answered(open, "1")];
            open = null;
          }
          const r = runAfter(events.slice(1));
          if (r?.pending?.asked.prompt === 2 && r.pending.question?.number !== 1) return false;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// Issue #144: the Implementation tab's list is reachable while its run is in progress; its focus is the list or its newest held run.
describe("issue #144: the Implementation tab's list during a run", () => {
  const implementing = (item: string): RunEvent => ({ ...started, item: { id: item, title: `item ${item}` } } as RunEvent);
  const eventsOf = (run: number, list: readonly RunEvent[], from = 0): ServerMessage[] => stamp(list).map(({ time, event }, i): ServerMessage => ({ type: "event", run, seq: from + i, time, event }));
  const helloOf = (implementation: number | null, incarnation = "a"): ServerMessage => ({ type: "hello", preparation: PREPARATION_VIEW_OFF, chain: helloChain, location: "/p", current: { refinement: [], implementation }, incarnation });
  const replayOf = (runs: readonly Readonly<{ id: number; events: readonly RunEvent[] }>[]): ServerMessage => ({ type: "replay", ui: [], runs: runs.map((r) => ({ id: r.id, events: stamp(r.events) })) });
  const empty = fold([helloOf(null), replayOf([])]);
  const question = asked(1, prompts.interviewMessagePrompt);
  const ended: RunEvent = { _tag: "Ended", code: 0 };
  const a = [implementing("11"), said("working")];
  const b = [implementing("12"), said("working")];
  const implFocus = (s: ViewState) => s.modes.implementation.focus;
  const presentedImpl = (s: ViewState) => presented(s).find((p) => p.key === "implementation")?.shown.run?.id ?? null;

  test("focusList hides the run in progress; focusRun shows it again", () => {
    const s = fold(eventsOf(1, a), empty);
    expect(runOf(s, "implementation")?.id).toBe(1);
    const list = focusList(s, "implementation");
    expect(runOf(list, "implementation")).toBe(null);
    expect(list.chosen).toBe(true);
    expect(runOf(focusRun(list, "implementation", 1), "implementation")?.id).toBe(1);
  });

  test("while the list is shown, presented and modeWaiting still follow the newest run", () => {
    const list = focusList(fold(eventsOf(1, [...a, question]), empty), "implementation");
    expect(presentedImpl(list)).toBe(1);
    expect(modeWaiting(list, "implementation")).toBe(true);
    expect(modeWaiting(focusList(fold(eventsOf(1, a), empty), "implementation"), "implementation")).toBe(false);
  });

  test("runTabs: the items alone with no run; with two held runs, the items and the newest run, marked while it waits", () => {
    expect(runTabs(empty, "implementation")).toEqual([{ value: "list", name: prompts.LIST_TAB }]);
    const two = fold([...eventsOf(1, [...a, ended]), ...eventsOf(2, [...b, question])], empty);
    expect(two.modes.implementation.runs.map((r) => r.id)).toEqual([1, 2]);
    expect(runTabs(two, "implementation")).toEqual([
      { value: "list", name: prompts.LIST_TAB },
      { value: "run-2", name: prompts.waitingTabName(prompts.runTabName({ id: "12", title: "item 12" })) },
    ]);
  });

  test("a Started is shown where asked, where the previous run was shown, or where the list holds no run; else the list stays", () => {
    const first = fold(eventsOf(1, [...a, ended]), empty);
    expect(implFocus(first)).toEqual({ _tag: "Run", run: 1 });
    expect(implFocus(fold(eventsOf(2, b), first))).toEqual({ _tag: "Run", run: 2 });
    const listing = focusList(first, "implementation");
    expect(implFocus(fold(eventsOf(2, b), listing))).toEqual({ _tag: "List" });
    const asking = startRequested(listing, "implementation", "12");
    const started2 = fold(eventsOf(2, b), asking);
    expect(implFocus(started2)).toEqual({ _tag: "Run", run: 2 });
    expect(started2.modes.implementation.starting).toBe(null);
  });

  test("a replay: before a choice the newest held run; once chosen a Run focus moves to the newest, a List focus stays unless the mode held none", () => {
    expect(implFocus(fold([helloOf(2), replayOf([{ id: 1, events: [...a, ended] }, { id: 2, events: b }])]))).toEqual({ _tag: "Run", run: 2 });
    expect(implFocus(fold([helloOf(null), replayOf([])]))).toEqual({ _tag: "List" });
    const viewingA = focusRun(fold(eventsOf(1, a), empty), "implementation", 1);
    expect(implFocus(fold([helloOf(2), replayOf([{ id: 1, events: [...a, ended] }, { id: 2, events: b }])], viewingA))).toEqual({ _tag: "Run", run: 2 });
    expect(implFocus(fold([helloOf(null, "b"), replayOf([])], viewingA))).toEqual({ _tag: "List" });
    const listing = focusList(fold(eventsOf(1, a), empty), "implementation");
    expect(implFocus(fold([helloOf(2), replayOf([{ id: 1, events: [...a, ended] }, { id: 2, events: b }])], listing))).toEqual({ _tag: "List" });
    const chosenEmpty = selectMode(empty, "implementation");
    expect(implFocus(fold([replayOf([{ id: 1, events: a }])], chosenEmpty))).toEqual({ _tag: "Run", run: 1 });
    expect(implFocus(fold([helloOf(1, "b"), replayOf([{ id: 1, events: a }])], listing))).toEqual({ _tag: "Run", run: 1 });
  });

  test("P1-R1-1: a reconnection whose replay holds a newer run moves a Run focus to it; the shown run, its tab and presented agree", () => {
    const viewingA = focusRun(fold(eventsOf(1, a), empty), "implementation", 1);
    const s = fold([helloOf(2), replayOf([{ id: 1, events: [...a, ended] }, { id: 2, events: b }])], viewingA);
    expect(runOf(s, "implementation")?.id).toBe(2);
    expect(runTabs(s, "implementation").filter((t) => t.value !== "list").map((t) => t.value)).toEqual(["run-2"]);
    expect(presentedImpl(s)).toBe(2);
    const listing = focusList(fold(eventsOf(1, a), empty), "implementation");
    expect(implFocus(fold([helloOf(2), replayOf([{ id: 1, events: [...a, ended] }, { id: 2, events: b }])], listing))).toEqual({ _tag: "List" });
  });

  test("property: the focus is the list or the newest held run, and presented and modeWaiting follow that run", () => {
    type Op = "start" | "ask" | "end" | "reconnect" | "list" | "run";
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Op>("start", "ask", "end", "reconnect", "list", "run"), { maxLength: 30 }), (ops) => {
        let s = empty;
        const events = new Map<number, RunEvent[]>();
        let next = 1;
        const newest = () => s.modes.implementation.runs.at(-1) ?? null;
        const push = (run: number, event: RunEvent) => {
          const list = events.get(run) ?? [];
          s = reduce(s, { type: "event", run, seq: list.length, time: at(list.length), event });
          events.set(run, [...list, event]);
        };
        for (const op of ops) {
          const last = next - 1;
          const open = last > 0 && !(events.get(last) ?? []).some((e) => e._tag === "Ended");
          if (op === "start" && !open) push(next++, implementing(`${next}`));
          if (op === "ask" && open) push(last, asked((events.get(last) ?? []).length, prompts.interviewMessagePrompt));
          if (op === "end" && open) push(last, ended);
          if (op === "reconnect") {
            const ids = [...events.keys()].sort((x, y) => x - y).slice(-2);
            s = fold([helloOf(open ? last : null), replayOf(ids.map((id) => ({ id, events: events.get(id) ?? [] })))], s);
          }
          if (op === "list") s = focusList(s, "implementation");
          const n = newest();
          if (op === "run" && n !== null) s = focusRun(s, "implementation", n.id);
          const top = newest();
          expect(presentedImpl(s)).toBe(top?.id ?? null);
          expect(modeWaiting(s, "implementation")).toBe(top !== null && top.pending !== null && top.pending.decision === "none" && top.ended === null);
          const focus = implFocus(s);
          expect(focus._tag === "List" || (top !== null && focus.run === top.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Issue #131 (S18): the preparation's switch, its status and the marks of the Refinement list.
describe("preparation", () => {
  const view = (status: PreparationStatus, enabled = true): PreparationView => ({ settings: { enabled, generation: 1 }, status });
  const frame = (status: PreparationStatus): ServerMessage => ({ type: "preparation", view: view(status) });
  const item = (id: string, preparation: ListedItem["preparation"] = null): ListedItem => ({ id, title: `t${id}`, excerpt: "", url: null, sentBack: 0, preparation });
  const listedRefinement = (): ViewState => {
    const helloed = reduce(initialState, { type: "hello", preparation: view({ _tag: "Off" }, false), chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation: "a" });
    return reduce(selectMode(helloed, "refinement"), { type: "items", mode: "refinement", result: { _tag: "Listed", items: [item("1"), item("2", { _tag: "SetAside", reason: "r" })], terms: "checked" } });
  };
  const preparing = (id: string): PreparationStatus => ({ _tag: "Preparing", item: id, title: `t${id}` });

  test("the hello sets the view and a preparation frame replaces it", () => {
    const s = listedRefinement();
    expect(s.preparation).toEqual(view({ _tag: "Off" }, false));
    expect(reduce(s, frame({ _tag: "Idle" })).preparation).toEqual(view({ _tag: "Idle" }));
  });

  test("each change of the item being prepared asks for the Refinement items again; a frame that leaves it unchanged does not", () => {
    const s = listedRefinement();
    const asks = (before: ViewState, status: PreparationStatus) => reduce(before, frame(status)).itemsRefresh > before.itemsRefresh;
    expect(asks(s, preparing("1"))).toBe(true);
    const idle = reduce(s, frame({ _tag: "Idle" }));
    expect(asks(idle, preparing("1"))).toBe(true);
    const a = reduce(s, frame(preparing("1")));
    expect(asks(a, preparing("2"))).toBe(true);
    expect(asks(a, { _tag: "Idle" })).toBe(true);
    expect(asks(s, { _tag: "Idle" })).toBe(false);
    expect(asks(a, preparing("1"))).toBe(false);
  });

  test("no request while a run is shown in the Refinement tab", () => {
    const s = listedRefinement();
    const shown = { ...s, modes: { ...s.modes, refinement: { ...s.modes.refinement, focus: { _tag: "Run" as const, run: 1 } } } };
    expect(reduce(shown, frame(preparing("1"))).itemsRefresh).toBe(shown.itemsRefresh);
  });

  test("shownMark gives Preparing for the item the view names, whatever its listed mark, and the listed mark for every other", () => {
    const s = reduce(listedRefinement(), frame(preparing("2")));
    expect(shownMark(s, item("2", { _tag: "SetAside", reason: "r" }))).toEqual({ _tag: "Preparing" });
    expect(shownMark(s, item("1"))).toBe(null);
    expect(shownMark(s, item("3", { _tag: "Prepared", questions: 2 }))).toEqual({ _tag: "Prepared", questions: 2 });
  });

  // W2-R1-1 (work review 2): a change of the item being prepared while a Refinement listing is outstanding is asked for
  // once every outstanding listing has answered, and a listed Preparing the view does not name is not shown.
  const listed = (items: readonly ListedItem[]): ServerMessage => ({ type: "items", mode: "refinement", result: { _tag: "Listed", items, terms: "checked" } });
  const sameHello: ServerMessage = { type: "hello", preparation: view({ _tag: "Idle" }), chain: helloChain, location: "/p", current: { refinement: [], implementation: null }, incarnation: "a" };

  test("(i) a change while the list loads is asked for after the answer, and the stale Preparing is hidden", () => {
    const loading = itemsRequested(listedRefinement(), "refinement");
    const changed = reduce(reduce(loading, frame(preparing("1"))), frame({ _tag: "Idle" }));
    expect(changed.itemsRefresh).toBe(loading.itemsRefresh);
    const answered = reduce(changed, listed([item("1", { _tag: "Preparing" })]));
    expect(answered.itemsRefresh).toBe(loading.itemsRefresh + 1);
    expect(answered.refinementOutstanding).toBe(0);
    expect(answered.itemsRefreshPending).toBe(false);
    expect(shownMark(answered, item("1", { _tag: "Preparing" }))).toBe(null);
  });

  test("(ii) during an automatic listing, changes are deferred and the answer asks exactly once", () => {
    const sent = refreshSent(listedRefinement());
    const changed = reduce(reduce(sent, frame(preparing("1"))), frame(preparing("2")));
    expect(changed.itemsRefresh).toBe(sent.itemsRefresh);
    expect(changed.itemsRefreshPending).toBe(true);
    expect(reduce(changed, listed([])).itemsRefresh).toBe(sent.itemsRefresh + 1);
  });

  test("(iii) two overlapping listings: no request after the first answer, exactly one after the second", () => {
    const both = itemsRequested(refreshSent(listedRefinement()), "refinement");
    const changed = reduce(both, frame(preparing("1")));
    const first = reduce(changed, listed([item("1")]));
    expect(first.itemsRefresh).toBe(both.itemsRefresh);
    const second = reduce(first, listed([item("1", { _tag: "Preparing" })]));
    expect(second.itemsRefresh).toBe(both.itemsRefresh + 1);
    expect(second.refinementOutstanding).toBe(0);
  });

  test("(iv) with nothing outstanding a change asks at once, exactly once", () => {
    const s = listedRefinement();
    const a = reduce(s, frame(preparing("1")));
    expect(a.itemsRefresh).toBe(s.itemsRefresh + 1);
    expect(a.itemsRefreshPending).toBe(false);
  });

  test("(v) an Implementation items frame changes neither the count nor the flag", () => {
    const deferred = reduce(refreshSent(listedRefinement()), frame(preparing("1")));
    const after = reduce(deferred, { type: "items", mode: "implementation", result: { _tag: "Listed", items: [] } });
    expect(after.refinementOutstanding).toBe(1);
    expect(after.itemsRefreshPending).toBe(true);
    expect(after.itemsRefresh).toBe(deferred.itemsRefresh);
  });

  test("(vi) a hello of the same incarnation reissues a lost automatic or deferred listing, and none for a list that loads", () => {
    const sent = refreshSent(listedRefinement());
    const helloed = reduce(sent, sameHello);
    expect(helloed.itemsRefresh).toBe(sent.itemsRefresh + 1);
    expect(helloed.refinementOutstanding).toBe(0);
    const deferred = reduce(sent, frame(preparing("1")));
    const helloedDeferred = reduce(deferred, sameHello);
    expect(helloedDeferred.itemsRefresh).toBe(deferred.itemsRefresh + 1);
    expect(helloedDeferred.itemsRefreshPending).toBe(false);
    const loading = itemsRequested(listedRefinement(), "refinement");
    const helloedLoading = reduce(loading, sameHello);
    expect(helloedLoading.itemsRefresh).toBe(loading.itemsRefresh);
    expect(helloedLoading.modes.refinement.items._tag).toBe("Unasked");
    expect(helloedLoading.refinementOutstanding).toBe(0);
  });

  test("(vii) a listed Preparing with no view is hidden; other listed marks are shown", () => {
    expect(shownMark(initialState, item("1", { _tag: "Preparing" }))).toBe(null);
    expect(shownMark(initialState, item("2", { _tag: "SetAside", reason: "r" }))).toEqual({ _tag: "SetAside", reason: "r" });
    expect(shownMark(initialState, item("3", { _tag: "Prepared", questions: 1 }))).toEqual({ _tag: "Prepared", questions: 1 });
  });

  test("property: the outstanding count is sends less answers, and a change after the last request is always asked for", () => {
    type Op = Readonly<{ _tag: "frame"; item: string | null }> | Readonly<{ _tag: "manual" }> | Readonly<{ _tag: "answer" }>;
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ _tag: fc.constant("frame" as const), item: fc.constantFrom("1", "2", null) }),
      fc.constant({ _tag: "manual" as const }),
      fc.constant({ _tag: "answer" as const }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        let state = listedRefinement();
        let outstanding = 0;
        let seen = state.itemsRefresh;
        // Whether a change of the preparing item came after the last request sent, unasked for since.
        let unasked = false;
        const autoSend = () => {
          if (state.itemsRefresh !== seen) {
            seen = state.itemsRefresh;
            state = refreshSent(state);
            outstanding += 1;
            unasked = false;
          }
        };
        for (const o of ops) {
          if (o._tag === "frame") {
            const before = state.preparation === null ? null : (state.preparation.status._tag === "Preparing" ? state.preparation.status.item : null);
            state = reduce(state, frame(o.item === null ? { _tag: "Idle" } : preparing(o.item)));
            if (before !== o.item) unasked = true;
          } else if (o._tag === "manual") {
            state = itemsRequested(state, "refinement");
            outstanding += 1;
            unasked = false;
          } else if (outstanding > 0) {
            state = reduce(state, listed([]));
            outstanding -= 1;
          }
          autoSend();
          expect(state.refinementOutstanding).toBe(outstanding);
          expect(state.refinementOutstanding).toBeGreaterThanOrEqual(0);
        }
        while (outstanding > 0) {
          state = reduce(state, listed([]));
          outstanding -= 1;
          autoSend();
        }
        expect(unasked).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
