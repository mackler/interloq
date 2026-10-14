// The SDK's background-task messages for the tests of issue #154, in the shapes of sdk.d.ts (SDKTaskStartedMessage,
// SDKBackgroundTasksChangedMessage, SDKTaskNotificationMessage).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MONITOR_TOOL_NAME } from "../src/prompts.ts";

const base = { uuid: "00000000-0000-0000-0000-000000000000", session_id: "session-1" };
export const started = (id: string, options: { backgrounded?: boolean; ambient?: boolean } = {}): SDKMessage =>
  ({ type: "system", subtype: "task_started", task_id: id, description: `task ${id}`, is_backgrounded: options.backgrounded ?? true, ...(options.ambient === undefined ? {} : { ambient: options.ambient }), ...base }) as unknown as SDKMessage;
export const changed = (tasks: readonly (readonly [string, boolean])[]): SDKMessage =>
  ({ type: "system", subtype: "background_tasks_changed", tasks: tasks.map(([id, ambient]) => ({ task_id: id, task_type: "local_bash", description: `task ${id}`, ambient })), ...base }) as unknown as SDKMessage;
export const notification = (id: string, status: "completed" | "failed" | "stopped", outputFile: string, ambient?: boolean): SDKMessage =>
  ({ type: "system", subtype: "task_notification", task_id: id, status, output_file: outputFile, summary: `summary of ${id}`, ...(ambient === undefined ? {} : { ambient }), ...base }) as unknown as SDKMessage;

// Issue #161 (S8): a Monitor watch's messages, with their fields as the developer's run of the prototype's monitor
// variant showed them on 14 Oct 2026: a local_bash task whose entries carry no ambient key at all.
export const watchChanged = (id: string, description: string): SDKMessage =>
  ({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: id, task_type: "local_bash", description }], ...base }) as unknown as SDKMessage;
export const watchStarted = (id: string, toolUseId: string, description: string): SDKMessage =>
  ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: toolUseId, description, is_backgrounded: true, task_type: "local_bash", ...base }) as unknown as SDKMessage;
export const noTasksChanged = (): SDKMessage => ({ type: "system", subtype: "background_tasks_changed", tasks: [], ...base }) as unknown as SDKMessage;
export const watchUpdated = (id: string): SDKMessage =>
  ({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed", end_time: 1791962186637 }, ...base }) as unknown as SDKMessage;
export const watchSummary = (description: string): string => `Monitor "${description}" stream ended`;
export const watchNotification = (id: string, toolUseId: string, outputFile: string, description: string): SDKMessage =>
  ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: toolUseId, status: "completed", output_file: outputFile, summary: watchSummary(description), ...base }) as unknown as SDKMessage;
export const monitorUse = (toolUseId: string, input: Readonly<{ description: string; timeout_ms: number; command: string }>): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: MONITOR_TOOL_NAME, input }] }, parent_tool_use_id: null, ...base }) as unknown as SDKMessage;
export const monitorResult = (toolUseId: string, output: Readonly<{ taskId: string; timeoutMs: number; persistent: boolean }>): SDKMessage =>
  ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Monitor started (task ${output.taskId})` }] }, tool_use_result: output, parent_tool_use_id: null, ...base }) as unknown as SDKMessage;
