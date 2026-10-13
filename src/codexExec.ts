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
import { fileURLToPath } from "node:url";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { Result } from "effect";
import { type CliExit, codexArgs, codexEnv, turnEnd } from "./codexArgs.ts";
import type { SdkThread } from "./sdk.ts";

/** The CLI's executable and the directories its package puts first on PATH. */
export type CodexExecutable = Readonly<{ path: string; pathDirs: readonly string[] }>;

const CODEX_PACKAGE = "@openai/codex";
/** The SDK's table of the platform packages, by target triple. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};
const TRIPLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  android: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
};

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** The SDK's own entry, from which it resolves `@openai/codex`, so both find the same binary. */
const sdkEntry = (): string => fileURLToPath(import.meta.resolve("@openai/codex-sdk"));

/**
 * The SDK's `findCodexPath`, reproduced: `@openai/codex` resolved from `anchor` (the SDK's entry, as the SDK resolves
 * it), then its platform package's binary, `vendor/<triple>/bin/codex` beside `codex-package.json`, or the legacy
 * `vendor/<triple>/codex/codex`, each with its directories for PATH.
 */
export const findCodexExecutable = (anchor: string = sdkEntry()): Result.Result<CodexExecutable, string> => {
  const triple = TRIPLES[process.platform]?.[process.arch];
  if (triple === undefined) return Result.fail(`Unsupported platform: ${process.platform} (${process.arch})`);
  const platformPackage = PLATFORM_PACKAGES[triple];
  const vendor = ((): string | null => {
    try {
      const codexJson = createRequire(anchor).resolve(`${CODEX_PACKAGE}/package.json`);
      return path.join(path.dirname(createRequire(codexJson).resolve(`${platformPackage}/package.json`)), "vendor");
    } catch {
      return null;
    }
  })();
  const missing = `Unable to locate Codex CLI binaries. Ensure ${CODEX_PACKAGE} is installed with optional dependencies.`;
  if (vendor === null) return Result.fail(missing);
  const root = path.join(vendor, triple);
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  const current = path.join(root, "bin", binary);
  if (isFile(current) && isFile(path.join(root, "codex-package.json"))) {
    return Result.succeed({ path: current, pathDirs: [path.join(root, "codex-path")].filter(isDirectory) });
  }
  const legacy = path.join(root, "codex", binary);
  if (isFile(legacy)) return Result.succeed({ path: legacy, pathDirs: [path.join(root, "path")].filter(isDirectory) });
  return Result.fail(`Unable to locate Codex CLI binaries for ${triple}. Ensure ${CODEX_PACKAGE} is installed with optional dependencies.`);
};

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
