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
    readOutputTail: (p) => fake.readOutputTail(p),
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

// Issue #233: a CLI that exits nonzero having printed nothing of its cause fails the turn with the cause Codex recorded,
// on its JSON stream or in its session file under $CODEX_HOME/sessions, and only what this invocation appended.
const TOO_MANY = "exceeded retry limit, last status: 429 Too Many Requests";
const PLAIN_EXIT = "Codex Exec exited with code 1: Reading prompt from stdin...";
const sessionLine = (payload: object): string => JSON.stringify({ timestamp: "2026-11-02T12:40:01.000Z", type: "event_msg", payload });
const STARTED = sessionLine({ type: "task_started" });
const REFUSED = sessionLine({ type: "task_complete", last_agent_message: null, error: { message: TOO_MANY, codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } } });
const COMPLETED = sessionLine({ type: "task_complete", last_agent_message: "{}" });

type CliTurn = Readonly<{ lines: readonly unknown[]; append?: Readonly<{ file: string; records: readonly string[] }>; exit: number }>;
/** A CLI whose first turn and resumed turn each print their lines, append their records to a session file and exit so. */
const sessionCli = (first: CliTurn, resumed: CliTurn = first): CodexExecutable =>
  executable(`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const turn = process.argv.includes("resume") ? ${JSON.stringify(resumed)} : ${JSON.stringify(first)};
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => {
  process.stderr.write("Reading prompt from stdin...\\n");
  for (const line of turn.lines) process.stdout.write(JSON.stringify(line) + "\\n");
  if (turn.append) {
    fs.mkdirSync(path.dirname(turn.append.file), { recursive: true });
    fs.appendFileSync(turn.append.file, turn.append.records.map((r) => r + "\\n").join(""));
  }
  process.exitCode = turn.exit;
});
`);
const codexHome = (): string => fs.mkdtempSync(path.join(DIR, "codex-home-"));
const rollout = (home: string, day: string, threadId: string): string => path.join(home, "sessions", ...day.split("/"), `rollout-${day.replaceAll("/", "-")}T12-39-55-${threadId}.jsonl`);
const failedWith = async (thread: ReturnType<typeof codexThread>): Promise<string> => {
  const error = await consume((await thread.runStreamed("p")).events).then(
    () => assert.fail("the turn succeeded"),
    (e: unknown) => e as Error,
  );
  return error.message;
};
const threadStarted = (id: string) => ({ type: "thread.started", thread_id: id });

test("a CLI that records a 429 in its session file and exits 1 fails the turn with the 429, and the reviewer with UsageLimited", async () => {
  const home = codexHome();
  const exe = sessionCli({ lines: [threadStarted("t-233")], append: { file: rollout(home, "2026/11/02", "t-233"), records: [STARTED, REFUSED] }, exit: 1 });
  const message = await failedWith(codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: home }));
  assert.ok(message.startsWith(TOO_MANY), message);
  assert.match(message, /exited with code 1/);

  const fake = new FakeSdk();
  const sdk: AgentSdk = {
    inheritedEnv: fake.inheritedEnv,
    readOutputTail: (p) => fake.readOutputTail(p),
    query: (p) => fake.query(p),
    stepReporter: (h) => fake.stepReporter(h),
    // A home of its own: the first thread's file is not this thread's, so the 429 read is the one this turn appends.
    startThread: (options) => {
      const own = codexHome();
      return codexThread(Result.succeed(sessionCli({ lines: [threadStarted("t-r")], append: { file: rollout(own, "2026/11/02", "t-r"), records: [STARTED, REFUSED] }, exit: 1 })), options ?? {}, { ...process.env, CODEX_HOME: own });
    },
  };
  const store = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig));
  const reviewer = await Effect.runPromise(makeCodexReviewer.pipe(Effect.provide(deps)));
  const session = await Effect.runPromise(reviewer.startPhase);
  const failure = await Effect.runPromise(Effect.flip(session.review("p", S.Review)));
  assert.equal((failure as { _tag: string })._tag, "UsageLimited");
  assert.equal((failure as { agent?: string }).agent, "codex");
});

test("a CLI that streams turn.failed and exits 1 fails the turn with that message", async () => {
  const exe = sessionCli({ lines: [threadStarted("t-2"), { type: "turn.failed", error: { message: "the model refused" } }], exit: 1 });
  const message = await failedWith(codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: codexHome() }));
  assert.ok(message.startsWith("the model refused ("), message);
});

test("a CLI that exits 1 recording nothing fails with the exit's text, as before", async () => {
  const exe = sessionCli({ lines: [threadStarted("t-3")], exit: 1 });
  assert.equal(await failedWith(codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: codexHome() })), `${PLAIN_EXIT}\n`);
});

test("a sessions tree that cannot be read, or holds no file for the thread, changes nothing and nothing is uncaught", async () => {
  const notADir = path.join(DIR, "codex-home-file");
  fs.writeFileSync(notADir, "x");
  const other = codexHome();
  fs.mkdirSync(path.join(other, "sessions", "2026", "11", "02"), { recursive: true });
  fs.writeFileSync(rollout(other, "2026/11/02", "someone-else"), `${STARTED}\n${REFUSED}\n`);
  for (const home of [notADir, other]) {
    const exe = sessionCli({ lines: [threadStarted("t-4")], exit: 1 });
    const uncaught = await uncaughtDuring(async () => {
      assert.equal(await failedWith(codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: home })), `${PLAIN_EXIT}\n`);
    });
    assert.deepEqual(uncaught, []);
  }
});

test("a resumed thread whose session file is in an old day directory: the 429 its second turn appends is found", async () => {
  const home = codexHome();
  const file = rollout(home, "2026/10/01", "t-233");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${STARTED}\n${COMPLETED}\n`);
  for (const day of ["2026/11/01", "2026/11/02", "2026/12/01"]) {
    fs.mkdirSync(path.join(home, "sessions", ...day.split("/")), { recursive: true });
    fs.writeFileSync(rollout(home, day, "another"), `${STARTED}\n`);
  }
  const exe = sessionCli({ lines: TURN.map((e) => (e.type === "thread.started" ? threadStarted("t-233") : e)), exit: 0 }, { lines: [], append: { file, records: [STARTED, REFUSED] }, exit: 1 });
  const thread = codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: home });
  await consume((await thread.runStreamed("first")).events);
  assert.equal(thread.id, "t-233");
  const message = await failedWith(thread);
  assert.ok(message.startsWith(TOO_MANY), message);
});

test("a session file that already ends with a 429 before a resumed turn that appends nothing: the plain exit text", async () => {
  const home = codexHome();
  const file = rollout(home, "2026/11/02", "t-6");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${STARTED}\n${REFUSED}\n`);
  const exe = sessionCli({ lines: TURN.map((e) => (e.type === "thread.started" ? threadStarted("t-6") : e)), exit: 0 }, { lines: [], exit: 1 });
  const thread = codexThread(Result.succeed(exe), OPTIONS, { ...process.env, CODEX_HOME: home });
  await consume((await thread.runStreamed("first")).events);
  assert.equal(await failedWith(thread), `${PLAIN_EXIT}\n`);
});
