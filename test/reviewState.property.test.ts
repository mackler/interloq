import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, subjectOf, type Transition } from "../src/reviewState.ts";
import type { Action, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

// Row 3 of the table in recommendation E of docs/functional-design-review.md: bounded generated event traces
// through `advance`, checked against a small independent model kept in the test.

const RUNS = { numRuns: 150, seed: 20260925 };
const setup: ReviewSetup = { subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, idNumber: 1, proceed: "proceed", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, onUnchanged: null, disputesSettledBy: "user", maxRounds: 3, maxIdleRounds: 2, countMinor: true };
const PRODUCING = new Set(["AskLimit", "AskUnchanged", "CallCorrective", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
const ACTIONS: readonly Action[] = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"];

/** One generated round: its review, the actions of the response, whether a self-correction is included, and the world's answers. */
type Script = { issueCount: number; actions: readonly Action[]; selfCorrection: boolean; hash: string; decide: boolean; limitAnswer: "p" | "0" | "2"; unchangedAnswer: "proceed" | "stop" };
const arbScript: fc.Arbitrary<Script> = fc.record(
  {
    issueCount: fc.integer({ min: 0, max: 3 }),
    // Weighted towards rounds without a correction, so that traces reach later rounds and the hash pauses (finding 9).
    actions: fc.array(fc.oneof({ arbitrary: fc.constantFrom(...ACTIONS), weight: 1 }, { arbitrary: fc.constantFrom<Action>("rejected", "no_change_needed"), weight: 2 }), { minLength: 3, maxLength: 3 }),
    selfCorrection: fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
    hash: fc.constantFrom("h0", "h1", "h2", "h3"),
    decide: fc.boolean(),
    limitAnswer: fc.constantFrom("p", "0", "2"),
    // Issue #30: the pause of an accepted issue with the file unchanged (Retry would repeat the same observation here).
    unchangedAnswer: fc.constantFrom("proceed", "stop"),
  },
  { noNullPrototype: true },
);

/** Drives `advance` with scripted answers until it finishes or halts, recording what the model needs. */
const drive = (scripts: readonly Script[], use: ReviewSetup = setup) => {
  const config = { maxRounds: use.maxRounds, maxIdleRounds: use.maxIdleRounds, countMinor: true };
  let t: Transition = advance(initialState(use, config), { kind: "Begin", hash: "h0", text: "", log: [] });
  const trace: ReviewCommand[] = [...t.commands];
  const reviewerCalls: number[] = [];
  const plannerCalls: number[] = [];
  let finished: string | null = null;
  let currentRound = 0;
  for (let guard = 0; guard < 400 && finished === null; guard++) {
    const producing = t.commands.filter((c) => PRODUCING.has(c.kind));
    assert.ok(producing.length <= 1 && (producing.length === 0 || t.commands[t.commands.length - 1] === producing[0]), "a batch with a misplaced event command");
    const command: ReviewCommand | undefined = producing[0];
    if (command === undefined) throw new Error("a batch without an event command");
    // Finding 9 of docs/gui-review.md: each command takes the script of the round it belongs to. The reviewer and
    // the planner name their round; the pauses and the observation belong to the round in progress; the limit
    // prompt takes the script of the round that would start, or "0" (stop) once the scripts are used up.
    const scriptOf = (round: number) => scripts[Math.min(Math.max(round - 1, 0), scripts.length - 1)];
    const script = scriptOf(command.kind === "CallReviewer" || command.kind === "CallPlanner" ? command.round : currentRound);
    let event: ReviewEvent | null = null;
    switch (command.kind) {
      case "Halt":
      case "Finish":
        finished = command.kind === "Finish" ? command.result : command.error._tag;
        break;
      case "CallReviewer": {
        currentRound = command.round;
        reviewerCalls.push(command.round);
        const review: Review = { issues: Array.from({ length: script.issueCount }, (_, i) => issue(`R${command.round}-${i}`)) };
        event = { kind: "ReviewDecoded", review };
        break;
      }
      case "CallPlanner": {
        plannerCalls.push(command.round);
        const ids = Array.from({ length: script.issueCount }, (_, i) => `R${command.round}-${i}`);
        const response = respond(ids.map((id, i) => [id, script.actions[i]] as [string, Action]), script.selfCorrection ? { self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "e" }] } : {});
        event = { kind: "ResponseDecoded", response, resultText: "", costUsd: 0.2 };
        break;
      }
      case "AskDecision":
        event = { kind: "DecisionGiven", text: script.decide ? "do it" : "" };
        break;
      case "AskUnchanged":
        event = { kind: "UnchangedAnswer", answer: script.unchangedAnswer };
        break;
      case "AskLimit":
        event = { kind: "LimitAnswer", answer: currentRound < scripts.length ? scripts[currentRound].limitAnswer : "0" };
        break;
      case "ApplyDecisions":
        event = { kind: "DecisionsApplied" };
        break;
      case "Amend":
        event = { kind: "Amended" };
        break;
      case "ObserveFile":
        event = { kind: "FileObserved", hash: script.hash, text: "" };
        break;
    }
    if (event !== null) {
      t = advance(t.state, event);
      trace.push(...t.commands);
    }
  }
  return { state: t.state, finished, reviewerCalls, plannerCalls, trace };
};

test("property: the loop finishes only by convergence, an explicit proceed, or a typed halt, and every round has one reviewer call", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state, finished, reviewerCalls, plannerCalls } = drive(scripts);
      assert.notEqual(finished, null, "the loop did not end within the bound");
      assert.deepEqual(reviewerCalls, Array.from({ length: reviewerCalls.length }, (_, i) => i + 1), "rounds are consecutive from 1");
      for (const round of plannerCalls) assert.ok(reviewerCalls.includes(round), "a response without a review");
      if (finished === "converged") assert.equal(state.counts[state.counts.length - 1], 0, "converged with counted issues");
      assert.equal(state.counts.length, reviewerCalls.length, "one count per review");
      assert.ok(state.costs.length <= plannerCalls.length && state.costs.length >= plannerCalls.length - 1, "one cost per completed response");
    }),
    RUNS,
  );
});

test("property: observations keep their true round and stage, and idle follows the policy", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state } = drive(scripts);
      const rounds = state.observations.map((o) => o.round);
      assert.deepEqual(rounds, [...rounds].sort((a, b) => a - b), "observations are in round order");
      assert.equal(state.observations[0]?.round, 0);
      assert.ok(state.observations.every((o) => o.round <= state.round));
      assert.ok(state.idle >= 0 && state.idle < setup.maxIdleRounds + 1);
      // Round 0 is the start; every later round has one observation (response, or decision when a decision
      // changed the file), plus at most one more from the idle pause, which is a decision.
      assert.deepEqual(state.observations.filter((o) => o.round === 0).map((o) => o.stage), ["start"]);
      for (let r = 1; r <= state.round; r++) {
        const stages = state.observations.filter((o) => o.round === r).map((o) => o.stage);
        assert.ok(stages.length <= 2, `round ${r}: ${stages}`);
        if (stages.length === 2) assert.equal(stages[1], "decision");
        assert.ok(stages.every((s) => s !== "start"));
      }
    }),
    RUNS,
  );
});

test("property: the limit is respected — no reviewer call beyond the current limit without the user's extra rounds", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state, reviewerCalls } = drive(scripts);
      assert.ok(reviewerCalls.every((r) => r <= state.limit), `a round beyond the limit: ${reviewerCalls} > ${state.limit}`);
    }),
    RUNS,
  );
});

// Plan step 2.4: the policies of a work review. A correction due or a user decision ends the trace with
// revise; no round is logged twice; every logged checkpoint follows the response and the validated record.
const workSetup: ReviewSetup = { ...setup, subject: { work: 1 }, heading: "Work review 1", fileLabel: "changes.diff", dirName: "work-review-1", proceed: null, leaveOnAcceptance: true, leaveOnDecision: true };
test("property: a work review ends at the first correction due or decision, logs each round once, and writes only valid logged checkpoints", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { finished, trace, state } = drive(scripts, workSetup);
      assert.notEqual(finished, null, "the loop did not end within the bound");
      assert.notEqual(finished, "proceed", "a work review proceeded");
      const decisions = trace.filter((c) => c.kind === "RecordDecision");
      if (decisions.length > 0) assert.equal(finished, "revise", "a decision did not end the loop");
      assert.ok(decisions.length <= 1, "the loop asked again after a decision");
      const rounds = state.log.filter((e) => e.source === "review").map((e) => `${e.phase}/${e.round}/${e.id}`);
      assert.equal(new Set(rounds).size, rounds.length, "a round is in the log twice");
      trace.forEach((c, i) => {
        if (c.kind !== "Checkpoint" || c.point.stage !== "logged") return;
        const earlier = trace.slice(0, i);
        assert.ok(earlier.some((e) => e.kind === "SaveResponse" && e.round === c.point.round), "logged without the response file");
        assert.ok(earlier.some((e) => e.kind === "SaveRound" && e.record.kind === "validated" && e.record.round === c.point.round), "logged without a validated round record");
      });
    }),
    RUNS,
  );
});

// Finding 9 of docs/gui-review.md: the first exit of a work review, against an independent model of behaviour 7.
// The order of the checks after a response is that of src/reviewState.ts: the pauses of the response (none is
// reachable here, see below), the log and leaveOnAcceptance, then the observation: accepted-without-change (not
// reachable: an accepted issue leaves first), the unexplained change, the identical content, the idle pause; the round
// limit when the next round would begin. A non-empty decision at any pause leaves with revise (leaveOnDecision).
type Exit = Readonly<{ exit: "converged" | "revise" | "RoundLimitStop"; round: number; pauses: readonly string[] }>;
const model = (scripts: readonly Script[], use: ReviewSetup): Exit => {
  const scriptOf = (round: number) => scripts[Math.min(round - 1, scripts.length - 1)];
  const seen: string[] = ["h0"];
  const pauses: string[] = [];
  let limit = use.maxRounds;
  let idle = 0;
  for (let round = 1; round <= 60; round++) {
    while (round > limit) {
      pauses.push("limit");
      const answer = round - 1 < scripts.length ? scripts[round - 1].limitAnswer : "0";
      if (answer !== "2") return { exit: "RoundLimitStop", round: round - 1, pauses };
      limit += 2;
    }
    const script = scriptOf(round);
    if (script.issueCount === 0) return { exit: "converged", round, pauses };
    const accepted = script.actions.slice(0, script.issueCount).some((a) => a === "accepted" || a === "partially_accepted");
    if (accepted || script.selfCorrection) return { exit: "revise", round, pauses };
    const last = seen[seen.length - 1];
    if (script.hash !== last) {
      pauses.push("unexplained");
      if (script.decide) return { exit: "revise", round, pauses };
    }
    if (script.hash !== last && seen.includes(script.hash)) {
      pauses.push("identical");
      if (script.decide) return { exit: "revise", round, pauses };
    }
    seen.push(script.hash);
    idle += 1;
    if (idle >= use.maxIdleRounds) {
      pauses.push("idle");
      if (script.decide) return { exit: "revise", round, pauses };
      idle = 0;
    }
  }
  throw new Error("the model did not end");
};
/** The pauses that the generated rounds cannot reach: their ids are unique per round, and no reference is set. */
const UNREACHABLE = /raised again|a second time|considers wrong|against the accepted correction|a repetition of|question from Claude Code/;
const pausesOf = (trace: readonly ReviewCommand[]): string[] =>
  trace.flatMap((c) => {
    if (c.kind === "AskLimit") return ["limit"];
    if (c.kind !== "AskDecision") return [];
    return [c.asks.kind === "pause" && (c.asks.facts.pause === "unexplained" || c.asks.facts.pause === "identical" || c.asks.facts.pause === "idle") ? c.asks.facts.pause : subjectOf("", c.asks)];
  });

test("property: a work review's first exit, its round and its pauses equal the independent model's", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { finished, state, trace } = drive(scripts, workSetup);
      const expected = model(scripts, workSetup);
      assert.equal(finished, expected.exit);
      assert.equal(state.round, expected.round, "the exit's round");
      assert.deepEqual(pausesOf(trace), expected.pauses);
      for (const c of trace) if (c.kind === "AskDecision") assert.doesNotMatch(subjectOf("", c.asks), UNREACHABLE, "a pause the generator cannot reach occurred");
    }),
    RUNS,
  );
});

test("property: after a correction due, nothing follows the round's logged checkpoint but the exit", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { finished, state, trace } = drive(scripts, workSetup);
      const script = scripts[Math.min(state.round - 1, scripts.length - 1)];
      const due = script.issueCount > 0 && (script.selfCorrection || script.actions.slice(0, script.issueCount).some((a) => a === "accepted" || a === "partially_accepted"));
      if (!due || finished !== "revise") return;
      const logged = trace.findIndex((c) => c.kind === "Checkpoint" && c.point.stage === "logged" && c.point.round === state.round);
      assert.ok(logged >= 0, "no logged checkpoint in the round of the correction");
      const after = trace.slice(logged + 1).map((c) => c.kind);
      assert.deepEqual(after.filter((k) => k !== "Notify"), ["Finish"], `after the logged checkpoint: ${after}`);
    }),
    RUNS,
  );
});

test("the generated work reviews reach round 2, every reachable pause and every exit, and never halt with RoundInvalid", () => {
  const samples = fc.sample(fc.array(arbScript, { minLength: 1, maxLength: 8 }), { numRuns: 400, seed: 20260926 });
  const reached = new Map<string, number>();
  const count = (k: string) => reached.set(k, (reached.get(k) ?? 0) + 1);
  for (const scripts of samples) {
    const { finished, state, trace } = drive(scripts, workSetup);
    assert.notEqual(finished, "RoundInvalid", "the driver generated an invalid round");
    count(`exit:${finished}`);
    if (state.round >= 2) count("round 2");
    for (const p of new Set(pausesOf(trace))) count(p);
  }
  for (const k of ["exit:converged", "exit:revise", "exit:RoundLimitStop", "unexplained", "identical", "idle", "limit"]) assert.ok((reached.get(k) ?? 0) > 0, `never reached: ${k}`);
  assert.ok((reached.get("round 2") ?? 0) >= samples.length / 5, `only ${reached.get("round 2")} of ${samples.length} traces reached round 2`);
});
