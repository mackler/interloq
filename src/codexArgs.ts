// The pure parts of the Codex launcher (issue #158): the arguments and the environment of one CLI turn,
// and what ends a turn. Interloq starts the `codex exec --experimental-json` process itself
// (src/codexExec.ts), because the Codex SDK's own exec writes the prompt to the CLI's stdin with no
// 'error' listener, so a write to a CLI that has exited (EPIPE) became an uncaught exception that ended
// the web server. What the SDK's `CodexExec.run` (node_modules/@openai/codex-sdk/dist/index.js) builds
// from a thread's options is reproduced here, in its order; test/codexArgs.test.ts compares the two
// over a recording executable. Issue #233: when the CLI exits nonzero having printed nothing of its cause, the cause
// is read from what the CLI streamed (`streamFailureOf`) or from Codex's own session file (`sessionFailureOf`), and put
// before the exit's text (`recordedFailureText`).

import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { LimitReset } from "./limitReset.ts";

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

/** How the CLI ended: its exit code, or the signal that ended it. */
export type CliExit = Readonly<{ code: number | null; signal: string | null }>;

/** The SDK's text of a CLI that ended other than with code 0, or null when it ended cleanly. */
export const exitText = (exit: CliExit, stderr: string): string | null =>
  exit.code === 0 && exit.signal === null ? null : `Codex Exec exited with ${exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`}: ${stderr}`;

/**
 * What ends a turn after the CLI's output: the first error kept from the child or its streams wins, since a write
 * to a CLI that has exited (EPIPE) is the positive evidence of a transport fault, while the exit code that
 * follows it says only that the CLI ended; otherwise the exit's text, or nothing.
 */
export const turnEnd = <E>(kept: E | null, exit: CliExit, stderr: string): Readonly<{ kind: "kept"; error: E }> | Readonly<{ kind: "exited"; text: string }> | null => {
  if (kept !== null) return { kind: "kept", error: kept };
  const text = exitText(exit, stderr);
  return text === null ? null : { kind: "exited", text };
};

/** The failure the CLI's JSON stream carried: the `turn.failed` error's message, and the last `error` event's message. */
export const streamFailureOf = (events: readonly ThreadEvent[]): Readonly<{ failed: string | null; notice: string | null }> => ({
  failed: events.flatMap((e) => (e.type === "turn.failed" ? [e.error.message] : [])).at(-1) ?? null,
  notice: events.flatMap((e) => (e.type === "error" ? [e.message] : [])).at(-1) ?? null,
});

/** A plain object, or null. */
const objectOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** A session file's line as a record's body: its object `payload` where it has one, else the record itself; null where it is no JSON object. */
const bodyOf = (line: string): Readonly<Record<string, unknown>> | null => {
  const record = ((): Readonly<Record<string, unknown>> | null => {
    try {
      return objectOf(JSON.parse(line));
    } catch {
      return null;
    }
  })();
  return record === null ? null : (objectOf(record.payload) ?? record);
};
const stringOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The failure Codex recorded in its session file for the last turn of the lines given (issue #233): among the bodies
 * after the last `task_started`, the `error.message` of the last `task_complete` that has one, else the `message` of
 * the last `error`, else null. The file is Codex's, so it is read leniently: a line that is no JSON object is skipped.
 */
export const sessionFailureOf = (lines: readonly string[]): string | null => {
  const bodies = lines.map(bodyOf).filter((b): b is Readonly<Record<string, unknown>> => b !== null);
  const turn = bodies.slice(bodies.map((b) => b.type).lastIndexOf("task_started") + 1);
  /** The last message of a body of the type given, by where that type keeps it. */
  const last = (type: string, messageOf: (body: Readonly<Record<string, unknown>>) => unknown): string | null =>
    turn.flatMap((body) => {
      const message = body.type === type ? stringOf(messageOf(body)) : null;
      return message === null ? [] : [message];
    }).at(-1) ?? null;
  return last("task_complete", (body) => objectOf(body.error)?.message) ?? last("error", (body) => body.message);
};

/** The text of a turn's failure where Codex recorded a cause: the cause, then the exit's text as evidence. */
export const recordedFailureText = (recorded: string, exit: string): string => `${recorded} (${exit.trim()})`;

/**
 * The reset of a limit Codex recorded in its session file (issue #251), from the lines this invocation appended: the
 * last body with an object `rate_limits`, whose windows (`primary`, `secondary`, any other key holding an object) each
 * carry `used_percent` and `resets_at` (Unix seconds), and which may name the window reached in
 * `rate_limit_reached_type`. A window is exhausted at `used_percent` 100 or more, or where that field names it; the reset
 * is the latest finite positive `resets_at` of the exhausted windows, else null. Lenient: a malformed line or field is
 * skipped, never thrown. The shape is taken from Codex 0.155.1's protocol, not observed in a record.
 */
export const sessionLimitResetOf = (lines: readonly string[]): LimitReset | null => {
  const limits = lines
    .map(bodyOf)
    .flatMap((b) => (b === null ? [] : [objectOf(b.rate_limits)]))
    .filter((l): l is Readonly<Record<string, unknown>> => l !== null)
    .at(-1);
  if (limits === undefined) return null;
  const reached = limits.rate_limit_reached_type;
  const resets = Object.entries(limits).flatMap(([key, value]) => {
    const window = objectOf(value);
    if (window === null) return [];
    const used = window.used_percent;
    const exhausted = (typeof used === "number" && used >= 100) || key === reached;
    const at = window.resets_at;
    return exhausted && typeof at === "number" && Number.isFinite(at) && at > 0 ? [at] : [];
  });
  return resets.length === 0 ? null : { kind: "instant", atMs: Math.max(...resets) * 1000 };
};

/** The failure of a turn whose CLI exited, with the reset Codex's session file recorded, or null (issue #251). */
export class RecordedFailure extends Error {
  readonly reset: LimitReset | null;
  constructor(message: string, reset: LimitReset | null) {
    super(message);
    this.name = "RecordedFailure";
    this.reset = reset;
  }
}
