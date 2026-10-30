// The real SDKs behind the AgentSdk interface. This file is the only untested code of the pair
// (plan U1): no test may reach the real agents, so nothing here is covered. Codex's threads run over
// Interloq's own launcher (src/codexExec.ts, issue #158), not the SDK's exec, which leaves the CLI's
// stdin without an 'error' listener; the Codex SDK supplies the types and the CLI's binary.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { open } from "node:fs/promises";
import { z } from "zod";
import { REPORT_STEP_DESCRIPTION, REPORT_STEP_SERVER, REPORT_STEP_STATUSES, REPORT_STEP_TOOL } from "./prompts.ts";
import { codexThread, findCodexExecutable } from "./codexExec.ts";
import type { AgentSdk } from "./sdk.ts";

/** Issue #49: how much of a background task's output file the live panel reads, from its end. */
const OUTPUT_TAIL_BYTES = 8192;

/** The live SDKs, built when the program starts rather than when the module loads (finding 29). */
export const liveSdk = (): AgentSdk => {
  const codex = findCodexExecutable();
  return {
    query,
    inheritedEnv: process.env,
    readOutputTail: async (path) => {
      try {
        const handle = await open(path, "r");
        try {
          const { size } = await handle.stat();
          const length = Math.min(size, OUTPUT_TAIL_BYTES);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, size - length);
          return buffer.toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
    },
    startThread: (options) => codexThread(codex, options ?? {}, process.env),
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
