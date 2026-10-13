// The Codex CLI, started by Interloq itself (an edge, issue #158). The SDK's `CodexExec.run` writes the
// prompt to the CLI's stdin with no 'error' listener and exposes neither the child nor its streams, so
// an EPIPE on that write was an uncaught exception that ended the web server and both runs with it.
// `codexThread` reproduces the SDK's thread over a child process whose every stream has an 'error'
// listener, so such a write fails the turn with its code, which src/transport.ts classifies.

import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { Result } from "effect";
import type { SdkThread } from "./sdk.ts";

/** The CLI's executable and the directories its package puts first on PATH. */
export type CodexExecutable = Readonly<{ path: string; pathDirs: readonly string[] }>;

/** The SDK's `findCodexPath`, reproduced: the platform package's binary beside `@openai/codex`. */
export const findCodexExecutable = (): Result.Result<CodexExecutable, string> => Result.fail("not implemented");

/** One Codex thread over the CLI. An unresolved executable fails each turn with its message. */
export const codexThread = (
  executable: Result.Result<CodexExecutable, string>,
  options: ThreadOptions,
  env: Readonly<Record<string, string | undefined>>,
): SdkThread => {
  if (Result.isFailure(executable)) {
    const message = executable.failure;
    return { id: null, runStreamed: () => Promise.reject(new Error(message)) };
  }
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value;
  return new Codex({ codexPathOverride: executable.success.path, env: defined }).startThread(options);
};
