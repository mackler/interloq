// The two SDKs as the adapters use them. A test supplies a fake, so the logic of src/claude.ts and
// src/codex.ts is covered without credentials. `liveSdk` binds the real SDKs and is the only
// untested code of the pair (plan U1).

import type { McpServerConfig, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";

/** One Codex thread. `Thread` of the Codex SDK satisfies this. */
export type SdkThread = {
  readonly id: string | null;
  /** One turn, streamed (the activity line shows its tool use); `RunStreamedResult` of the Codex SDK is `{ events }`. */
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

/** One report of report_step (issue #6, Q2): a step's id and its new status. */
export type StepReport = Readonly<{ id: string; status: "started" | "done" }>;
/** The program's answer to a report: the text Claude Code receives, and whether it is an error. */
export type StepHandler = (report: StepReport) => Promise<Readonly<{ text: string; isError: boolean }>>;

export type AgentSdk = {
  /** The environment Interloq was started with, which every Claude Code call carries with the command ceiling added (issue #78). */
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
  /** One Claude Code call. The messages of the turn arrive in order. */
  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
  /**
   * The in-process MCP server that offers report_step to an execution call (issue #6, Q2), for `Options.mcpServers`
   * under the name REPORT_STEP_SERVER of src/prompts.ts; `handler` answers each call.
   */
  stepReporter(handler: StepHandler): McpServerConfig;
  startThread(options?: ThreadOptions): SdkThread;
};
