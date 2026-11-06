// Frozen copy of src/types.ts as it was before the Effect rewrite (plan step 1.0).
// The type comparisons of stage 1 read this file, so they stay independent of src/schema.ts.
// Data exchanged between the orchestrator, Claude Code (the planner), and Codex (the reviewer).

export type Severity = "blocking" | "major" | "minor";

export type Issue = {
  id: string;
  severity: Severity;
  location: string;
  problem: string;
  evidence: string;
};

export type Review = { issues: Issue[] };

export type Action =
  | "accepted"
  | "partially_accepted"
  | "rejected"
  | "no_change_needed"
  | "clarification_requested";

export type Disposition = {
  id: string;
  action: Action;
  rationale: string;
  duplicate_of: string;
  reverses: string;
};

export type SelfCorrection = {
  id: string;
  new_action: "accepted" | "rejected" | "plan_error";
  explanation: string;
};

export type PlannerResponse = {
  dispositions: Disposition[];
  self_corrections: SelfCorrection[];
  reviewer_feedback: string;
  questions_for_user: string[];
};

export type PlanWriteResult = { questions_for_user: string[] };

/** One entry of the question list that Claude Code and Codex agree on before the clarification. */
export type QuestionEntry = {
  id: string;
  question: string;
  reason: string;
  proposed_answers: { label: string; description: string }[];
  default_answer: string;
};

export type QuestionList = { questions: QuestionEntry[] };

/** A response to a review of the question list: the dispositions and the complete amended list. */
export type QuestionListResponse = PlannerResponse & QuestionList;

/** Claude Code's output for one turn of the clarification. */
export type ClarificationTurn = {
  message_to_user: string;
  answered_ids: string[];
  complete: boolean;
  summary: string;
};

export type ExecReport = {
  status: "finished" | "needs_input" | "blocked";
  summary: string;
  question: string;
  remaining_work: string;
};

export type ExecOutcome = {
  status: "finished" | "needs_input" | "blocked" | "aborted";
  summary: string;
  question: string;
  remainingWork: string;
  // Set when the user's input was already read during the phase (a question from Claude Code).
  userInput: string | null;
};

export type LogEntry = {
  id: string;
  phase: number;
  round: number;
  source: "review" | "self_correction" | "user";
  severity?: Severity;
  location?: string;
  problem: string;
  evidence?: string;
  action: string;
  rationale: string;
  duplicate_of?: string;
  reverses?: string;
  superseded?: boolean;
};

export type Config = {
  questionPhase: boolean;
  /** Paths relative to the project that the change detection ignores. A directory covers everything below it. */
  ignorePaths: string[];
  maxRounds: number;
  maxIdleRounds: number;
  countMinor: boolean;
  execPermissionMode: "auto" | "acceptEdits" | "bypassPermissions" | "default";
  claudeModel: string | null;
  codexModel: string | null;
};

export const defaultConfig: Config = {
  questionPhase: true,
  ignorePaths: [],
  maxRounds: 5,
  maxIdleRounds: 2,
  countMinor: true,
  execPermissionMode: "auto",
  claudeModel: null,
  codexModel: null,
};
