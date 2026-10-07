import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeQuestions, decodeToolTarget, interpretExecution, reduceMessages } from "../src/claudeEvents.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantText, failure, init, success } from "./fakeSdk.ts";

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
    failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: "error_max_turns", rejection: null },
  });
});

test("reduceMessages marks a stream that ended before a result as partial, with the stream failure or the missing-result text", () => {
  assert.deepEqual(reduceMessages([init(), assistantText("half")]), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null },
  });
  assert.deepEqual(reduceMessages([init()], "socket hang up"), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "socket hang up", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null },
  });
  assert.deepEqual(reduceMessages([]), {
    sessionId: null, costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true, failure: { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null },
  });
});

const complete = (structured: unknown, resultText = "") => ({ sessionId: "s", costUsd: 1, structured, resultText, error: null, partial: false, failure: null });

test("interpretExecution returns the report when it is valid and there is no stop", () => {
  const outcome = interpretExecution(complete({ status: "finished", summary: "all done", question: "", remaining_work: "" }), null);
  assert.deepEqual(outcome, { status: "finished", summary: "all done", question: "", remainingWork: "", userInput: null });
});

test("interpretExecution gives a recorded stop precedence over the report, valid or not", () => {
  const stop = { question: "A or B?", input: "A or B? -> A" };
  const valid = interpretExecution(complete({ status: "finished", summary: "s", question: "", remaining_work: "w" }), stop);
  assert.deepEqual(valid, { status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "A or B? -> A" });
  const invalid = interpretExecution(complete({ status: "bogus" }), stop);
  assert.deepEqual(invalid, { status: "needs_input", summary: "", question: "A or B?", remainingWork: "", userInput: "A or B? -> A" });
});

test("interpretExecution treats a missing or invalid report and a call error as aborted, keeping the result text", () => {
  const invalid = interpretExecution(complete({ status: "bogus" }, "text only"), null);
  assert.equal(invalid.status, "aborted");
  assert.equal(invalid.summary, "text only");
  assert.match(invalid.question, /ended without a status report: the status report does not match its schema/);
  const missing = interpretExecution(complete(null, "text only"), null);
  assert.match(missing.question, /ended without a status report: no structured output/);
  const failed = interpretExecution({ ...complete(null), error: "error_during_execution" }, null);
  assert.equal(failed.status, "aborted");
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
  assert.deepEqual(outcome.failure, { streamCode: null, apiStatus: 503, terminalReason: "api_error", assistantError: null, retrySeen: null, subtype: "success", rejection: null });
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
  const report = { status: "finished", summary: "all done", question: "", remaining_work: "" };
  const faulted = { ...complete(report), error: "read ECONNRESET", partial: true, failure: { streamCode: "ECONNRESET", apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null } };
  assert.equal(interpretExecution(faulted, null, true).status, "finished");
  assert.equal(interpretExecution(faulted, null, false).status, "aborted");
  assert.equal(interpretExecution(faulted, { question: "A?", input: "A? -> a" }, true).status, "needs_input");
});
