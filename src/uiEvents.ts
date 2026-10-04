// The structured events of a run for a user interface (decision Q5): the terminal ignores them but InterviewOpened and ClaudeSaid, the scripted Ui
// records them, the web Ui turns them into the page's panels, activity line and progress. Pure; types only from src/.

import { type SubjectId, subjectDir } from "./artifacts.ts";
import { agentReconnectingLine, cycleHeading, phaseLabel, transportRecoveredLine, transportRetryLine } from "./prompts.ts";
import type { PresentedQuestion } from "./question.ts";
import type { TermsResponse } from "./schema.ts";
import type { DecisionAnalysis, DecisionResponse, ExecOutcome, PlannerResponse, PlanResponse, QuestionListResponse, RecordedPlan, Review, UserQuestion } from "./schema.ts";
import { piecesText } from "./pieces.ts";

/** A phase of the run as the progress display names it. */
export type Phase = Readonly<{ kind: "questions" }> | Readonly<{ kind: "planning" | "execution" | "work"; n: number }>;
/** Which conversation with the user runs (issue #21): the first clarification, or a follow-up on accepted requirements gaps. An empty agreed list opens none (issue #83). */
export type InterviewStage = "clarification" | "followUp";
export type Agent = "claude" | "codex";
export type LoopResult = "converged" | "proceed" | "revise";

export type UiEvent =
  | Readonly<{ _tag: "PhaseBegan"; phase: Phase }>
  | Readonly<{ _tag: "PhaseEnded"; phase: Phase; result: string }>
  | Readonly<{ _tag: "RoundBegan"; subject: SubjectId; round: number; limit: number }>
  | Readonly<{ _tag: "ReviewReceived"; subject: SubjectId; round: number; review: Review; counted: number }>
  /** The question subject answers with its amended list besides (defect A of docs/page-question-phase-defects.md), a decision with its amended analysis (W2-R1-1), the plan with the whole plan (issue #6). */
  | Readonly<{ _tag: "ResponseReceived"; subject: SubjectId; round: number; response: PlannerResponse | QuestionListResponse | TermsResponse | DecisionResponse | PlanResponse; resultText: string }>
  | Readonly<{ _tag: "LoopFinished"; subject: SubjectId; result: LoopResult }>
  /** A plan was written; its questions for the user are presented one by one after it (S19), not listed here. */
  | Readonly<{ _tag: "PlanWritten"; phase: number; resultText: string }>
  | Readonly<{ _tag: "ExecutionEnded"; phase: number; outcome: ExecOutcome }>
  | Readonly<{ _tag: "AgentCallStarted"; agent: Agent; purpose: string }>
  | Readonly<{ _tag: "ToolUsed"; agent: Agent; tool: string; target: string }>
  | Readonly<{ _tag: "AgentCallEnded"; agent: Agent; ok: boolean }>
  /**
   * The SDK's own reconnection during a call (issue #26): Codex's error event (no attempt, count or delay), or the Agent
   * SDK's api_retry message (its attempt, its maximum and its delay).
   */
  | Readonly<{ _tag: "AgentReconnecting"; agent: Agent; by: "sdk"; attempt: number | null; of: number | null; delayMs: number | null; detail: string }>
  /** The program retries a call that failed from a transport fault (issue #26): retry `attempt` of `of`, after `delaySeconds`. */
  | Readonly<{ _tag: "TransportRetrying"; agent: Agent; attempt: number; of: number; delaySeconds: number; fault: string }>
  /** A call succeeded after a retry. */
  | Readonly<{ _tag: "TransportRecovered"; agent: Agent }>
  /** `answered` of `total` questions so far (issue #21): the agreed ones and the follow-ups Claude reports asking. */
  | Readonly<{ _tag: "InterviewTurn"; heading: string; message: string; summary: string | null; answered: number; total: number }>
  /** The interview begins; each interface renders its own help (finding 8 of docs/gui-review.md). */
  | Readonly<{ _tag: "InterviewOpened"; heading: string; stage: InterviewStage; total: number }>
  /** Claude Code's prose during an execution call, attributed as data (issue #5); the terminal prefixes it with "[claude] ". */
  | Readonly<{ _tag: "ClaudeSaid"; text: string }>
  /**
   * A question the user is to answer, presented the same way whatever produced it (S5): the terminal prints it
   * (`questionLines` in src/render.ts) and the page shows it with its options. The prompt that asks it follows.
   */
  | Readonly<{ _tag: "QuestionPresented"; question: PresentedQuestion }>
  /**
   * The analysis of decision k is being prepared (S21, Q4): check 0 while it is written, then the number of Codex's checks
   * so far; `question` is the number of the question it is for. The user reads one plain status, not the loop's cycles.
   */
  | Readonly<{ _tag: "AnalysisProgress"; decision: number; question: number | null; check: number }>
  /** A decision loop has ended: its analysis, shown before the question is asked again (decision support). */
  /** S22: `presented`, the question as the user was shown it, which the analysis is shown beside: its number, context and terms. */
  | Readonly<{ _tag: "DecisionAnalyzed"; decision: number; question: string; presented: PresentedQuestion; options: readonly Readonly<{ label: string; description: string }>[]; analysis: DecisionAnalysis }>
  /** The last answer was rejected (a blank reply where one is required) and the question is asked again (W3-R1-1); for the page. */
  | Readonly<{ _tag: "AnswerRejected" }>
  /** Every phase known of the run so far, begun or ahead, in order (issue #6): the whole list each time, so folding it twice changes nothing. */
  | Readonly<{ _tag: "PhasesForeseen"; phases: readonly Phase[] }>
  /** The plan with the status of each step (issue #6), after every write and every report of a step; `phase` is the planning and implementation phase it belongs to (Q5). */
  | Readonly<{ _tag: "PlanChanged"; phase: number; plan: RecordedPlan; step: StepReport | null }>;

/** The report of a step that caused a PlanChanged (issue #53, G-R1-1): what makes a step current in the page. */
export type StepReport = Readonly<{ id: string; status: "started" | "done" }>;

const AGENT_LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
/** The name of a phase as the progress display shows it; `count` is how many phases of its kind the run holds (issue #6). */
export const phaseName = (phase: Phase, count: number): string => (phase.kind === "questions" ? phaseLabel("questions", 0, count) : phaseLabel(phase.kind, phase.n, count));
/** How many of the phases are of the kind: the count the terminal, the progress rail and the bands number by (issue #6). */
export const countOfKind = (phases: readonly Phase[], kind: Phase["kind"]): number => phases.filter((p) => p.kind === kind).length;
/** The name of a phase in test output: always numbered. */
const numberedName = (phase: Phase): string => phaseName(phase, 2);
/**
 * The phases known of a run (issue #6): Gather Requirements when the question phase is configured, then Planning,
 * Implementation and Work review of each iteration known so far.
 */
export const foreseenPhases = (questionPhase: boolean, iterations: number): readonly Phase[] => [
  ...(questionPhase ? [{ kind: "questions" } as const] : []),
  ...Array.from({ length: iterations }, (_, i) => i + 1).flatMap((n): Phase[] => [{ kind: "planning", n }, { kind: "execution", n }, { kind: "work", n }]),
];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per event, for test output. Total over the variants. */
export const describeEvent = (event: UiEvent): string => {
  switch (event._tag) {
    case "PhaseBegan":
      return `${numberedName(event.phase)} began`;
    case "PhaseEnded":
      return `${numberedName(event.phase)} ended: ${event.result}`;
    case "RoundBegan":
      return cycleHeading(subjectDir(event.subject), event.round);
    case "ReviewReceived":
      return `review of ${subjectDir(event.subject)}, round ${event.round}: ${plural(event.review.issues.length, "issue")}, ${event.counted} counted`;
    case "ResponseReceived":
      return `response in ${subjectDir(event.subject)}, round ${event.round}`;
    case "LoopFinished":
      return `${subjectDir(event.subject)} finished: ${event.result}`;
    case "PlanWritten":
      return `plan written in phase ${event.phase}`;
    case "ExecutionEnded":
      return `execution ${event.phase} ended: ${event.outcome.status}`;
    case "AgentCallStarted":
      return `${AGENT_LABEL[event.agent]} call started: ${event.purpose}`;
    case "ToolUsed":
      return `${AGENT_LABEL[event.agent]} used ${event.tool} ${event.target}`.trimEnd();
    case "AgentCallEnded":
      return `${AGENT_LABEL[event.agent]} call ended: ${event.ok ? "ok" : "failed"}`;
    case "AgentReconnecting":
      return agentReconnectingLine(AGENT_LABEL[event.agent], event.attempt, event.of, event.delayMs, event.detail);
    case "TransportRetrying":
      return transportRetryLine(event.agent, event.attempt, event.of, event.delaySeconds, event.fault);
    case "TransportRecovered":
      return transportRecoveredLine(event.agent);
    case "InterviewTurn":
      return `${event.heading} (${event.answered} of ${event.total} answered): ${event.message}`;
    case "InterviewOpened":
      return `${event.heading} opened, ${plural(event.total, "question")}`;
    case "ClaudeSaid":
      return `Claude Code said: ${event.text}`;
    case "QuestionPresented":
      return `question ${event.question.number}: ${piecesText(event.question.question)} (${plural(event.question.options.length, "option")})`;
    case "DecisionAnalyzed":
      return `decision ${event.decision} analyzed: ${event.question} (${plural(event.analysis.columns.length, "column")})`;
    case "AnswerRejected":
      return "answer rejected, asked again";
    case "AnalysisProgress":
      return `decision ${event.decision}, check ${event.check}`;
    case "PhasesForeseen":
      return `phases foreseen: ${event.phases.map(numberedName).join(", ")}`;
    case "PlanChanged": {
      const steps = event.plan.stages.flatMap((st) => st.steps);
      return `plan of phase ${event.phase} changed: ${steps.filter((st) => st.status === "done").length} of ${plural(steps.length, "step")} done`;
    }
  }
};
