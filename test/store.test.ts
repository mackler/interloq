import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Option } from "effect";
import { platformLayer } from "../src/platform.ts";
import type { StoreShape } from "../src/services.ts";
import { allocateRunRoot, makeStore } from "../src/store.ts";
import { compareRecords } from "../src/snapshot.ts";
import { pathOf, type RunRoot, runRootOf } from "../src/artifacts.ts";
import { tempRepo , TEST_ROOT } from "./helpers.ts";

// Plan step 2.3 (decision Q7; P1-R1-5, P1-R2-1, P1-R2-2, P4-R1-1): the baseline tree at init, the change
// record before each work-review turn, and the two hashes of the work subject.
const run = Effect.runPromise;
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const commit = (dir: string, message: string) => git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", message);
const write = (dir: string, name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};
const storeOf = (repo: string, ignorePaths: readonly string[] = []): Promise<StoreShape> => run(makeStore(repo, TEST_ROOT, ignorePaths).pipe(Effect.provide(platformLayer)));
const changes = (repo: string, phase = 1): string => fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, `work-review-${phase}`, "changes.diff"), "utf8");

test("init records the baseline tree, and the change record holds new, modified and committed changes", async () => {
  const repo = tempRepo();
  // tempRepo does not ignore plan-review/, so a temporary index under it could be staged (P1-R2-1).
  write(repo, "b.txt", "b\n");
  git(repo, "add", "b.txt");
  commit(repo, "b");
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const store = await storeOf(repo);
  await run(store.init("task"));
  await run(store.writeBaseline());
  const baseline = JSON.parse(fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, "baseline.json"), "utf8"));
  assert.equal(baseline.version, 2);
  assert.equal(git(repo, "cat-file", "-t", baseline.tree).trim(), "tree");
  assert.ok(!git(repo, "ls-tree", "-r", "--name-only", baseline.tree).includes("plan-review/"), "the baseline tree contains plan-review/");

  write(repo, "new.txt", "brand new\n");
  write(repo, "a.txt", "x\nmodified\n");
  write(repo, "b.txt", "b\ncommitted later\n");
  commit(repo, "after init");
  await run(store.changeRecord(1));
  const diff = changes(repo);
  assert.match(diff, /\+brand new/, "the new file is not in the diff");
  assert.match(diff, /\+modified/);
  assert.match(diff, /\+committed later/);
  assert.doesNotMatch(diff, /plan-review\//);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")).equals(indexBefore) || git(repo, "diff", "--cached", "--name-only").trim() === "", true, "the repository's own index changed");
  assert.deepEqual(fs.readdirSync(path.join(repo, ".git")).filter((n) => n.startsWith("plan-review-index")), [], "a temporary index is left");
});

test("the change record leaves out ignorePaths literally and keeps tracked files that match .gitignore", async () => {
  const repo = tempRepo();
  write(repo, "src/run.ts", "run\n");
  write(repo, "src/[rs]*.ts", "literal\n");
  write(repo, "tracked.log", "log\n");
  git(repo, "add", "-f", "src/run.ts", "src/[rs]*.ts", "tracked.log");
  commit(repo, "files");
  write(repo, ".gitignore", "*.log\n");
  const store = await storeOf(repo, ["src/[rs]*.ts", ".devcontainer/claude.json"]);
  await run(store.init("task"));
  await run(store.writeBaseline());
  write(repo, "src/run.ts", "run\nchanged\n");
  write(repo, "src/[rs]*.ts", "literal\nchanged\n");
  write(repo, "tracked.log", "log\nchanged\n");
  write(repo, ".devcontainer/claude.json", "{}\n");
  await run(store.changeRecord(1));
  const diff = changes(repo);
  assert.match(diff, /src\/run\.ts/, "a file matching the ignorePaths entry as a pattern was left out");
  assert.doesNotMatch(diff, /\[rs\]\*/, "the literal ignorePaths entry is in the diff");
  assert.doesNotMatch(diff, /claude\.json/);
  assert.match(diff, /tracked\.log/, "a tracked file matching .gitignore is not observed");
});

test("changeRecord rewrites the file; fileHash of the work subject follows the project, recordHash the file on disk", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  assert.equal(await run(store.fileHash({ work: 1 })), "", "fileHash before the baseline");
  await run(store.init("task"));
  await run(store.writeBaseline());
  const before = await run(store.fileHash({ work: 1 }));
  write(repo, "a.txt", "x\nfirst\n");
  await run(store.changeRecord(1));
  const first = await run(store.fileHash({ work: 1 }));
  assert.notEqual(first, before);
  assert.equal(await run(store.recordHash({ work: 1 })), await run(store.recordHash({ work: 1 })));
  write(repo, "a.txt", "x\nsecond\n");
  await run(store.changeRecord(1));
  assert.match(changes(repo), /\+second/);
  // An edit of changes.diff itself changes recordHash but not fileHash (P1-R2-2).
  const hashes = { file: await run(store.fileHash({ work: 1 })), record: await run(store.recordHash({ work: 1 })) };
  fs.appendFileSync(path.join(repo, "plan-review", TEST_ROOT, "work-review-1", "changes.diff"), "edited\n");
  assert.equal(await run(store.fileHash({ work: 1 })), hashes.file);
  assert.notEqual(await run(store.recordHash({ work: 1 })), hashes.record);
  // For the other subjects the two hashes are the same.
  fs.writeFileSync(store.plan, "plan\n");
  assert.equal(await run(store.recordHash({ plan: 1 })), await run(store.fileHash({ plan: 1 })));
});

// Issue #120: two runs may be in progress at once in one project, each with its own records directory.
const rootB = runRootOf("refinement", "2", "2026-01-01T00:00:00.000Z");
const storeAt = (repo: string, root: RunRoot): Promise<StoreShape> => run(makeStore(repo, root, []).pipe(Effect.provide(platformLayer)));
const filesUnder = (dir: string): readonly string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

test("two stores with distinct roots write their records to disjoint directories, and neither's init moves the other's files", async () => {
  const repo = tempRepo();
  const a = await storeAt(repo, TEST_ROOT);
  await run(a.init("task a"));
  await run(a.converse("from a\n"));
  const before = filesUnder(a.dir);
  const b = await storeAt(repo, rootB);
  await run(b.init("task b"));
  await run(b.converse("from b\n"));
  assert.equal(a.dir, path.join(repo, "plan-review", TEST_ROOT));
  assert.equal(b.dir, path.join(repo, "plan-review", rootB));
  assert.deepEqual(filesUnder(a.dir), before);
  assert.match(fs.readFileSync(path.join(a.dir, "conversation.md"), "utf8"), /task a[\s\S]*from a/);
  assert.doesNotMatch(fs.readFileSync(path.join(a.dir, "conversation.md"), "utf8"), /from b/);
  assert.match(fs.readFileSync(path.join(b.dir, "conversation.md"), "utf8"), /task b[\s\S]*from b/);
  assert.deepEqual(fs.readdirSync(path.join(repo, "plan-review")).filter((n) => n.startsWith("archive-")), []);
});

test("allocateRunRoot creates the run's directory, and a clashing root gets -2, then -3", async () => {
  const repo = tempRepo();
  const first = await run(allocateRunRoot(repo, TEST_ROOT).pipe(Effect.provide(platformLayer)));
  const second = await run(allocateRunRoot(repo, TEST_ROOT).pipe(Effect.provide(platformLayer)));
  const third = await run(allocateRunRoot(repo, TEST_ROOT).pipe(Effect.provide(platformLayer)));
  assert.deepEqual([first, second, third], [TEST_ROOT, `${TEST_ROOT}-2`, `${TEST_ROOT}-3`]);
  for (const root of [first, second, third]) assert.ok(fs.statSync(path.join(repo, "plan-review", root)).isDirectory());
});

test("a read-only call's records guard ignores a file written under another run's root and sees a change under its own", async () => {
  const repo = tempRepo();
  const a = await storeAt(repo, TEST_ROOT);
  await run(a.init("task"));
  const before = await run(a.recordsSnapshot());
  write(path.join(repo, "plan-review", rootB), "conversation.md", "the other run\n");
  write(path.join(repo, "plan-review"), "loose.md", "an earlier run's loose file\n");
  assert.deepEqual(compareRecords(before, await run(a.recordsSnapshot())), []);
  fs.appendFileSync(path.join(a.dir, "conversation.md"), "x");
  assert.equal(compareRecords(before, await run(a.recordsSnapshot())).length, 1);
});

test("init writes no baseline.json, and writeBaseline does", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  assert.ok(!fs.existsSync(path.join(store.dir, "baseline.json")));
  await run(store.writeBaseline());
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.dir, "baseline.json"), "utf8")).version, 2);
});

test("the project snapshot leaves the repository's index unchanged, even when the index is stale", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  // A tracked file touched without a change of content makes the index's stat data stale; a plain git status refreshes it.
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(repo, "a.txt"), later, later);
  const index = path.join(repo, ".git", "index");
  const [bytes, mtime] = [fs.readFileSync(index), fs.statSync(index).mtimeMs];
  await run(store.projectSnapshot());
  assert.ok(fs.readFileSync(index).equals(bytes), "the index's bytes changed");
  assert.equal(fs.statSync(index).mtimeMs, mtime, "the index was rewritten");
});

// Stage A (finding 1 of docs/gui-review.md): the records snapshot that a read-only call is checked with.
test("recordsSnapshot changes with every guarded record and not with usage.jsonl or invalid-replies/", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  const dir = path.join(repo, "plan-review", TEST_ROOT);
  for (const [name, text] of [["plan.md", "p"], ["requirements.md", "r"], ["work-review-1/changes.diff", "d"], ["work-review-1/round-1.json", "{}"], ["checkpoint.json", "{}"]] as const) write(dir, name, text);
  const moved = async (change: () => void): Promise<number> => {
    const before = await run(store.recordsSnapshot());
    change();
    return compareRecords(before, await run(store.recordsSnapshot())).length;
  };
  for (const name of ["plan.md", "requirements.md", "work-review-1/changes.diff", "work-review-1/round-1.json", "checkpoint.json", "baseline.json"]) {
    assert.equal(await moved(() => fs.appendFileSync(path.join(dir, name), "x")), 1, `rewritten: ${name}`);
  }
  assert.equal(await moved(() => fs.rmSync(path.join(dir, "requirements.md"))), 1, "deleted");
  assert.equal(await moved(() => write(dir, "notes/new.md", "n")), 2, "a new file and its new directory");
  assert.equal(await moved(() => fs.appendFileSync(path.join(dir, "usage.jsonl"), "{}\n")), 0, "usage.jsonl");
  assert.equal(await moved(() => write(dir, "invalid-replies/claude-1.json", "{}")), 0, "invalid-replies/");
});

// Decision support, plan step 1.5: the records of decision k.
const logEntry = (id: string, phase = 1) => ({ id, phase, round: 1, source: "self_correction" as const, problem: "p", action: "plan_error" as const, rationale: "r", superseded: false, file_change: null }) as never;
const analysis = { decision: "d", columns: [{ kind: "argued" as const, option: "A", advantages: [], disadvantages: [] }, { kind: "argued" as const, option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "", reason: "" } };
const question = { phase: { kind: "planning" as const, n: 1 }, label: "Planning", question: "Which?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
const json = (repo: string, name: string) => JSON.parse(fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, name), "utf8"));

test("decisions are numbered across the run, each with its question, analysis, raw output and choice", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  assert.deepEqual(json(repo, "decision-log.json"), { version: 2, entries: [] });
  assert.equal(await run(store.openDecision(question)), 1);
  // A nested decision, opened while decision 1 runs, is decision 2.
  assert.equal(await run(store.openDecision({ ...question, question: "Inner?" })), 2);
  assert.deepEqual(json(repo, "decision-1/question.json"), { version: 2, decision: 1, ...question });
  assert.equal(json(repo, "decision-2/question.json").question, "Inner?");
  await run(store.saveAnalysisWrite(1, { raw: true }));
  assert.deepEqual(json(repo, "decision-1/cc-0.json"), { raw: true });
  await run(store.saveAnalysis(1, analysis));
  assert.deepEqual(json(repo, "decision-1/analysis.json"), { version: 2, analysis });
  assert.deepEqual(await run(store.loadAnalysis(1)), analysis);
  await run(store.saveChoice(1, { answer: "2", option: "B" }));
  assert.deepEqual(json(repo, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "2", option: "B" });
  // The reviewed file's hash is the analysis's.
  assert.notEqual(await run(store.recordHash({ decision: 1 })), "");
  assert.equal(await run(store.fileHash({ decision: 1 })), await run(store.recordHash({ decision: 1 })));
  assert.equal(await run(store.fileHash({ decision: 2 })), "");
});

test("decision-log.json holds every decision; each decision reads and replaces only its own entries (D6, P1-R1-1)", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  // Decisions 1 and 2, both in phase 1, each with a generated self-correction id.
  await run(store.saveLog({ decision: 1 }, [logEntry("D1-S1-1")]));
  await run(store.saveLog({ decision: 2 }, [logEntry("D2-S1-1")]));
  await run(store.saveLog({ decision: 1 }, [logEntry("D1-S1-1"), logEntry("D1-R2-1")]));
  assert.deepEqual((await run(store.loadLog({ decision: 1 }))).map((e) => e.id), ["D1-S1-1", "D1-R2-1"]);
  assert.deepEqual((await run(store.loadLog({ decision: 2 }))).map((e) => e.id), ["D2-S1-1"]);
  assert.deepEqual((await run(store.loadLog({ decision: 3 }))).map((e) => e.id), []);
  assert.deepEqual(json(repo, "decision-log.json").entries.map((e: { id: string; phase: number }) => [e.id, e.phase]), [["D2-S1-1", 1], ["D1-S1-1", 1], ["D1-R2-1", 1]]);
  // Decision 1 is not decision 10.
  await run(store.saveLog({ decision: 10 }, [logEntry("D10-S1-1")]));
  assert.deepEqual((await run(store.loadLog({ decision: 1 }))).map((e) => e.id), ["D1-S1-1", "D1-R2-1"]);
});

test("readContext gives requirements.md and plan.md where they exist", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  assert.deepEqual(await run(store.readContext()), { requirements: null, plan: null });
  write(repo, `plan-review/${TEST_ROOT}/plan.md`, "1. [ ] step\n");
  assert.deepEqual(await run(store.readContext()), { requirements: null, plan: "1. [ ] step\n" });
});

// Issue #6 (F1, F2): the program writes plan.json, the reviewed file, and plan.md rendered from it.
test("savePlan writes plan.json and plan.md rendered from it, and replaces both; loadPlan reads plan.json back", async () => {
  const { renderPlanMarkdown } = await import("../src/plan.ts");
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  assert.ok(Option.isNone(await run(store.loadPlan())));
  const plan = (text: string, status: "pending" | "done") => ({ stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text, status }] }] });
  await run(store.savePlan(plan("first", "pending")));
  await run(store.savePlan(plan("second", "done")));
  const loaded = await run(store.loadPlan());
  assert.ok(Option.isSome(loaded));
  assert.deepEqual(loaded.value, plan("second", "done"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, "plan.json"), "utf8")), { version: 2, plan: plan("second", "done") });
  // The seam of F2: plan.md is what renderPlanMarkdown makes of what loadPlan returns.
  assert.equal(fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, "plan.md"), "utf8"), renderPlanMarkdown(loaded.value));
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, "plan.md"), "utf8"), /first/);
});

test("a plan.json that does not decode is a typed error", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  fs.writeFileSync(path.join(repo, "plan-review", TEST_ROOT, "plan.json"), JSON.stringify({ version: 2, plan: { stages: [{ number: 1 }] } }));
  const failure = await run(Effect.flip(store.loadPlan()));
  assert.equal(failure._tag, "StateFileInvalid");
});

// Issue #31 (plan step S4): the reviewed file is observed once, its hash and its text from the one read; the hash is
// the one fileHash gives, so the change record and the guard of behaviour 7 cannot disagree.
test("observeFile gives the hash fileHash gives and the text of the same read", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  assert.deepEqual(await run(store.observeFile("requirements")), { hash: "", text: "" }, "an absent file");
  await run(store.writeRequirements("# R\n\nline\n"));
  const observed = await run(store.observeFile("requirements"));
  assert.equal(observed.hash, await run(store.fileHash("requirements")));
  assert.equal(observed.text, fs.readFileSync(path.join(repo, "plan-review", TEST_ROOT, "requirements.md"), "utf8"));
  // The work review is not measured (Q7): its hash is fileHash's, and it has no text.
  const work = await run(store.observeFile({ work: 1 }));
  assert.equal(work.hash, await run(store.fileHash({ work: 1 })));
  assert.equal(work.text, "");
});

// Issue #30 (plan step S10): a corrective turn's raw reply is its own record beside the response of its round; the
// store writes it where the catalog names it.
test("saveCorrection writes the corrective reply at the catalog's path", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  const subject = { plan: 2 } as const;
  await run(store.saveCorrection(subject, 3, 1, { dispositions: [] }));
  const file = pathOf({ kind: "correction", subject, round: 3, attempt: 1 });
  assert.equal(file, "planning-2/cc-3-corrective-1.json");
  assert.deepEqual(json(repo, file), { dispositions: [] });
});

// Issue #26 (S19): the journal of the program's own writes to guarded records, with their preimages. Every write
// operation of the Store is enumerated: each change it makes under plan-review/ is in the journal, and replaying the
// journal from the snapshot before it gives the snapshot after it (the seam between the journal and recordsSnapshot).
import { compareJournaled } from "../src/snapshot.ts";

test("every write of the Store to a guarded record is in its journal, with the entry recordsSnapshot gives", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  const plan = { stages: [{ number: 1, title: "t", steps: [{ id: "S1", number: 1, label: "l", text: "x", status: "pending" as const }] }] };
  const response = { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
  const writes: [string, Effect.Effect<unknown, unknown>][] = [
    ["init", store.init("task")],
    ["saveReview", store.saveReview({ plan: 1 }, 1, { issues: [] })],
    ["saveResponse", store.saveResponse({ plan: 1 }, 1, response)],
    ["saveCorrection", store.saveCorrection({ plan: 1 }, 1, 1, response)],
    ["saveRound", store.saveRound({ plan: 1 }, { round: 1, kind: "no_response", review: { issues: [] } } as never)],
    ["savePlanWrite", store.savePlanWrite(1, { questions_for_user: [] } as never)],
    ["saveExecution", store.saveExecution(1, { status: "finished", summary: "", question: "", remainingWork: "", userInput: null })],
    ["saveQuestions", store.saveQuestions("task", [])],
    ["writeRequirements", store.writeRequirements("# R\n")],
    ["savePlan", store.savePlan(plan)],
    ["saveLog", store.saveLog({ plan: 1 }, [])],
    ["appendDecision", store.appendDecision({ subject: "issue A", id: null, decision: "keep it", phase: 1, round: 1 })],
    ["recordFeedback", store.recordFeedback({ plan: 1 }, 1, "thanks")],
    ["converse", store.converse("a line\n")],
    ["recordUsage", store.recordUsage({ agent: "codex", thread: "t", inputTokens: 1, outputTokens: 1 })],
    ["checkpoint", store.checkpoint({ subject: "run", phase: 0, round: 0, stage: "started" })],
    ["changeRecord", store.changeRecord(1)],
    ["saveInvalidReply", store.saveInvalidReply("claude", "x")],
    ["openDecision", store.openDecision({ phase: { kind: "planning", n: 1 }, label: "Planning", question: "q?", options: [] } as never)],
    ["saveAnalysisWrite", store.saveAnalysisWrite(1, {} as never)],
    ["saveAnalysis", store.saveAnalysis(1, { decision: "d", columns: [], recommendation: { option: "", reason: "" } })],
    ["saveChoice", store.saveChoice(1, { answer: "a", option: null })],
    ["init again", store.init("task")],
  ];
  for (const [name, write] of writes) {
    const before = await run(store.recordsSnapshot());
    const mark = await run(store.journalMark);
    await run(write as Effect.Effect<unknown>);
    const after = await run(store.recordsSnapshot());
    const own = await run(store.ownWritesSince(mark));
    assert.deepEqual(compareJournaled(before, own, after), [], `${name}: a change the journal does not account for`);
    for (const change of compareRecords(before, after)) assert.ok(own.some((w) => w.path === change.path), `${name}: ${change.path} is not in the journal`);
    const last = new Map(own.map((w) => [w.path, w.after]));
    for (const [p, entry] of last) assert.equal(entry, after.get(p) ?? null, `${name}: the journal's last entry of ${p} is not recordsSnapshot's`);
  }
});
