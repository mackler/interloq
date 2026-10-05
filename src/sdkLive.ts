// The real SDKs behind the AgentSdk interface. This file is the only untested code of the pair
// (plan U1): no test may reach the real agents, so nothing here is covered.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { REPORT_STEP_DESCRIPTION, REPORT_STEP_SERVER, REPORT_STEP_STATUSES, REPORT_STEP_TOOL } from "./prompts.ts";
import type { AgentSdk } from "./sdk.ts";

/** The live SDKs, built when the program starts rather than when the module loads (finding 29). */
export const liveSdk = (): AgentSdk => {
  const codex = new Codex();
  return {
    query,
    inheritedEnv: process.env,
    startThread: (options) => codex.startThread(options),
    stepReporter: (handler) =>
      createSdkMcpServer({
        name: REPORT_STEP_SERVER,
        version: "1.0.0",
        tools: [
          tool(REPORT_STEP_TOOL, REPORT_STEP_DESCRIPTION, { id: z.string(), status: z.enum(REPORT_STEP_STATUSES) }, async (args) => {
            const reply = await handler({ id: args.id, status: args.status });
            return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
          }),
        ],
      }),
  };
};
