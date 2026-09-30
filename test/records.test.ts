import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { describe, type StateFileInvalid } from "../src/errors.ts";
import { platformLayer } from "../src/platform.ts";
import { AnalysisFile, ChoiceFile, DecisionQuestionFile, readCheckpoint, readLog, readQuestions, readUsage } from "../src/records.ts";
import { Schema } from "effect";
import { finished, issue, respond, runTask, tempRepo, testLayer, entryOf } from "./helpers.ts";

// Decision Q5: tagged version-2 records. Only the current shape is read (the developer removed the old-shape
// readers and the converter on 25 Sep 2026); a file of the old shape is StateFileInvalid.
const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result), `failed: ${Result.isFailure(result) ? describe(result.failure as never) : ""}`);
  return result.success;
};
const failureText = <A>(result: Result.Result<A, StateFileInvalid>): string => {
  assert.ok(Result.isFailure(result), "the read succeeded");
  return describe(result.failure);
};
const review = { id: "A", phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r", duplicate_of: null, reverses: null, superseded: false, file_change: null };

test("readLog reads a version-2 log file and rejects a bare array (the old shape)", () => {
  const entries = ok(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [review] })));
  assert.deepEqual(entries, [review]);
  const { duplicate_of: _d, reverses: _r, superseded: _s, ...old } = review;
  assert.match(failureText(readLog("issue-log.json", JSON.stringify([old]))), /issue-log\.json could not be read/);
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ entries: [review] }))), /version/);
});

// Issue #31 (behavior 8 amended): an entry of source review or self_correction carries file_change, the change of the
// reviewed file measured during the round's response, or null; an entry without the field is not of the current shape.
test("readLog reads file_change, and rejects a review or self-correction entry without it", () => {
  const measured = { ...review, file_change: { changed: true, added: 3, removed: 1 } };
  const self = { id: "P1-S1-1", phase: 1, round: 1, source: "self_correction", problem: "p", action: "plan_error", rationale: "r", superseded: false, file_change: null };
  assert.deepEqual(ok(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [measured, self] }))), [measured, self]);
  const { file_change: _f, ...withoutReview } = measured;
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [withoutReview] }))), /file_change/);
  const { file_change: _g, ...withoutSelf } = self;
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [withoutSelf] }))), /file_change/);
});

test("a version-2 review entry with a misspelled action fails naming the path (finding 6)", () => {
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [{ ...review, action: "accpeted" }] }))), /issue-log\.json could not be read: .*entries\[0\]\.action/);
});

test("a version-2 user entry with a severity, and a review entry without one, fail", () => {
  const user = { id: "A", phase: 1, round: 1, source: "user", problem: "p", action: "decided_by_user", rationale: "r", superseded: false, severity: "major" };
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [user] }))), /entries\[0\]/);
  const { severity: _severity, ...noSeverity } = review;
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [noSeverity] }))), /entries\[0\]\.severity/);
});

test("readUsage reads version-2 lines and rejects a line of the old shape, naming the line", () => {
  const claude = { version: 2, agent: "claude", time: "t", session: "s", num_turns: 12, total_cost_usd: 1.07 };
  const codex = { version: 2, agent: "codex", time: "t", thread: "x", input_tokens: 10, output_tokens: 2 };
  assert.deepEqual(ok(readUsage("usage.jsonl", `${JSON.stringify(claude)}\n${JSON.stringify(codex)}\n`)), [claude, codex]);
  const old = { time: "t", agent: "codex", thread_id: "x", usage: { input_tokens: 10, output_tokens: 2 } };
  assert.match(failureText(readUsage("usage.jsonl", `${JSON.stringify(claude)}\n${JSON.stringify(old)}\n`)), /usage\.jsonl could not be read: line 2/);
});

test("readQuestions reads the version-2 file and rejects one without the version marker", () => {
  const file = { version: 2, task: "t", questions: [{ ...entryOf({ id: "Q1", context: "c", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "" }), default_answer: null }] };
  assert.deepEqual(ok(readQuestions("questions.json", JSON.stringify(file))), file);
  const { version: _v, ...old } = file;
  assert.match(failureText(readQuestions("questions.json", JSON.stringify(old))), /questions\.json could not be read/);
});

// Q6: the checkpoint reader verifies that the records the checkpoint names exist and decode.
test("readCheckpoint gives null without a file, the checkpoint when its records are complete, and StateFileInvalid otherwise", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const dir = probe.dir;
  const read = () => Effect.runPromise(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
  // A finished run's last transition is its work review's converged round.
  assert.deepEqual([(await read())?.subject, (await read())?.stage], ["work-review-1", "reviewed"]);
  const write = (point: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "checkpoint.json"), JSON.stringify({ version: 2, ...point, time: "2026-09-25T12:00:00.000Z" }));
  write({ subject: "planning-1", phase: 1, round: 1, stage: "responded" });
  assert.equal((await read())?.stage, "responded");
  write({ subject: "planning-1", phase: 1, round: 2, stage: "reviewed" });
  assert.equal((await read())?.stage, "reviewed");
  const rejects = async (point: Record<string, unknown>, what: string) => {
    write(point);
    const exit = await Effect.runPromiseExit(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
    assert.ok(exit._tag === "Failure", `${what}: the checkpoint was accepted`);
  };
  await rejects({ subject: "planning-1", phase: 1, round: 3, stage: "reviewed" }, "a round without a review file");
  await rejects({ subject: "planning-1", phase: 1, round: 2, stage: "responded" }, "a responded stage without a response file");
  await rejects({ subject: "execution", phase: 2, round: 0, stage: "executed" }, "an execution without a result file");
  await rejects({ subject: "planning-1", phase: 1, round: 1, stage: "shipped" }, "an unknown stage");
  fs.rmSync(path.join(dir, "checkpoint.json"));
  assert.equal(await read(), null);
});

// Plan step 2.2: the work review adds baseline.json (read for `started`) and the work-review-<k> subject directory.
test("readCheckpoint requires baseline.json and the four logs for started, and reads a work-review checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(tempRepo(), "records-"));
  const put = (name: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  };
  const read = () => Effect.runPromiseExit(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
  const failure = async () => {
    const exit = await read();
    assert.ok(exit._tag === "Failure", "the checkpoint was accepted");
    return String(exit.cause);
  };
  for (const log of ["issue-log.json", "questions-log.json", "terms-log.json", "requirements-log.json", "work-review-log.json", "decision-log.json"]) put(log, { version: 2, entries: [] });
  put("checkpoint.json", { version: 2, subject: "init", phase: 0, round: 0, stage: "started", time: "t" });
  assert.match(await failure(), /baseline\.json/);
  put("baseline.json", { version: 2, tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", time: "t" });
  assert.equal((await read())._tag, "Success");
  fs.rmSync(path.join(dir, "work-review-log.json"));
  assert.match(await failure(), /work-review-log\.json/);
  put("work-review-log.json", { version: 2, entries: [] });
  put("baseline.json", { version: 2, tree: "", time: "t" });
  assert.match(await failure(), /at tree/);

  const reviewRecord = { issues: [] };
  put("work-review-1/review-1.json", reviewRecord);
  put("work-review-1/round-1.json", { version: 2, kind: "no_response", subject: "work-review-1", phase: 1, round: 1, reconstructed: false, review: reviewRecord });
  put("checkpoint.json", { version: 2, subject: "work-review-1", phase: 1, round: 1, stage: "reviewed", time: "t" });
  const exit = await read();
  assert.ok(exit._tag === "Success", `the work-review checkpoint was rejected: ${exit._tag === "Failure" ? String(exit.cause) : ""}`);
});

// Decision support, plan step 1.4: the records of decision k and its checkpoint.
const emptyAnalysis = { decision: "d", columns: [{ kind: "argued", option: "A", advantages: [], disadvantages: [] }, { kind: "argued", option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "", reason: "" } };
test("the decision record files decode their version-2 shape", () => {
  const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  const question = { version: 2, decision: 1, phase: { kind: "planning", n: 2 }, label: "Planning 2", question: "Which?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
  assert.deepEqual(decode(DecisionQuestionFile, question), question);
  assert.deepEqual(decode(DecisionQuestionFile, { ...question, phase: { kind: "questions" } }).phase, { kind: "questions" });
  assert.deepEqual(decode(AnalysisFile, { version: 2, analysis: emptyAnalysis }).analysis, emptyAnalysis);
  const choice = { version: 2, decision: 1, answer: "2", option: "B" };
  assert.deepEqual(decode(ChoiceFile, choice), choice);
  assert.equal(decode(ChoiceFile, { ...choice, option: null }).option, null);
  assert.throws(() => decode(ChoiceFile, { decision: 1, answer: "2", option: "B" }), "a choice without the version marker was accepted");
});

test("readCheckpoint reads a decision checkpoint and requires its question and analysis", async () => {
  const dir = fs.mkdtempSync(path.join(tempRepo(), "records-"));
  const put = (name: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  };
  const read = () => Effect.runPromiseExit(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
  const reviewRecord = { issues: [] };
  put("decision-2/review-1.json", reviewRecord);
  put("decision-2/round-1.json", { version: 2, kind: "no_response", subject: "decision-2", phase: 1, round: 1, reconstructed: false, review: reviewRecord });
  put("checkpoint.json", { version: 2, subject: "decision-2", phase: 1, round: 1, stage: "reviewed", time: "t" });
  const missing = await read();
  assert.ok(missing._tag === "Failure" && /decision-2\/question\.json/.test(String(missing.cause)), "a decision checkpoint without question.json was accepted");
  put("decision-2/question.json", { version: 2, decision: 2, phase: { kind: "planning", n: 1 }, label: "Planning", question: "Which?", options: [] });
  const noAnalysis = await read();
  assert.ok(noAnalysis._tag === "Failure" && /decision-2\/analysis\.json/.test(String(noAnalysis.cause)), "a decision checkpoint without analysis.json was accepted");
  put("decision-2/analysis.json", { version: 2, analysis: emptyAnalysis });
  const exit = await read();
  assert.ok(exit._tag === "Success", `the decision checkpoint was rejected: ${exit._tag === "Failure" ? String(exit.cause) : ""}`);
});
