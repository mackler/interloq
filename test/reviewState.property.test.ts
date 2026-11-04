import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, roundCheckOf, subjectOf, type Transition } from "../src/reviewState.ts";
import { validateReview } from "../src/round.ts";
import type { Action, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";
import { lineChange } from "../src/lineChange.ts";

// Row 3 of the table in recommendation E of docs/functional-design-review.md: bounded generated event traces
// through `advance`, checked against a small independent model kept in the test.

const RUNS = { numRuns: 150, seed: 20260925 };
const setup: ReviewSetup = { subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, idNumber: 1, proceed: "proceed", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, onUnchanged: null, disputesSettledBy: "user", maxRounds: 3, maxIdleRounds: 2, countMinor: true };
const PRODUCING = new Set(["AwaitBoundary", "CallCorrective", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
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
  // Issue #243: the answers to the questions opened beside the review, given at once and read at the next boundary.
  let pending: { key: string; text: string }[] = [];
  const answerOf = (c: Extract<ReviewCommand, { kind: "OpenBeside" }>): string => {
    const q = c.beside.question;
    const script = scripts[Math.min(Math.max(currentRound - 1, 0), scripts.length - 1)];
    switch (q.kind) {
      case "limit":
        return currentRound < scripts.length ? scripts[currentRound].limitAnswer : "0";
      case "idle":
        return script.decide ? "do it" : "";
      case "unchanged":
        return script.unchangedAnswer;
      case "dispute":
        return script.decide ? "do it" : "";
    }
  };
  const opening = (commands: readonly ReviewCommand[]) => {
    for (const c of commands) if (c.kind === "OpenBeside") pending.push({ key: c.beside.key, text: answerOf(c) });
  };
  opening(t.commands);
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
        // The interpreter validates the review before the state machine sees it (issue #151); a generated review is valid.
        event = { kind: "ReviewDecoded", review, validated: Result.getOrThrow(validateReview(review)) };
        break;
      }
      case "CallPlanner": {
        plannerCalls.push(command.round);
        const ids = Array.from({ length: script.issueCount }, (_, i) => `R${command.round}-${i}`);
        const response = respond(ids.map((id, i) => [id, script.actions[i]] as [string, Action]), script.selfCorrection ? { self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "e", concern: "c", remedy: "r", resolution: null }] } : {});
        // As the interpreter does (issue #151): a response the round's validation refuses would halt after its repair turn.
        const round = roundCheckOf(t.state)(response);
        if (Result.isFailure(round)) {
          finished = "RoundInvalid";
          break;
        }
        event = { kind: "ResponseDecoded", response, round: round.success, resultText: "", costUsd: 0.2 };
        break;
      }
      case "AskDecision":
        event = { kind: "DecisionGiven", text: script.decide ? "do it" : "" };
        break;
      case "AwaitBoundary":
        event = { kind: "BoundaryReached", answers: pending };
        pending = [];
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
      opening(t.commands);
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

// Finding 9 of docs/gui-review.md: the first exit of a work review, against an independent model of behaviour 7 as
// issue #243 left it. Nothing waits: the round limit is extended at once and its question opened beside the review
// (while none is open), the idle limit restarts its count and opens its question, identical content is a line; the
// answers are read at the next round's boundary, a Stop first, then an idle decision (which leaves with revise, the work
// review leaving on a decision), then a number of cycles. An end of the loop reads the answers still to come first: a
// Stop then halts, anything else stands.
type Exit = Readonly<{ exit: "converged" | "revise" | "RoundLimitStop"; round: number; pauses: readonly string[] }>;
const model = (scripts: readonly Script[], use: ReviewSetup): Exit => {
  const scriptOf = (round: number) => scripts[Math.min(round - 1, scripts.length - 1)];
  const stops = (answer: string) => answer !== "2";
  const seen: string[] = ["h0"];
  const pauses: string[] = [];
  let limit = use.maxRounds;
  let idle = 0;
  let pending: { kind: "limit" | "idle"; text: string }[] = [];
  let limitOpen = false;
  let idleOpen = false;
  const drained = (round: number, exit: Exit["exit"]): Exit => {
    if (pending.some((p) => p.kind === "limit" && stops(p.text))) return { exit: "RoundLimitStop", round, pauses };
    return { exit, round, pauses };
  };
  for (let round = 1; round <= 60; round++) {
    if (pending.length > 0) {
      if (pending.some((p) => p.kind === "limit" && stops(p.text))) return { exit: "RoundLimitStop", round: round - 1, pauses };
      if (pending.some((p) => p.kind === "idle" && p.text !== "")) return { exit: "revise", round: round - 1, pauses };
      const count = pending.find((p) => p.kind === "limit");
      if (count !== undefined) limit = round - 1 + 2;
      if (pending.some((p) => p.kind === "limit")) limitOpen = false;
      if (pending.some((p) => p.kind === "idle")) idleOpen = false;
      pending = [];
    }
    if (round > limit) {
      limit += use.maxRounds;
      if (!limitOpen) {
        pauses.push("limit");
        limitOpen = true;
        pending.push({ kind: "limit", text: round - 1 < scripts.length ? scripts[round - 1].limitAnswer : "0" });
      }
    }
    const script = scriptOf(round);
    if (script.issueCount === 0) return drained(round, "converged");
    const accepted = script.actions.slice(0, script.issueCount).some((a) => a === "accepted" || a === "partially_accepted");
    if (accepted || script.selfCorrection) return drained(round, "revise");
    seen.push(script.hash);
    idle += 1;
    if (idle >= use.maxIdleRounds) {
      idle = 0;
      if (!idleOpen) {
        pauses.push("idle");
        idleOpen = true;
        pending.push({ kind: "idle", text: script.decide ? "do it" : "" });
      }
    }
  }
  throw new Error("the model did not end");
};
/** The pauses that the generated rounds cannot reach: their ids are unique per round, and no reference is set. */
const UNREACHABLE = /raised again|a second time|considers wrong|against the accepted correction|a repetition of|question from Claude Code/;
const pausesOf = (trace: readonly ReviewCommand[]): string[] =>
  trace.flatMap((c) => {
    if (c.kind === "OpenBeside") return [c.beside.question.kind === "dispute" ? subjectOf("", c.beside.question.dispute.asks) : c.beside.question.kind];
    if (c.kind !== "AskDecision") return [];
    return [subjectOf("", c.asks)];
  });

test("property: a work review's first exit, its round and its pauses equal the independent model's", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { finished, state, trace } = drive(scripts, workSetup);
      const expected = model(scripts, workSetup);
      assert.equal(finished, expected.exit);
      assert.equal(state.round, expected.round, "the exit's round");
      assert.deepEqual(pausesOf(trace), expected.pauses);
      for (const p of pausesOf(trace)) assert.doesNotMatch(p, UNREACHABLE, "a pause the generator cannot reach occurred");
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
      // Issue #243: the boundary's answers are read before the end, and an answer after it is only recorded.
      assert.deepEqual(after.filter((k) => k !== "Notify" && k !== "AwaitBoundary" && k !== "Converse"), ["Finish"], `after the logged checkpoint: ${after}`);
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
  for (const k of ["exit:converged", "exit:revise", "exit:RoundLimitStop", "idle", "limit"]) assert.ok((reached.get(k) ?? 0) > 0, `never reached: ${k}`);
  assert.ok((reached.get("round 2") ?? 0) >= samples.length / 5, `only ${reached.get("round 2")} of ${samples.length} traces reached round 2`);
});

// Issue #208: a response that accepts nothing and corrects nothing, with the file changed, asks nothing, and the next
// review carries the change as lineChange measures it from the round's start.
test("property: an unexplained change is never asked, and the next review carries its measured change", () => {
  const line = fc.constantFrom("a", "b", "c", "d", "");
  const text = fc.array(line, { maxLength: 6 }).map((ls) => ls.join("\n"));
  fc.assert(
    fc.property(fc.tuple(text, text).filter(([a, b]) => a !== b), ([before, after]) => {
      const config = { maxRounds: 5, maxIdleRounds: 5, countMinor: true };
      const begun = advance(initialState(setup, config), { kind: "Begin", hash: "h0", text: before, log: [] });
      const review: Review = { issues: [issue("A")] };
      const reviewed = advance(begun.state, { kind: "ReviewDecoded", review, validated: Result.getOrThrow(validateReview(review)) });
      const response = respond([["A", "rejected"]]);
      const responded = advance(reviewed.state, { kind: "ResponseDecoded", response, round: Result.getOrThrow(roundCheckOf(reviewed.state)(response)), resultText: "", costUsd: null });
      const observed = advance(responded.state, { kind: "FileObserved", hash: "h1", text: after });
      assert.ok(!observed.commands.some((c) => c.kind === "AskDecision"));
      const next = observed.commands.at(-1);
      assert.equal(next?.kind, "CallReviewer");
      const { added, removed } = lineChange(before, after);
      if (next?.kind === "CallReviewer") assert.deepEqual(next.unexplained, { fileLabel: "plan.md", heading: "Planning phase 1", round: 1, added, removed });
    }),
    RUNS,
  );
});
