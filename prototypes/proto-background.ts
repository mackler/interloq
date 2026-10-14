// proto-background.ts -- issue #154: can an execution call keep its session open while a background command it started
// runs, and continue the same session with the command's end, instead of letting the structured output end the query?
// Usage: node prototypes/proto-background.ts <scratch git repository> stop|structured|denials|monitor
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
//   denials:    (work review issue W1-R1-2) after how many refused structured outputs does Claude Code end the call
//               (the terminal reason structured_output_retry_exhausted)? The command runs about 6 minutes, and Claude
//               Code is asked to return the report at once after starting it. A PreToolUse hook on StructuredOutput
//               denies every report immediately, without waiting, while the command is pending, and allows one only
//               when nothing is pending. It prints the number of denials, their times, the result's subtype and
//               terminal reason, and whether the call ended with the command still running or the command ended first.
//               The adapter refuses a report once per renewal of the bound of one wait and once per new background
//               command, so this number is how far a long command or several commands can go before the call ends.
//   monitor:    (issue #161) does a Monitor watch appear in the SDK's task messages, so that foldBackground of
//               src/claudeEvents.ts already waits for it? Claude Code is asked to start one watch with the Monitor tool
//               (no Bash call, nothing with run_in_background), whose command prints one line and exits after about
//               90 s, and to end its turn with text only. A Stop hook records the turn's end, logs background_tasks,
//               waits once (up to 180 s) for the watch's task_notification and blocks with its end. The stream loop
//               logs the Monitor tool_use and its result (MonitorOutput: taskId, timeoutMs, persistent) and every
//               task_started, task_updated, background_tasks_changed and task_notification. At the end it prints, for
//               the watch's task id, whether a non-ambient pending signal arrived and when relative to the turn's end,
//               whether anything marked it ambient, whether a task_notification ended it, whether the Stop hook's
//               background_tasks listed it, and one verdict line: "the existing fold covers the watch" or "the
//               existing fold does not cover the watch".
// Both log, with seconds since the start:
//   (a) whether the Stop hook fired before the structured-output enforcement, with the task in background_tasks;
//   (b) whether stream messages (task_notification, background_tasks_changed) reached the loop while a hook was pending;
//   (c) whether a hook pending for more than 60 s is honored, with the matcher's timeout set to 600 s;
//   (d) whether block or deny with a reason continued the turn with the command alive (the marker in the file and in the
//       final report);
//   (e) in "structured", whether Claude Code returns the report again after a denial, and how the call ends.
// It costs one short Claude Code session per variant and takes two to four minutes, "denials" up to about seven;
// "monitor" two to four.

import { query, type HookInput, type HookJSONOutput, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const [repoArg, variant] = process.argv.slice(2);
if (repoArg === undefined || (variant !== "stop" && variant !== "structured" && variant !== "denials" && variant !== "monitor")) {
  console.error("usage: node prototypes/proto-background.ts <scratch git repository> stop|structured|denials|monitor");
  process.exit(2);
}
const cwd = path.resolve(repoArg);
const OUT = path.join(cwd, "proto-background.out");
fs.rmSync(OUT, { force: true });
const DURATION_MS = variant === "denials" ? 360000 : 90000;
const COMMAND = `node -e "setTimeout(() => require('fs').writeFileSync('${OUT}', 'background-done-' + 6 * 7), ${DURATION_MS})"`;
const MARKER = "background-done-42";
const WATCH_DESCRIPTION = "proto watch";
const WATCH_COMMAND = `node -e "setTimeout(() => console.log('watch-done-' + 6 * 7), 90000)"`;
const prompt =
  variant === "monitor"
    ? `Start exactly one watch with the Monitor tool, with the description "${WATCH_DESCRIPTION}", timeout_ms 300000, and exactly this command: ${WATCH_COMMAND}
Do not use the Bash tool and start nothing with run_in_background. Then end your turn with a short text saying that you are waiting for the watch, and make no other tool call.
When you are told that the watch has ended, return the status report with the summary "watched".`
    : variant === "denials"
    ? `Start exactly this command with the Bash tool, with run_in_background set to true: ${COMMAND}
Then, at once and without waiting for it, return the status report with the summary "started". If the report is refused, return it again.`
    : `Start exactly this command with the Bash tool, with run_in_background set to true: ${COMMAND}
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

// The denials variant: every report refused at once while the command is pending, each refusal with its time.
const DENIAL_REASON = "A command you started in the background is still running. Return the status report again.";
const denialTimes: string[] = [];
let resultSeen = false;
let endedBeforeResult = false;
let resultLine = "";
const denyingHook = async (input: HookInput): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (pending.size === 0) {
    log(`StructuredOutput allowed after ${denialTimes.length} denials`);
    return {};
  }
  denialTimes.push(at());
  log(`StructuredOutput denial #${denialTimes.length}`);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENIAL_REASON } };
};
// The monitor variant: the watch's messages as the stream shows them, each with its absolute time, matched to the watch
// after the stream ends, since a task message may arrive before the tool's result names the task id.
type Kept = Readonly<{ time: number; message: SDKMessage }>;
const kept: Kept[] = [];
const monitorUses = new Set<string>();
let watchTaskId: string | null = null;
let turnEnd: number | null = null;
let notified: () => void = () => {};
let watchNotified = false;
let delivered = false;
const stopListings: string[][] = [];
const WATCH_WAIT_MS = 180000;
const monitorStopHook = async (input: HookInput): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Stop") return {};
  stopHookCalls++;
  turnEnd ??= Date.now();
  stopListings.push((input.background_tasks ?? []).map((t) => JSON.stringify(t)));
  log(`(a) Stop hook #${stopHookCalls}: background_tasks ${JSON.stringify(input.background_tasks ?? null)}`);
  // The watch's end is delivered once: a later Stop call would find the notification present and block again forever.
  if (delivered) return {};
  const since = Date.now();
  hookPending = true;
  const came = watchNotified || (await Promise.race([new Promise<boolean>((resolve) => (notified = () => resolve(true))), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WATCH_WAIT_MS))]));
  hookPending = false;
  delivered = true;
  log(`(c) Stop hook waited ${((Date.now() - since) / 1000).toFixed(1)} s; the watch's notification ${came ? "came" : "did not come"}`);
  return came ? { decision: "block", reason: `The watch "${WATCH_DESCRIPTION}" has ended. Return the status report with the summary "watched".` } : {};
};
const hooksOf = (): NonNullable<Parameters<typeof query>[0]["options"]>["hooks"] => {
  switch (variant) {
    case "stop":
      return { Stop: [{ hooks: [stopHook], timeout: 600 }] };
    case "monitor":
      return { Stop: [{ hooks: [monitorStopHook], timeout: 600 }] };
    case "structured":
      return { PreToolUse: [{ matcher: "StructuredOutput", hooks: [structuredHook], timeout: 600 }] };
    default:
      return { PreToolUse: [{ matcher: "StructuredOutput", hooks: [denyingHook], timeout: 600 }] };
  }
};

const iterator = query({
  prompt,
  options: {
    cwd,
    permissionMode: "auto",
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    env: { ...process.env, BASH_MAX_TIMEOUT_MS: "1200000" },
    outputFormat: { type: "json_schema", schema },
    hooks: hooksOf(),
  },
});
const isWatchMessage = (message: SDKMessage): boolean =>
  message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_updated" || message.subtype === "background_tasks_changed" || message.subtype === "task_notification");
function observeWatch(message: SDKMessage): void {
  const time = Date.now();
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use" && block.name === "Monitor") {
        monitorUses.add(block.id);
        log(`Monitor tool_use ${block.id} ${JSON.stringify(block.input)}`);
      }
    }
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result" && "tool_use_id" in block && monitorUses.has(String(block.tool_use_id))) {
        const output = message.tool_use_result;
        log(`Monitor tool_result for ${String(block.tool_use_id)}: tool_use_result ${JSON.stringify(output ?? null)}`);
        if (typeof output === "object" && output !== null && "taskId" in output && typeof output.taskId === "string") watchTaskId ??= output.taskId;
      }
    }
  }
  if (isWatchMessage(message)) {
    kept.push({ time, message });
    log(`${"subtype" in message ? String(message.subtype) : ""} ${JSON.stringify(message)}`);
    if (message.type === "system" && message.subtype === "task_notification" && (message.task_id === watchTaskId || (message.tool_use_id !== undefined && monitorUses.has(message.tool_use_id)))) {
      watchNotified = true;
      notified();
    }
  }
}
let structured: unknown = null;
for await (const message of iterator as AsyncIterable<SDKMessage>) {
  if (hookPending) messagesDuringHook.push(`${message.type}/${"subtype" in message ? String(message.subtype) : ""}`);
  if (variant === "monitor") observeWatch(message);
  if (message.type === "system" && message.subtype === "task_started") {
    log(`task_started ${message.task_id} backgrounded ${String(message.is_backgrounded)} ambient ${String(message.ambient)}`);
    if (message.is_backgrounded === true && message.ambient !== true) pending.add(message.task_id);
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") log(`background_tasks_changed ${JSON.stringify(message.tasks)}`);
  if (message.type === "system" && message.subtype === "task_notification") {
    log(`task_notification ${message.task_id} ${message.status} ${message.output_file}`);
    if (!resultSeen && pending.has(message.task_id)) endedBeforeResult = true;
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
    resultSeen = true;
    resultLine = `subtype ${message.subtype}, terminal_reason ${"terminal_reason" in message ? String(message.terminal_reason) : "-"}`;
    log(`result ${message.subtype} terminal ${"terminal_reason" in message ? String(message.terminal_reason) : "-"} structured ${JSON.stringify(structured)}`);
  }
}
const file = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
console.log(`\nvariant: ${variant}`);
console.log(`(a) Stop hook calls: ${stopHookCalls}; enforcement seen: ${enforcementSeen}`);
console.log(`(b) messages that reached the loop while a hook was pending: ${JSON.stringify(messagesDuringHook)}`);
console.log(`(d) the command survived (marker in the file): ${file.includes(MARKER)}; the final report holds it: ${JSON.stringify(structured ?? "").includes(MARKER)}`);
if (variant === "structured") console.log(`(e) denials: ${denials}`);
if (variant === "denials") {
  console.log(`denials: ${denialTimes.length}, at ${JSON.stringify(denialTimes)}`);
  console.log(`result: ${resultLine || "none"}`);
  console.log(endedBeforeResult ? `the command ended first, after ${denialTimes.length} denials` : `the call ended after ${denialTimes.length} denials with the command still running`);
}
if (variant === "monitor") {
  // Each kept message is matched to the watch by its task id, or by the tool_use_id of the Monitor call.
  const ids = new Set<string>(watchTaskId === null ? [] : [watchTaskId]);
  for (const { message } of kept) {
    if (message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_notification") && message.tool_use_id !== undefined && monitorUses.has(message.tool_use_id)) ids.add(message.task_id);
  }
  const rel = (time: number): string => (turnEnd === null ? "(the turn never ended)" : `${((time - turnEnd) / 1000).toFixed(1)} s relative to the turn's end`);
  type Signal = Readonly<{ time: number; where: string }>;
  const signals: Signal[] = [];
  const ambients: Signal[] = [];
  const notifications: { time: number; status: string; ambient: boolean }[] = [];
  for (const { time, message } of kept) {
    if (message.type !== "system") continue;
    if (message.subtype === "background_tasks_changed") {
      for (const task of message.tasks.filter((t) => ids.has(t.task_id))) (task.ambient === true ? ambients : signals).push({ time, where: "background_tasks_changed" });
    }
    if (message.subtype === "task_started" && ids.has(message.task_id)) {
      if (message.ambient === true) ambients.push({ time, where: "task_started" });
      else if (message.is_backgrounded === true) signals.push({ time, where: "task_started (is_backgrounded)" });
    }
    if (message.subtype === "task_notification" && ids.has(message.task_id)) {
      if (message.ambient === true) ambients.push({ time, where: "task_notification" });
      notifications.push({ time, status: message.status, ambient: message.ambient === true });
    }
  }
  const first = signals[0];
  const notice = notifications[0];
  const signalBeforeEnd = first !== undefined && turnEnd !== null && first.time <= turnEnd;
  // The fold marks a task ambient for good at the first ambient marking and then never makes it pending, and it ends a
  // pending task only on a notification that is not ambient; so an ambient marking anywhere means it does not cover it.
  const covers = signalBeforeEnd && ambients.length === 0 && notice !== undefined && !notice.ambient;
  console.log(`watch task id: ${[...ids].join(", ") || "none seen"} (Monitor tool_use ids: ${[...monitorUses].join(", ") || "none"})`);
  console.log(`pending signal: ${first === undefined ? "none" : `yes, first by ${first.where}, ${rel(first.time)}`}`);
  console.log(`marked ambient: ${ambients.length === 0 ? "no" : `yes, by ${ambients.map((a) => `${a.where} (${rel(a.time)})`).join("; ")}`}`);
  console.log(`notification: ${notice === undefined ? "none" : `yes, status ${notice.status}, ambient ${String(notice.ambient)}, ${rel(notice.time)}`}`);
  console.log(`Stop hook's background_tasks listed it: ${stopListings.some((listing) => listing.some((entry) => [...ids].some((id) => entry.includes(id))))}`);
  console.log(covers ? "the existing fold covers the watch" : "the existing fold does not cover the watch");
}
