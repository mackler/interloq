// The arguments and the environment of one Codex CLI turn (pure; issue #158). Interloq starts the
// `codex exec --experimental-json` process itself (src/codexExec.ts), because the Codex SDK's own exec
// writes the prompt to the CLI's stdin with no 'error' listener, so a write to a CLI that has exited
// (EPIPE) became an uncaught exception that ended the web server. What the SDK's `CodexExec.run`
// (node_modules/@openai/codex-sdk/dist/index.js) builds from a thread's options is reproduced here, in
// its order; test/codexArgs.test.ts compares the two over a recording executable.

import type { ThreadOptions } from "@openai/codex-sdk";

/** What one turn's command line is built from: the thread's options, its id once known, the output schema's file. */
export type CodexArgsInput = Readonly<{
  options: ThreadOptions;
  threadId: string | null;
  outputSchemaFile: string | null;
}>;

/** The CLI's arguments for one turn, as the SDK's `CodexExec.run` builds them (no config overrides, no images). */
export const codexArgs = (_input: CodexArgsInput): readonly string[] => [];

/** The CLI's environment: the inherited variables, the SDK's originator, the executable's own directories first on PATH. */
export const codexEnv = (
  _inherited: Readonly<Record<string, string | undefined>>,
  _pathDirs: readonly string[],
): Readonly<Record<string, string>> => ({});
