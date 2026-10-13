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
export const codexArgs = ({ options: o, threadId, outputSchemaFile }: CodexArgsInput): readonly string[] => {
  /** The arguments of a value the SDK tests for truthiness, or none. */
  const given = <A>(value: A | null | undefined, args: (a: A) => readonly string[]): readonly string[] => (value ? args(value) : []);
  const config = (setting: string): readonly string[] => ["--config", setting];
  const webSearch = o.webSearchMode
    ? config(`web_search="${o.webSearchMode}"`)
    : o.webSearchEnabled === undefined
      ? []
      : config(`web_search="${o.webSearchEnabled ? "live" : "disabled"}"`);
  return [
    "exec",
    "--experimental-json",
    ...given(o.model, (model) => ["--model", model]),
    ...(o.threadSource !== undefined && !threadId ? ["--thread-source", o.threadSource] : []),
    ...given(o.sandboxMode, (mode) => ["--sandbox", mode]),
    ...given(o.workingDirectory, (dir) => ["--cd", dir]),
    ...(o.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...given(o.skipGitRepoCheck, () => ["--skip-git-repo-check"]),
    ...given(outputSchemaFile, (file) => ["--output-schema", file]),
    ...given(o.modelReasoningEffort, (effort) => config(`model_reasoning_effort="${effort}"`)),
    ...(o.networkAccessEnabled === undefined ? [] : config(`sandbox_workspace_write.network_access=${o.networkAccessEnabled}`)),
    ...webSearch,
    ...given(o.approvalPolicy, (policy) => config(`approval_policy="${policy}"`)),
    ...given(threadId, (id) => ["resume", id]),
  ];
};

/** The variable the SDK sets to name itself as the CLI's originator, and its value. */
const ORIGINATOR_VARIABLE = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const ORIGINATOR = "codex_sdk_ts";

/** The CLI's environment: the inherited variables, the SDK's originator, the executable's own directories first on PATH. */
export const codexEnv = (
  inherited: Readonly<Record<string, string | undefined>>,
  pathDirs: readonly string[],
): Readonly<Record<string, string>> => {
  const defined = Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const originator: Record<string, string> = defined[ORIGINATOR_VARIABLE] ? {} : { [ORIGINATOR_VARIABLE]: ORIGINATOR };
  const path: Record<string, string> =
    pathDirs.length > 0
      ? { PATH: [...pathDirs, ...(defined.PATH ?? "").split(":").filter((entry) => entry.length > 0 && !pathDirs.includes(entry))].join(":") }
      : {};
  return { ...defined, ...originator, ...path };
};
