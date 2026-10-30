import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { claudeOpenProcesses, claudeOutputOf, type ClaudeOutputState, decodeQuestions, decodeToolTarget, EMPTY_CLAUDE_OUTPUT, interpretExecution, NOT_REFINED_BLANK_REASON, type OutputCommand, reduceMessages } from "../src/claudeEvents.ts";
import { changed, notification, started } from "./backgroundMessages.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantText, failure, init, limitError, limitResult, rateLimit, success } from "./fakeSdk.ts";

// Finding 17: the AskUserQuestion input is decoded, not asserted.
test("decodeQuestions accepts the SDK's question list and ignores the fields the program does not read", () => {
  const input = { questions: [{ question: "A or B?", header: "Choice", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
  const result = decodeQuestions(input);
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }]);
});

test("decodeQuestions treats a missing question list as empty", () => {
  const result = decodeQuestions({});
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, []);
});

test("decodeQuestions fails with a message that names the field when the list is not an array or a question has no options", () => {
  const notArray = decodeQuestions({ questions: "nope" });
  assert.ok(Result.isFailure(notArray));
  assert.match(notArray.failure, /questions/);
  const noOptions = decodeQuestions({ questions: [{ question: "A?" }] });
  assert.ok(Result.isFailure(noOptions));
  assert.match(noOptions.failure, /questions\[0\]\.options/);
  const notObject = decodeQuestions("nope");
  assert.ok(Result.isFailure(notObject));
});

test("decodeToolTarget reads file_path, then notebook_path, and yields null for anything else", () => {
  assert.equal(decodeToolTarget({ file_path: "a/b.ts" }), "a/b.ts");
  assert.equal(decodeToolTarget({ notebook_path: "n.ipynb" }), "n.ipynb");
  assert.equal(decodeToolTarget({ file_path: "a", notebook_path: "n" }), "a");
  assert.equal(decodeToolTarget({ file_path: 42 }), null);
  assert.equal(decodeToolTarget({}), null);
  assert.equal(decodeToolTarget(null), null);
  assert.equal(decodeToolTarget("a"), null);
});

// Finding 19: the reduction of the message list is pure, and partial output is explicit.
test("reduceMessages folds init and a success result into a complete outcome", () => {
  assert.deepEqual(reduceMessages([init("s-9"), assistantText("working"), success({ a: 1 }, "done", 0.5)]), {
    sessionId: "s-9", costUsd: 0.5, structured: { a: 1 }, resultText: "done", error: null, partial: false, failure: null,
  });
});

test("reduceMessages reports a failed result as an error of a complete call, not as partial output", () => {
  assert.deepEqual(reduceMessages([init(), failure("error_max_turns", 0.1)]), {
    sessionId: "session-1", costUsd: 0.1, structured: null, resultText: "", error: "error_max_turns", partial: false,
    failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: "error_max_turns", rejection: null, resultText: null, processEnd: null },
  });
});

test("reduceMessages marks a stream that ended before a result as partial, with the stream failure or the missing-result text", () => {
  assert.deepEqual(reduceMessages([init(), assistantText("half")]), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null },
  });
  assert.deepEqual(reduceMessages([init()], "socket hang up"), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "socket hang up", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null },
  });
  assert.deepEqual(reduceMessages([]), {
    sessionId: null, costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null },
  });
});

const complete = (structured: unknown, resultText = "") => ({ sessionId: "s", costUsd: 1, structured, resultText, error: null, partial: false, failure: null });

test("interpretExecution returns the report when it is valid and there is no stop", () => {
  const outcome = interpretExecution(complete({ status: "finished", summary: "all done", question: "", remaining_work: "", missing: "", checks: [] }), null);
  assert.deepEqual(outcome, { status: "finished", summary: "all done", question: "", remainingWork: "", userInput: null, checks: [] });
});

// Issue #154 (Q2): work left and nothing for the user to decide is its own status, which the run continues without asking.
test("interpretExecution reads a continuing report as a continuation", () => {
  const outcome = interpretExecution(complete({ status: "continuing", summary: "half", question: "ignored", remaining_work: "S3 and S4", missing: "", checks: [] }), null);
  assert.deepEqual(outcome, { status: "continuing", summary: "half", remainingWork: "S3 and S4", checks: [] });
});

test("interpretExecution: a recorded stop takes precedence over a continuing report, and one before a transport fault stands", () => {
  const stop = { question: "A or B?", input: "A or B? -> A" };
  const report = { status: "continuing", summary: "s", question: "", remaining_work: "w", missing: "", checks: [] };
  assert.deepEqual(interpretExecution(complete(report), stop), { status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "A or B? -> A", checks: [] });
  assert.deepEqual(interpretExecution({ ...complete(report), error: "socket hang up" }, null, true), { status: "continuing", summary: "s", remainingWork: "w", checks: [] });
  assert.equal(interpretExecution({ ...complete(report), error: "error_during_execution" }, null, false).status, "aborted");
});

// Issue #186: the verdict that the item is not refined carries what is missing in the outcome's question; a verdict
// that names nothing is treated as no report, since an execution report gets no repair turn (behavior 10).
test("interpretExecution reads a not_refined report as its verdict, and one with a blank missing as aborted", () => {
  const verdict = interpretExecution(complete({ status: "not_refined", summary: "S1 done", question: "", remaining_work: "S2", missing: "The retention period.", checks: [] }), null);
  assert.deepEqual(verdict, { status: "not_refined", summary: "S1 done", question: "The retention period.", remainingWork: "S2", userInput: null, checks: [] });
  const blank = interpretExecution(complete({ status: "not_refined", summary: "s", question: "", remaining_work: "", missing: " \n", checks: [] }, "r"), null);
  assert.equal(blank.status, "aborted");
  assert.ok(blank.status === "aborted" && blank.question.endsWith(NOT_REFINED_BLANK_REASON), blank.status === "aborted" ? blank.question : "");
  const stopped = interpretExecution(complete({ status: "not_refined", summary: "s", question: "", remaining_work: "", missing: "m", checks: [] }), { question: "A?", input: "A" });
  assert.equal(stopped.status, "needs_input");
});

test("interpretExecution gives a recorded stop precedence over the report, valid or not", () => {
  const stop = { question: "A or B?", input: "A or B? -> A" };
  const valid = interpretExecution(complete({ status: "finished", summary: "s", question: "", remaining_work: "w", missing: "", checks: [] }), stop);
  assert.deepEqual(valid, { status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "A or B? -> A", checks: [] });
  const invalid = interpretExecution(complete({ status: "bogus" }), stop);
  assert.deepEqual(invalid, { status: "needs_input", summary: "", question: "A or B?", remainingWork: "", userInput: "A or B? -> A", checks: [] });
});

test("interpretExecution treats a missing or invalid report and a call error as aborted, keeping the result text", () => {
  const invalid = interpretExecution(complete({ status: "bogus" }, "text only"), null);
  assert.ok(invalid.status === "aborted");
  assert.equal(invalid.summary, "text only");
  assert.match(invalid.question, /ended without a status report: the status report does not match its schema/);
  const missing = interpretExecution(complete(null, "text only"), null);
  assert.ok(missing.status === "aborted");
  assert.match(missing.question, /ended without a status report: no structured output/);
  const failed = interpretExecution({ ...complete(null), error: "error_during_execution" }, null);
  assert.ok(failed.status === "aborted");
  assert.match(failed.question, /ended without a status report: error_during_execution/);
});

// Issue #26: the facts of a failure that src/transport.ts classifies; non-terminal evidence only after the last progress.
const apiError = (status: number | null, text = "API Error: 503 upstream"): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: true, api_error_status: status, terminal_reason: "api_error", result: text, structured_output: { ignored: true }, total_cost_usd: 0.1, num_turns: 1 }) as unknown as SDKMessage;
const apiRetry = (status: number | null, error = "server_error"): SDKMessage =>
  ({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: status, error }) as unknown as SDKMessage;
const assistantError = (error: string): SDKMessage => ({ type: "assistant", error, message: { content: [{ type: "text", text: "" }] } }) as unknown as SDKMessage;

test("a success result with is_error is a failure: its text is the error, its output is ignored, and its status is kept", () => {
  const outcome = reduceMessages([init(), apiError(503)]);
  assert.equal(outcome.error, "API Error: 503 upstream");
  assert.equal(outcome.structured, null);
  assert.equal(outcome.partial, false);
  assert.deepEqual(outcome.failure, { streamCode: null, apiStatus: 503, terminalReason: "api_error", assistantError: null, retrySeen: null, subtype: "success", rejection: null, resultText: "API Error: 503 upstream", processEnd: null });
  assert.equal(reduceMessages([init(), apiError(500, "")]).error, "api error");
});

test("a stream error keeps its code", () => {
  assert.equal(reduceMessages([init()], "read ECONNRESET", "ECONNRESET").failure?.streamCode, "ECONNRESET");
});

test("an api_retry followed by progress is cleared; one right before the failure is kept with its status and error", () => {
  assert.equal(reduceMessages([init(), apiRetry(503), assistantText("resumed")], "broke").failure?.retrySeen, null);
  assert.deepEqual(reduceMessages([init(), apiRetry(429, "rate_limit")], "read ECONNRESET", "ECONNRESET").failure?.retrySeen, { status: 429, error: "rate_limit" });
});

test("an assistant error followed by a message without error is cleared; one right before the failure is kept", () => {
  assert.equal(reduceMessages([init(), assistantError("server_error"), assistantText("fine")], "broke").failure?.assistantError, null);
  assert.equal(reduceMessages([init(), assistantError("server_error")], "broke").failure?.assistantError, "server_error");
});

// Issue #26 (S20, P1-R1-3): a valid status report delivered before a transport fault stands.
test("interpretExecution: a valid report with a transport error stands; with another error it is aborted; a stop wins", () => {
  const report = { status: "finished", summary: "all done", question: "", remaining_work: "", missing: "", checks: [] };
  const faulted = { ...complete(report), error: "read ECONNRESET", partial: true, failure: { streamCode: "ECONNRESET", apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null } };
  assert.equal(interpretExecution(faulted, null, true).status, "finished");
  assert.equal(interpretExecution(faulted, null, false).status, "aborted");
  assert.equal(interpretExecution(faulted, { question: "A?", input: "A? -> a" }, true).status, "needs_input");
});

// Issue #68: the latest usage-limit rejection of the stream is among the facts of the failure.
const RESET_S = 1_791_400_000;
const rejected = rateLimit({ status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour" });

test("reduceMessages keeps a rejection with its reset in milliseconds and its type", () => {
  const outcome = reduceMessages([init(), assistantText("working"), rejected, limitError(), limitResult()]);
  assert.deepEqual(outcome.failure?.rejection, { kind: "withReset", resetsAtMs: RESET_S * 1000, limitType: "five_hour" });
  assert.equal(outcome.failure?.assistantError, "rate_limit");
});

test("a later allowed rate-limit event, or progress after the rejection, clears it; a success has no failure", () => {
  const allowed = rateLimit({ status: "allowed", resetsAt: RESET_S });
  assert.equal(reduceMessages([init(), rejected, allowed, limitResult()]).failure?.rejection, null);
  assert.equal(reduceMessages([init(), rejected, assistantText("working again"), limitResult()]).failure?.rejection, null);
  assert.equal(reduceMessages([init(), rejected, success({ a: 1 })]).failure, null);
});

// Issue #122: the text of an error result is kept, so that a context-length rejection can be recognized.
test("an error result's text is kept in the failure facts; a stream failure keeps none", () => {
  const tooLong = reduceMessages([init(), apiError(400, "Prompt is too long")]);
  assert.equal(tooLong.failure?.resultText, "Prompt is too long");
  assert.equal(tooLong.failure?.apiStatus, 400);
  assert.equal(reduceMessages([init()], "socket hang up").failure?.resultText, null);
});

// Issue #154: a report made while a background task is still pending is never the call's end; a recorded stop wins.
test("checkBackground aborts any outcome while a task is pending, names it, and leaves a recorded stop or no pending task alone", async () => {
  const { checkBackground, foldBackground, NO_BACKGROUND } = await import("../src/claudeEvents.ts");
  const { backgroundKilledText } = await import("../src/prompts.ts");
  const { started, notification } = await import("./backgroundMessages.ts");
  const pending = foldBackground(NO_BACKGROUND, started("t1"));
  const finished = { status: "finished" as const, summary: "s", question: "", remainingWork: "w", userInput: null, checks: [] };
  const nameOf = (id: string) => `the suite (${id})`;
  for (const result of [finished, { status: "continuing" as const, summary: "s", remainingWork: "w", checks: [] }]) {
    assert.deepEqual(checkBackground(result, null, pending, nameOf), { status: "aborted", summary: "s", question: backgroundKilledText(["the suite (t1)"]), remainingWork: "w", userInput: null, checks: [] });
  }
  const stopped = { status: "needs_input" as const, summary: "s", question: "A?", remainingWork: "w", userInput: "A", checks: [] };
  assert.equal(checkBackground(stopped, { question: "A?", input: "A" }, pending, nameOf), stopped);
  assert.equal(checkBackground(finished, null, foldBackground(pending, notification("t1", "completed", "/x")), nameOf), finished);
});

// Issue #157: the process ending is a fact of a stream failure, like its code.
test("reduceMessages keeps a stream failure's process ending, and none without a stream failure", () => {
  const end = { kind: "signal" as const, signal: "SIGBUS" };
  assert.deepEqual(reduceMessages([init()], "Claude Code process terminated by signal SIGBUS", null, end).failure?.processEnd, end);
  assert.equal(reduceMessages([init(), assistantText("half")], null, null, end).failure?.processEnd, null);
});

// Issue #162: the report's checks reach the outcome, and a stop keeps the checks its report gave.
test("interpretExecution carries the report's checks to the outcome", () => {
  const checks = [{ step: "S1", command: "npm run check", seconds: 9 }];
  assert.deepEqual(interpretExecution(complete({ status: "finished", summary: "s", question: "", remaining_work: "", missing: "", checks }), null).checks, checks);
  assert.deepEqual(interpretExecution(complete({ status: "continuing", summary: "s", question: "", remaining_work: "w", missing: "", checks }), null).checks, checks);
  assert.deepEqual(interpretExecution(complete({ status: "blocked", summary: "s", question: "q", remaining_work: "w", missing: "", checks }), { question: "q?", input: "a" }).checks, checks);
  assert.deepEqual(interpretExecution(complete({ status: "finished", summary: "s", question: "" }), null).checks, []);
});

// Issue #49: the live output of a Claude Code call.
const meta = { uuid: "00000000-0000-0000-0000-000000000000", session_id: "session-1" };
const toolUse = (id: string, name: string, input: Record<string, unknown>): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, ...meta }) as unknown as SDKMessage;
const toolResult = (id: string, content: unknown, isError = false): SDKMessage =>
  ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, ...meta }) as unknown as SDKMessage;
const progress = (id: string, seconds: number): SDKMessage => ({ type: "tool_progress", tool_use_id: id, tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: seconds, ...meta }) as unknown as SDKMessage;
const moved = (id: string): SDKMessage => ({ type: "system", subtype: "task_updated", task_id: id, patch: { is_backgrounded: true }, ...meta }) as unknown as SDKMessage;
const commandsOf = (messages: readonly SDKMessage[]): { state: ClaudeOutputState; out: OutputCommand[] } =>
  messages.reduce<{ state: ClaudeOutputState; out: OutputCommand[] }>(
    (acc, m) => {
      const [state, commands] = claudeOutputOf(acc.state, m);
      return { state, out: [...acc.out, ...commands] };
    },
    { state: EMPTY_CLAUDE_OUTPUT, out: [] },
  );
const brief = (c: OutputCommand): string =>
  c._tag === "Tail" ? `Tail ${c.key} ${c.path} ${c.status._tag}` : c.event._tag === "Touched" ? `Touched ${c.event.name}` : c.event._tag === "Printed" ? `Printed ${c.event.key} ${JSON.stringify(c.event.text)}` : c.event._tag === "Finished" ? `Finished ${c.event.key} ${c.event.status._tag}` : c.event._tag === "Progress" ? `Progress ${c.event.key} ${c.event.seconds}` : `Started ${c.event.key} ${c.event.name}`;

test("a foreground Bash starts, reports its time, and ends with its error result's output", () => {
  const { out, state } = commandsOf([toolUse("t1", "Bash", { command: "npm test" }), progress("t1", 4), toolResult("t1", [{ type: "text", text: "\u001b[31mnot ok 1\u001b[0m" }], true)]);
  assert.deepEqual(out.map(brief), ["Started claude:t1 npm test", "Progress claude:t1 4", 'Printed claude:t1 "not ok 1"', "Finished claude:t1 Failed"]);
  assert.deepEqual(claudeOpenProcesses(state), []);
});

test("a backgrounded Bash starts nothing itself; its task starts and ends with its output file", () => {
  const { out } = commandsOf([toolUse("t2", "Bash", { command: "npm test", run_in_background: true }), started("b1"), toolResult("t2", "running in the background"), notification("b1", "completed", "/tmp/b1.out")]);
  assert.deepEqual(out.map(brief), ["Started task:b1 task b1", "Tail task:b1 /tmp/b1.out Succeeded"]);
});

test("a task first seen in background_tasks_changed starts under its description", () => {
  const { out } = commandsOf([changed([["b2", false]]), notification("b2", "stopped", "/tmp/b2.out")]);
  assert.deepEqual(out.map(brief), ["Started task:b2 task b2", "Tail task:b2 /tmp/b2.out Stopped"]);
});

test("a foreground task moved to the background by task_updated starts under its description and ends by its notification", () => {
  const { out } = commandsOf([started("f1", { backgrounded: false }), moved("f1"), notification("f1", "failed", "/tmp/f1.out")]);
  assert.deepEqual(out.map(brief), ["Started task:f1 task f1", "Tail task:f1 /tmp/f1.out Failed"]);
});

test("an ambient task is ignored; a Read is one Touched line; an open command ends Unknown at the call's end", () => {
  const { out, state } = commandsOf([started("a1", { ambient: true }), notification("a1", "completed", "/tmp/a"), toolUse("r1", "Read", { file_path: "src/a.ts" }), toolUse("t3", "Bash", { command: "sleep 9" })]);
  assert.deepEqual(out.map(brief), ["Touched Read src/a.ts", "Started claude:t3 sleep 9"]);
  assert.deepEqual(claudeOpenProcesses(state), [{ _tag: "Finished", key: "claude:t3", name: "sleep 9", status: { _tag: "Unknown" } }]);
});
