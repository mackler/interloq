// A fake for the two SDKs, so that the logic of src/claude.ts and src/codex.ts is tested without
// credentials. The message and turn objects carry only the fields the adapters read.

import type { Options, SDKMessage, SDKRateLimitEvent, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSdk, SdkThread, StepHandler } from "../src/sdk.ts";
import { REPORT_STEP_SERVER } from "../src/prompts.ts";

export type Call = { prompt: string; options: Options };
/** One scripted Claude Code call: the messages it produces, possibly after calling back. */
export type Script = (call: Call) => AsyncIterable<SDKMessage>;

export const init = (sessionId = "session-1", model = "claude-fake"): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: sessionId, model }) as unknown as SDKMessage;

export const success = (structured: unknown, text = "", costUsd: number | null = 0.25, turns = 3): SDKMessage =>
  ({ type: "result", subtype: "success", structured_output: structured, result: text, total_cost_usd: costUsd, num_turns: turns }) as unknown as SDKMessage;

export const failure = (subtype = "error_during_execution", costUsd: number | null = 0.1): SDKMessage =>
  ({ type: "result", subtype, total_cost_usd: costUsd, num_turns: 1 }) as unknown as SDKMessage;

export const assistantText = (text: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as SDKMessage;

export const assistantTool = (name: string, input: Record<string, unknown>): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }) as unknown as SDKMessage;

/** A rate-limit event (issue #68), built with the SDK's own types so that a wrong field name is a type error. */
export const rateLimit = (info: SDKRateLimitInfo, sessionId = "session-1"): SDKMessage => {
  const event: SDKRateLimitEvent = { type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-000000000000", session_id: sessionId };
  return event;
};
/** The assistant's rate_limit error and the failed result that end a call rejected for a usage limit. */
export const limitError = (): SDKMessage =>
  ({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit" }] } }) as unknown as SDKMessage;
export const limitResult = (): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "You've hit your session limit", total_cost_usd: 0.1, num_turns: 1 }) as unknown as SDKMessage;

/** The messages of one call, with no callback to the adapter. */
export const messages = (...list: SDKMessage[]): Script =>
  () => (async function* () {
    for (const message of list) yield message;
  })();

/** A completed turn as its streamed events: the final agent message, then turn.completed with the usage. */
export const turn = (finalResponse: string, usage: unknown = { input_tokens: 10, output_tokens: 5 }, before: readonly ThreadEvent[] = []): ThreadEvent[] =>
  [...before, { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: finalResponse } }, { type: "turn.completed", usage }] as unknown as ThreadEvent[];
/** A command execution item, reported started and completed (the SDK emits both). */
export const command = (id: string, cmd: string): ThreadEvent[] =>
  [
    { type: "item.started", item: { id, type: "command_execution", command: cmd, aggregated_output: "", status: "in_progress" } },
    { type: "item.completed", item: { id, type: "command_execution", command: cmd, aggregated_output: "ok", exit_code: 0, status: "completed" } },
  ] as ThreadEvent[];
/** A file change, which the SDK reports only on completion. */
export const fileChange = (id: string, ...paths: string[]): ThreadEvent[] => [{ type: "item.completed", item: { id, type: "file_change", changes: paths.map((p) => ({ path: p, kind: "update" })), status: "completed" } }] as ThreadEvent[];
export const webSearch = (id: string, query: string): ThreadEvent[] =>
  [
    { type: "item.started", item: { id, type: "web_search", query } },
    { type: "item.completed", item: { id, type: "web_search", query } },
  ] as ThreadEvent[];
export const turnFailed = (message: string): ThreadEvent[] => [{ type: "turn.failed", error: { message } }] as ThreadEvent[];

export type ThreadCall = { input: string; turnOptions: TurnOptions | undefined };
/**
 * An answer of `thread.runStreamed`: the events of the turn, an error to reject with, or a function of the turn
 * options that returns the event generator (to observe the abort signal and the generator's return).
 */
export type TurnAnswer = ThreadEvent[] | Error | ((turnOptions: TurnOptions | undefined) => AsyncGenerator<ThreadEvent>);

/** A turn whose event stream rejects with `value` (any value, not only an Error), as the SDK's stream can (W1-R1-2). */
export const rejecting = (value: unknown): TurnAnswer => () =>
  (async function* (): AsyncGenerator<ThreadEvent> {
    throw value;
  })();

export class FakeSdk implements AgentSdk {
  readonly calls: Call[] = [];
  /** A made-up environment, so that a test sees exactly what each call carries (issue #78). */
  readonly inheritedEnv: Readonly<Record<string, string | undefined>> = { PATH: "/fake/bin", HOME: "/fake/home", BASH_MAX_TIMEOUT_MS: "1" };
  readonly threads: { options: ThreadOptions | undefined; calls: ThreadCall[] }[] = [];
  private readonly scripts: Script[];
  private readonly turns: TurnAnswer[];
  private waiters: (() => void)[] = [];
  /** Resolves when the next query or thread turn begins. */
  nextCall(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private signal(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const resolve of current) resolve();
  }

  constructor(scripts: Script[] = [], turns: TurnAnswer[] = []) {
    this.scripts = [...scripts];
    this.turns = [...turns];
  }

  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage> {
    const call: Call = { prompt: params.prompt, options: params.options ?? {} };
    this.calls.push(call);
    this.signal();
    const script = this.scripts.shift();
    if (script === undefined) throw new Error(`no scripted Claude Code call for: ${params.prompt.slice(0, 60)}`);
    return script(call);
  }

  /** The server a live binding would build; the handler is kept for `reportStep`. */
  stepReporter(handler: StepHandler): McpServerConfig {
    return { type: "sdk", name: REPORT_STEP_SERVER, instance: { handler } } as unknown as McpServerConfig;
  }

  startThread(options?: ThreadOptions): SdkThread {
    const record: { options: ThreadOptions | undefined; calls: ThreadCall[] } = { options, calls: [] };
    this.threads.push(record);
    const id = `thread-${this.threads.length}`;
    const answers = this.turns;
    return {
      id,
      runStreamed: async (input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }> => {
        record.calls.push({ input, turnOptions });
        this.signal();
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no scripted Codex turn");
        if (answer instanceof Error) throw answer;
        if (typeof answer === "function") return { events: answer(turnOptions) };
        return {
          events: (async function* () {
            for (const event of answer) yield event;
          })(),
        };
      },
    };
  }
}

/** The fake of the in-process report_step server: the handler, found again by `reportStep` in the options of a call. */
type FakeStepServer = { type: "sdk"; name: string; instance: { handler: StepHandler } };
/** Calls report_step as Claude Code would, through the server the adapter passed in the call's options. */
export const reportStep = async (options: Options, id: string, status: "started" | "done"): Promise<Readonly<{ text: string; isError: boolean }>> => {
  const server = options.mcpServers?.[REPORT_STEP_SERVER] as FakeStepServer | undefined;
  if (server === undefined) throw new Error("the call offers no report_step server");
  return server.instance.handler({ id, status });
};
