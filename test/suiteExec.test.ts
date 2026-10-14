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
import { SUITE_CLOSE_GRACE_MS, suiteRunner } from "../src/suiteExec.ts";

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

// W2-R1-1: a descendant in a process group of its own survives the group's kill and holds the output open; the result
// must not wait for it. The command prints the descendant's pid, which the test kills itself so that it leaks nowhere.
const DETACHED = `node -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'});console.log('pid='+c.pid);c.unref()"`;
const withDetached = async (command: string, ceilingMs: number, check: (result: Awaited<ReturnType<typeof run>>, elapsed: number) => void): Promise<void> => {
  const uncaught: unknown[] = [];
  const listener = (e: unknown): void => void uncaught.push(e);
  process.on("uncaughtException", listener);
  let pid: number | null = null;
  try {
    const started = Date.now();
    const result = await run(command, ceilingMs);
    const elapsed = Date.now() - started;
    const found = /pid=(\d+)/u.exec(result.output);
    pid = found === null ? null : Number(found[1]);
    assert.ok(pid !== null, `the output names no detached pid: ${result.output}`);
    check(result, elapsed);
    await sleep(100);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", listener);
    if (pid !== null) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
};

test("the ceiling bounds a run whose detached descendant holds the output open", { timeout: 10_000 }, async () => {
  // A ceiling of 2 s, so that node has printed the pid on a loaded machine; the shell outlives it by far (20 s), and so
  // does the descendant (30 s), so a result under 5 s is the ceiling's.
  await withDetached(`${DETACHED}; sleep 20`, 2000, (result, elapsed) => {
    assert.deepEqual(result._tag === "Failed" ? result.reason : null, { kind: "timedOut", ms: 2000 });
    assert.ok(elapsed < 5000, `the result took ${elapsed} ms`);
  });
});

test("a shell that exits while a detached descendant holds the output passes within the grace", { timeout: 10_000 }, async () => {
  await withDetached(DETACHED, 60_000, (result, elapsed) => {
    assert.equal(result._tag, "Passed");
    assert.ok(elapsed < SUITE_CLOSE_GRACE_MS + 2000, `the result took ${elapsed} ms`);
  });
});

test("a shell that exits 3 while a detached descendant holds the output fails with 3 within the grace", { timeout: 10_000 }, async () => {
  await withDetached(`${DETACHED}; exit 3`, 60_000, (result, elapsed) => {
    assert.deepEqual(result._tag === "Failed" ? result.reason : null, { kind: "exit", code: 3 });
    assert.ok(elapsed < SUITE_CLOSE_GRACE_MS + 2000, `the result took ${elapsed} ms`);
  });
});
