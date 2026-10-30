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
const run = (command: string, ceilingMs = 10_000, env: Record<string, string | undefined> = process.env) => Effect.runPromise(suiteRunner(env).run(line(command), DIR, ceilingMs, () => undefined));
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

/** Runs `body`, then asserts that nothing became an uncaught exception during it or in the 100 ms after it. */
const noneUncaught = async (body: () => Promise<void>): Promise<void> => {
  const uncaught: unknown[] = [];
  const listener = (e: unknown): void => void uncaught.push(e);
  process.on("uncaughtException", listener);
  try {
    await body();
    await sleep(100);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", listener);
  }
};
const killQuietly = (pid: number | null): void => {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
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
  // The ceiling is 2 s so that the shell has written its pid file on a loaded machine; the suite run of 18 Oct 2026 missed it at 300 ms.
  const ceilingMs = 2000;
  const result = await run(`sleep 30 & echo $! > ${pidFile}; wait`, ceilingMs);
  assert.equal(result._tag, "Failed");
  assert.deepEqual(result._tag === "Failed" ? result.reason : null, { kind: "timedOut", ms: ceilingMs });
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(await waitGone(pid), "the background sleep of the suite was left running");
});

test("an interrupted run kills its process group, and nothing is uncaught", async () => {
  await noneUncaught(async () => {
    const pidFile = path.join(DIR, "interrupted.pid");
    const fiber = Effect.runFork(suiteRunner(process.env).run(line(`sleep 30 & echo $! > ${pidFile}; wait`), DIR, 10_000, () => undefined));
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(20);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(await waitGone(pid), "the suite's process was left running");
  });
});

test("the command runs in the given directory with the given environment", async () => {
  const result = await run("pwd; echo $SUITE_PROBE", 10_000, { ...process.env, SUITE_PROBE: "probe-value" });
  assert.equal(result._tag, "Passed");
  assert.equal(result.output, `${fs.realpathSync(DIR)}\nprobe-value\n`);
});

test("a directory that does not exist fails as not started", async () => {
  const result = await Effect.runPromise(suiteRunner(process.env).run(line("true"), path.join(DIR, "missing"), 1000, () => undefined));
  assert.equal(result._tag, "Failed");
  assert.equal(result._tag === "Failed" ? result.reason.kind : null, "notStarted");
});

// W2-R1-1: a descendant in a process group of its own survives the group's kill and holds the output open; the result
// must not wait for it. The command prints the descendant's pid, which the test kills itself so that it leaks nowhere.
const DETACHED = `node -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'});console.log('pid='+c.pid);c.unref()"`;
const withDetached = async (command: string, ceilingMs: number, check: (result: Awaited<ReturnType<typeof run>>, elapsed: number) => void): Promise<void> => {
  let pid: number | null = null;
  try {
    await noneUncaught(async () => {
      const started = Date.now();
      const result = await run(command, ceilingMs);
      const elapsed = Date.now() - started;
      const found = /pid=(\d+)/u.exec(result.output);
      pid = found === null ? null : Number(found[1]);
      assert.ok(pid !== null, `the output names no detached pid: ${result.output}`);
      check(result, elapsed);
    });
  } finally {
    killQuietly(pid);
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

// W3-R1-2: Stop task during the suite stops reading its output, even when a detached descendant holds it. The writer
// writes every 50 ms into the inherited output; once the runner destroys its read ends, the next write fails with EPIPE,
// uncaught in the writer, and the writer exits. While the output is still read, it lives on.
test("an interrupted run stops reading an output a detached descendant holds, and nothing is uncaught", { timeout: 10_000 }, async () => {
  const pidFile = path.join(DIR, "writer.pid");
  const writer = path.join(DIR, "writer.js");
  fs.writeFileSync(writer, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => process.stdout.write("x"), 50);`);
  const command = `node -e "require('child_process').spawn(process.execPath,[${JSON.stringify(writer).replaceAll('"', "'")}],{detached:true,stdio:'inherit'}).unref()"; sleep 20`;
  let pid: number | null = null;
  try {
    await noneUncaught(async () => {
      const fiber = Effect.runFork(suiteRunner(process.env).run(line(command), DIR, 10_000, () => undefined));
      for (let i = 0; i < 150 && !fs.existsSync(pidFile); i++) await sleep(20);
      const writerPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      pid = writerPid;
      await sleep(200);
      await Effect.runPromise(Fiber.interrupt(fiber));
      assert.ok(await waitGone(writerPid), "the detached writer is still alive: its output is still read");
    });
  } finally {
    killQuietly(pid);
  }
});

// W2-R1-2: spawn throws synchronously on a NUL character; the edge stays total and reports the run as not started.
test("a command spawn refuses synchronously fails as not started, and nothing is uncaught", async () => {
  await noneUncaught(async () => {
    // The cast bypasses commandLineOf on purpose, to reach the edge with a value the constructor refuses.
    const result = await Effect.runPromise(suiteRunner(process.env).run("echo ok\u0000" as CommandLine, DIR, 1000, () => undefined));
    assert.equal(result._tag, "Failed");
    assert.equal(result._tag === "Failed" ? result.reason.kind : null, "notStarted");
  });
});

test("issue #49: onOutput receives every chunk of both streams in order, together the result's output, and nothing after an interruption", async () => {
  const chunks: string[] = [];
  const result = await Effect.runPromise(suiteRunner(process.env).run(line("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three"), DIR, 10_000, (t) => void chunks.push(t)));
  assert.ok(chunks.length >= 3, `chunks: ${JSON.stringify(chunks)}`);
  assert.equal(chunks.join(""), result.output);
  assert.equal(result.output, "one\ntwo\nthree\n");
  const late: string[] = [];
  const fiber = Effect.runFork(suiteRunner(process.env).run(line("echo first; sleep 0.5; echo after"), DIR, 10_000, (t) => void late.push(t)));
  for (let i = 0; i < 100 && late.length === 0; i++) await sleep(10);
  await Effect.runPromise(Fiber.interrupt(fiber));
  await sleep(800);
  assert.deepEqual(late, ["first\n"]);
});
