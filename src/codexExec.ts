// The Codex CLI, started by Interloq itself (an edge, issue #158). The SDK's `CodexExec.run` writes the
// prompt to the CLI's stdin with no 'error' listener and exposes neither the child nor its streams, so
// an EPIPE on that write was an uncaught exception that ended the web server and both runs with it.
// `codexThread` reproduces the SDK's thread over a child process whose every stream has an 'error'
// listener, so such a write fails the turn with its code, which src/transport.ts classifies. The
// listeners are never removed: a write error can arrive after the turn ended, a kill included, and a
// removed listener would make it uncaught again. The decisions (arguments, environment, which error
// ends a turn, the exit's text) are the pure functions of src/codexArgs.ts.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { Result } from "effect";
import { type CliExit, codexArgs, codexEnv, turnEnd } from "./codexArgs.ts";
import type { SdkThread } from "./sdk.ts";

/** The CLI's executable and the directories its package puts first on PATH. */
export type CodexExecutable = Readonly<{ path: string; pathDirs: readonly string[] }>;

/** The SDK's `findCodexPath`, reproduced: the platform package's binary beside `@openai/codex`. */
export const findCodexExecutable = (): Result.Result<CodexExecutable, string> => Result.fail("not implemented");

/** The output schema's file, written as the SDK's `createOutputSchemaFile` writes it, and its removal. */
const schemaFile = async (schema: unknown): Promise<Readonly<{ path: string | null; remove: () => Promise<void> }>> => {
  if (schema === undefined) return { path: null, remove: async () => undefined };
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-output-schema-"));
  const remove = (): Promise<void> => rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const file = path.join(dir, "schema.json");
  return writeFile(file, JSON.stringify(schema), "utf8").then(
    () => ({ path: file, remove }),
    async (e: unknown) => {
      await remove();
      throw e;
    },
  );
};

/** One parsed line of the CLI's output, as the SDK's thread yields it (the usage's cache writes defaulted to 0). */
const eventOf = (line: string): ThreadEvent => {
  const parsed = ((): ThreadEvent => {
    try {
      return JSON.parse(line) as ThreadEvent;
    } catch (cause) {
      throw new Error(`Failed to parse item: ${line}`, { cause });
    }
  })();
  return parsed.type === "turn.completed" ? { ...parsed, usage: { ...parsed.usage, cache_write_input_tokens: parsed.usage.cache_write_input_tokens ?? 0 } } : parsed;
};

/** One turn: the CLI started, its every stream listened to for errors, its prompt written, its lines read. */
async function* turnLines(
  executable: CodexExecutable,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  input: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  const child = spawn(executable.path, args, { env: codexEnv(env, executable.pathDirs), signal });
  const kept: { first: Error | null } = { first: null };
  const keep = (e: Error): void => {
    kept.first ??= e;
  };
  // Attached before the write and never removed (the header comment says why).
  child.on("error", keep);
  child.stdin.on("error", keep);
  child.stdout.on("error", keep);
  child.stderr.on("error", keep);
  const stderr: Buffer[] = [];
  const onStderr = (chunk: Buffer): void => void stderr.push(chunk);
  child.stderr.on("data", onStderr);
  const exited = new Promise<CliExit>((resolve) => {
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    // A child that never started has no close to wait for.
    child.once("error", () => {
      if (child.pid === undefined) resolve({ code: null, signal: null });
    });
  });
  child.stdin.write(input);
  child.stdin.end();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
    // The exit is awaited before the kept error is read, so a write error that arrives after the output ended still wins.
    const exit = kept.first === null ? await exited : { code: null, signal: null };
    const end = turnEnd(kept.first, exit, Buffer.concat(stderr).toString("utf8"));
    if (end?.kind === "kept") throw end.error;
    if (end?.kind === "exited") throw new Error(end.text);
  } finally {
    lines.close();
    child.stderr.off("data", onStderr);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** One Codex thread over the CLI. An unresolved executable fails each turn with its message. */
export const codexThread = (
  executable: Result.Result<CodexExecutable, string>,
  options: ThreadOptions,
  env: Readonly<Record<string, string | undefined>>,
): SdkThread => {
  let id: string | null = null;
  async function* events(input: string, turnOptions: TurnOptions): AsyncGenerator<ThreadEvent> {
    if (Result.isFailure(executable)) throw new Error(executable.failure);
    const schema = await schemaFile(turnOptions.outputSchema);
    try {
      const args = codexArgs({ options, threadId: id, outputSchemaFile: schema.path });
      for await (const line of turnLines(executable.success, args, env, input, turnOptions.signal)) {
        const event = eventOf(line);
        if (event.type === "thread.started") id = event.thread_id;
        yield event;
      }
    } finally {
      await schema.remove();
    }
  }
  return {
    get id() {
      return id;
    },
    runStreamed: async (input, turnOptions = {}) => ({ events: events(input, turnOptions) }),
  };
};
