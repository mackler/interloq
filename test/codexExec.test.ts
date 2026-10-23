import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { Effect, Layer, Result } from "effect";
import { makeCodexReviewer } from "../src/codex.ts";
import { type CodexExecutable, codexThread, findCodexExecutable } from "../src/codexExec.ts";
import type { RunError } from "../src/errors.ts";
import { platformLayer } from "../src/platform.ts";
import * as S from "../src/schema.ts";
import type { AgentSdk } from "../src/sdk.ts";
import { RunConfig, Sdk, Store, Ui } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { FakeSdk } from "./fakeSdk.ts";
import { ScriptedUi, tempRepo, TEST_ROOT } from "./helpers.ts";

// Issue #158: the Codex CLI started by Interloq, tested against real child processes, because the defect is an
// asynchronous 'error' event on the CLI's stdin, which a fake SDK's rejected promise does not reproduce.

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exec-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

let scripts = 0;
/** An executable script in the temporary directory. */
const executable = (body: string): CodexExecutable => {
  const file = path.join(DIR, `codex-${++scripts}`);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return { path: file, pathDirs: [] };
};

/** More than a pipe's buffer, so the write is still pending when the child dies. */
const BIG = "x".repeat(2 * 1024 * 1024);
const OPTIONS: ThreadOptions = { workingDirectory: DIR, sandboxMode: "danger-full-access", approvalPolicy: "never" };

const consume = async (events: AsyncGenerator<ThreadEvent>): Promise<ThreadEvent[]> => {
  const seen: ThreadEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

/** Records every uncaught exception while `body` runs, and for `settle` milliseconds after it. */
const uncaughtDuring = async (body: () => Promise<void>, settle = 200): Promise<unknown[]> => {
  const caught: unknown[] = [];
  const spy = (e: unknown): void => void caught.push(e);
  process.on("uncaughtException", spy);
  try {
    await body();
    await sleep(settle);
  } finally {
    process.off("uncaughtException", spy);
  }
  return caught;
};

const EXITS_AT_ONCE = "#!/bin/sh\nexit 3\n";

test("the defect: a CLI that exits before reading its input fails the turn with EPIPE, and nothing is uncaught", async () => {
  const thread = codexThread(Result.succeed(executable(EXITS_AT_ONCE)), OPTIONS, process.env);
  const uncaught = await uncaughtDuring(async () => {
    const { events } = await thread.runStreamed(BIG);
    await assert.rejects(consume(events), (e: unknown) => (e as { code?: unknown }).code === "EPIPE");
  });
  assert.deepEqual(uncaught, []);
});

test("the seam with the classifier: the reviewer fails such a turn with TransportFault, not CodexCallFailed", async () => {
  const exe = executable(EXITS_AT_ONCE);
  const fake = new FakeSdk();
  const sdk: AgentSdk = {
    inheritedEnv: fake.inheritedEnv,
    query: (p) => fake.query(p),
    stepReporter: (h) => fake.stepReporter(h),
    startThread: (options) => codexThread(Result.succeed(exe), options ?? {}, process.env),
  };
  const store = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig));
  const reviewer = await Effect.runPromise(makeCodexReviewer.pipe(Effect.provide(deps)));
  const session = await Effect.runPromise(reviewer.startPhase);
  const failure = await Effect.runPromise(Effect.flip(session.review(BIG, S.Review)));
  assert.equal((failure as RunError | { _tag: string })._tag, "TransportFault");
  assert.equal((failure as { agent?: string }).agent, "codex");
});

/** A CLI that reads its input, records its arguments, and prints `lines`. */
const printing = (lines: readonly unknown[], record: string, exit = 0, stderr = ""): CodexExecutable =>
  executable(`#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, schemaExists: (() => { const i = process.argv.indexOf("--output-schema"); return i < 0 ? null : fs.readFileSync(process.argv[i + 1], "utf8"); })() }));
  for (const line of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) process.stdout.write(line + "\\n");
  process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = ${exit};
});
`);

const TURN = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "item.completed", item: { id: "m", type: "agent_message", text: "{}" } },
  { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } },
];

test("a successful turn: the events in order, the thread's id, the usage's default, the schema file passed and removed", async () => {
  const record = path.join(DIR, "ok.json");
  const thread = codexThread(Result.succeed(printing(TURN, record)), OPTIONS, process.env);
  assert.equal(thread.id, null);
  const seen = await consume((await thread.runStreamed("the prompt", { outputSchema: { type: "object" } })).events);
  assert.deepEqual(seen.map((e) => e.type), ["thread.started", "item.completed", "turn.completed"]);
  assert.equal(thread.id, "th-1");
  assert.equal((seen[2] as { usage: { cache_write_input_tokens: number } }).usage.cache_write_input_tokens, 0);
  const recorded = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.equal(recorded.input, "the prompt");
  assert.equal(recorded.schemaExists, JSON.stringify({ type: "object" }));
  const schema = recorded.argv[recorded.argv.indexOf("--output-schema") + 1];
  assert.equal(fs.existsSync(schema), false);

  await consume((await thread.runStreamed("again")).events);
  const resumed = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(resumed.argv.slice(-2), ["resume", "th-1"]);
});

test("a nonzero exit with no write error rejects with the SDK's text, and the schema file is removed", async () => {
  const record = path.join(DIR, "exit.json");
  const thread = codexThread(Result.succeed(printing([], record, 7, "the model refused")), OPTIONS, process.env);
  await assert.rejects(consume((await thread.runStreamed("p", { outputSchema: { type: "object" } })).events), (e: unknown) => (e as Error).message === "Codex Exec exited with code 7: the model refused");
  const recorded = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.equal(fs.existsSync(recorded.argv[recorded.argv.indexOf("--output-schema") + 1]), false);
});

test("a missing executable rejects with ENOENT, and an unresolved one with its message; nothing is uncaught", async () => {
  const uncaught = await uncaughtDuring(async () => {
    const missing = codexThread(Result.succeed({ path: path.join(DIR, "absent"), pathDirs: [] }), OPTIONS, process.env);
    await assert.rejects(consume((await missing.runStreamed(BIG)).events), (e: unknown) => (e as { code?: unknown }).code === "ENOENT");
  });
  assert.deepEqual(uncaught, []);
  const unresolved = codexThread(Result.fail("no Codex CLI"), OPTIONS, process.env);
  await assert.rejects(async () => consume((await unresolved.runStreamed("p")).events), /no Codex CLI/);
});

/** A CLI that prints its pid's first event and sleeps without reading its input. */
const sleeping = (pidFile: string): CodexExecutable =>
  executable(`#!/bin/sh\necho $$ > ${pidFile}\necho '{"type":"thread.started","thread_id":"th-s"}'\nexec sleep 30\n`);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pidFile: string): Promise<void> => {
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  for (let i = 0; i < 200 && alive(pid); i++) await sleep(20);
  assert.equal(alive(pid), false, "the child must be killed");
};

test("cancellation with a pending write: the abort signal kills the child and nothing is uncaught", async () => {
  const pidFile = path.join(DIR, "abort.pid");
  const controller = new AbortController();
  const thread = codexThread(Result.succeed(sleeping(pidFile)), OPTIONS, process.env);
  const uncaught = await uncaughtDuring(async () => {
    const { events } = await thread.runStreamed(BIG, { signal: controller.signal });
    assert.equal((await events.next()).done, false);
    const pending = events.next();
    controller.abort();
    await assert.rejects(pending);
    await gone(pidFile);
  });
  assert.deepEqual(uncaught, []);
});

test("cancellation with a pending write: the stream's return kills the child and nothing is uncaught", async () => {
  const pidFile = path.join(DIR, "return.pid");
  const thread = codexThread(Result.succeed(sleeping(pidFile)), OPTIONS, process.env);
  const uncaught = await uncaughtDuring(async () => {
    const { events } = await thread.runStreamed(BIG);
    assert.equal((await events.next()).done, false);
    await events.return(undefined);
    await gone(pidFile);
  });
  assert.deepEqual(uncaught, []);
});

test("findCodexExecutable: on this machine the platform package's binary under node_modules/@openai/", () => {
  const found = findCodexExecutable();
  assert.ok(Result.isSuccess(found), Result.isFailure(found) ? found.failure : "");
  if (Result.isSuccess(found)) {
    assert.ok(fs.statSync(found.success.path).isFile());
    assert.ok(found.success.path.includes(`${path.sep}node_modules${path.sep}@openai${path.sep}`), found.success.path);
  }
});

test("findCodexExecutable: from a directory without the package, a failure naming @openai/codex", () => {
  const found = findCodexExecutable(path.join(DIR, "anchor.js"));
  assert.ok(Result.isFailure(found));
  if (Result.isFailure(found)) assert.match(found.failure, /@openai\/codex/);
});
