import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { platformLayer } from "../src/platform.ts";
import { limitNoProceedPrompt, execInputPrompt, planApplyDecisionsPrompt, withOffer } from "../src/prompts.ts";
import { readCheckpoint } from "../src/records.ts";
import type { ExecOutcome } from "../src/schema.ts";
import type { StoreShape } from "../src/services.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer, presentedQuestions, presentedSubjects, TEST_ROOT } from "./helpers.ts";

// Plan step 2.8: the work review after every execution phase (the task; decisions Q7, Q13, Q14, G-R1-1).
const noQuestions = { questions_for_user: [] };
const planWrite = (plan: string) => ({ output: noQuestions, plan });
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const json = (dir: string, name: string) => JSON.parse(read(dir, name));
const workLog = (dir: string) => json(dir, "work-review-log.json").entries as { id: string; round: number; phase: number; source: string; action: string; rationale: string }[];

/** Captures checkpoint.json when the next planning call begins; `verify` later decodes it against the records. */
const checkpointAtCall = (dir: () => string) => {
  let captured: string | null = null;
  return {
    onCall: () => {
      captured = fs.readFileSync(path.join(dir(), "checkpoint.json"), "utf8");
    },
    verify: async () => {
      assert.ok(captured !== null, "no checkpoint was captured");
      const file = path.join(dir(), "checkpoint.json");
      const later = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, captured);
      const checkpoint = await Effect.runPromise(readCheckpoint(dir()).pipe(Effect.provide(platformLayer)));
      fs.writeFileSync(file, later);
      return checkpoint;
    },
  };
};

/** A store whose saveResponse of a work review round changes the project afterwards (after planningCall's guard). */
const changeAfterResponse = (repo: string, change: (round: number) => void) => (store: StoreShape): StoreShape => ({
  ...store,
  saveResponse: (subject, round, response) =>
    store.saveResponse(subject, round, response).pipe(Effect.tap(() => Effect.sync(() => (typeof subject === "object" && "work" in subject ? change(round) : undefined)))),
});

test("(a, g, h) a finished execution and a converged work review finish the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(json(probe.dir, "work-review-1/review-1.json"), { issues: [] });
  assert.equal(json(probe.dir, "work-review-1/round-1.json").kind, "no_response");
  assert.deepEqual([json(probe.dir, "checkpoint.json").subject, json(probe.dir, "checkpoint.json").stage], ["work-review-1", "reviewed"]);
  assert.match(read(probe.dir, "work-review-1/changes.diff"), /\+implemented/);
  assert.match(read(probe.dir, "conversation.md"), /## Work review 1, round 1/);
  assert.ok(probe.ui.notified.some((e) => e._tag === "PhaseBegan" && e.phase.kind === "work" && e.phase.n === 1));
  assert.match(probe.reviewer.prompts[1], /work-review-1\/changes\.diff/);
  assert.equal(probe.reviewer.phases, 2, "the work review has its own thread");
});

test("(b) an accepted work issue leads to planning 2, execution 2 and a second work review", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.planner.prompts[2], /Work review 1 ended in round 1/);
  assert.match(probe.planner.prompts[2], /work-review-1\/round-1\.json/);
  assert.ok(!probe.planner.prompts.includes(planApplyDecisionsPrompt), "a work review applied decisions with a planning call");
  assert.deepEqual(workLog(probe.dir).map((e) => [e.id, e.action]), [["W1-R1-1", "accepted"]]);
  // Issue #31, Q7: the work review is not measured.
  assert.deepEqual(json(probe.dir, "work-review-log.json").entries.map((e: { file_change: unknown }) => e.file_change), [null]);
  assert.equal((await capture.verify())?.stage, "logged");
});

// Issue #117: the execution ran in a session of its own; the work response, in the main session, is given its report.
test("issue #117: the work response's prompt carries the summary the execution, in its own session, returned", async () => {
  const done: ExecOutcome = { ...finished, summary: "the scripted summary of execution 1", remainingWork: "nothing left" };
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [done, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.notEqual(probe.planner.execSessions[0], "test-session");
  const response = probe.planner.prompts[1];
  assert.match(response, /work-review-1\/review-1\.json/);
  assert.ok(response.includes(done.summary), response);
  assert.ok(response.includes(done.remainingWork));
  assert.ok(response.includes("v1"), "the plan as the execution's end left it");
  assert.deepEqual(probe.planner.history.get("test-session")?.at(-2), response, "the response ran on the main session");
});

test("(b2) an accepted self-correction of an earlier work issue leaves for planning 2", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
  const self = { self_corrections: [{ id: "W1-R1-1", new_action: "accepted" as const, explanation: "the earlier issue is valid" }] };
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { output: respond([["W1-R2-1", "rejected"]], self) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.ok(workLog(probe.dir).some((e) => e.source === "self_correction" && e.id === "W1-R1-1" && e.action === "accepted"));
  assert.equal((await capture.verify())?.stage, "logged");
});

test("(b3) changes.diff is rewritten for every round: an outside change after an empty answer is in round 2's file", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    answers: [""],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
    store: changeAfterResponse(repo, () => fs.appendFileSync(path.join(repo, "a.txt"), "outside change\n")),
  });
  assert.equal(await runTask(layer), 1);
  assert.match(presentedSubjects(probe.ui)[0], /unexplained change to changes\.diff/);
  assert.match(read(probe.dir, "work-review-1/changes.diff"), /\+outside change/);
});

test("(c) exit (iii): a decision on a reraised work issue leaves for planning 2 with a valid decided checkpoint", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
  const { layer, probe } = testLayer(repo, {
    answers: ["act on it"],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(presentedSubjects(probe.ui)[0], /issue W1-R1-1, raised again/);
  assert.deepEqual(workLog(probe.dir).at(-1)?.action, "decided_by_user");
  assert.match(read(probe.dir, "user-decisions.md"), /act on it/);
  assert.equal((await capture.verify())?.stage, "decided");
});

test("(c1) exit (i): a decision on a second clarification logs the round once with the decision and a valid logged checkpoint", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
  const { layer, probe } = testLayer(repo, {
    answers: ["this is what I mean"],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "clarification_requested"]]) }, { output: respond([["W1-R1-1", "clarification_requested"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  const round2 = workLog(probe.dir).filter((e) => e.round === 2);
  assert.deepEqual(round2.map((e) => [e.source, e.action]), [["review", "clarification_requested"], ["user", "decided_by_user"]]);
  assert.equal((await capture.verify())?.stage, "logged");
});

for (const [name, config, change, answers] of [
  ["(c2) exit (ii), unexplained change", {}, (repo: string) => () => fs.appendFileSync(path.join(repo, "a.txt"), "outside\n"), ["decide"]],
  ["(c4) exit (ii), idle rounds", { maxIdleRounds: 1 }, null, ["decide"]],
] as const) {
  test(`${name}: the decision leaves for planning 2; the log holds the round once and the decided checkpoint is valid`, async () => {
    const repo = tempRepo();
    const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
    const { layer, probe } = testLayer(repo, {
      answers: [...answers],
      config,
      steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
      reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
      execs: [finished, finished],
      ...(change !== null ? { store: changeAfterResponse(repo, change(repo)) } : {}),
    });
    assert.equal(await runTask(layer), 2);
    assert.equal(workLog(probe.dir).filter((e) => e.id === "W1-R1-1" && e.source === "review").length, 1);
    assert.equal((await capture.verify())?.stage, "decided");
  });
}

test("(c3) exit (ii), identical content: a diff back to an earlier round's text, then a decision, leaves for planning 2", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review", TEST_ROOT));
  let saved = "";
  const change = (round: number) => {
    const file = path.join(repo, "a.txt");
    if (round === 1) {
      saved = fs.readFileSync(file, "utf8");
      fs.appendFileSync(file, "temporary\n");
    } else fs.writeFileSync(file, saved);
  };
  const { layer, probe } = testLayer(repo, {
    answers: ["", "", "keep the first version"],
    config: { maxIdleRounds: 5 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { output: respond([["W1-R2-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    store: changeAfterResponse(repo, change),
  });
  assert.equal(await runTask(layer), 2);
  assert.match(presentedSubjects(probe.ui)[2], /alternating versions of changes\.diff/);
  assert.equal((await capture.verify())?.stage, "decided");
});

test("(d) an empty decision at the idle pause continues the work review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    config: { maxIdleRounds: 1 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts.length, 3);
});

test("(e) the round limit of a work review has no p, and p stops the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["p"],
    config: { maxRounds: 1, maxIdleRounds: 5 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }],
    execs: [finished],
  });
  await runFails(layer, "RoundLimitStop", /Work review 1/);
  // Decision support (decision Q6): Stop or more cycles is a choice, so it carries the offer.
  assert.equal(probe.ui.asked[0], withOffer(limitNoProceedPrompt));
});

test("(f) a Codex turn of the work review that changes the project halts with ProjectChanged", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [], touchProject: true }], execs: [finished] });
  await runFails(layer, "ProjectChanged");
});

test("(f2) a Codex turn that edits only changes.diff halts with ReviewedFileChanged", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [], editRecord: "work-review-1/changes.diff" }], execs: [finished] });
  await runFails(layer, "ReviewedFileChanged", /changes\.diff/);
});

test("(f3) the same edit during a repair turn halts the same way", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [planWrite("v1")],
    reviews: [{ issues: [] }, { issues: [], raw: "not a review" }, { issues: [], editRecord: "work-review-1/changes.diff" }],
    execs: [finished],
  });
  await runFails(layer, "ReviewedFileChanged", /changes\.diff/);
});

const stop = (status: ExecOutcome["status"], userInput: string | null): ExecOutcome => ({ status, summary: "partial", question: "Which database?", remainingWork: "the rest", userInput });

test("(i) a needs_input stop is recorded, then the work review runs and converges, then planning 2; the run does not finish there", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stop("needs_input", "PostgreSQL"), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(read(probe.dir, "user-decisions.md"), /stop in execution phase 1 \(needs_input\)[\s\S]*PostgreSQL/);
  assert.match(probe.reviewer.prompts[1], /work-review-1\/changes\.diff/);
  assert.match(probe.planner.prompts[1], /user's input for this stop/);
  assert.match(probe.planner.prompts[1], /Work review 1 found no issue in the work so far/);
});

test("(j) an aborted execution asks the user for input, then the work review runs, then planning 2", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["go on"],
    steps: [planWrite("v1"), planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stop("aborted", null), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.ui.asked[0], execInputPrompt);
  assert.equal(probe.reviewer.prompts.length, 4);
});

test("(k) a stop and a work review that leaves with revise: planning 2's prompt names both", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [stop("needs_input", "PostgreSQL"), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.planner.prompts[2], /user's input for this stop/);
  assert.match(probe.planner.prompts[2], /Work review 1 ended in round 1/);
});

// Stage A (finding 1 of docs/gui-review.md): a work response is read-only. The hook denies the edit (test/claude.test.ts);
// these detection tests bypass the hook deliberately and show that the program halts on the change it finds.
const rejectingResponse = (step: object = {}) => ({ output: respond([["W1-R1-1", "rejected"]]), ...step });
const workResponseRun = (step: object, extraReviews: object[] = []) =>
  testLayer(tempRepo(), { steps: [planWrite("v1"), rejectingResponse(step)], reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, ...extraReviews] as never, execs: [finished] });

test("(A) a work response and its repair turn are read-only calls; the plan's calls keep their records capability", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: { not: "a response" } }, rejectingResponse()],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.planner.capabilities, ["records", "readOnly", "readOnly"]);
});

for (const [label, file, content] of [
  ["plan.md", "plan.md", "a replacement plan"],
  ["requirements.md", "requirements.md", "new requirements"],
  ["changes.diff", "work-review-1/changes.diff", "a forged diff"],
  ["checkpoint.json", "checkpoint.json", "{}"],
  ["a new file", "notes/new.md", "n"],
  ["a deleted record", "work-review-1/review-1.json", null],
] as const) {
  test(`(A) a work response that changes ${label} halts the run with RecordsChanged`, async () => {
    const { layer } = workResponseRun({ editRecord: { file, content } });
    await runFails(layer, "RecordsChanged", new RegExp(file.replace(/[.]/g, "\\.")));
  });
}

test("(A) a plan response that writes under plan-review/ is not a read-only call and passes", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["P1-R1-1", "accepted"]]), plan: "v2", editRecord: { file: "notes.md", content: "v2" } }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
});

test("(A) the program's own writes during a read-only call do not halt it: usage.jsonl and the invalid reply before a repair", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: { not: "a response" }, usage: true }, rejectingResponse({ usage: true })],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
});

test("(A, Q1) the work response of round 2 receives the round-2 review, the round-1 log entry and the current changes.diff", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), rejectingResponse(), { output: respond([["W1-R2-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1", "first problem")] }, { issues: [issue("W1-R2-1", "second problem")] }, { issues: [] }],
    execs: [finished],
    answers: [""],
  });
  assert.equal(await runTask(layer), 1);
  const prompt = probe.planner.prompts[2];
  assert.ok(prompt.includes("second problem"), "the round-2 review");
  assert.ok(prompt.includes("rationale W1-R1-1"), "the round-1 log entry");
  assert.ok(prompt.includes(read(probe.dir, "work-review-1/changes.diff")), "the current changes.diff");
  assert.match(prompt, /\+implemented/);
});

// W1-R1-1: behaviour 12 names the two halts separately; a project change during a read-only response is ProjectChanged.
test("(A) a work response that changes the project halts the run with ProjectChanged, not RecordsChanged", async () => {
  const { layer } = workResponseRun({ touchProject: true });
  await runFails(layer, "ProjectChanged");
});

// Issue #26 (plan step S19): the work review's Codex turn and its read-only response are retried; the guards hold their
// baselines across the attempts, and the records guard accounts for the program's own writes through the journal.
import * as prompts from "../src/prompts.ts";
import type { Config } from "../src/schema.ts";

const fault = "stream disconnected before completion";
const quick: Partial<Config> = { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 };
const duringBackoff = (effect: () => void) => (s: StoreShape): StoreShape => ({
  ...s,
  converse: (markdown) => s.converse(markdown).pipe(Effect.tap(() => Effect.sync(() => (markdown.includes("connection lost, retry") ? effect() : undefined)))),
});
const conversation = (repo: string) => path.join(repo, "plan-review", TEST_ROOT, "conversation.md");

test("(d, #26) changes.diff edited during the exhaustion pause, then Retry again: ReviewedFileChanged, and no further turn", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1")],
    reviews: [{ issues: [] }, { issues: [], fault }, { issues: [], fault }, { issues: [] }],
    execs: [finished],
    answers: [{ text: prompts.TRANSPORT_ANSWERS.retry, before: () => fs.appendFileSync(path.join(repo, "plan-review", TEST_ROOT, "work-review-1", "changes.diff"), "forged\n") }],
    config: quick,
  });
  await runFails(layer, "ReviewedFileChanged");
  assert.equal(probe.reviewer.prompts.length, 3);
});

test("(g, #26) a read-only work response that faults is retried and succeeds, though the retry line was written meanwhile", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), rejectingResponse({ fault }), rejectingResponse()],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.planner.capabilities, ["records", "readOnly", "readOnly"]);
});

test("(h, #26) a read-only work response whose retries are exhausted, then Help me decide, then Retry again: it succeeds", async () => {
  const columns = [prompts.TRANSPORT_RETRY_AGAIN, prompts.TRANSPORT_STOP].map((option) => ({ kind: "argued", option, advantages: [], disadvantages: [] }));
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), rejectingResponse({ fault }), rejectingResponse({ fault }), { output: { decision: "d", columns, recommendation: { option: "", reason: "" } } }, rejectingResponse()],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    answers: ["/decide", prompts.TRANSPORT_ANSWERS.retry],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.ok(fs.existsSync(path.join(probe.dir, "decision-1", "analysis.json")));
  assert.ok(probe.ui.notified.some((e) => e._tag === "DecisionAnalyzed"));
});

test("(i, #26) an external edit of conversation.md during the backoff, after the retry line: RecordsChanged", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), rejectingResponse({ fault }), rejectingResponse()],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
    config: quick,
    store: duringBackoff(() => fs.appendFileSync(conversation(repo), "an outside edit\n")),
  });
  await runFails(layer, "RecordsChanged", /conversation\.md/);
  assert.equal(probe.planner.prompts.length, 2);
});

test("(j, #26) an external edit of conversation.md during the exhaustion pause, before the answer is appended: RecordsChanged", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), rejectingResponse({ fault }), rejectingResponse({ fault }), rejectingResponse()],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
    answers: [{ text: prompts.TRANSPORT_ANSWERS.retry, before: () => fs.appendFileSync(conversation(repo), "an outside edit\n") }],
    config: quick,
  });
  await runFails(layer, "RecordsChanged", /conversation\.md/);
  assert.equal(probe.planner.prompts.length, 3);
});
