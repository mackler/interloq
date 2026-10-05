// proto-bash-timeout.ts -- issue #78: does BASH_MAX_TIMEOUT_MS reach the Claude Code bundled with the Agent SDK when it
// is passed as Interloq would pass it, through Options.env?
// Usage: node prototypes/proto-bash-timeout.ts <scratch git repository> with|without
//
// It asks Claude Code to run one Bash command of 11 minutes with a timeout of 20 minutes, under the options of an
// execution call (permissionMode "auto"), and prints whether the command's result came back in the same call with its
// output ("prototype-done-42"), or the tool timed out or moved it to the background. "with" passes
// env: { ...process.env, BASH_MAX_TIMEOUT_MS: "1200000" }; "without" passes no env, the control.
// It costs one short Claude Code session per variant and takes more than ten minutes.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";

const [repoArg, variant] = process.argv.slice(2);
if (repoArg === undefined || (variant !== "with" && variant !== "without")) {
  console.error("usage: node prototypes/proto-bash-timeout.ts <scratch git repository> with|without");
  process.exit(2);
}
const cwd = path.resolve(repoArg);
// The bundled CLI refuses a bare sleep ("Blocked: sleep 660 followed by: ..."), so the wait is a node timer. The output
// is computed (6 * 7), so that it never appears in the command's text, which an error message may echo.
const COMMAND = `node -e "setTimeout(() => console.log('prototype-done-' + 6 * 7), 660000)"`;
const MARKER = "prototype-done-42";
const prompt = `Run exactly this command with the Bash tool, in the foreground, with the tool's timeout set to 1200000 milliseconds, and do not run it in the background: ${COMMAND}
Then reply with the tool's result exactly as you received it, and nothing else. Do not run any other command.`;

const started = Date.now();
const results: string[] = [];
const iterator = query({
  prompt,
  options: {
    cwd,
    permissionMode: "auto",
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    ...(variant === "with" ? { env: { ...process.env, BASH_MAX_TIMEOUT_MS: "1200000" } } : {}),
  },
});
for await (const message of iterator as AsyncIterable<SDKMessage>) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`[tool_use ${((Date.now() - started) / 1000).toFixed(0)} s] ${block.name} ${JSON.stringify(block.input)}`);
    }
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
        const text = JSON.stringify(block.content);
        results.push(text);
        console.log(`[tool_result ${((Date.now() - started) / 1000).toFixed(0)} s] ${text.slice(0, 600)}`);
      }
    }
  }
  if (message.type === "result") console.log(`[result ${((Date.now() - started) / 1000).toFixed(0)} s] ${message.subtype} ${"result" in message ? String(message.result).slice(0, 400) : ""}`);
}
const first = results[0] ?? "";
const completed = first.includes(MARKER) && !first.includes("tool_use_error");
console.log(`\nvariant: ${variant}`);
console.log(`the first Bash result holds the command's output: ${completed}`);
console.log(`verdict: ${completed ? "the command ran to its end inside one tool call" : "the command did not complete inside one tool call (timed out or moved to the background)"}`);
