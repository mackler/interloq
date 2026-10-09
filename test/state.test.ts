import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Clock, Effect, Exit, Layer, Option, Result, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import type { StoreShape } from "../src/services.ts";
import { compareSnapshots, type Snapshot } from "../src/snapshot.ts";
import * as S from "../src/schema.ts";
import type { IssueId } from "../src/schema.ts";
import { decodeRecord, parseJson } from "../src/state.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { renderUsage, summarizeUsage } from "../src/usage.ts";
import { faultyPlatform, tempRepo, questionOf, entryOf , TEST_ROOT } from "./helpers.ts";

/** The store of a repository, built on the live platform services. */
const store = (repo: string, ignorePaths: readonly string[] = []): Promise<StoreShape> => Effect.runPromise(makeStore(repo, TEST_ROOT, ignorePaths).pipe(Effect.provide(platformLayer)));

/** A store on a temporary repository with the records initialised. */
const initialised = async (): Promise<StoreShape> => {
  const s = await store(tempRepo());
  await Effect.runPromise(s.init("task"));
  return s;
};

const fails = async (effect: Effect.Effect<unknown, RunError>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
};

test("an unreadable issue log fails with StateFileInvalid naming the file", async () => {
  const s = await initialised();
  fs.writeFileSync(path.join(s.dir, "issue-log.json"), "{");
  await fails(s.loadLog({ plan: 1 }), "StateFileInvalid", /issue-log\.json/);
});

test("git failure in the snapshot fails with GitError", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pr-nogit-"));
  const s = await store(outside);
  await fails(s.projectSnapshot(), "GitError", /git --no-optional-locks status/);
});

test("an unwritable plan-review directory fails with FileSystemError", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const s = await initialised();
  fs.chmodSync(s.dir, 0o500);
  try {
    await fails(s.writeRequirements("x"), "FileSystemError", /requirements\.md/);
  } finally {
    fs.chmodSync(s.dir, 0o700);
  }
});

test("an issue log entry with an unknown action source fails with StateFileInvalid", async () => {
  const s = await initialised();
  const entry = { id: "A", phase: 1, round: 1, source: "robot", problem: "p", action: "accepted", rationale: "r" };
  fs.writeFileSync(path.join(s.dir, "issue-log.json"), JSON.stringify({ version: 2, entries: [entry] }));
  await fails(s.loadLog({ plan: 1 }), "StateFileInvalid", /issue-log\.json/, /entries\[0\]/);
});

test("questions.json without questions fails with StateFileInvalid", async () => {
  const s = await initialised();
  fs.writeFileSync(s.questions, JSON.stringify({ task: "t" }));
  await fails(s.loadQuestions(), "StateFileInvalid", /questions\.json/, /questions/);
});

test("loadQuestions returns the agreed list", async () => {
  const s = await initialised();
  const question = entryOf({ id: "Q1", context: "c", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "A" });
  fs.writeFileSync(s.questions, JSON.stringify({ version: 2, task: "t", questions: [question] }));
  assert.deepEqual((await Effect.runPromise(s.loadQuestions())).questions, [question]);
});

test("a usage.jsonl line that is not an object fails with StateFileInvalid", async () => {
  const s = await initialised();
  fs.writeFileSync(path.join(s.dir, "usage.jsonl"), '{"time":"t","agent":"claude","total_cost_usd":1}\n42\n');
  await fails(s.usageLines(), "StateFileInvalid", /usage\.jsonl/);
});

// Issue #120: every run has its own records directory, so init moves nothing; plan-review/config.json stays where it is.
test("init archives nothing and leaves plan-review/config.json alone; the records are written", async () => {
  const s = await initialised();
  const config = path.join(path.dirname(path.dirname(s.dir)), "config.json");
  fs.writeFileSync(config, "{}");
  await Effect.runPromise(s.init("second"));
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(s.dir))).filter((n) => n.startsWith("archive-")), []);
  assert.deepEqual(fs.readdirSync(s.dir).filter((n) => n.startsWith("archive-")), []);
  assert.equal(fs.readFileSync(config, "utf8"), "{}");
  assert.match(fs.readFileSync(path.join(s.dir, "conversation.md"), "utf8"), /Task: second/);
  assert.deepEqual(await Effect.runPromise(s.loadLog({ plan: 1 })), []);
});

// Issue #68: a wait for a usage limit is a line of usage.jsonl, read back apart from the calls' usage.
test("recordLimitWait appends a usage_limit_wait line, and usageLines returns it under waits and the calls under calls", async () => {
  const s = await initialised();
  const from = Date.UTC(2026, 9, 7, 5, 32);
  const wait = { agent: "claude" as const, limitType: "five_hour", fromMs: from, untilMs: from + 9_000_000, endedMs: from + 60_000, outcome: "interrupted" as const };
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 1.5 }));
  await Effect.runPromise(s.recordLimitWait(wait));
  const lines = fs.readFileSync(path.join(s.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  const { time, ...line } = lines[1] ?? {};
  assert.equal(typeof time, "string");
  assert.deepEqual(line, { version: 2, kind: "usage_limit_wait", agent: "claude", limit_type: "five_hour", from: new Date(from).toISOString(), until: new Date(from + 9_000_000).toISOString(), ended: new Date(from + 60_000).toISOString(), outcome: "interrupted" });
  const read = await Effect.runPromise(s.usageLines());
  assert.deepEqual(read.waits, [wait]);
  assert.deepEqual(read.calls, [{ agent: "claude", session: "s", turns: 1, totalCostUsd: 1.5 }]);
});

test("the records: decisions, feedback, usage and the invalid-reply files", async () => {
  const s = await initialised();
  await Effect.runPromise(s.appendDecision({ subject: "issue A", id: null, decision: "keep it", phase: 1, round: 1 }));
  await Effect.runPromise(s.recordFeedback({ plan: 1 }, 2, "too strict"));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 1.5 }));
  await Effect.runPromise(s.recordUsage({ agent: "codex", thread: "t", inputTokens: 10, outputTokens: 5 }));
  assert.match(fs.readFileSync(path.join(s.dir, "user-decisions.md"), "utf8"), /Subject: issue A\nDecision: keep it/);
  assert.match(fs.readFileSync(path.join(s.dir, "conversation.md"), "utf8"), /\*\*User decision\*\* on issue A: keep it/);
  assert.match(fs.readFileSync(path.join(s.dir, "reviewer-feedback.md"), "utf8"), /## Planning phase 1, round 2\ntoo strict/);
  assert.match(renderUsage(summarizeUsage(await Effect.runPromise(s.usageLines()))), /Claude Code: 1 calls in 1 sessions, total_cost_usd = 1\.50 .* Codex: 1 turns, 10 input tokens, 5 output tokens/);
  assert.equal(await Effect.runPromise(s.saveInvalidReply("codex", "x")), path.join("plan-review", TEST_ROOT, "invalid-replies", "codex-1.json"));
  assert.equal(await Effect.runPromise(s.saveInvalidReply("codex", "y")), path.join("plan-review", TEST_ROOT, "invalid-replies", "codex-2.json"));
  assert.equal(fs.readFileSync(path.join(s.dir, "invalid-replies", "codex-2.json"), "utf8"), "y");
});

test("fileHash by subject; the save operations create their directories", async () => {
  const s = await initialised();
  // Issue #6 (F1): the plan subject's reviewed file is plan.json.
  fs.writeFileSync(path.join(s.dir, "plan.json"), "v1");
  assert.equal(await Effect.runPromise(s.fileHash("requirements")), "", "an absent reviewed file hashes to the empty string");
  assert.notEqual(await Effect.runPromise(s.fileHash({ plan: 1 })), "");
  await Effect.runPromise(s.saveReview({ plan: 2 }, 1, { issues: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, "planning-2", "review-1.json"), "utf8")), { issues: [] });
  await Effect.runPromise(s.saveExecution(3, { status: "finished", summary: "s", question: "", remainingWork: "", userInput: null }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "execution-3", "result.json"), "utf8")).status, "finished");
  await Effect.runPromise(s.savePlanWrite(4, { questions_for_user: [questionOf({ context: "c", question: "q?", terms: [], options: [] })] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, "planning-4", "cc-0.json"), "utf8")), { questions_for_user: [questionOf({ context: "c", question: "q?", terms: [], options: [] })] });
  await Effect.runPromise(s.writeRequirements("# R\n"));
  assert.equal(fs.readFileSync(s.requirements, "utf8"), "# R\n");
});

const git = (repo: string, ...args: string[]): void => void execFileSync("git", ["-C", repo, ...args]);
const kinds = (changes: readonly { kind: string; path: string }[]): string[] => changes.map((c) => `${c.kind} ${c.path}`);
/** Two snapshots of one repository around `change`, compared. */
const around = async (repo: string, ignorePaths: readonly string[], change: () => void): Promise<{ before: Snapshot; after: Snapshot; changes: string[] }> => {
  const s = await store(repo, ignorePaths);
  const before = await Effect.runPromise(s.projectSnapshot());
  change();
  const after = await Effect.runPromise(s.projectSnapshot());
  return { before, after, changes: kinds(compareSnapshots(before, after)) };
};

test("the snapshot lists the changed and untracked paths with their records and content, and ignores plan-review/ and the ignored paths", async () => {
  const repo = tempRepo();
  const s = await store(repo, ["ignored.txt"]);
  await Effect.runPromise(s.init("task"));
  fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "i\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual([...snapshot.entries.keys()].sort(), ["a.txt", "new.txt"]);
  const a = snapshot.entries.get("a.txt")!;
  assert.equal(a.record.kind, "changed");
  assert.equal(a.record.kind === "changed" && a.record.xy, ".M");
  assert.equal(a.content.type, "file");
  assert.equal(snapshot.entries.get("new.txt")!.record.kind, "untracked");
});

// Decision Q1: the cases the stage-1 snapshot could not see (finding 1).
test("editing an untracked file changes the snapshot", async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "new.txt"), "1\n");
  const { changes } = await around(repo, [], () => fs.writeFileSync(path.join(repo, "new.txt"), "2\n"));
  assert.deepEqual(changes, ["content_changed new.txt"]);
});

test("replacing one staged version by another changes the snapshot", async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "s.txt"), "1\n");
  git(repo, "add", "s.txt");
  const { changes } = await around(repo, [], () => {
    fs.writeFileSync(path.join(repo, "s.txt"), "2\n");
    git(repo, "add", "s.txt");
  });
  assert.deepEqual(changes, ["content_changed s.txt"]);
});

test("a rename is reported; a new empty directory is not (git does not list it)", async () => {
  const repo = tempRepo();
  const renamed = await around(repo, [], () => git(repo, "mv", "a.txt", "b.txt"));
  assert.ok(renamed.changes.some((c) => c.endsWith(" b.txt")), renamed.changes.join(", "));
  const empty = await around(tempRepo(), [], () => fs.mkdirSync(path.join(repo, "emptydir")));
  assert.deepEqual(empty.changes, []);
});

test("a symlink is the link itself: retargeting between identical files is a content change, a dangling link is listed, and a file replacing a link is a type change", async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "t1.txt"), "same\n");
  fs.writeFileSync(path.join(repo, "t2.txt"), "same\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "targets");
  fs.symlinkSync("t1.txt", path.join(repo, "l"));
  const retargeted = await around(repo, [], () => {
    fs.rmSync(path.join(repo, "l"));
    fs.symlinkSync("t2.txt", path.join(repo, "l"));
  });
  assert.deepEqual(retargeted.changes, ["content_changed l"]);

  fs.symlinkSync("nowhere.txt", path.join(repo, "dangling"));
  const s = await store(repo, []);
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual(snapshot.entries.get("dangling")?.content, { type: "link", target: "nowhere.txt" });

  const replaced = await around(repo, [], () => {
    fs.rmSync(path.join(repo, "l"));
    fs.writeFileSync(path.join(repo, "l"), "same\n");
  });
  assert.deepEqual(replaced.changes, ["type_changed l"]);
});

test("a symlink to target.txt and a regular file whose bytes are link:target.txt are different entries, in both directions", async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "target.txt"), "t\n");
  fs.symlinkSync("target.txt", path.join(repo, "l"));
  const toFile = await around(repo, [], () => {
    fs.rmSync(path.join(repo, "l"));
    fs.writeFileSync(path.join(repo, "l"), "link:target.txt");
  });
  assert.deepEqual(toFile.changes, ["type_changed l"]);
  const toLink = await around(repo, [], () => {
    fs.rmSync(path.join(repo, "l"));
    fs.symlinkSync("target.txt", path.join(repo, "l"));
  });
  assert.deepEqual(toLink.changes, ["type_changed l"]);
});

// The command service seen by the store: a fake spawner that records the arguments and answers
// with fixed output, so the test shows which git commands the snapshot runs.
type Spawn = Parameters<typeof ChildProcessSpawner.make>[0];
const recordingSpawner = (answer: (args: readonly string[]) => string): { layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>; commands: string[][] } => {
  const commands: string[][] = [];
  const spawn: Spawn = (command) => {
    if (command._tag !== "StandardCommand") throw new Error("piped commands are not expected");
    const args = [command.command, ...command.args];
    commands.push(args);
    const stdout = Stream.make(new TextEncoder().encode(answer(command.args)));
    const handle = {
      pid: 1,
      exitCode: Effect.succeed(0),
      isRunning: Effect.succeed(false),
      kill: () => Effect.succeed(undefined),
      stdout,
      stderr: Stream.empty,
      all: stdout,
    } as unknown as ChildProcessSpawner.ChildProcessHandle;
    return Effect.succeed(handle);
  };
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)), commands };
};

/** Porcelain v2 -z as git writes it, for the recording spawner. */
const v2 = (entries: { xy?: string; name: string }[]): string =>
  entries.map((e) => (e.xy === undefined ? `? ${e.name}\0` : `1 ${e.xy} N... 100644 100644 100644 ${"1".repeat(40)} ${"1".repeat(40)} ${e.name}\0`)).join("");

test("the snapshot decodes git's porcelain v2 records and reads the working tree of each listed path", async () => {
  const repo = tempRepo();
  const { layer, commands } = recordingSpawner(() => v2([{ xy: ".M", name: "a.txt" }, { xy: ".M", name: "ignored.txt" }, { name: "plan-review/plan.md" }, { name: "gone.txt" }]));
  const platform = Layer.mergeAll(platformLayer, layer);
  const s = await Effect.runPromise(makeStore(repo, TEST_ROOT, ["ignored.txt"]).pipe(Effect.provide(platform)));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual([...snapshot.entries.keys()].sort(), ["a.txt", "gone.txt"]);
  assert.deepEqual(snapshot.entries.get("a.txt")?.content, { type: "file", hash: createHash("sha256").update(fs.readFileSync(path.join(repo, "a.txt"))).digest("hex") });
  assert.deepEqual(snapshot.entries.get("gone.txt")?.content, { type: "missing" });
  assert.equal(commands.length, 1, JSON.stringify(commands));
  assert.deepEqual(commands[0].slice(0, 3), ["git", "-C", repo]);
  assert.ok(commands[0].includes("--porcelain=v2") && commands[0].includes("-z") && commands[0].includes("--untracked-files=all"), commands[0].join(" "));
});

test("usageSummary reports the running total of each Claude Code session, not the sum of the calls", async () => {
  // The Agent SDK's total_cost_usd is cumulative for a session, and a resumed session continues from
  // its saved total, so every call of one session reports the total so far (observed in the run of 25 Sep 2026).
  const s = await initialised();
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s-1", turns: 6, totalCostUsd: 0.5 }));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s-1", turns: 4, totalCostUsd: 1.25 }));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s-2", turns: 2, totalCostUsd: 0.25 }));
  assert.match(renderUsage(summarizeUsage(await Effect.runPromise(s.usageLines()))), /Claude Code: 3 calls in 2 sessions, total_cost_usd = 1\.50 \(the sessions' last reported running totals, an estimate by the client\)/);
});

// Finding 22 of docs/functional-design-review.md: the time was read and the JSON serialized when the
// effect was built, not when it ran; a serialization failure was a defect.
test("recordUsage reads the time when it runs, and the store owns the time", async () => {
  const s = await initialised();
  const once = s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 1 });
  await Effect.runPromise(once);
  await new Promise((resolve) => setTimeout(resolve, 3));
  await Effect.runPromise(once);
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 2, time: "1999" } as unknown as Parameters<typeof s.recordUsage>[0]));
  const lines = fs.readFileSync(path.join(s.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.notEqual(lines[0].time, lines[1].time, "one effect run twice recorded the same time");
  assert.notEqual(lines[2].time, "1999", "the entry's own time overrode the store's");
});

test("a record value that cannot be serialized fails with FileSystemError (serialize), not a defect", async () => {
  const s = await initialised();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await fails(s.saveExecution(1, cyclic as unknown as Parameters<typeof s.saveExecution>[1]), "FileSystemError", /serialize/, /result\.json/);
});

// Finding 2 of docs/functional-design-review.md: plan-review/ and ignorePaths under one exclusion predicate,
// and git's raw names (never quoted) matched and used as they are.
test("plan-review/ is excluded from the snapshot", async () => {
  const repo = tempRepo();
  const { layer } = recordingSpawner(() => v2([{ xy: ".M", name: "a.txt" }, { name: "plan-review/plan.md" }]));
  const s = await Effect.runPromise(makeStore(repo, TEST_ROOT, []).pipe(Effect.provide(Layer.mergeAll(platformLayer, layer))));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual([...snapshot.entries.keys()], ["a.txt"]);
});

test("names with tabs and quotes are the real names: matched against ignorePaths and kept as they are", async () => {
  const repo = tempRepo();
  const { layer } = recordingSpawner(() => v2([{ name: "tab\there.txt" }, { xy: ".M", name: 'q"uote.txt' }]));
  const s = await Effect.runPromise(makeStore(repo, TEST_ROOT, ["tab\there.txt"]).pipe(Effect.provide(Layer.mergeAll(platformLayer, layer))));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual([...snapshot.entries.keys()], ['q"uote.txt']);
});

// Finding 10: the decoders of the program's own records return a Result instead of throwing.
test("parseJson and decodeRecord return a Result whose failure is StateFileInvalid naming the file", () => {
  const bad = parseJson("f.json", "{nope");
  assert.ok(Result.isFailure(bad));
  assert.equal(bad.failure._tag, "StateFileInvalid");
  assert.equal(bad.failure.file, "f.json");
  const good = parseJson("f.json", '{"a":1}');
  assert.ok(Result.isSuccess(good));
  assert.deepEqual(good.success, { a: 1 });

  const mismatch = decodeRecord("q.json", S.QuestionList, { questions: "x" });
  assert.ok(Result.isFailure(mismatch));
  assert.match(describe(mismatch.failure), /q\.json could not be read: .*questions/);
  const decoded = decodeRecord("q.json", S.QuestionList, { questions: [] });
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { questions: [] });
});

test("lift, the throw-based bridge into Effect, is gone (compile-time)", () => {
  // @ts-expect-error services.ts exports no `lift`: decoders return Result, and Effect.fromResult lifts them
  type Lift = (typeof import("../src/services.ts"))["lift"];
  void (null as Lift | null);
});

// Q5: the files the store writes are version 2; a version-1 file of an earlier run is still read.
test("saveLog writes a version-2 log file; a log file of the old shape (a bare array) is StateFileInvalid", async () => {
  const s = await initialised();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, "issue-log.json"), "utf8")), { version: 2, entries: [] });
  const old = { id: "A", phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r" };
  fs.writeFileSync(path.join(s.dir, "issue-log.json"), JSON.stringify([old]));
  await fails(s.loadLog({ plan: 1 }), "StateFileInvalid", /issue-log\.json/);
});

test("recordUsage writes version-2 lines per agent", async () => {
  const s = await initialised();
  await Effect.runPromise(s.recordUsage({ agent: "claude", session: "s", turns: 1, totalCostUsd: 1.5 }));
  await Effect.runPromise(s.recordUsage({ agent: "codex", thread: "t", inputTokens: 10, outputTokens: 5 }));
  const lines = fs.readFileSync(path.join(s.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { version: 2, agent: "claude", time: lines[0].time, session: "s", num_turns: 1, total_cost_usd: 1.5 });
  assert.deepEqual(lines[1], { version: 2, agent: "codex", time: lines[1].time, thread: "t", input_tokens: 10, output_tokens: 5 });
});

// Finding 22 / 23 (step 5.3): the store reads the Clock service; names that could collide are made distinct or created exclusively.
const fixedClock = (ms: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => ms,
  currentTimeMillis: Effect.succeed(ms),
  currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.succeed(undefined),
});
const NOON = Date.UTC(2026, 8, 25, 12, 0, 0);
const atNoon = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, fixedClock(NOON))));

test("recordUsage takes its time from the Clock service", async () => {
  const s = await initialised();
  await atNoon(s.recordUsage({ agent: "codex", thread: "t", inputTokens: 1, outputTokens: 1 }));
  const line = JSON.parse(fs.readFileSync(path.join(s.dir, "usage.jsonl"), "utf8").trim());
  assert.equal(line.time, "2026-09-25T12:00:00.000Z");
});

test("a gap in the invalid-reply sequence never overwrites an existing file", async () => {
  const s = await initialised();
  const dir = path.join(s.dir, "invalid-replies");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "codex-1.json"), "one");
  fs.writeFileSync(path.join(dir, "codex-3.json"), "three");
  const saved = await Effect.runPromise(s.saveInvalidReply("codex", "new"));
  assert.equal(fs.readFileSync(path.join(dir, "codex-3.json"), "utf8"), "three", "an existing invalid-reply file was overwritten");
  assert.equal(fs.readFileSync(path.join(s.project, saved), "utf8"), "new");
  assert.notEqual(saved, path.join("plan-review", TEST_ROOT, "invalid-replies", "codex-3.json"));
});

// Finding 16 / Q6: JSON records are written to a temporary name and renamed into place.
test("a record is replaced atomically: a failure between the temporary file and the rename leaves the previous file intact, and the readers ignore the temporary file", async () => {
  let armed = false;
  const s = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(faultyPlatform((method) => method === "rename" && armed))));
  await Effect.runPromise(s.init("task"));
  const a = { id: "A" as IssueId, phase: 1, round: 1, source: "review" as const, severity: "major" as const, location: "l", problem: "p", evidence: "e", action: "accepted" as const, rationale: "r", duplicate_of: null, reverses: null, superseded: false, file_change: null };
  await Effect.runPromise(s.saveLog({ plan: 1 }, [a]));
  armed = true;
  await fails(s.saveLog({ plan: 1 }, [a, { ...a, id: "B" as IssueId }]), "FileSystemError", /injected/);
  armed = false;
  assert.deepEqual(await Effect.runPromise(s.loadLog({ plan: 1 })), [a]);
  assert.ok(fs.readdirSync(s.dir).some((n) => n.includes(".tmp-")), "the temporary file of the failed write was expected to remain");
  assert.equal((await Effect.runPromise(s.usageLines())).calls.length, 0);
});
