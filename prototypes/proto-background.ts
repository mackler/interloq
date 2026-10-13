// proto-background.ts -- issue #154: can an execution call keep its session open while a background command it started
// runs, and continue the same session with the command's end, instead of letting the structured output end the query?
// Usage: node prototypes/proto-background.ts <scratch git repository> stop|structured
//
// It runs one query with the options of an execution call (permissionMode "auto", a json_schema output format, env with
// BASH_MAX_TIMEOUT_MS 1,200,000) and asks Claude Code to start, with run_in_background, a command that writes a computed
// marker to a file after about 90 s, to end its turn with text only, and then to report the marker. The bundled CLI
// refuses a bare sleep, so the wait is a node timer, and the marker is computed (6 * 7) so that it never appears in the
// command's text.
//   stop:       a Stop hook that, while a background task is in flight, waits for the task_notification the stream loop
//               sees and then returns { decision: "block", reason } naming the output file.
//   structured: a PreToolUse hook on StructuredOutput that, while a task is pending, waits for its notification and then
//               denies the report once, naming the output file; it reports how Claude Code answers the denial.
// Both log, with seconds since the start:
//   (a) whether the Stop hook fired before the structured-output enforcement, with the task in background_tasks;
//   (b) whether stream messages (task_notification, background_tasks_changed) reached the loop while a hook was pending;
//   (c) whether a hook pending for more than 60 s is honored, with the matcher's timeout set to 600 s;
//   (d) whether block or deny with a reason continued the turn with the command alive (the marker in the file and in the
//       final report);
//   (e) in "structured", whether Claude Code returns the report again after a denial, and how the call ends.
// It costs one short Claude Code session per variant and takes two to four minutes.

import { query, type HookInput, type HookJSONOutput, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const [repoArg, variant] = process.argv.slice(2);
if (repoArg === undefined || (variant !== "stop" && variant !== "structured")) {
  console.error("usage: node prototypes/proto-background.ts <scratch git repository> stop|structured");
  process.exit(2);
}
const cwd = path.resolve(repoArg);
const OUT = path.join(cwd, "proto-background.out");
fs.rmSync(OUT, { force: true });
const COMMAND = `node -e "setTimeout(() => require('fs').writeFileSync('${OUT}', 'background-done-' + 6 * 7), 90000)"`;
const MARKER = "background-done-42";
const prompt = `Start exactly this command with the Bash tool, with run_in_background set to true: ${COMMAND}
Then end your turn with a short text saying that you are waiting for it, and make no other tool call.
When you are told that the command has ended, read the file ${OUT} and return the status report with its contents as the summary.`;
const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false };

const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`;
const log = (line: string): void => console.log(`[${at()}] ${line}`);

// The pending background tasks, as the stream shows them: a task is pending from its start until its notification.
const pending = new Set<string>();
const ended: { id: string; status: string; outputFile: string }[] = [];
let wake: () => void = () => {};
let hookPending = false;
const messagesDuringHook: string[] = [];
const waitForEnd = (): Promise<void> => (pending.size === 0 ? Promise.resolve() : new Promise((resolve) => (wake = resolve)));

let stopHookCalls = 0;
let denials = 0;
let enforcementSeen = false;
const stopHook = async (input: HookInput): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Stop") return {};
  stopHookCalls++;
  log(`(a) Stop hook #${stopHookCalls}: enforcement seen before it: ${enforcementSeen}; background_tasks ${JSON.stringify(input.background_tasks ?? null)}`);
  if ((input.background_tasks ?? []).length === 0 && pending.size === 0) return {};
  const since = Date.now();
  hookPending = true;
  await waitForEnd();
  hookPending = false;
  log(`(c) Stop hook waited ${((Date.now() - since) / 1000).toFixed(1)} s and is answering`);
  const reason = `The background command has ended: ${ended.map((e) => `${e.id} ${e.status}, output file ${e.outputFile}`).join("; ")}. Read ${OUT} and return the status report.`;
  return { decision: "block", reason };
};
const structuredHook = async (input: HookInput): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "PreToolUse") return {};
  log(`StructuredOutput hook: pending tasks ${JSON.stringify([...pending])}, denials so far ${denials}`);
  if (pending.size === 0) return {};
  const since = Date.now();
  hookPending = true;
  await waitForEnd();
  hookPending = false;
  denials++;
  log(`(c) StructuredOutput hook waited ${((Date.now() - since) / 1000).toFixed(1)} s and denies`);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `A command you started in the background was still running; it has ended now. Read ${OUT} and return the status report again with its contents.` } };
};

const iterator = query({
  prompt,
  options: {
    cwd,
    permissionMode: "auto",
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    env: { ...process.env, BASH_MAX_TIMEOUT_MS: "1200000" },
    outputFormat: { type: "json_schema", schema },
    hooks: variant === "stop" ? { Stop: [{ hooks: [stopHook], timeout: 600 }] } : { PreToolUse: [{ matcher: "StructuredOutput", hooks: [structuredHook], timeout: 600 }] },
  },
});
let structured: unknown = null;
for await (const message of iterator as AsyncIterable<SDKMessage>) {
  if (hookPending) messagesDuringHook.push(`${message.type}/${"subtype" in message ? String(message.subtype) : ""}`);
  if (message.type === "system" && message.subtype === "task_started") {
    log(`task_started ${message.task_id} backgrounded ${String(message.is_backgrounded)} ambient ${String(message.ambient)}`);
    if (message.is_backgrounded === true && message.ambient !== true) pending.add(message.task_id);
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") log(`background_tasks_changed ${JSON.stringify(message.tasks)}`);
  if (message.type === "system" && message.subtype === "task_notification") {
    log(`task_notification ${message.task_id} ${message.status} ${message.output_file}`);
    if (pending.delete(message.task_id)) ended.push({ id: message.task_id, status: message.status, outputFile: message.output_file });
    if (pending.size === 0) wake();
  }
  if (message.type === "user" && JSON.stringify(message.message.content).includes("structured-output")) {
    enforcementSeen = true;
    log(`structured-output enforcement: ${JSON.stringify(message.message.content).slice(0, 300)}`);
  }
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") log(`tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 300)}`);
      if (block.type === "text") log(`text ${block.text.slice(0, 300)}`);
    }
  }
  if (message.type === "result") {
    structured = "structured_output" in message ? message.structured_output : null;
    log(`result ${message.subtype} terminal ${"terminal_reason" in message ? String(message.terminal_reason) : "-"} structured ${JSON.stringify(structured)}`);
  }
}
const file = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
console.log(`\nvariant: ${variant}`);
console.log(`(a) Stop hook calls: ${stopHookCalls}; enforcement seen: ${enforcementSeen}`);
console.log(`(b) messages that reached the loop while a hook was pending: ${JSON.stringify(messagesDuringHook)}`);
console.log(`(d) the command survived (marker in the file): ${file.includes(MARKER)}; the final report holds it: ${JSON.stringify(structured ?? "").includes(MARKER)}`);
if (variant === "structured") console.log(`(e) denials: ${denials}`);
