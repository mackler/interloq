// The SDK's background-task messages for the tests of issue #154, in the shapes of sdk.d.ts (SDKTaskStartedMessage,
// SDKBackgroundTasksChangedMessage, SDKTaskNotificationMessage).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const base = { uuid: "00000000-0000-0000-0000-000000000000", session_id: "session-1" };
export const started = (id: string, options: { backgrounded?: boolean; ambient?: boolean } = {}): SDKMessage =>
  ({ type: "system", subtype: "task_started", task_id: id, description: `task ${id}`, is_backgrounded: options.backgrounded ?? true, ...(options.ambient === undefined ? {} : { ambient: options.ambient }), ...base }) as unknown as SDKMessage;
export const changed = (tasks: readonly (readonly [string, boolean])[]): SDKMessage =>
  ({ type: "system", subtype: "background_tasks_changed", tasks: tasks.map(([id, ambient]) => ({ task_id: id, task_type: "local_bash", description: `task ${id}`, ambient })), ...base }) as unknown as SDKMessage;
export const notification = (id: string, status: "completed" | "failed" | "stopped", outputFile: string, ambient?: boolean): SDKMessage =>
  ({ type: "system", subtype: "task_notification", task_id: id, status, output_file: outputFile, summary: `summary of ${id}`, ...(ambient === undefined ? {} : { ambient }), ...base }) as unknown as SDKMessage;
