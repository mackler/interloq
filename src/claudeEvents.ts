// Pure decoding of what the Claude Agent SDK hands the planner adapter, and the pure reduction of a
// call's messages into its outcome (findings 17 and 19 of docs/functional-design-review.md). No I/O,
// no Effect services: src/claude.ts keeps stream consumption, cancellation and persistence.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result, Schema } from "effect";
import * as S from "./schema.ts";
import type { ExecCallOutcome, ExecReport } from "./schema.ts";
import { normalizeReport } from "./schemaNormalize.ts";
import { type ClaudeFailure, type ProcessEnd, rejectionOf } from "./transport.ts";
import { backgroundKilledText } from "./prompts.ts";

export type Question = Readonly<{ question: string; options: readonly Readonly<{ label: string; description: string }>[] }>;
/** A recorded AskUserQuestion stop of an execution call. */
export type Stop = Readonly<{ question: string; input: string }>;
/**
 * What one SDK call produced. `error` is null only after a success result. `partial` is true when the
 * stream ended before any result message (an abort or a stream failure): the other fields hold what
 * was retained up to that point. A failed result (`error_max_turns`, …) is a complete call, not partial.
 */
export type CallOutcome = Readonly<{
  sessionId: string | null;
  costUsd: number | null;
  structured: unknown;
  resultText: string;
  error: string | null;
  partial: boolean;
  /** The facts of the failure that src/transport.ts classifies (issue #26); null exactly when `error` is. */
  failure: ClaudeFailure | null;
}>;

/** The fields of the SDK's AskUserQuestion input that the program reads; the others (header, multiSelect) are ignored. */
const QuestionInput = Schema.Struct({
  questions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        question: Schema.String,
        options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      }),
    ),
  ),
});
const decodeQuestionInput = Schema.decodeUnknownResult(QuestionInput);

/** The questions of an AskUserQuestion call; a missing list is empty; the failure text names the field. */
export const decodeQuestions = (input: unknown): Result.Result<readonly Question[], string> => {
  const decoded = decodeQuestionInput(input);
  if (Result.isFailure(decoded)) {
    const { path, message } = S.firstIssue(decoded.failure);
    return Result.fail(path === "" ? message : `${path}: ${message}`);
  }
  return Result.succeed(decoded.success.questions ?? []);
};

/** The file an edit tool targets: `file_path`, else `notebook_path`; null when neither is a string. */
export const decodeToolTarget = (toolInput: unknown): string | null => {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const { file_path, notebook_path } = toolInput as Readonly<Record<string, unknown>>;
  if (typeof file_path === "string") return file_path;
  if (typeof notebook_path === "string") return notebook_path;
  return null;
};

const noResult = "the call produced no result message";
const noFacts: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null };

/** Whether a message shows that the call made progress: an assistant message without error, a stream event, a tool result. */
const isProgress = (message: SDKMessage): boolean => {
  if (message.type === "assistant") return message.error === undefined;
  if (message.type === "stream_event") return true;
  if (message.type === "user") {
    const content: unknown = message.message.content;
    return Array.isArray(content) && content.some((block: unknown) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result");
  }
  return false;
};

type Fold = Readonly<{ out: CallOutcome; facts: ClaudeFailure }>;

/**
 * The outcome of a call from its messages in order; `streamError` is the text of a failure of the stream, which wins over
 * any result, `streamCode` its error code and `processEnd` how the Claude Code process ended (issue #157), both kept
 * only with a stream failure. A success result with is_error is a failure (the turn ended on an API
 * error). The facts of a failure keep the result's status, reason and subtype, and the assistant error and the api_retry
 * seen after the last sign of progress (issue #26), and the latest usage-limit rejection after it (issue #68).
 */
export const reduceMessages = (messages: readonly SDKMessage[], streamError: string | null = null, streamCode: string | null = null, processEnd: ProcessEnd | null = null): CallOutcome => {
  const start: Fold = { out: { sessionId: null, costUsd: null, structured: null, resultText: "", error: noResult, partial: true, failure: null }, facts: noFacts };
  const folded = messages.reduce<Fold>(({ out, facts }, message) => {
    if (message.type === "system" && message.subtype === "init") return { out: { ...out, sessionId: message.session_id }, facts };
    if (message.type === "system" && message.subtype === "api_retry") return { out, facts: { ...facts, retrySeen: { status: message.error_status, error: message.error } } };
    if (message.type === "assistant" && message.error !== undefined) return { out, facts: { ...facts, assistantError: message.error } };
    // Issue #68: the latest usage-limit rejection; an allowed event clears it. It is not progress.
    if (message.type === "rate_limit_event") return { out, facts: { ...facts, rejection: rejectionOf(message.rate_limit_info) } };
    if (isProgress(message)) return { out, facts: { ...facts, assistantError: null, retrySeen: null, rejection: null } };
    if (message.type !== "result") return { out, facts };
    const terminal = { ...facts, terminalReason: message.terminal_reason ?? null, subtype: message.subtype };
    if (message.subtype !== "success") return { out: { ...out, costUsd: message.total_cost_usd, error: message.subtype, partial: false }, facts: terminal };
    if (message.is_error) {
      const error = message.result === "" ? "api error" : message.result;
      return { out: { ...out, costUsd: message.total_cost_usd, structured: null, resultText: message.result, error, partial: false }, facts: { ...terminal, apiStatus: message.api_error_status ?? null, resultText: message.result } };
    }
    return { out: { ...out, costUsd: message.total_cost_usd, structured: message.structured_output, resultText: message.result, error: null, partial: false }, facts: terminal };
  }, start);
  const out = streamError === null ? folded.out : { ...folded.out, error: streamError };
  return { ...out, failure: out.error === null ? null : { ...folded.facts, streamCode: streamError === null ? null : streamCode, processEnd: streamError === null ? null : processEnd } };
};

const decodeExecReport = Schema.decodeUnknownResult(S.ExecReport);
/** The status report of an execution call, or null if there is none or it does not match its schema. */
export const execReport = (structured: unknown): ExecReport | null => {
  const decoded = decodeExecReport(structured);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

/**
 * The outcome of an execution phase. A recorded stop takes precedence over any report; an invalid
 * report is treated as a missing one (status aborted). Execution calls never get a repair turn (decision Q5).
 * `transport` is whether the call's error is a transport fault (src/transport.ts): a valid report before one stands.
 */
export const interpretExecution = (outcome: CallOutcome, stop: Stop | null, transport = false): ExecCallOutcome => {
  const report = execReport(outcome.structured);
  if (stop !== null) {
    return { status: "needs_input", summary: report?.summary ?? "", question: stop.question, remainingWork: report?.remaining_work ?? "", userInput: stop.input };
  }
  // A valid report delivered before a transport fault stands (issue #26, P1-R1-3): it is the call's last act.
  const reportStands = report !== null && (outcome.error === null || transport);
  if (!reportStands) {
    const reason = outcome.error ?? (outcome.structured === null || outcome.structured === undefined ? "no structured output" : "the status report does not match its schema");
    return { status: "aborted", summary: outcome.resultText, question: `The execution call ended without a status report: ${reason}`, remainingWork: "", userInput: null };
  }
  const variant = normalizeReport(report);
  switch (variant.kind) {
    case "finished":
      return { status: "finished", summary: variant.summary, question: "", remainingWork: variant.remainingWork, userInput: null };
    case "continuing":
      return { status: "continuing", summary: variant.summary, remainingWork: variant.remainingWork };
    case "awaiting_input":
      return { status: "needs_input", summary: variant.summary, question: variant.question, remainingWork: variant.remainingWork, userInput: null };
    case "blocked":
      return { status: "blocked", summary: variant.summary, question: variant.description, remainingWork: variant.remainingWork, userInput: null };
  }
};

// ---- background tasks of an execution call (issue #154, decision Q1) ------------------------------------------------

/** A background task's end, as its task_notification states it. */
export type TaskEnd = Readonly<{ taskId: string; status: "completed" | "failed" | "stopped"; outputFile: string; summary: string }>;
/** A task's end with the name its wait is told by (issue #161): its description, else its id (`taskName`). */
export type NamedEnd = Readonly<{ end: TaskEnd; name: string }>;
/**
 * The background tasks of one execution call, folded from the SDK's messages: the tasks pending (seen live and not
 * yet ended), the tasks that are not activity (ambient, never waited on), and the ends seen, in order, one per task.
 */
export type BackgroundState = Readonly<{ pending: ReadonlySet<string>; ambient: ReadonlySet<string>; ended: readonly TaskEnd[] }>;
export const NO_BACKGROUND: BackgroundState = { pending: new Set(), ambient: new Set(), ended: [] };
/** The task marked ambient: never waited on again, whatever else is said of it (the SDK says the flag can flip while live). */
const markedAmbient = (state: BackgroundState, id: string): BackgroundState => ({ ...state, ambient: new Set([...state.ambient, id]), pending: new Set([...state.pending].filter((p) => p !== id)) });
const ended = (state: BackgroundState, id: string): boolean => state.ended.some((e) => e.taskId === id);
/** The task seen live: pending, unless it is ambient or already ended. */
const seenLive = (state: BackgroundState, id: string): BackgroundState =>
  state.ambient.has(id) || ended(state, id) || state.pending.has(id) ? state : { ...state, pending: new Set([...state.pending, id]) };
/**
 * The state after one SDK message. Only an explicit ambient marking and a notification end a task's wait: a level
 * signal without the task never does, because the SDK leaves its order relative to the notification unspecified and in
 * practice sends it first (P1-R1-1), so its absence would continue the session before the task's output is known.
 */
export const foldBackground = (state: BackgroundState, message: SDKMessage): BackgroundState => {
  if (message.type !== "system") return state;
  switch (message.subtype) {
    case "background_tasks_changed":
      return message.tasks.reduce((s, task) => (task.ambient === true ? markedAmbient(s, task.task_id) : seenLive(s, task.task_id)), state);
    case "task_started":
      if (message.ambient === true) return markedAmbient(state, message.task_id);
      return message.is_backgrounded === true ? seenLive(state, message.task_id) : state;
    case "task_notification": {
      if (message.ambient === true) return markedAmbient(state, message.task_id);
      // A task already ended or ambient is never pending (seenLive refuses both), so there is nothing to remove.
      if (ended(state, message.task_id) || state.ambient.has(message.task_id)) return state;
      const pending = new Set([...state.pending].filter((p) => p !== message.task_id));
      return { ...state, pending, ended: [...state.ended, { taskId: message.task_id, status: message.status, outputFile: message.output_file, summary: message.summary }] };
    }
    default:
      return state;
  }
};
/** Whether a background task is still pending. */
export const waitingOn = (state: BackgroundState): boolean => state.pending.size > 0;

/**
 * An execution call's outcome checked against its background tasks (issue #154): a call that ended while a task was
 * still pending ended with its result lost, so its report is not taken as its end, however the SDK came to end it (a
 * hook canceled at its timeout, structured-output retries exhausted, hooks never called); the outcome is aborted,
 * which takes the stop's path. A recorded stop takes precedence.
 */
export const checkBackground = (result: ExecCallOutcome, stop: Stop | null, state: BackgroundState, nameOf: (id: string) => string): ExecCallOutcome => {
  if (stop !== null || !waitingOn(state)) return result;
  return { status: "aborted", summary: result.summary, question: backgroundKilledText([...state.pending].map(nameOf)), remainingWork: result.remainingWork, userInput: null };
};
/** The name of each background task, its description as the SDK first gave it, for the lines and texts naming it. */
export const nameTasks = (names: ReadonlyMap<string, string>, message: SDKMessage): ReadonlyMap<string, string> => {
  if (message.type !== "system") return names;
  const named = (m: ReadonlyMap<string, string>, id: string, description: string): ReadonlyMap<string, string> => (m.has(id) ? m : new Map([...m, [id, description]]));
  if (message.subtype === "task_started") return named(names, message.task_id, message.description);
  if (message.subtype === "background_tasks_changed") return message.tasks.reduce((m, task) => named(m, task.task_id, task.description), names);
  return names;
};
/** The one naming rule of a task in the wait's texts (issue #161): the description `nameTasks` recorded, else its id. */
export const taskName = (names: ReadonlyMap<string, string>, id: string): string => names.get(id) ?? id;
