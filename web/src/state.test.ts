import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { decodeServer, type RunEvent, type ServerMessage, type Stamped } from "../../src/protocol.ts";
import { foreseenPhases, phaseName, type UiEvent } from "../../src/uiEvents.ts";
import { promptOf } from "../../src/userPrompts.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import { piecesText, plainBlocks, plainPieces } from "../../src/pieces.ts";
import { type ShownPlan, shownPlan, waiting, type Band, bandsOf, callStartedAt, currentPlanStep, dismissUnsent, executing, initialState, keepUnsent, planStepState, progressOf, protocolError, reduce, showsTime, type ViewState } from "./state.ts";

// Plan step 4.2: the page's reducer.
const hello = (current: number | null = 1): ServerMessage => ({ type: "hello", cwd: "/p", current, incarnation: "a" });
const started: RunEvent = { _tag: "Started", project: "/p", task: "the task" };
const said = (text: string): RunEvent => ({ _tag: "Said", text });
const notified = (event: UiEvent): RunEvent => ({ _tag: "Notified", event });
const asked = (prompt: number, text: string): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(text) });
/** A question presented to the user (S5), with its options numbered as the run numbers them. */
const presentedEvent = (question: string, options: readonly { label: string; description: string }[], origin: PresentedQuestion["origin"] = { kind: "relayed" }): UiEvent => ({
  _tag: "QuestionPresented",
  question: { number: 1, origin, context: { blocks: [], by: "agent" }, explanations: [], question: plainPieces(question), options: options.map((o, i) => ({ label: plainPieces(o.label), description: plainPieces(o.description), answer: { token: String(i + 1) } })), details: [], decision: null },
});
const presentedOf = (event: UiEvent): PresentedQuestion => (event._tag === "QuestionPresented" ? event.question : (undefined as never));
/** The time of publication of an event: by default one second per seq from 14:00:00 UTC; `times` gives it in seconds. */
const BASE = Date.UTC(2026, 8, 27, 14, 0, 0);
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();
const stamp = (events: readonly RunEvent[], times?: readonly number[]): Stamped[] => events.map((event, seq) => ({ time: at(times?.[seq] ?? seq), event }));
/** The live messages of one run: hello, an empty replay, then the events with seq from 0. */
const live = (events: readonly RunEvent[], run = 1, times?: readonly number[]): ServerMessage[] => [hello(run), { type: "replay", runs: [] }, ...stamp(events, times).map(({ time, event }, seq): ServerMessage => ({ type: "event", run, seq, time, event }))];
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const replayed = (events: readonly RunEvent[], run = 1, current: number | null = run, times?: readonly number[]): ViewState => fold([hello(current), { type: "replay", runs: [{ id: run, events: stamp(events, times) }] }]);
/** A shown plan without its stages' rendering keys: the plan it shows. */
const bare = (p: ShownPlan | null) => (p === null ? null : { stages: p.stages.map(({ key: _key, ...st }) => st) });
const bodies = (s: ViewState) => s.run?.left.map((m) => `${m.author}:${m.body}`) ?? [];

describe("ordering and the panels", () => {
  test("program messages, a prompt and the user's answer appear in order; a blank say is dropped", () => {
    const s = fold(live([started, said("Planning phase 1 ..."), said("\n"), asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" }]));
    expect(bodies(s)).toEqual(["program:Planning phase 1 ...", `program:${prompts.pagePromptText("decision", prompts.decisionPrompt)}`, `user:${prompts.CONTINUE_WITHOUT_DECIDING}`]);
    expect(s.run?.pending).toBe(null);
  });

  test("a pending prompt carries the catalog's choices; the question's options are apart (issue #12, S5)", () => {
    const decision = fold(live([started, asked(1, prompts.decisionPrompt)]));
    expect(decision.run?.pending?.choices.map((c) => c.label)).toEqual([prompts.CONTINUE_WITHOUT_DECIDING, prompts.END_RUN_LABEL]);
    expect(decision.run?.pending?.options).toEqual([]);
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?", summary: null, answered: 0, total: 1 };
    const interview = fold(live([started, notified(turn), said("\nWhich database?\n"), notified(presentedEvent("Which database?", [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }], { kind: "clarification", id: "Q1" })), asked(1, prompts.interviewMessagePrompt)]));
    expect(interview.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["PostgreSQL=1", "SQLite=2"]);
    expect(interview.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_CLARIFICATION}=/done`, `${prompts.END_RUN_LABEL}=/quit`]);
    const relayed = fold(live([started, notified(presentedEvent("A or B?", [{ label: "A", description: "a" }, { label: "B", description: "b" }])), asked(1, prompts.optionOrTextPrompt)]));
    expect(relayed.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A — a=1", "B — b=2"]);
    expect(relayed.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_RUN_LABEL}=q`]);
  });

  test("an answer to an interview shows the chosen option, or the fixed choice's label (issue #12, Q2)", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?", summary: null, answered: 0, total: 1 };
    const presented = presentedEvent("Which database?", [{ label: "PostgreSQL", description: "" }, { label: "SQLite", description: "" }], { kind: "clarification", id: "Q1" });
    const answered = (text: string) => fold(live([started, notified(turn), notified(presented), asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text }]));
    expect(bodies(answered("2")).at(-1)).toBe("user:SQLite");
    expect(bodies(answered("/done")).at(-1)).toBe(`user:${prompts.END_CLARIFICATION}`);
  });

  test("an answer that is a choice shows the choice's label", () => {
    const permission: UiEvent = { _tag: "QuestionPresented", question: { ...presentedOf(presentedEvent("Allow?", [])), options: [{ label: plainPieces("Allow"), description: [], answer: { token: "y" } }, { label: plainPieces("Deny"), description: [], answer: { token: "n" } }] } };
    const s = fold(live([started, notified(permission), asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }]));
    expect(bodies(s).at(-1)).toBe("user:Allow");
  });

  test("an interview turn and a proposed summary each appear once, live and after a replay", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null, answered: 0, total: 1 };
    const summary: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R", answered: 0, total: 1 };
    const events: RunEvent[] = [started, notified(turn), said("\nHello\n"), notified(summary), said("\nDone.\n"), said("Summary proposed by Claude Code:\n\n# R\n"), said("\nHello\n")];
    const expected = ["claude:Hello", "claude:Done.\n\n**Summary proposed by Claude:**\n\n# R", "program:\nHello\n"];
    expect(bodies(fold(live(events)))).toEqual(expected);
    expect(bodies(replayed(events))).toEqual(expected);
  });

  // Issue #46 (S19): a question of the plan writer reaches the user once, as its presented question; the plan-written
  // message does not also list it.
  test("a plan write is one program message with its result text and no list of questions, live and after a replay", () => {
    const events: RunEvent[] = [started, notified({ _tag: "PlanWritten", phase: 1, resultText: "I wrote the plan." })];
    for (const s of [fold(live(events)), replayed(events)]) {
      const m = s.run?.left.at(-1);
      expect(m?.format).toBe("markdown");
      expect(m?.author).toBe("program");
      // Issue #6: the run holds one planning phase, so it carries no number.
      expect(m?.body.startsWith(`**${prompts.planWrittenHeading("Planning")}**`)).toBe(true);
      expect(m?.body).toMatch(/I wrote the plan\./);
      expect(m?.body).not.toMatch(/Questions for you/);
    }
  });

  test("reviews and responses go to the right panel as Codex and Claude Code messages", () => {
    const review = { issues: [{ id: "A", severity: "major" as const, location: "l", problem: "p", evidence: "e" }] };
    const response = { dispositions: [{ id: "A", action: "accepted" as const, rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
    const s = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 2, review, counted: 1 }), notified({ _tag: "ResponseReceived", subject: { plan: 1 }, round: 2, response, resultText: "" })]));
    expect(s.run?.right.map((m) => [m.author, m.heading])).toEqual([["codex", "Planning phase 1, cycle 2"], ["claude", "Planning phase 1, cycle 2"]]);
    expect(s.run?.right[0].body).toMatch(/\*\*\[A\]\*\*/);
    // The author is the message's; the body does not repeat it (aesthetic and minimalist design).
    expect(s.run?.right.map((m) => m.body)).not.toContainEqual(expect.stringMatching(/^### /));
    const none = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 3, review: { issues: [] }, counted: 0 })]));
    expect(none.run?.right[0].body).toBe("No issue: the review has converged.");
  });
});

// Issue #5: what Claude Code writes is attributed to Claude, as data; the page names it "Claude".
describe("who speaks in the left panel", () => {
  const claudeSaid = notified({ _tag: "ClaudeSaid", text: "done" });

  test("Claude's prose is one message of Claude, without a prefix, live and after a replay", () => {
    for (const s of [fold(live([started, claudeSaid])), replayed([started, claudeSaid])]) {
      expect(s.run?.left.map((m) => [m.author, m.body])).toEqual([["claude", "done"]]);
    }
  });

  test("an interview turn and its proposed summary are Claude's; a plan write stays Interloq's", () => {
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 });
    const summary = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R", answered: 0, total: 1 });
    const plan = notified({ _tag: "PlanWritten", phase: 1, resultText: "" });
    for (const s of [fold(live([started, turn, summary, plan])), replayed([started, turn, summary, plan])]) {
      expect(s.run?.left.map((m) => m.author)).toEqual(["claude", "claude", "program"]);
    }
  });

  test("the activity line and the page's prompts say Claude", () => {
    const s = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning" })]));
    expect(s.run?.activity).toBe("Claude — planning");
    const tool = fold(live([started, notified({ _tag: "ToolUsed", agent: "claude", tool: "Read", target: "x" })]));
    expect(tool.run?.activity).toBe("Claude — Read: x");
    expect(prompts.pagePromptText("execInput", prompts.execInputPrompt)).toBe("Your input for Claude");
    expect(prompts.pagePromptText("startOrTalk", prompts.startOrTalkPrompt)).toBe("Claude and Codex agree that no question is needed. Start planning, or write a message to open a conversation with Claude.");
  });
});

// Issue #7: the left panel renders Markdown where Claude writes and where the user answers; Interloq's own texts stay plain.
describe("Markdown in the left panel", () => {
  const question: UiEvent = presentedEvent("A or **B**?", [{ label: "A", description: "a" }, { label: "B", description: "b" }]);
  const formats = (s: ViewState) => s.run?.left.map((m) => `${m.author}:${m.format}`) ?? [];

  test("Claude's prose is Markdown", () => {
    for (const s of [fold(live([started, notified({ _tag: "ClaudeSaid", text: "**done**" })])), replayed([started, notified({ _tag: "ClaudeSaid", text: "**done**" })])]) {
      expect(formats(s)).toEqual(["claude:markdown"]);
    }
  });

  test("a presented question is held with its options by the pending prompt, live and after a replay (S5, S26)", () => {
    const events: RunEvent[] = [started, notified(question), asked(1, prompts.optionOrTextPrompt)];
    for (const s of [fold(live(events)), replayed(events)]) {
      // S26: while pending, the question is the widget's, not the transcript's.
      expect(s.run?.left).toEqual([]);
      expect(s.run?.pending?.question).toEqual(presentedOf(question));
      expect(s.run?.pending?.options.map((c) => c.sends)).toEqual(["1", "2"]);
    }
  });

  test("the user's answers are Markdown, typed or chosen", () => {
    const typed = [started, asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text: "use **x**" } as RunEvent];
    const chosen = [started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" } as RunEvent];
    for (const s of [fold(live(typed)), replayed(typed), fold(live(chosen)), replayed(chosen)]) {
      expect(s.run?.left.at(-1)?.format).toBe("markdown");
    }
  });

  test("Interloq's lines, prompts and interview help stay plain; plan writes and interview turns stay Markdown", () => {
    const events: RunEvent[] = [
      started,
      said("a_b"),
      notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 }),
      notified({ _tag: "PlanWritten", phase: 1, resultText: "" }),
      asked(1, prompts.decisionPrompt),
      { _tag: "Answered", prompt: 1, text: "" },
    ];
    expect(formats(fold(live(events)))).toEqual(["program:text", "program:text", "claude:markdown", "program:markdown", "program:text", "user:markdown"]);
  });
});

// Plan step 4.7 (the review against the heuristics): the page states a prompt without the terminal's key
// conventions, which the buttons replace [match between the system and the real world].
test("every prompt is shown in the page's words, without the terminal's key conventions", () => {
  const texts = [prompts.decisionPrompt, prompts.limitPrompt, prompts.limitNoProceedPrompt, prompts.execInputPrompt, prompts.optionOrTextPrompt, prompts.permissionPrompt, prompts.interviewMessagePrompt, prompts.confirmSummaryPrompt, prompts.startOrTalkPrompt];
  for (const text of texts) {
    const body = fold(live([started, asked(1, text)])).run?.pending?.hint ?? "";
    expect(body, text).not.toMatch(/>\s*$|\bq = quit|Enter =|= stop|p = /);
    expect(body.trim(), text).not.toBe("");
  }
  expect(fold(live([started, asked(1, "Something new > ")])).run?.pending?.hint).toBe("Something new");
});

describe("activity and timeline", () => {
  test("the activity line shows the last agent event and is cleared at the end of a phase", () => {
    const s1 = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review" }), notified({ _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff" })]));
    expect(s1.run?.activity).toBe("Codex — review — command: git diff");
    expect(s1.run?.busy).toBe(true);
    const s2 = fold([{ type: "event", run: 1, seq: 3, time: at(3), event: notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" }) }], s1);
    expect(s2.run?.activity).toBe("");
  });

  test("the activity line names a call's purpose in the user's words: clarification and implementation (issues #14, #21)", () => {
    const of = (purpose: string) => fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose })])).run?.activity;
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
    const entry = during.run?.timeline[0];
    expect(entry?.state).toBe("active");
    expect(entry?.steps.flatMap((st) => st.groups.map((g) => [g.heading, g.done]))).toEqual([["Question review", true], ["Requirements review", false]]);
    const after = fold(live([...events, notified({ _tag: "LoopFinished", subject: "requirements", result: "converged" }), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })]));
    expect(after.run?.timeline[0].state).toBe("done");
    expect(replayed(events).run?.timeline).toEqual(during.run?.timeline);
  });

  test("phases appear in order with their rounds; an interrupted run stops the active phase", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 }), { _tag: "Ended", code: 130 }]));
    expect(s.run?.timeline.map((e) => [e.label, e.state])).toEqual([["Planning", "stopped"]]);
    expect(s.run?.timeline[0].groups[0].rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(s.run?.ended).toBe(130);
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
  const groupOf = (s: ViewState) => s.run?.timeline[0].groups[0];

  test("a cycle carries the issues its review raised and the counted ones; a cycle without its review has none yet", () => {
    const s = fold(live(events));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, null, null]]);
    expect(groupOf(s)?.corrections).toBe(3);
    expect(groupOf(s)?.result).toBe(null);
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("LoopFinished records the loop's result; the corrections of every cycle are summed", () => {
    const finished = [...events, notified({ _tag: "ReviewReceived", subject: plan, round: 2, review: { issues: [] }, counted: 0 }), notified({ _tag: "LoopFinished", subject: plan, result: "converged" })];
    const s = fold(live(finished));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, 0, 0]]);
    expect([groupOf(s)?.result, groupOf(s)?.done, groupOf(s)?.corrections]).toEqual(["converged", true, 3]);
    expect(replayed(finished).run?.timeline).toEqual(s.run?.timeline);
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
  const turn = (answered: number, total: number, summary: string | null = null) => notified({ _tag: "InterviewTurn", heading: "Clarification", message: "Hi", summary, answered, total });
  const opened = (stage: "clarification" | "followUp" | "conversation", total: number) => notified({ _tag: "InterviewOpened", heading: "Clarification", stage, total });
  const round = (subject: "questions" | "requirements", n: number) => notified({ _tag: "RoundBegan", subject, round: n, limit: 5 });
  const finished = (subject: "questions" | "requirements") => notified({ _tag: "LoopFinished", subject, result: "converged" });
  const steps = (s: ViewState) => s.run?.timeline[0].steps.map((st) => [st.label, st.state, st.count === null ? null : `${st.count.answered}/${st.count.total}`, st.groups.map((g) => `${g.heading}:${g.rounds.map((c) => c.round).join(",")}`).join(";")]);
  const through = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("clarification", 7), turn(0, 7), turn(3, 7)];

  test("the question phase begins with its first step, which holds the question review's cycles", () => {
    const s = fold(live(through.slice(0, 3)));
    expect(steps(s)).toEqual([[prompts.stepLabel("formulate"), "active", null, "Question review:1"]]);
    expect(s.run?.timeline[0].groups).toEqual([]);
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
      ["Clarification", "active", "1/2"],
    ]);
  });

  test("InterviewOpened ends the first step and opens Clarification with its total; each turn updates the count", () => {
    const s = fold(live(through));
    expect(steps(s)).toEqual([[prompts.stepLabel("formulate"), "done", null, "Question review:1"], ["Clarification", "active", "3/7", ""]]);
    expect(replayed(through).run?.timeline).toEqual(s.run?.timeline);
  });

  // Issue #51 (Q4): the follow-up clarifications are one conversation with the clarification, so they fold into its
  // step: the counts are summed, and the requirements review is one group of cycles under it.
  test("a follow-up clarification folds into the Clarification step: counts summed, one group of the requirements review", () => {
    const followUp = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 2)];
    expect(steps(fold(live(followUp)))?.at(-1)).toEqual(["Clarification", "active", "7/9", "Requirements review:1"]);
    expect(steps(fold(live([...followUp, turn(1, 2)])))?.at(-1)).toEqual(["Clarification", "active", "8/9", "Requirements review:1"]);
    const events = [...followUp, turn(1, 2), turn(2, 2, "# R2"), round("requirements", 2), finished("requirements"), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })];
    const s = fold(live(events));
    expect(steps(s)).toEqual([
      [prompts.stepLabel("formulate"), "done", null, "Question review:1"],
      ["Clarification", "done", "9/9", "Requirements review:1,2"],
    ]);
    expect(s.run?.timeline[0].steps[1].groups.length).toBe(1);
    expect(s.run?.timeline[0].steps[1].groups[0].result).toBe("converged");
    expect(s.run?.timeline[0].state).toBe("done");
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("every further follow-up folds in the same way", () => {
    const events = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 1), turn(1, 1, "# R2"), round("requirements", 2), opened("followUp", 3), turn(2, 3), round("requirements", 3), finished("requirements")];
    const s = fold(live(events));
    expect(steps(s)?.map((st) => st[0])).toEqual([prompts.stepLabel("formulate"), "Clarification"]);
    expect(steps(s)?.at(-1)).toEqual(["Clarification", "active", "10/11", "Requirements review:1,2,3"]);
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("a follow-up after the conversation of an empty list folds into the same step", () => {
    const events = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("conversation", 0), turn(0, 0, "# R"), round("requirements", 1), opened("followUp", 2), turn(2, 2)];
    expect(steps(fold(live(events)))).toEqual([[prompts.stepLabel("formulate"), "done", null, "Question review:1"], ["Clarification", "active", "2/2", "Requirements review:1"]]);
  });

  test("the conversation after an empty list is a Clarification whose count starts at 0 of 0", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("conversation", 0)]));
    expect(steps(s)?.at(-1)).toEqual(["Clarification", "active", "0/0", ""]);
  });

  test("a run that ends during a clarification stops that step with its phase; the earlier steps stay done", () => {
    const events = [...through, { _tag: "Ended", code: 130 } as RunEvent];
    const s = fold(live(events));
    expect(s.run?.timeline[0].state).toBe("stopped");
    expect(steps(s)?.map((st) => st[1])).toEqual(["done", "stopped"]);
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("the other phases have no steps", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } })]));
    expect(s.run?.timeline[0].steps).toEqual([]);
  });

  test("the compact progress line names the active step and its count, or its latest cycle", () => {
    expect(progressOf(fold(live(through)).run!)).toBe("Progress: Gather Requirements — Clarification, 3 of 7 answered");
    expect(progressOf(fold(live(through.slice(0, 3))).run!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("formulate")), "cycle 1"));
    expect(progressOf(fold(live([...through, turn(7, 7, "# R"), round("requirements", 1)])).run!)).toBe("Progress: Gather Requirements — Clarification, cycle 1");
  });
});

// Issue #14: the compact window's progress line names the latest cycle, without a limit.
describe("the compact progress line", () => {
  test("the active phase and its latest cycle; none before any phase", () => {
    const planning = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 })]));
    expect(progressOf(planning.run!)).toBe("Progress: Planning, cycle 2");
    expect(progressOf(fold(live([started])).run!)).toBe("Progress: no phase has begun");
    const execution = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } })]));
    expect(progressOf(execution.run!)).toBe("Progress: Implementation");
  });
});

describe("runs, replay and gaps", () => {
  test("a seq that does not follow sets the reconnect flag; a new run's Started at seq 0 after Ended is not a gap", () => {
    const one = fold(live([started, { _tag: "Ended", code: 0 }]));
    expect(one.needsReconnect).toBe(false);
    const two = fold([{ type: "event", run: 2, seq: 0, time: at(0), event: started }], one);
    expect(two.needsReconnect).toBe(false);
    expect([two.run?.id, two.last?.id]).toEqual([2, 1]);
    const gap = fold([{ type: "event", run: 2, seq: 5, time: at(5), event: said("x") }], two);
    expect(gap.needsReconnect).toBe(true);
    const badStart = fold([{ type: "event", run: 3, seq: 4, time: at(4), event: started }], two);
    expect(badStart.needsReconnect).toBe(true);
  });

  test("a refusal becomes a notice; a listing is kept", () => {
    const s = fold([hello(null), { type: "refused", reason: "a run is in progress" }, { type: "listing", path: "/p", parent: "/", dirs: ["a"], error: null }]);
    expect(s.notices).toEqual(["a run is in progress"]);
    expect(s.listing?.dirs).toEqual(["a"]);
    expect(s.connection).toBe("open");
    expect(s.cwd).toBe("/p");
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
      { _tag: "InterviewOpened", heading: "Clarification", stage: "clarification", total: 2 },
      { _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 },
      { _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }, counted: 1 },
      { _tag: "ResponseReceived", subject: { plan: 1 }, round: 1, response: { dispositions: [{ id: "A", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" },
      { _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" },
      { _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 },
      { _tag: "AgentCallStarted", agent: "claude", purpose: "planning" },
      { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "a" },
      // Issue #6: the phases ahead, the plan, and nested calls.
      { _tag: "PhasesForeseen", phases: foreseenPhases(true, 1) },
      { _tag: "PhasesForeseen", phases: foreseenPhases(true, 2) },
      { _tag: "PlanChanged", phase: 1, plan: { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "x", status: "started" }] }] }, step: null },
      { _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } },
      { _tag: "AgentCallEnded", agent: "claude", ok: true },
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
        const incremental = fold([hello(null), { type: "replay", runs: [] }, ...first.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 1, seq, time, event })), ...second.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 2, seq, time, event }))]);
        const replay = fold([hello(2), { type: "replay", runs: [{ id: 1, events: first }, { id: 2, events: second }] }]);
        expect(replay.run).toEqual(incremental.run);
        expect(replay.last).toEqual(incremental.last);
        expect(incremental.needsReconnect).toBe(false);
        // Every phase that began has ended by Ended(0), and has retired the steps it never began.
        expect(incremental.last?.timeline.filter((e) => e.state !== "ahead").flatMap((e) => e.steps.filter((st) => st.state === "ahead"))).toEqual([]);
      }),
      // A phase that began and a step of it that never did, always among the cases rather than only when drawn.
      { examples: [[[notified({ _tag: "PhasesForeseen", phases: foreseenPhases(true, 1) }), notified({ _tag: "PhaseBegan", phase: { kind: "questions" } })], [], Array(14).fill(0), Array(14).fill(0)]] },
    );
  });
});

// Finding 12 of docs/gui-review.md: a hello from another incarnation clears the view of the earlier server's runs.
describe("a server restart", () => {
  test("a hello with a new incarnation clears the old run's view; the same incarnation keeps it", () => {
    const withRun = reduce(reduce(initialState, { type: "hello", cwd: "/w", current: 3, incarnation: "a" }), { type: "replay", runs: [{ id: 3, events: [{ time: at(0), event: { _tag: "Started", project: "/p", task: "t" } }] }] });
    expect(withRun.run?.id).toBe(3);
    expect(withRun.incarnation).toBe("a");
    expect(reduce(withRun, { type: "hello", cwd: "/w", current: 3, incarnation: "a" }).run?.id).toBe(3);
    const restarted = reduce(withRun, { type: "hello", cwd: "/w", current: null, incarnation: "b" });
    expect([restarted.run, restarted.last, restarted.incarnation]).toEqual([null, null, "b"]);
    const next = reduce(restarted, { type: "event", run: 1, seq: 0, time: at(0), event: { _tag: "Started", project: "/p", task: "u" } });
    expect(next.run?.id).toBe(1);
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
    const liveRun = fold(live(events)).run;
    expect(liveRun?.answered).toEqual([1, 2]);
    expect(replayed(events).run?.answered).toEqual(liveRun?.answered);
  });
});

// Finding 8 of docs/gui-review.md: the page renders the interview's help without the terminal's """ convention.
describe("the interview's opening help", () => {
  test("the page message names /done, /quit and Shift+Enter, and has no triple quotes", () => {
    const s = fold(live([started, notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 })]));
    const body = s.run?.left.at(-1)?.body ?? "";
    expect(body).toBe(prompts.interviewHelp("Interview", "page"));
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
  test("decoded as the socket decodes it, it yields both panels and the pending interview prompt", () => {
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhaseBegan", phase: { kind: "questions" } }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "ReviewReceived", subject: "questions", round: 1, review: { issues: [{ id: "Q-R1-1", severity: "major", location: "Q1", problem: "The list does not ask for the database.", evidence: "e" }] }, counted: 1 }),
      notified({
        _tag: "ResponseReceived",
        subject: "questions",
        round: 1,
        response: {
          dispositions: [{ id: "Q-R1-1", action: "accepted", rationale: "Added the database question.", duplicate_of: "", reverses: "" }],
          self_corrections: [],
          reviewer_feedback: "",
          questions_for_user: [],
          questions: [{ id: "Q1", context: plainBlocks("c"), question: plainPieces("Which database?"), reason: plainBlocks("r"), proposed_answers: [{ label: plainPieces("PostgreSQL"), description: plainPieces("p") }, { label: plainPieces("SQLite"), description: plainPieces("s") }], default_answer: "PostgreSQL" }],
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
    const frames = [JSON.stringify(hello()), JSON.stringify({ type: "replay", runs: [{ id: 1, events: stamp(events) }] })];
    const messages = frames.map((f) => {
      const d = decodeServer(f);
      if (d._tag !== "Success") throw new Error(`not decoded: ${d.failure}`);
      return d.success;
    });
    const s = fold(messages);
    const right = s.run?.right.map((m) => `${m.author}:${m.body}`) ?? [];
    expect(right.length).toBe(2);
    expect(right[0]).toMatch(/^codex:.*The list does not ask for the database\./s);
    expect(right[1]).toMatch(/^claude:.*\[Q-R1-1\]\*\* accepted: Added the database question\./s);
    expect(bodies(s).slice(0, 2)).toEqual([`program:${prompts.interviewHelp("Interview", "page")}`, "claude:Which database should the service use?\n1. PostgreSQL\n2. SQLite"]);
    expect(s.run?.pending?.asked.kind).toBe("interviewMessage");
    expect(s.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["PostgreSQL=1", "SQLite=2"]);
    expect(s.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.END_CLARIFICATION}=/done`, `${prompts.END_RUN_LABEL}=/quit`]);
  });
});

// Issue #1: each message carries the time its event was published; a time is shown when the author changes or more
// than 2 minutes lie between a message and the one before it in the same panel (decision Q3).
describe("the time of a message", () => {
  const review = notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 });
  const shown = (s: ViewState, panel: "left" | "right" = "left") => s.run?.[panel].map((m) => m.showTime) ?? [];

  test("a message carries its event's time, live and after a replay, and the first of a panel shows it", () => {
    for (const s of [fold(live([started, said("a")], 1, [0, 5])), replayed([started, said("a")], 1, 1, [0, 5])]) {
      expect(s.run?.left[0]?.time).toBe(at(5));
      expect(s.run?.left[0]?.showTime).toBe(true);
    }
  });

  test("the same author within 2 minutes is grouped; exactly 2 minutes too; more than 2 minutes shows the time", () => {
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 60])))).toEqual([true, false]);
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 120])))).toEqual([true, false]);
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 121])))).toEqual([true, true]);
  });

  test("another author shows the time, however close", () => {
    const s = fold(live([started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }, said("c")], 1, [0, 0, 1, 2]));
    expect(s.run?.left.map((m) => m.author)).toEqual(["program", "user", "program"]);
    expect(shown(s)).toEqual([true, true, true]);
  });

  test("each panel groups on its own: a review between two program lines does not separate them, nor a line two reviews", () => {
    const s = fold(live([started, said("a"), review, said("b"), review], 1, [0, 0, 10, 20, 30]));
    expect(shown(s, "left")).toEqual([true, false]);
    expect(shown(s, "right")).toEqual([true, false]);
  });

  // Issue #15: the gap is measured from the last time shown in the panel, so no long span goes unmarked.
  test("thirty messages 90 s apart show a time whenever more than 2 minutes lie since the last time shown", () => {
    const lines = Array.from({ length: 30 }, (_, i) => said(`line ${i}`));
    const times = [0, ...lines.map((_, i) => i * 90)];
    const expected = lines.map((_, i) => i % 2 === 0);
    expect(shown(fold(live([started, ...lines], 1, times)))).toEqual(expected);
    expect(shown(replayed([started, ...lines], 1, 1, times))).toEqual(expected);
  });

  test("a message just inside 2 minutes of the last time shown stays grouped", () => {
    expect(shown(fold(live([started, said("a"), said("b"), said("c")], 1, [0, 0, 60, 119])))).toEqual([true, false, false]);
  });

  test("an event that makes no message (a blank line, an absorbed line, Ended) does not count as the message before", () => {
    const blank = fold(live([started, said("a"), said("\n"), said("b")], 1, [0, 0, 60, 170]));
    expect(shown(blank)).toEqual([true, true]);
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 });
    const absorbed = fold(live([started, turn, said("\nHi\n"), said("b")], 1, [0, 0, 100, 150]));
    expect(absorbed.run?.left.map((m) => m.body)).toEqual(["Hi", "b"]);
    expect(shown(absorbed)).toEqual([true, true]);
    const ended = fold(live([started, said("a"), { _tag: "Ended", code: 0 }], 1, [0, 0, 500]));
    expect(ended.run?.left.map((m) => [m.time, m.showTime])).toEqual([[at(0), true]]);
  });

  test("a tab that joins late or reconnects folds the replay to the same messages, times and grouping as a live tab", () => {
    const events = [started, said("a"), review, said("b"), asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "" } as RunEvent, said("c")];
    const times = [0, 1, 2, 30, 200, 210, 400];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    const again = fold([hello(1), { type: "replay", runs: [{ id: 1, events: stamp(events, times) }] }], late);
    for (const s of [late, again]) {
      expect(s.run?.left).toEqual(liveView.run?.left);
      expect(s.run?.right).toEqual(liveView.run?.right);
    }
    expect(liveView.run?.left.map((m) => [m.time, m.showTime])).toEqual([[at(1), true], [at(30), false], [at(200), true], [at(210), true], [at(400), true]]);
  });

  test("showsTime: no message before, another author, more than 120 s since the last time shown, or a time that cannot be read", () => {
    const m = { key: "1-1", author: "program" as const, heading: null, body: "a", format: "text" as const, time: at(0), showTime: true, band: null };
    const next = (author: "program" | "user", time: string, band: Band | null = null) => ({ author, band, time });
    expect(showsTime(undefined, null, next("program", at(0)))).toBe(true);
    expect(showsTime(m, at(0), next("user", at(1)))).toBe(true);
    expect(showsTime(m, at(0), next("program", at(120)))).toBe(false);
    expect(showsTime(m, at(0), next("program", at(121)))).toBe(true);
    // Measured from the last time shown, not from the message just before (issue #15).
    expect(showsTime({ ...m, time: at(100) }, at(0), next("program", at(121)))).toBe(true);
    expect(showsTime(m, at(0), next("program", "not a time"))).toBe(true);
    expect(showsTime(m, "not a time", next("program", at(1)))).toBe(true);
    // The first message of a band: measured from the band's label, whoever wrote it (G-R1-1).
    const band: Band = { key: "planning-1", kind: "planning", name: "Planning 1", began: at(100) };
    expect(showsTime(m, at(0), next("user", at(130), band))).toBe(false);
    expect(showsTime(undefined, null, next("user", at(221), band))).toBe(true);
    expect(showsTime({ ...m, band, time: at(130), showTime: false }, at(100), next("program", at(200), band))).toBe(false);
  });
});

// Issue #15: each phase is a band in each panel where it places a message, opened by a label with its name and the
// time it began; the label's time counts as shown (G-R1-1).
describe("phase bands", () => {
  const began = (phase: UiEvent extends infer E ? (E extends { _tag: "PhaseBegan"; phase: infer P } ? P : never) : never): RunEvent => notified({ _tag: "PhaseBegan", phase });
  const planning = (n: number) => began({ kind: "planning", n });
  const execution = (n: number) => began({ kind: "execution", n });
  const review = notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 });
  const views = (events: readonly RunEvent[], times: readonly number[]) => [fold(live(events, 1, times)), replayed(events, 1, 1, times)];
  const shown = (s: ViewState, panel: "left" | "right" = "left") => s.run?.[panel].map((m) => m.showTime) ?? [];

  test("a message before any phase has no band and shows its time as the first of its panel", () => {
    for (const s of views([started, said("a")], [0, 5])) {
      expect(s.run?.left.map((m) => [m.band, m.showTime])).toEqual([[null, true]]);
    }
  });

  test("the first message after a label shows no time within 2 minutes of it, although it is the first of its panel", () => {
    for (const s of views([started, planning(1), said("a"), said("b"), said("c")], [0, 100, 130, 200, 260])) {
      expect(s.run?.left[0]?.band).toEqual({ key: "planning-1", kind: "planning", name: "Planning", began: at(100) });
      expect(shown(s)).toEqual([false, false, true]);
    }
  });

  test("the first message after a label shows its time more than 2 minutes after it, whoever wrote it", () => {
    for (const s of views([started, said("a"), planning(1), said("b")], [0, 0, 10, 131])) {
      expect(shown(s)).toEqual([true, true]);
    }
    const answered: RunEvent = { _tag: "Answered", prompt: 1, text: "y" };
    for (const s of views([started, said("a"), planning(1), asked(1, prompts.permissionPrompt), answered], [0, 0, 10, 20, 30])) {
      // The prompt is exempt from the change of author, being the band's first; the answer after it is not.
      expect(shown(s)).toEqual([true, false, true]);
    }
  });

  test("a message of the right panel opens the phase's band there; a phase without a message there makes none", () => {
    for (const s of views([started, planning(1), said("a"), review, execution(1), said("x")], [0, 0, 1, 300, 310, 311])) {
      expect(s.run?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["planning-1", true]]);
      expect(bandsOf(s.run?.right ?? []).map((g) => g.band?.key)).toEqual(["planning-1"]);
      expect(bandsOf(s.run?.left ?? []).map((g) => g.band?.key)).toEqual(["planning-1", "execution-1"]);
    }
  });

  test("the lines after a phase ends stay in its band until the next phase begins", () => {
    const ended = notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" });
    for (const s of views([started, planning(1), said("a"), ended, said("b")], [0, 0, 1, 2, 3])) {
      expect(s.run?.left.map((m) => m.band?.key)).toEqual(["planning-1", "planning-1"]);
    }
  });

  test("bandsOf groups consecutive messages of a band: before any phase, execution, planning, execution", () => {
    const events = [started, said("m0"), execution(1), said("e1"), planning(2), said("p1"), said("p2"), execution(2), said("e2")];
    for (const s of views(events, events.map((_, i) => i))) {
      const groups = bandsOf(s.run?.left ?? []);
      expect(groups.map((g) => [g.band?.kind ?? null, g.band?.name ?? null, g.messages.map((m) => m.body)])).toEqual([
        [null, null, ["m0"]],
        ["execution", "Implementation 1", ["e1"]],
        // Issue #6: one planning phase in the run carries no number; the two executions are renumbered when the second begins.
        ["planning", "Planning", ["p1", "p2"]],
        ["execution", "Implementation 2", ["e2"]],
      ]);
    }
  });

  test("a tab that joins late folds the bands and their times as a live tab does", () => {
    const events = [started, said("a"), began({ kind: "questions" }), said("b"), review, planning(1), said("c"), review];
    const times = [0, 1, 2, 3, 4, 200, 201, 202];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    expect(late.run?.left).toEqual(liveView.run?.left);
    expect(late.run?.right).toEqual(liveView.run?.right);
    expect(liveView.run?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["questions", false], ["planning-1", false]]);
  });
});

// Decision support, plan step 3.6.
describe("decision support", () => {
  const positions = [{ label: "Follow Codex", description: "the issue" }, { label: "Follow Claude", description: "the rationale" }];
  const presented: UiEvent = presentedEvent("Should Codex's position or Claude Code's position stand?", positions, { kind: "pause", heading: "Planning phase 1", pause: "reraised", id: "A" });
  const analysis = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const analyzed = (decision: number): UiEvent => ({ _tag: "DecisionAnalyzed", decision, question: "issue A", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details: [], decision: null }, options: positions, analysis });

  test("presented options become the cards of the next decision prompt; the offer is a choice", () => {
    const s = fold(live([started, notified(presented), asked(1, prompts.withOffer(prompts.decisionPrompt))]));
    expect(s.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["Follow Codex — the issue=1", "Follow Claude — the rationale=2"]);
    expect(s.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual([`${prompts.CONTINUE_WITHOUT_DECIDING}=`, `${prompts.HELP_ME_DECIDE}=/decide`, `${prompts.END_RUN_LABEL}=q`]);
    expect(bodies(s)).toEqual([]);
    expect(s.run?.pending?.hint).toBe(prompts.pagePromptText("decision", prompts.decisionPrompt));
    const helped = fold([{ type: "event", run: 1, seq: 3, time: at(3), event: { _tag: "Answered", prompt: 1, text: "/decide" } }], s);
    expect(bodies(helped)).toEqual([`program:${piecesText(presentedOf(presented).question)}`, `user:${prompts.HELP_ME_DECIDE}`]);
  });

  test("options never outlive their prompt: a pause without options after one with options shows no cards", () => {
    const s = fold(live([started, notified(presented), asked(1, prompts.decisionPrompt), { _tag: "Answered", prompt: 1, text: "1" }, asked(2, prompts.decisionPrompt)]));
    expect(s.run?.pending?.options).toEqual([]);
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
    expect(s.run?.pending?.options.map((c) => c.label)).toEqual(["A", "B"]);
  });

  // S21 (Q4): while the analysis is prepared, one plain status message, updated in place at every check.
  test("the analysis's progress is one message, updated in place, live and after a replay", () => {
    const progress = (check: number): RunEvent => notified({ _tag: "AnalysisProgress", decision: 1, question: 3, check });
    const events: RunEvent[] = [started, said("a"), progress(0), progress(1), said("b"), progress(2)];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(bodies(s)).toEqual(["program:a", `program:${prompts.analysisProgressLine(1, 3, 2).trim()}`, "program:b"]);
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
    expect(s.run?.timeline).toEqual(before.run?.timeline);
    expect(progressOf(s.run!)).toBe(progressOf(before.run!));
    expect(s.run?.analysis?.event.decision).toBe(1);
    expect(s.run?.analysis?.prompt).toBe(2);
    const answered = fold([{ type: "event", run: 1, seq: 9, time: at(9), event: { _tag: "Answered", prompt: 2, text: "1" } }], s);
    expect(answered.run?.analysis).toBe(null);
    // A replay folds alike.
    expect(replayed([started, notified(analyzed(3)), asked(1, prompts.withOffer(prompts.decisionPrompt))]).run?.analysis?.event.decision).toBe(3);
  });
});

// W1-R1-2: a relayed question presented again before the retry of a blank answer keeps its cards.
test("a blank answer to a relayed question, then the question presented again: the retry keeps both cards", () => {
  const question: UiEvent = presentedEvent("A or B?", [{ label: "A", description: "a" }, { label: "B", description: "b" }]);
  const s = fold(live([started, notified(question), asked(1, prompts.withOffer(prompts.optionOrTextPrompt)), { _tag: "Answered", prompt: 1, text: "" }, notified(question), asked(2, prompts.withOffer(prompts.optionOrTextPrompt))]));
  expect(s.run?.pending?.asked.prompt).toBe(2);
  expect(s.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A — a=1", "B — b=2"]);
});

// W2-R1-1: a decision's response (with its amended analysis) folds into one Claude message; the rail is unchanged.
test("a decision's ResponseReceived is one Claude message in the right panel, live and replayed, and adds nothing to the rail", () => {
  const analysisOf = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const response = { dispositions: [{ id: "D1-R1-1", action: "accepted" as const, rationale: "amended", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [], analysis: analysisOf };
  const phase = notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } });
  const events: RunEvent[] = [started, phase, notified({ _tag: "ResponseReceived", subject: { decision: 1 }, round: 1, response, resultText: "" })];
  const before = fold(live([started, phase]));
  for (const s of [fold(live(events)), replayed(events)]) {
    expect(s.run?.right.map((m) => m.author)).toEqual(["claude"]);
    expect(s.run?.right[0].body).toMatch(/D1-R1-1/);
    expect(s.run?.timeline).toEqual(before.run?.timeline);
  }
  // The message decodes from the wire as well.
  const wire: ServerMessage = { type: "event", run: 1, seq: 2, time: at(2), event: events[2] };
  expect(decodeServer(JSON.stringify(wire))._tag).toBe("Success");
});

// W3-R1-1: a reply the run rejects (a blank answer where one is required) keeps the analysis for the prompt asked again.
test("a rejected blank reply keeps the analysis for the retry; an accepted empty answer and the retry's answer dismiss it", () => {
  const options = [{ label: "A", description: "" }, { label: "B", description: "" }];
  const analyzedEvent: UiEvent = { _tag: "DecisionAnalyzed", decision: 1, question: "A or B?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: plainBlocks("c"), by: "agent" }, explanations: [], question: plainPieces("Q?"), options: [], details: [], decision: null }, options, analysis: { decision: "d", columns: [], recommendation: { option: "", reason: "" } } };
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
  for (const s of [fold(live(rejected)), replayed(rejected)]) expect(s.run?.analysis?.prompt).toBe(3);
  const answered = fold(live([...rejected, { _tag: "Answered", prompt: 3, text: "1" }]));
  expect(answered.run?.analysis).toBe(null);
  const accepted = fold(live([started, notified(analyzedEvent), asked(2, prompts.withOffer(prompts.decisionPrompt)), { _tag: "Answered", prompt: 2, text: "" }, asked(3, prompts.decisionPrompt)]));
  expect(accepted.run?.analysis).toBe(null);
});

// Issue #6 (Q5, Q9): the reducer keeps the current plan with the phase that carries it out; every write replaces it.
describe("the plan", () => {
  const planOf = (id: string, status: "pending" | "done") => ({ stages: [{ number: 1, title: "t", steps: [{ id, number: 1, label: "l", text: "x", status }] }] });
  test("PlanChanged keeps the latest plan and its phase, live and after a replay", () => {
    const events = [started, notified({ _tag: "PlanChanged", phase: 1, plan: planOf("S1", "pending"), step: null }), notified({ _tag: "PlanChanged", phase: 2, plan: planOf("S2", "done"), step: null })];
    const s = fold(live(events));
    expect(s.run?.plan).toEqual({ phase: 2, plan: planOf("S2", "done") });
    expect(replayed(events).run?.plan).toEqual(s.run?.plan);
  });
});

// Issue #6: the whole run in the timeline, numbered by the count of each kind, the plan under the Implementation that
// carries it out, and the current step only while an execution call runs (G-R1-2), nested calls included (P1-R2-1).
describe("the whole run in the timeline", () => {
  const foreseen = (questions: boolean, iterations: number) => notified({ _tag: "PhasesForeseen", phases: foreseenPhases(questions, iterations) });
  const began = (phase: Parameters<typeof phaseName>[0]) => notified({ _tag: "PhaseBegan", phase });
  const entries = (s: ViewState) => s.run?.timeline.map((e) => [e.label, e.state]) ?? [];
  const recorded = (id: string, status: "pending" | "started" | "done" | "unfinished") => ({ stages: [{ number: 1, title: "t", steps: [{ id, number: 1, label: "l", text: "x", status }] }] });

  test("the entries foreseen at the start, with and without the question phase", () => {
    const withQuestions = fold(live([started, foreseen(true, 1)]));
    expect(entries(withQuestions)).toEqual([["Gather Requirements", "ahead"], ["Planning", "ahead"], ["Implementation", "ahead"], ["Work review", "ahead"]]);
    expect(withQuestions.run?.timeline[0].steps.map((st) => [st.label, st.state])).toEqual([[prompts.stepLabel("formulate"), "ahead"], [prompts.stepLabel("clarification"), "ahead"]]);
    expect(entries(fold(live([started, foreseen(false, 1)])))).toEqual([["Planning", "ahead"], ["Implementation", "ahead"], ["Work review", "ahead"]]);
  });

  test("the seam of the labels: Planning becomes Planning 1 in the rail and in its band the moment Planning 2 is foreseen", () => {
    const before = [started, foreseen(false, 1), began({ kind: "planning", n: 1 }), said("a")];
    const one = fold(live(before));
    expect([one.run?.timeline[0].label, one.run?.left[0].band?.name]).toEqual([phaseName({ kind: "planning", n: 1 }, 1), phaseName({ kind: "planning", n: 1 }, 1)]);
    for (const s of [fold(live([...before, foreseen(false, 2)])), replayed([...before, foreseen(false, 2)])]) {
      expect(s.run?.timeline[0].label).toBe(phaseName({ kind: "planning", n: 1 }, 2));
      expect(s.run?.left[0].band?.name).toBe(s.run?.timeline[0].label);
      expect(entries(s).map(([label]) => label)).toEqual(["Planning 1", "Implementation 1", "Work review 1", "Planning 2", "Implementation 2", "Work review 2"]);
    }
  });

  test("a phase that begins turns its entry active; a run that halts leaves the phases ahead not reached", () => {
    const s = fold(live([started, foreseen(false, 1), began({ kind: "planning", n: 1 }), { _tag: "Ended", code: 1 }]));
    expect(entries(s)).toEqual([["Planning", "stopped"], ["Implementation", "notReached"], ["Work review", "notReached"]]);
    const finished = fold(live([started, foreseen(false, 1), began({ kind: "planning", n: 1 }), { _tag: "Ended", code: 0 }]));
    expect(entries(finished)[1]).toEqual(["Implementation", "ahead"]);
  });

  // A foreseen step that never began is retired when its phase ends: "skipped", not "ahead", and not "notReached",
  // which a halt gives. The states are compared as strings.
  const stepStates = (s: ViewState) => s.run?.timeline.map((e) => e.steps.map((st) => [st.kind, st.state as string])) ?? [];
  const noStepAhead = (s: ViewState) => s.run?.timeline.every((e) => e.steps.every((st) => (st.state as string) !== "ahead")) ?? false;
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
    expect(ended.run?.timeline[0].steps.every((st) => (st.state as string) !== "ahead")).toBe(true);
    expect(stepStates(ended)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    const finished = fold(live([...prefix, { _tag: "Ended", code: 0 }]));
    expect(stepStates(finished)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
    const halted = fold(live([...prefix, { _tag: "Ended", code: 1 }]));
    expect(stepStates(halted)[0]).toEqual([["formulate", "stopped"], ["clarification", "notReached"]]);
    const skippedThenHalted = fold(live([...prefix, notified({ _tag: "PhaseEnded", phase: q, result: "converged" }), { _tag: "Ended", code: 1 }]));
    expect(stepStates(skippedThenHalted)[0]).toEqual([["formulate", "done"], ["clarification", "skipped"]]);
  });

  test("the plan hangs under the Implementation of its phase, and a revision moves it there (Q5, Q9)", () => {
    const first = [started, foreseen(false, 1), began({ kind: "planning", n: 1 }), notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "pending"), step: null })];
    const plans = (x: ViewState) => x.run?.timeline.map((e) => bare(e.plan));
    const one = fold(live(first));
    expect(plans(one)).toEqual([null, recorded("S1", "pending"), null]);
    const revised = fold(live([...first, foreseen(false, 2), notified({ _tag: "PlanChanged", phase: 2, plan: recorded("S2", "pending"), step: null })]));
    expect(plans(revised)).toEqual([null, null, null, null, recorded("S2", "pending"), null]);
    // A phase that was not foreseen (a replay of an older run) takes the plan when it begins.
    const late = fold(live([started, notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "pending"), step: null }), began({ kind: "execution", n: 1 })]));
    expect(bare(late.run?.timeline[0].plan ?? null)).toEqual(recorded("S1", "pending"));
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
    const call = (agent: "claude" | "codex", purpose: string) => notified({ _tag: "AgentCallStarted", agent, purpose });
    const end = (agent: "claude" | "codex") => notified({ _tag: "AgentCallEnded", agent, ok: true });
    const prefix = [started, foreseen(false, 1), began({ kind: "execution", n: 1 }), call("claude", "execution"), notified({ _tag: "PlanChanged", phase: 1, plan: recorded("S1", "started"), step: null })];
    const executing = fold(live(prefix));
    const nested = fold(live([...prefix, call("claude", "planning"), call("codex", "review")]));
    const resumed = fold(live([...prefix, call("claude", "planning"), call("codex", "review"), end("codex"), end("claude")]));
    for (const s of [executing, nested, resumed]) {
      expect(s.run?.busy).toBe(true);
      expect(s.run?.calls.some((c) => c.purpose === "execution")).toBe(true);
    }
    expect(nested.run?.activity).toBe("Codex — review");
    expect(resumed.run?.activity).toBe(executing.run?.activity);
    expect(resumed.run?.calls.at(-1)?.startedAt).toBe(executing.run?.calls.at(-1)?.startedAt);
    const ended = fold(live([...prefix, end("claude")]));
    expect([ended.run?.busy, ended.run?.calls.length]).toEqual([false, 0]);
  });

  test("with the whole run foreseen, cycles and counts attach to the active phase and step, and the progress line names them", () => {
    const events: RunEvent[] = [
      started,
      foreseen(true, 1),
      began({ kind: "questions" }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
    ];
    const formulate = fold(live(events));
    expect(formulate.run?.timeline[0].steps[0].groups[0].rounds.length).toBe(1);
    expect(formulate.run?.timeline.slice(1).every((e) => e.groups.length === 0)).toBe(true);
    expect(progressOf(formulate.run!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("formulate")), "cycle 1"));
    const interview = fold(live([...events, notified({ _tag: "InterviewOpened", heading: "Clarification", stage: "clarification", total: 3 }), notified({ _tag: "InterviewTurn", heading: "Clarification", message: "Q?", summary: null, answered: 1, total: 3 })]));
    expect(interview.run?.timeline[0].steps.map((st) => [st.kind, st.state, st.count])).toEqual([["formulate", "done", null], ["clarification", "active", { answered: 1, total: 3 }]]);
    expect(progressOf(interview.run!)).toBe(prompts.progressLine(prompts.stepOfPhase("Gather Requirements", prompts.stepLabel("clarification")), prompts.clarificationProgress(1, 3)));
    const planning = fold(live([...events, notified({ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "done" }), began({ kind: "planning", n: 1 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 })]));
    expect(planning.run?.timeline[1].groups[0].rounds.length).toBe(1);
    expect(planning.run?.timeline[3].groups).toEqual([]);
    expect(progressOf(planning.run!)).toBe(prompts.progressLine("Planning", "cycle 1"));
  });
});

// Issue #42 (Q7, P1-R2-1): the start time the elapsed time is measured from is the innermost call's, then the outer's again.
test("the elapsed time's start: the nested call's while it runs, the outer call's after it", () => {
  const events: RunEvent[] = [started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution" }), notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review" })];
  const nested = fold(live(events, 1, [0, 10, 70]));
  expect(callStartedAt(nested.run!)).toBe(at(70));
  const after = fold(live([...events, notified({ _tag: "AgentCallEnded", agent: "codex", ok: true })], 1, [0, 10, 70, 80]));
  expect(callStartedAt(after.run!)).toBe(at(10));
  expect(callStartedAt(fold(live([started])).run!)).toBe(null);
});

// Issue #26 (S21): the retry of a transport fault on the activity line, live and replayed alike.
describe("transport retries on the activity line", () => {
  const call: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review" };
  const failed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", attempt: 2, of: 3, delaySeconds: 10, fault: "stream disconnected" };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a retry shows the agent, the attempt of the retries and the fault, and the retried call keeps it", () => {
    for (const s of both([started, notified(call), notified(failed), notified(retrying)])) expect(s.run?.activity).toBe("Codex — connection lost, retry 2 of 3 (stream disconnected)");
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call)])) expect(s.run?.activity).toBe("Codex — review — connection lost, retry 2 of 3 (stream disconnected)");
  });

  test("the retry clears when the call recovers or a call ends well", () => {
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call), notified({ _tag: "TransportRecovered", agent: "codex" })])) expect(s.run?.activity).toBe("Codex — review");
    for (const s of both([started, notified(call), notified(failed), notified(retrying), notified(call), notified({ _tag: "AgentCallEnded", agent: "codex", ok: true }), notified(call)])) expect(s.run?.activity).toBe("Codex — review");
  });

  test("the SDK's own reconnection during a call is shown on the activity line", () => {
    const reconnecting: UiEvent = { _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: 2, of: 10, delayMs: 1500, detail: "status 503, server_error" };
    for (const s of both([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning" }), notified(reconnecting)])) {
      expect(s.run?.activity).toBe("Claude — planning — reconnecting 2 of 10 (status 503, server_error)");
    }
  });
});

// W1-R1-3: the retry belongs to its agent and ends with every call's end.
describe("the retry state after the retries are exhausted", () => {
  const codexCall: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review" };
  const codexFailed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", attempt: 1, of: 1, delaySeconds: 5, fault: "stream disconnected" };
  const claudeCall: UiEvent = { _tag: "AgentCallStarted", agent: "claude", purpose: "planning" };
  const both = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)];

  test("a Claude call of Help me decide after the exhausted Codex retries shows no retry text", () => {
    for (const s of both([started, notified(codexCall), notified(codexFailed), notified(retrying), notified(codexCall), notified(codexFailed), notified(claudeCall)])) {
      expect(s.run?.activity).toBe("Claude — planning");
    }
  });

  test("a retried call that fails again: the next call of the same agent shows no retry text either", () => {
    for (const s of both([started, notified(codexCall), notified(codexFailed), notified(retrying), notified(codexCall), notified(codexFailed), notified(codexCall)])) {
      expect(s.run?.activity).toBe("Codex — review");
    }
  });
});

// W1-R1-4: while the program waits to retry, the page shows that it is busy.
describe("waiting during a retry's backoff", () => {
  const call: UiEvent = { _tag: "AgentCallStarted", agent: "codex", purpose: "review" };
  const failed: UiEvent = { _tag: "AgentCallEnded", agent: "codex", ok: false };
  const retrying: UiEvent = { _tag: "TransportRetrying", agent: "codex", attempt: 1, of: 3, delaySeconds: 5, fault: "stream disconnected" };
  const w = (events: readonly RunEvent[]) => [fold(live(events)), replayed(events)].map((s) => waiting(s.run!));
  test("waiting holds from TransportRetrying until the retried call starts, the call recovers or a call ends", () => {
    expect(w([started, notified(call), notified(failed), notified(retrying)])).toEqual([true, true]);
    expect(w([started, notified(call), notified(failed), notified(retrying), notified(call)])).toEqual([false, false]);
    expect(w([started, notified(call), notified(failed), notified(retrying), notified({ _tag: "TransportRecovered", agent: "codex" })])).toEqual([false, false]);
    expect(w([started, notified(call), notified(failed), notified(retrying), notified(call), notified(failed)])).toEqual([false, false]);
    expect(w([started, notified(call), notified(failed)])).toEqual([false, false]);
  });
});

// Issue #50 (Q2): each phase's begin and end from its events' publication times, for the rail's duration.
describe("phase times", () => {
  const foreseen = (questions: boolean, iterations: number) => notified({ _tag: "PhasesForeseen", phases: foreseenPhases(questions, iterations) });
  const planning = { kind: "planning" as const, n: 1 };
  const times = (s: ViewState) => s.run?.timeline.map((e) => [e.label, e.began, e.ended]) ?? [];

  test("PhaseBegan and PhaseEnded stamp the entry; an entry ahead has neither; live and replay agree", () => {
    const events: RunEvent[] = [started, foreseen(false, 1), notified({ _tag: "PhaseBegan", phase: planning }), notified({ _tag: "PhaseEnded", phase: planning, result: "converged" })];
    const seconds = [0, 1, 10, 670];
    for (const s of [fold(live(events, 1, seconds)), replayed(events, 1, 1, seconds)]) {
      expect(times(s)).toEqual([["Planning", at(10), at(670)], ["Implementation", null, null], ["Work review", null, null]]);
    }
  });

  test("a run that ends while a phase is active ends that phase at the time of Ended; the phases not reached keep none", () => {
    const events: RunEvent[] = [started, foreseen(false, 1), notified({ _tag: "PhaseBegan", phase: planning }), { _tag: "Ended", code: 130 }];
    const seconds = [0, 1, 10, 95];
    for (const s of [fold(live(events, 1, seconds)), replayed(events, 1, 1, seconds)]) {
      expect(times(s)).toEqual([["Planning", at(10), at(95)], ["Implementation", null, null], ["Work review", null, null]]);
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
  const foreseen = notified({ _tag: "PhasesForeseen", phases: foreseenPhases(false, 1) });
  const began = notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } });
  const call = (purpose = "execution") => notified({ _tag: "AgentCallStarted", agent: "claude", purpose });
  const callEnded = (ok = true) => notified({ _tag: "AgentCallEnded", agent: "claude", ok });
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
  const implementation = (s: ViewState) => s.run!.timeline.find((e) => e.phase.kind === "execution")!;
  /** The state of each step as the rail derives it, in the order of the plan. */
  const states = (s: ViewState) => {
    const entry = implementation(s);
    return (s.run!.plan?.plan.stages[0].steps ?? []).map((st) => `${st.id}:${planStepState(entry, st, executing(s.run!))}`);
  };
  const both = (events: RunEvent[]) => [fold(live(events)), replayed(events)];

  test("two steps started: the later is current, the earlier unfinished; live and replay agree", () => {
    for (const s of both([...prefix, ...reports([["S1", "started"], ["S2", "started"]])])) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:current", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(s.run!))).toBe("S2");
    }
  });

  test("the current step done while an earlier one is open: no step is current, until the earlier one is reported started again", () => {
    const done = [...prefix, ...reports([["S1", "started"], ["S2", "started"], ["S2", "done"]])];
    for (const s of both(done)) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:done", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(s.run!))).toBe(null);
    }
    const resumed = [...prefix, ...reports([["S1", "started"], ["S2", "started"], ["S2", "done"], ["S1", "started"]])];
    for (const s of both(resumed)) expect(states(s)).toEqual(["S1:current", "S2:done", "S3:pending"]);
  });

  test("a transport retry of the execution call: the step is not current until it is reported again", () => {
    const retried = [...prefix, ...reports([["S1", "started"]]), callEnded(false), call()];
    for (const s of both(retried)) {
      expect(states(s)).toEqual(["S1:unfinished", "S2:pending", "S3:pending"]);
      expect(currentPlanStep(implementation(s), executing(s.run!))).toBe(null);
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
  const call = notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution" });
  const callEnded = notified({ _tag: "AgentCallEnded", agent: "claude", ok: true });

  // The plan of Planning 1: stage A with S1 and S3, stage B with S4 and S2 (S2 never touched).
  const v1 = (s: Record<string, Status> = {}) => planOf([["A", [{ id: "S1", label: "one", status: s.S1 ?? "pending" }, { id: "S3", label: "three", status: s.S3 ?? "pending" }]], ["B", [{ id: "S4", label: "four", status: s.S4 ?? "pending" }, { id: "S2", label: "two", status: s.S2 ?? "pending" }]]]);
  // The revision of Planning 2: S1 removed; stage 1 is now "B'" with S5, S4 (renumbered, relabeled) and S2; S3 done in stage 2 "A'".
  const v2 = (s: Record<string, Status> = {}) => planOf([["B'", [{ id: "S5", label: "five", status: s.S5 ?? "pending" }, { id: "S4", label: "four revised", status: s.S4 ?? "unfinished" }, { id: "S2", label: "two", status: s.S2 ?? "pending" }]], ["A'", [{ id: "S3", label: "three", status: "done" }]]]);

  const implementation1: RunEvent[] = [
    started,
    notified({ _tag: "PhasesForeseen", phases: foreseenPhases(false, 1) }),
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
  const revision: RunEvent[] = [begin("work", 1), end("work", 1), notified({ _tag: "PhasesForeseen", phases: foreseenPhases(false, 2) }), begin("planning", 2), planChanged(2, v2()), end("planning", 2)];
  const implementation2: RunEvent[] = [begin("execution", 2), call, planChanged(2, v2({ S4: "started" }), { id: "S4", status: "started" }), planChanged(2, v2({ S4: "done" }), { id: "S4", status: "done" }), callEnded, end("execution", 2, "finished")];

  const entry = (s: ViewState, label: string) => s.run!.timeline.find((e) => e.label === label)!;
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
    expect(shownPlan(entry(s, "Planning"), s.run!.plan)).toBe(null);
  });
});

// S26: the question the run waits on stays out of the transcript until it is answered; then the question and the
// answer are appended as an ordinary exchange. Replay and live events fold alike.
describe("the pending question", () => {
  const presented = presentedEvent("Which database?", [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "" }]);
  const pendingEvents: RunEvent[] = [started, said("a"), notified(presented), asked(1, prompts.withOffer(prompts.optionOrTextPrompt))];
  test("while pending, neither the question nor the prompt's text is a transcript message; the widget holds both", () => {
    for (const s of [fold(live(pendingEvents)), replayed(pendingEvents)]) {
      expect(bodies(s)).toEqual(["program:a"]);
      expect(s.run?.pending?.question).toEqual(presentedOf(presented));
      expect(s.run?.pending?.hint).toBe(prompts.pagePromptText("optionOrText", prompts.withOffer(prompts.optionOrTextPrompt)));
    }
  });
  test("when answered, the question and the answer are appended as an exchange", () => {
    const events: RunEvent[] = [...pendingEvents, { _tag: "Answered", prompt: 1, text: "1" }];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(bodies(s)).toEqual(["program:a", `program:${piecesText(presentedOf(presented).question)}`, "user:SQLite — a file"]);
      expect(s.run?.pending).toBe(null);
    }
  });
  test("a question presented again after a rejected answer is the next prompt's question", () => {
    const again = presentedEvent("Which database, again?", []);
    const s = fold(live([...pendingEvents, { _tag: "Answered", prompt: 1, text: "" }, notified({ _tag: "AnswerRejected" }), notified(again), asked(2, prompts.optionOrTextPrompt)]));
    expect(piecesText(s.run?.pending?.question?.question ?? [])).toBe("Which database, again?");
  });
  test("property: while a prompt is pending, its question's text is in no transcript message", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }).map((t) => said(`s ${t}`)), { maxLength: 4 }), fc.string({ minLength: 3, maxLength: 12 }), (before, text) => {
        const q = presentedEvent(`Q? ${text}`, []);
        const s = fold(live([started, ...before, notified(q), asked(1, prompts.optionOrTextPrompt)]));
        return (s.run?.left ?? []).every((m) => !m.body.includes(`Q? ${text}`));
      }),
    );
  });
});

// S28, S12 of the task of issue #36: an answered question joins the transcript whole, as it was presented, so that its
// pieces keep referring to their explanations there.
test("the question of an answered exchange is the presented question, whole", () => {
  const question: PresentedQuestion = {
    ...presentedOf(presentedEvent("Which zod?", [{ label: "A", description: "a" }])),
    question: [{ text: "Which ", ref: "", code: false }, { text: "zod", ref: "z", code: false }, { text: "?", ref: "", code: false }],
    explanations: [{ id: "z", term: "zod", explanation: "A library." }],
    details: [{ kind: "code", text: "npm i zod" }, { kind: "document", markdown: "# Doc" }],
  };
  const s = fold(live([started, notified({ _tag: "QuestionPresented", question }), asked(1, prompts.optionOrTextPrompt), { _tag: "Answered", prompt: 1, text: "x" }]));
  expect(s.run?.left[0].question).toEqual(question);
  expect(s.run?.left[0].body).toBe("Which zod?");
  expect(s.run?.left[1].question).toBeUndefined();
});

test("property: an answered question joins the transcript exactly as it was presented", () => {
  const piece = fc.record({ text: fc.string({ maxLength: 6 }), ref: fc.constantFrom("", "a"), code: fc.boolean() });
  const block = fc.oneof(
    fc.record({ kind: fc.constant("paragraph" as const), pieces: fc.array(piece, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant("list" as const), items: fc.array(fc.record({ level: fc.nat(2), pieces: fc.array(piece, { maxLength: 2 }) }), { maxLength: 2 }) }),
    fc.record({ kind: fc.constant("code" as const), text: fc.string({ maxLength: 6 }) }),
    fc.record({ kind: fc.constant("document" as const), markdown: fc.string({ maxLength: 6 }) }),
  );
  fc.assert(
    fc.property(fc.array(block, { maxLength: 3 }), fc.array(piece, { minLength: 1, maxLength: 3 }), fc.array(block, { maxLength: 2 }), (context, text, details) => {
      const question: PresentedQuestion = { ...presentedOf(presentedEvent("q", [])), context: { blocks: context, by: "agent" }, question: text, details, explanations: [{ id: "a", term: "t", explanation: "e" }] };
      const s = fold(live([started, notified({ _tag: "QuestionPresented", question }), asked(1, prompts.optionOrTextPrompt), { _tag: "Answered", prompt: 1, text: "x" }]));
      return JSON.stringify(s.run?.left[0].question) === JSON.stringify(question) && s.run?.left[0].body === piecesText(text);
    }),
    { numRuns: 100 },
  );
});
