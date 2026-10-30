// Pure decoding of what the Claude Agent SDK hands the planner adapter, and the pure reduction of a
// call's messages into its outcome (findings 17 and 19 of docs/functional-design-review.md). No I/O,
// no Effect services: src/claude.ts keeps stream consumption, cancellation and persistence.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result, Schema } from "effect";
import * as S from "./schema.ts";
import type { ExecContinuation, ExecOutcome, ExecReport } from "./schema.ts";
import { normalizeReport } from "./schemaNormalize.ts";
import { type ClaudeFailure, type ProcessEnd, rejectionOf } from "./transport.ts";
import { backgroundKilledText } from "./prompts.ts";
import { type OutputEvent, plainOutput, type ProcessKey, processKeyOf, processNameOf, type ProcessStatus } from "./liveOutput.ts";

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
/** Issue #186: why a not_refined report with nothing in 'missing' is treated as no report. */
export const NOT_REFINED_BLANK_REASON = "the status report is 'not_refined' with nothing in 'missing'";
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
export const interpretExecution = (outcome: CallOutcome, stop: Stop | null, transport = false): ExecOutcome | ExecContinuation => {
  const report = execReport(outcome.structured);
  if (stop !== null) {
    return { status: "needs_input", summary: report?.summary ?? "", question: stop.question, remainingWork: report?.remaining_work ?? "", userInput: stop.input, checks: report?.checks ?? [] };
  }
  // A valid report delivered before a transport fault stands (issue #26, P1-R1-3): it is the call's last act.
  // Issue #186: a verdict that names nothing missing is an invalid report, since an execution report gets no repair turn.
  const blankVerdict = report !== null && report.status === "not_refined" && report.missing.trim() === "";
  const reportStands = report !== null && !blankVerdict && (outcome.error === null || transport);
  if (!reportStands) {
    const reason = outcome.error ?? (outcome.structured === null || outcome.structured === undefined ? "no structured output" : blankVerdict ? NOT_REFINED_BLANK_REASON : "the status report does not match its schema");
    return { status: "aborted", summary: outcome.resultText, question: `The execution call ended without a status report: ${reason}`, remainingWork: "", userInput: null, checks: [] };
  }
  const variant = normalizeReport(report);
  switch (variant.kind) {
    case "finished":
      return { status: "finished", summary: variant.summary, question: "", remainingWork: variant.remainingWork, userInput: null, checks: variant.checks };
    case "continuing":
      return { status: "continuing", summary: variant.summary, remainingWork: variant.remainingWork, checks: variant.checks };
    case "awaiting_input":
      return { status: "needs_input", summary: variant.summary, question: variant.question, remainingWork: variant.remainingWork, userInput: null, checks: variant.checks };
    case "blocked":
      return { status: "blocked", summary: variant.summary, question: variant.description, remainingWork: variant.remainingWork, userInput: null, checks: variant.checks };
    case "not_refined":
      return { status: "not_refined", summary: variant.summary, question: variant.missing, remainingWork: variant.remainingWork, userInput: null, checks: variant.checks };
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
export const checkBackground = (result: ExecOutcome | ExecContinuation, stop: Stop | null, state: BackgroundState, nameOf: (id: string) => string): ExecOutcome | ExecContinuation => {
  if (stop !== null || !waitingOn(state)) return result;
  return { status: "aborted", summary: result.summary, question: backgroundKilledText([...state.pending].map(nameOf)), remainingWork: result.remainingWork, userInput: null, checks: result.checks };
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

// ---- the live output of a Claude Code call (issue #49) ---------------------------------------------------------------
// The Agent SDK sends no foreground command's output before it returns (sdk.d.ts of 0.3.283: tool_progress carries the
// elapsed time alone, task messages no text): a command shows its name and elapsed time while it runs and its output
// when its result arrives; a background task shows its name, and its output from its output file at its end.

/** What the adapter does for the live panel: emit an event, or read a task's output file and emit its tail. */
export type OutputCommand = Readonly<{ _tag: "Emit"; event: OutputEvent }> | Readonly<{ _tag: "Tail"; key: ProcessKey; name: string; path: string; status: ProcessStatus }>;

/**
 * The live output's state of one call: the foreground commands running, by tool_use_id, with their names; the
 * background tasks as `foldBackground` and `nameTasks` see them; every non-ambient task seen in a task_started with its
 * description (a foreground task may move to the background later); and the tasks started on the panel and not ended.
 */
export type ClaudeOutputState = Readonly<{
  commands: ReadonlyMap<string, string>;
  background: BackgroundState;
  names: ReadonlyMap<string, string>;
  seenTasks: ReadonlyMap<string, string>;
  openTasks: ReadonlyMap<string, string>;
}>;
export const EMPTY_CLAUDE_OUTPUT: ClaudeOutputState = { commands: new Map(), background: NO_BACKGROUND, names: new Map(), seenTasks: new Map(), openTasks: new Map() };

const emit = (event: OutputEvent): OutputCommand => ({ _tag: "Emit", event });
const withEntry = (m: ReadonlyMap<string, string>, k: string, v: string): ReadonlyMap<string, string> => new Map([...m, [k, v]]);
const withoutEntry = (m: ReadonlyMap<string, string>, k: string): ReadonlyMap<string, string> => new Map([...m].filter(([key]) => key !== k));
const keyed = (source: Parameters<typeof processKeyOf>[0], f: (key: ProcessKey) => readonly OutputCommand[]): readonly OutputCommand[] => {
  const built = processKeyOf(source);
  return Result.isSuccess(built) ? f(built.success) : [];
};
/** The target of a tool use as the activity line names it (`ToolUsed` in src/claude.ts). */
export const toolTarget = (input: unknown): string => {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return String(i.file_path ?? i.pattern ?? i.command ?? "");
};
const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((b: unknown) => (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" ? [String((b as { text?: unknown }).text ?? "")] : [])).join("\n")
      : "";
const statusOfTask = (status: TaskEnd["status"]): ProcessStatus => (status === "completed" ? { _tag: "Succeeded" } : status === "failed" ? { _tag: "Failed" } : { _tag: "Stopped" });

/** The live output of one message of a call (issue #49), pure. */
export const claudeOutputOf = (state: ClaudeOutputState, message: SDKMessage): readonly [ClaudeOutputState, readonly OutputCommand[]] => {
  if (message.type === "assistant") {
    let s = state;
    const out: OutputCommand[] = [];
    for (const block of message.message.content) {
      if (block.type !== "tool_use" || block.name === "StructuredOutput") continue;
      const input = (typeof block.input === "object" && block.input !== null ? block.input : {}) as Record<string, unknown>;
      if (block.name === "Bash") {
        if (input.run_in_background === true) continue;
        const name = processNameOf(String(input.command ?? ""));
        const id = block.id;
        out.push(...keyed({ kind: "claude", id }, (key) => ((s = { ...s, commands: withEntry(s.commands, id, name) }), [emit({ _tag: "Started", key, name })])));
      } else out.push(emit({ _tag: "Touched", name: processNameOf(`${block.name} ${toolTarget(input)}`) }));
    }
    return [s, out];
  }
  if (message.type === "tool_progress") {
    const name = state.commands.get(message.tool_use_id);
    return name === undefined ? [state, []] : [state, keyed({ kind: "claude", id: message.tool_use_id }, (key) => [emit({ _tag: "Progress", key, name, seconds: message.elapsed_time_seconds })])];
  }
  if (message.type === "user") {
    const content = message.message.content;
    if (typeof content === "string") return [state, []];
    let s = state;
    const out: OutputCommand[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const name = s.commands.get(block.tool_use_id);
      if (name === undefined) continue;
      s = { ...s, commands: withoutEntry(s.commands, block.tool_use_id) };
      const text = plainOutput(resultText(block.content));
      const status: ProcessStatus = block.is_error === true ? { _tag: "Failed" } : { _tag: "Succeeded" };
      out.push(...keyed({ kind: "claude", id: block.tool_use_id }, (key) => [...(text === "" ? [] : [emit({ _tag: "Printed", key, name, text })]), emit({ _tag: "Finished", key, name, status })]));
    }
    return [s, out];
  }
  if (message.type !== "system") return [state, []];
  const background = foldBackground(state.background, message);
  const names = nameTasks(state.names, message);
  let s: ClaudeOutputState = { ...state, background, names };
  const out: OutputCommand[] = [];
  const start = (id: string, name: string): void => {
    if (s.openTasks.has(id) || background.ambient.has(id) || background.ended.some((e) => e.taskId === id)) return;
    out.push(...keyed({ kind: "task", id }, (key) => ((s = { ...s, openTasks: withEntry(s.openTasks, id, name) }), [emit({ _tag: "Started", key, name })])));
  };
  if (message.subtype === "task_started" && message.ambient !== true) s = { ...s, seenTasks: withEntry(s.seenTasks, message.task_id, message.description) };
  for (const id of background.pending) if (!state.background.pending.has(id)) start(id, taskName(names, id));
  if (message.subtype === "task_updated" && message.patch.is_backgrounded === true) {
    const description = s.seenTasks.get(message.task_id);
    if (description !== undefined) start(message.task_id, description);
  }
  if (message.subtype === "task_notification" && message.ambient !== true) {
    const name = s.openTasks.get(message.task_id);
    if (name !== undefined) {
      s = { ...s, openTasks: withoutEntry(s.openTasks, message.task_id) };
      out.push(...keyed({ kind: "task", id: message.task_id }, (key) => [{ _tag: "Tail", key, name, path: message.output_file, status: statusOfTask(message.status) }]));
    }
  }
  // A task on the panel later marked ambient is ended there: how is not known.
  for (const [id, name] of s.openTasks) {
    if (!background.ambient.has(id)) continue;
    s = { ...s, openTasks: withoutEntry(s.openTasks, id) };
    out.push(...keyed({ kind: "task", id }, (key) => [emit({ _tag: "Finished", key, name, status: { _tag: "Unknown" } })]));
  }
  return [s, out];
};

/** The end of every command and task of the call still open on the panel (issue #49), for the call's end. */
export const claudeOpenProcesses = (state: ClaudeOutputState): readonly OutputEvent[] => [
  ...[...state.commands].flatMap(([id, name]) => keyed({ kind: "claude", id }, (key) => [emit({ _tag: "Finished", key, name, status: { _tag: "Unknown" } })])),
  ...[...state.openTasks].flatMap(([id, name]) => keyed({ kind: "task", id }, (key) => [emit({ _tag: "Finished", key, name, status: { _tag: "Unknown" } })])),
].flatMap((c) => (c._tag === "Emit" ? [c.event] : []));
