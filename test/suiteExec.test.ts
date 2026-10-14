// Issue #162: the whole suite run by Interloq, tested against real child processes, as src/codexExec.ts is: a stream's
// asynchronous 'error' event and a process group left behind are what a fake cannot reproduce.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { Effect, Fiber, Result } from "effect";
import { type CommandLine, commandLineOf } from "../src/schema.ts";
import { suiteRunner } from "../src/suiteExec.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "suite-exec-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const line = (text: string): CommandLine => Result.getOrThrow(commandLineOf(text));
const run = (command: string, ceilingMs = 10_000, env: Record<string, string | undefined> = process.env) => Effect.runPromise(suiteRunner(env, ceilingMs).run(line(command), DIR));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(50);
  return !alive(pid);
};

test("a command that exits 0 passes with its output", async () => {
  const result = await run("echo hello");
  assert.equal(result._tag, "Passed");
  assert.equal(result.output, "hello\n");
  assert.ok(result.ms >= 0);
});

test("a command that exits 3 fails with its exit code, and both streams are kept", async () => {
  const result = await run("echo out; echo err >&2; exit 3");
  assert.equal(result._tag, "Failed");
  assert.deepEqual(result._tag === "Failed" ? result.reason : null, { kind: "exit", code: 3 });
  assert.match(result.output, /out\n/u);
  assert.match(result.output, /err\n/u);
});

test("a command past the ceiling is killed with its process group and fails as timed out", async () => {
  const pidFile = path.join(DIR, "timed.pid");
  const result = await run(`sleep 30 & echo $! > ${pidFile}; wait`, 300);
  assert.equal(result._tag, "Failed");
  assert.deepEqual(result._tag === "Failed" ? result.reason : null, { kind: "timedOut", ms: 300 });
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(await waitGone(pid), "the background sleep of the suite was left running");
});

test("an interrupted run kills its process group, and nothing is uncaught", async () => {
  const uncaught: unknown[] = [];
  const listener = (e: unknown): void => void uncaught.push(e);
  process.on("uncaughtException", listener);
  try {
    const pidFile = path.join(DIR, "interrupted.pid");
    const fiber = Effect.runFork(suiteRunner(process.env, 10_000).run(line(`sleep 30 & echo $! > ${pidFile}; wait`), DIR));
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(20);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(await waitGone(pid), "the suite's process was left running");
    await sleep(100);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", listener);
  }
});

test("the command runs in the given directory with the given environment", async () => {
  const result = await run("pwd; echo $SUITE_PROBE", 10_000, { ...process.env, SUITE_PROBE: "probe-value" });
  assert.equal(result._tag, "Passed");
  assert.equal(result.output, `${fs.realpathSync(DIR)}\nprobe-value\n`);
});

test("a directory that does not exist fails as not started", async () => {
  const result = await Effect.runPromise(suiteRunner(process.env, 1000).run(line("true"), path.join(DIR, "missing")));
  assert.equal(result._tag, "Failed");
  assert.equal(result._tag === "Failed" ? result.reason.kind : null, "notStarted");
});
