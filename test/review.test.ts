import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer, Result } from "effect";
import { UserStopped } from "../src/errors.ts";
import { decodeValidating, decodeWithRepair, planningCall, type Repair } from "../src/review.ts";
import { Planner } from "../src/services.ts";
import { noDecider, pathsOf, ScriptedPlanner, ScriptedUi, questionOf , TEST_ROOT } from "./helpers.ts";
import * as S from "../src/schema.ts";
import { Decider, REVIEW_PURPOSE, RunConfig, RunKind, Store, type StoreShape, Ui } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

const store = async (): Promise<StoreShape> => {
  const s = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  return s;
};

// Finding 22 of docs/functional-design-review.md: keeping an invalid reply serialized it with JSON.stringify
// outside any error channel, so a reply with a BigInt or a cycle was a defect instead of a repair turn.
for (const [what, reply] of [["a BigInt", { questions_for_user: 1n }], ["a cycle", (() => { const c: Record<string, unknown> = { questions_for_user: "x" }; c.self = c; return c; })()]] as const) {
  test(`an invalid reply containing ${what} is kept with the serialization failure named, and the repair turn runs`, async () => {
    const s = await store();
    const prompts: string[] = [];
    const repair = (r: Repair) => Effect.sync(() => (prompts.push(r.prompt), { questions_for_user: [] }));
    const output = await Effect.runPromise(decodeWithRepair("claude", S.PlanWriteResult, reply, repair).pipe(Effect.provide(Layer.succeed(Store, s))));
    assert.deepEqual(output, { questions_for_user: [] });
    assert.equal(prompts.length, 1, "the repair turn did not run");
    assert.match(fs.readFileSync(path.join(s.dir, "invalid-replies", "claude-1.json"), "utf8"), /reply not serializable/);
  });
}

// Plan step 3.4 (finding 25): the repair is reported in the result instead of being tracked in a mutable binding.
test("planningCall reports whether a repair turn was needed", async () => {
  const repo = tempRepo();
  const s = await Effect.runPromise(makeStore(repo, TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  const planner = new ScriptedPlanner(pathsOf(repo), [{ output: { questions_for_user: "x" } }, { output: { questions_for_user: [] } }, { output: { questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] } }], []);
  const layer = Layer.mergeAll(Layer.succeed(Store, s), Layer.succeed(Planner, planner), Layer.succeed(Decider, noDecider), Layer.succeed(Ui, new ScriptedUi([])), Layer.succeed(RunConfig, S.defaultConfig), Layer.succeed(RunKind, { mode: "implementation" }));
  const repaired = await Effect.runPromise(planningCall("first", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.output, { questions_for_user: [] });
  const direct = await Effect.runPromise(planningCall("second", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(direct.repaired, false);
  assert.deepEqual(direct.output, { questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] });
});

// Plan step S10 (issue #30): one kind of second turn for a defective reply, the Repair, whose kind names its budget.
test("decodeValidating hands its repair a Repair of kind schema, then of kind validation, each budget once", async () => {
  const s = await store();
  const kinds: string[] = [];
  const replies: unknown[] = [{ questions_for_user: [questionOf({ context: "c", question: "q", terms: [], options: [] })] }, { questions_for_user: [] }];
  const repair = (r: Repair) => Effect.sync(() => (kinds.push(r.kind), replies.shift()));
  const validate = (v: { questions_for_user: readonly unknown[] }) =>
    v.questions_for_user.length === 0 ? Result.succeed({ value: v, notes: [] }) : Result.fail({ error: new UserStopped({ where: "x" }), repair: "no questions, please" });
  const out = await Effect.runPromise(decodeValidating("claude", S.PlanWriteResult, { questions_for_user: "x" }, repair, validate as never).pipe(Effect.provide(Layer.succeed(Store, s))));
  assert.deepEqual(out.value, { questions_for_user: [] });
  assert.deepEqual(kinds, ["schema", "validation"]);
});

// Issue #26 (plan step S19): Codex turns and planning calls are retried after a transport fault, with the guard's
// baselines taken once per call and compared after every attempt and before every retry.
import { finished, issue, respond, runFails, runTask, testLayer } from "./helpers.ts";
import * as prompts from "../src/prompts.ts";
import type { Config } from "../src/schema.ts";

const issue26 = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";
const quick: Partial<Config> = { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 };
const noQuestions = { questions_for_user: [] };
/** A store that runs `effect` right after the retry line is appended to conversation.md: during the backoff. */
const duringBackoff = (effect: () => void) => (s: StoreShape): StoreShape => ({
  ...s,
  converse: (markdown) => s.converse(markdown).pipe(Effect.tap(() => Effect.sync(() => (markdown.includes("connection lost, retry") ? effect() : undefined)))),
});

test("(a) a Codex turn that fails with the message of #26 is retried, and the run converges", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts[0], probe.reviewer.prompts[1], "the retry repeats the turn");
  assert.equal(probe.reviewer.callPhases[1], probe.reviewer.callPhases[0], "the retry is in the same thread");
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRetrying" && e.agent === "codex"));
  // W4-R2-1 of issue #184: the wait names the Codex turn by the purpose the Codex adapter announces (test/codex.test.ts).
  assert.ok(probe.ui.notified.filter((e) => e._tag === "TransportRetrying").every((e) => e._tag === "TransportRetrying" && e.purpose === REVIEW_PURPOSE));
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRecovered"));
  assert.ok(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8").includes(prompts.transportRetryLine("codex", 1, 1, 0.01, issue26)));
});

test("(b) a project change during the failed turn halts with ProjectChanged, and there is no retry", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], fault: issue26, touchProject: true }], config: quick });
  await runFails(layer, "ProjectChanged");
  assert.equal(probe.reviewer.prompts.length, 1);
});

test("(c) a project change during the backoff halts with ProjectChanged before a second attempt", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [] }],
    config: quick,
    store: duringBackoff(() => fs.appendFileSync(path.join(repo, "a.txt"), "outside\n")),
  });
  await runFails(layer, "ProjectChanged");
  assert.equal(probe.reviewer.prompts.length, 1);
});

test("(e) a transport fault, then an invalid reply: one schema repair turn, then success", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [], raw: "not a review" }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts.length, 4);
});

test("(f) a planning call that faults and then succeeds: the same prompt again, in the same session", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, fault: "read ECONNRESET" }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[0], probe.planner.prompts[1]);
  assert.ok(probe.ui.notified.some((e) => e._tag === "TransportRetrying" && e.agent === "claude"));
});

test("(k) Stop at the exhaustion pause halts with AgentUnreachable, and the checkpoint is the last committed transition", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [], fault: issue26 }, { issues: [], fault: issue26 }],
    answers: [prompts.TRANSPORT_ANSWERS.stop],
    config: quick,
  });
  await runFails(layer, "AgentUnreachable", /Codex could not be reached after 2 attempts/);
  assert.equal(probe.ui.asked[0], prompts.withOffer(prompts.transportPrompt));
  const { readCheckpoint } = await import("../src/records.ts");
  const checkpoint = await Effect.runPromise(readCheckpoint(probe.dir).pipe(Effect.provide(platformLayer)));
  // The halt comes during the first review, before any transition of planning 1 was committed.
  assert.deepEqual([checkpoint?.subject, checkpoint?.stage], ["run", "started"]);
});

test("(l) a corrective turn that faults and then succeeds: the loop continues, and the corrective budget is spent once", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]) },
      { output: respond([["P1-R1-1", "accepted"]]), fault: "read ECONNRESET" },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: quick,
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts[2], prompts.correctivePrompt(TEST_ROOT, "plan.json", 1, ["P1-R1-1"]));
  assert.equal(probe.planner.prompts[3], probe.planner.prompts[2], "the retry repeats the corrective turn");
  assert.deepEqual(probe.ui.asked, []);
});

// Issue #156: a marked disagreement asks which reading of the task the work should follow, with the program's context
// saying that it is about what the task requires; an unmarked one asks as before. The options are the two positions.
test("decisionDraft asks a marked disagreement as a reading of the task, and an unmarked one as before", async () => {
  const { decisionDraft } = await import("../src/review.ts");
  const { programContext } = await import("../src/offer.ts");
  const { piecesText, blocksText } = await import("../src/pieces.ts");
  const options = [{ label: prompts.REVIEWER_POSITION, description: "Drop Q1." }, { label: prompts.PLANNER_POSITION, description: "Keep Q1." }];
  const facts = (taskDispute: boolean) => ({ pause: "reraised" as const, id: "Q-R1-1", history: [], issue: null, taskDispute, effects: null });
  const markedDraft = decisionDraft("Question review", { kind: "pause", facts: facts(true) }, options, null);
  assert.equal(piecesText(markedDraft.question), prompts.TASK_DISPUTE_QUESTION);
  assert.deepEqual(markedDraft.context, { blocks: [{ kind: "paragraph", pieces: [{ text: prompts.taskDisputeContext("Question review"), ref: "", code: false }] }], by: "program" });
  const plainDraft = decisionDraft("Question review", { kind: "pause", facts: facts(false) }, options, null);
  assert.equal(piecesText(plainDraft.question), prompts.pauseQuestion({ pause: "reraised", id: "Q-R1-1" }));
  assert.deepEqual(plainDraft.context, programContext(plainDraft.origin));
  assert.deepEqual(markedDraft.options.map((o) => o.label), plainDraft.options.map((o) => o.label));
  // Issue #159: both keep the record labels and show the outcome labels.
  for (const draft of [markedDraft, plainDraft]) {
    assert.deepEqual(draft.options.map((o) => o.label), [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION]);
    const { reviewer, planner } = prompts.positionLabels("reraised");
    assert.deepEqual(draft.options.map((o) => piecesText(o.shown.label)), [reviewer, planner]);
  }
  assert.ok(blocksText(markedDraft.context.blocks).join("").includes("Question review"));
});

// Issue #159: every kind of disputed pause shows outcome labels naming no agent, and keeps the record labels.
test("decisionDraft shows the outcome labels of every disputed pause, naming no agent", async () => {
  const { decisionDraft } = await import("../src/review.ts");
  const { presentedQuestion } = await import("../src/offer.ts");
  const { piecesText } = await import("../src/pieces.ts");
  const options = [{ label: prompts.REVIEWER_POSITION, description: "Drop Q1." }, { label: prompts.PLANNER_POSITION, description: "Keep Q1." }];
  const base = { id: "P1-R2-1", history: [], taskDispute: false };
  const factsOf = (kind: prompts.DisputedPauseKind): import("../src/question.ts").PauseFacts => {
    switch (kind) {
      case "reraised":
        return { ...base, pause: kind, issue: null, effects: null };
      case "secondClarification":
        return { ...base, pause: kind, disposition: null, effects: null };
      case "disputedSelfCorrection":
        return { ...base, pause: kind, explanation: "wrong", effects: null };
      case "reversal":
        return { ...base, pause: kind, reverses: "P1-R1-1", issue: null, disposition: null, effects: null };
      case "repeatedUnderNewId":
        return { ...base, pause: kind, repeats: "P1-R1-1", issue: null, disposition: null, effects: null };
    }
  };
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) {
    const draft = decisionDraft("Planning 1", { kind: "pause", facts: factsOf(kind) }, options, null);
    assert.deepEqual(draft.options.map((o) => o.label), [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION], kind);
    const presented = presentedQuestion(draft, 1);
    assert.ok(Result.isSuccess(presented));
    const labels = presented.success.options.map((o) => piecesText(o.label));
    const { reviewer, planner } = prompts.positionLabels(kind);
    assert.deepEqual(labels, [reviewer, planner], kind);
    for (const label of labels) assert.equal(prompts.namesAgent(label), false, `${kind}: ${label}`);
  }
});

// Issue #159 (seam, P1-R1-1): a label the context call wrote chooses the option at its position and resolves to its
// record label; a permission request keeps its own matching (P1-R2-1).
test("a context-written label of a disputed pause chooses its position, and a permission's Allow is still chosen by y alone", async () => {
  const { positionOptions, withContext, decisionAnswerOf, permissionOptions, programContext } = await import("../src/offer.ts");
  const { plainOption } = await import("../src/pieces.ts");
  const { optionText } = await import("../src/input.ts");
  const options = positionOptions("reraised", [{ label: prompts.REVIEWER_POSITION, description: "Drop Q1." }, { label: prompts.PLANNER_POSITION, description: "Keep Q1." }]);
  const origin = { kind: "pause" as const, heading: "Planning 1", pause: "reraised" as const, id: "P1-R1-1" };
  const draft = { origin, context: programContext(origin), history: [], explanations: [], question: [], options, decision: null };
  const written = { context: programContext(origin), history: [], explanations: [], options: [plainOption("Accept the review's point", "Drop Q1."), plainOption("Leave the plan as it is now", "Keep Q1.")] };
  const rephrased = withContext(draft, written).options;
  assert.equal(rephrased[0].matches("Accept the review's point"), true);
  assert.equal(rephrased[1].matches("Leave the plan as it is now"), true);
  assert.equal(rephrased[0].matches("Leave the plan as it is now"), false);
  assert.equal(decisionAnswerOf("Leave the plan as it is now", rephrased), prompts.PLANNER_POSITION);
  assert.equal(decisionAnswerOf(prompts.positionLabels("reraised").reviewer, rephrased), prompts.REVIEWER_POSITION);
  assert.equal(decisionAnswerOf("2", rephrased), optionText(rephrased[1]));
  assert.equal(decisionAnswerOf("something else", rephrased), "something else");
  const permOrigin = { kind: "permission" as const, tool: "Bash", input: "ls" };
  const permDraft = { origin: permOrigin, context: programContext(permOrigin), history: [], explanations: [], question: [], options: permissionOptions, decision: null };
  const permWritten = { context: programContext(permOrigin), history: [], explanations: [], options: [plainOption("Let Claude Code run the command", "x"), plainOption("Refuse it", "y")] };
  const perm = withContext(permDraft, permWritten).options;
  assert.equal(perm[0].matches("Let Claude Code run the command"), false);
  assert.equal(perm[0].matches("y"), true);
});

// Issue #156 (W1-R1-1): where the context call cannot succeed, the marked pause keeps its own context, which says the
// disagreement is about what the task requires; the call is told what that context must say.
test("a marked pause keeps its context when the context call falls back, and the call is given the task-dispute facts", async () => {
  const { decisionDraft } = await import("../src/review.ts");
  const { askOffering, byLine, programContext } = await import("../src/offer.ts");
  const { programWritten } = await import("../src/questionContext.ts");
  const { plainBlocks } = await import("../src/pieces.ts");
  const { presentedQuestions } = await import("./helpers.ts");
  const options = [{ label: prompts.REVIEWER_POSITION, description: "Drop Q1." }, { label: prompts.PLANNER_POSITION, description: "Keep Q1." }];
  const facts = (taskDispute: boolean) => ({ pause: "reraised" as const, id: "Q-R1-1", history: [], issue: null, taskDispute, effects: null });
  const asked = async (taskDispute: boolean) => {
    const { layer, probe } = testLayer(tempRepo(), { answers: ["1"] });
    const requests: prompts.ContextRequest[] = [];
    const decider = { ...noDecider, explain: (request: prompts.ContextRequest) => Effect.sync(() => (requests.push(request), programWritten(request))) };
    const draft = decisionDraft("Question review", { kind: "pause", facts: facts(taskDispute) }, options, null);
    await Effect.runPromise(Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering(byLine((p) => ui.ask(p)), prompts.decisionPrompt, draft);
    }).pipe(Effect.provideService(Decider, decider), Effect.provide(layer)));
    return { draft, requests, presented: presentedQuestions(probe.ui)[0] };
  };
  const marked = await asked(true);
  assert.deepEqual(marked.presented.context, { blocks: plainBlocks(prompts.taskDisputeContext("Question review")), by: "program" });
  assert.equal(marked.requests[0].facts, prompts.TASK_DISPUTE_CONTEXT_FACTS);
  // The seam: the prompt the context call is given carries the facts.
  assert.ok(prompts.contextPrompt("t", marked.requests[0]).includes(prompts.TASK_DISPUTE_CONTEXT_FACTS));
  const unmarked = await asked(false);
  assert.deepEqual(unmarked.presented.context, programContext(unmarked.draft.origin));
  assert.equal(unmarked.requests[0].facts, "");
  assert.ok(!prompts.contextPrompt("t", unmarked.requests[0]).includes("Facts for your understanding"));
});

// Issue #183: the work subject's review is decoded with the effect review, so its issues keep Codex's statement.
test("a work review's issue keeps Codex's statement of its effect on the work in the round record", async () => {
  const noQuestions = { questions_for_user: [] };
  const stated = { ...issue("W1-R1-1"), [S.WORK_EFFECT_FIELD]: { kind: "none" } } as S.Issue;
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [stated] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  const round = JSON.parse(fs.readFileSync(path.join(probe.dir, "work-review-1/round-1.json"), "utf8"));
  assert.deepEqual(round.review.issues[0].workEffect, { kind: "none" });
  assert.deepEqual(round.response.dispositions[0].workEffect, { kind: "differs", difference: "scripted" });
});

// Issue #183 (seam): the answer "2" and the planner's label, through askDecisionQuestion and decisionDraft, keep the work
// review going instead of leaving for a planning phase.
for (const answer of ["2", prompts.PLANNER_POSITION, prompts.positionLabels("reraised").planner]) {
  test(`a work-review dispute answered ${JSON.stringify(answer)} stays in the review`, async () => {
    const noQuestions = { questions_for_user: [] };
    const none = { kind: "none" };
    const point = (effect: unknown) => ({ ...issue("W1-R1-1"), [S.WORK_EFFECT_FIELD]: effect }) as S.Issue;
    const rejected = () => respond([], { dispositions: [{ id: "W1-R1-1", action: "rejected", rationale: "r", duplicate_of: "", reverses: "", [S.WORK_EFFECT_FIELD]: none } as S.Disposition] });
    const { layer, probe } = testLayer(tempRepo(), {
      config: { maxIdleRounds: 5 },
      answers: [answer],
      steps: [{ output: noQuestions, plan: "v1" }, { output: rejected() }, { output: rejected() }],
      reviews: [{ issues: [] }, { issues: [point(none)] }, { issues: [point({ kind: "differs", difference: "a file changes" })] }, { issues: [] }],
      execs: [finished],
    });
    assert.equal(await runTask(layer), 1, "one execution phase: no plan revision");
    assert.ok(probe.ui.notified.some((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "pause"));
  });
}

// Issue #159 (P1-R1-1): a planner label the context call wrote, typed, keeps the work review going as "2" does.
test("a work-review dispute answered with the context call's own planner label stays in the review", async () => {
  const { scriptedContextReply } = await import("./helpers.ts");
  const { plainPieces } = await import("../src/pieces.ts");
  const leave = "Leave the work as it is now";
  const noQuestions = { questions_for_user: [] };
  const none = { kind: "none" };
  const point = (effect: unknown) => ({ ...issue("W1-R1-1"), [S.WORK_EFFECT_FIELD]: effect }) as S.Issue;
  const rejected = () => respond([], { dispositions: [{ id: "W1-R1-1", action: "rejected", rationale: "r", duplicate_of: "", reverses: "", [S.WORK_EFFECT_FIELD]: none } as S.Disposition] });
  const relabel = (prompt: string) => {
    const reply = scriptedContextReply(prompt);
    return { ...reply, options: reply.options.map((o, i) => ({ ...o, label: plainPieces(i === 0 ? "Correct the work as the point asks" : leave) })) };
  };
  const { layer, probe } = testLayer(tempRepo(), {
    config: { maxIdleRounds: 5 },
    answers: [leave],
    contexts: [{ output: relabel }],
    steps: [{ output: noQuestions, plan: "v1" }, { output: rejected() }, { output: rejected() }],
    reviews: [{ issues: [] }, { issues: [point(none)] }, { issues: [point({ kind: "differs", difference: "a file changes" })] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1, "one execution phase: no plan revision");
  const { piecesText } = await import("../src/pieces.ts");
  const asked = probe.ui.notified.flatMap((e) => (e._tag === "QuestionPresented" && e.question.origin.kind === "pause" ? [e.question] : []));
  assert.equal(piecesText(asked[0].options[1].label), leave);
});
