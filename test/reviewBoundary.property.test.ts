// Issue #243: no transition of the review loop waits for an answer. A limit, the idle limit, an accepted point that left
// the file unchanged and a disputed pause are opened beside the review, and the review goes on; their answers are read
// at a round's boundary and never waited for. Driven with fast-check over generated reviews and responses.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, roundCheckOf, type Transition } from "../src/reviewState.ts";
import { validateReview } from "../src/round.ts";
import type { Action, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

const PRODUCING = new Set(["AwaitBoundary", "CallCorrective", "CallInvestigation", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
const ACTIONS: readonly Action[] = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"];

/** `resolution` (issue #38): the resolution each disposition not accepted in full carries, none, an agreed one, or one only the developer may authorize. */
type Round = Readonly<{ fresh: number; reraise: boolean; actions: readonly Action[]; selfReject: boolean; changed: boolean; resolution: "none" | "agreed" | "authority" }>;
const arbRound: fc.Arbitrary<Round> = fc.record({
  fresh: fc.integer({ min: 1, max: 2 }),
  reraise: fc.boolean(),
  actions: fc.array(fc.constantFrom(...ACTIONS), { minLength: 3, maxLength: 3 }),
  selfReject: fc.boolean(),
  changed: fc.boolean(),
  resolution: fc.constantFrom("none" as const, "agreed" as const, "authority" as const),
});
const arbSetup: fc.Arbitrary<ReviewSetup> = fc
  .record({
    disputesSettledBy: fc.constantFrom("user" as const, "agents" as const, "noWorkEffect" as const),
    onUnchanged: fc.constantFrom("corrective" as const, "pause" as const, null),
    leave: fc.boolean(),
    maxRounds: fc.integer({ min: 1, max: 3 }),
    maxIdleRounds: fc.integer({ min: 1, max: 3 }),
  })
  .map(({ disputesSettledBy, onUnchanged, leave, maxRounds, maxIdleRounds }) => ({
    subject: leave ? { work: 1 } : { plan: 1 },
    heading: "H",
    fileLabel: "f",
    dirName: "d",
    phase: 1,
    idNumber: 1,
    proceed: leave ? null : "proceed",
    hasAmend: onUnchanged === "pause",
    onAcceptance: leave ? "leave" : "continue",
    leaveOnDecision: leave,
    onUnchanged: leave ? null : onUnchanged,
    disputesSettledBy,
    maxRounds,
    maxIdleRounds,
    countMinor: true,
  }));
type Answer = Readonly<{ text: string; after: number }>;
const arbAnswer: fc.Arbitrary<Answer> = fc.record({ text: fc.constantFrom("", "p", "0", "2", "retry", "proceed", "stop", "Claude Code's position", "do it"), after: fc.integer({ min: 0, max: 3 }) });

type Drive = Readonly<{ finished: string; trace: readonly ReviewCommand[]; last: number; problems: readonly string[]; delivered: ReadonlySet<string> }>;
/**
 * Drives the loop over `rounds` (then a review with no counted issue). `answers`, where given, answer the questions
 * opened beside the review in their order, each given `after` boundaries later; otherwise no answer is ever given.
 */
const drive = (setup: ReviewSetup, rounds: readonly Round[], answers: readonly Answer[] | null): Drive => {
  const config = { maxRounds: setup.maxRounds, maxIdleRounds: setup.maxIdleRounds, countMinor: true };
  let t: Transition = advance(initialState(setup, config), { kind: "Begin", hash: "h0", text: "", log: [] });
  const trace: ReviewCommand[] = [];
  const problems: string[] = [];
  let boundaries = 0;
  let hash = 0;
  let opened = 0;
  const given: { key: string; text: string; at: number }[] = [];
  const delivered = new Set<string>();
  const closed = new Set<string>();
  const open = new Set<string>();
  let lastEvent: ReviewEvent["kind"] | null = null;
  const look = (commands: readonly ReviewCommand[]) => {
    trace.push(...commands);
    for (const c of commands) {
      if (c.kind === "OpenBeside") {
        open.add(c.beside.key);
        const a = answers?.[opened];
        opened += 1;
        if (a !== undefined) given.push({ key: c.beside.key, text: a.text, at: boundaries + a.after });
      }
      if (c.kind === "CloseBeside") {
        if (delivered.has(c.key)) problems.push(`closed after its answer was read: ${c.key}`);
        if (given.some((g) => g.key === c.key && g.at < boundaries && !delivered.has(c.key))) problems.push(`closed while holding an answer: ${c.key}`);
        closed.add(c.key);
        open.delete(c.key);
      }
      if (c.kind === "AskDecision") problems.push("a question waited for an answer");
      if (c.kind === "Finish" && open.size > 0 && lastEvent !== "BoundaryReached") problems.push("an end with questions open, not after a boundary");
    }
  };
  look(t.commands);
  for (let guard = 0; guard < 600; guard++) {
    const command = t.commands.filter((c) => PRODUCING.has(c.kind))[0];
    if (command === undefined) throw new Error("a batch without an event command");
    let event: ReviewEvent | undefined;
    switch (command.kind) {
      case "Finish":
        return { finished: command.result, trace, last: t.state.round, problems, delivered };
      case "Halt":
        return { finished: command.error._tag, trace, last: t.state.round, problems, delivered };
      case "CallReviewer": {
        const r = rounds[command.round - 1];
        const ids = r === undefined ? [] : Array.from({ length: r.fresh }, (_, i) => `R${command.round}-${i}`);
        const earlier = r?.reraise === true && command.round > 1 ? [`R${command.round - 1}-0`] : [];
        const review: Review = { issues: [...earlier, ...ids].map((id) => issue(id)) };
        event = { kind: "ReviewDecoded", review, validated: Result.getOrThrow(validateReview(review)) };
        break;
      }
      case "CallPlanner":
      case "CallCorrective":
      case "CallInvestigation": {
        const r = rounds[t.state.round - 1]!;
        const ids = t.state.current.review!.issues.map((i) => i.id);
        const selfId = t.state.log.find((e) => e.source === "review" && e.action === "accepted")?.id;
        const resolution = r.resolution === "none" ? null : { text: "meet both concerns", changes: r.resolution === "authority" ? ["requirement 1"] : [] };
        const base = respond(
          ids.map((id, i) => [id, r.actions[i % 3]!] as [string, Action]),
          r.selfReject && selfId !== undefined ? { self_corrections: [{ id: selfId, new_action: "rejected" as const, explanation: "e", concern: "c", remedy: "m", resolution }] } : {},
        );
        const response = { ...base, dispositions: base.dispositions.map((d) => (d.action === "accepted" ? d : { ...d, concern: "c", remedy: "m", resolution })) };
        const round = roundCheckOf(t.state)(response);
        fc.pre(Result.isSuccess(round));
        if (Result.isFailure(round)) throw new Error("unreachable");
        event = { kind: command.kind === "CallPlanner" ? "ResponseDecoded" : command.kind === "CallCorrective" ? "CorrectionDecoded" : "InvestigationDecoded", response, round: round.success, resultText: "", costUsd: null };
        break;
      }
      case "AskDecision":
        event = { kind: "DecisionGiven", text: "" };
        break;
      case "AwaitBoundary": {
        const ready = given.filter((g) => g.at <= boundaries && !delivered.has(g.key) && !closed.has(g.key));
        for (const g of ready) {
          delivered.add(g.key);
          open.delete(g.key);
        }
        boundaries += 1;
        event = { kind: "BoundaryReached", answers: ready.map((g) => ({ key: g.key, text: g.text })) };
        break;
      }
      case "ApplyDecisions":
        event = { kind: "DecisionsApplied" };
        break;
      case "Amend":
        event = { kind: "Amended" };
        break;
      case "ObserveFile": {
        const r = rounds[t.state.round - 1];
        if (r?.changed === true) hash += 1;
        event = { kind: "FileObserved", hash: `h${hash}`, text: `${hash}` };
        break;
      }
    }
    if (event === undefined) throw new Error("no event");
    lastEvent = event.kind;
    t = advance(t.state, event);
    look(t.commands);
  }
  throw new Error("the loop did not end within the bound");
};

test("property: with no answer given, nothing waits, and the loop ends converged at the last review or leaves for a revision", () => {
  fc.assert(
    fc.property(arbSetup, fc.array(arbRound, { minLength: 1, maxLength: 25 }), (setup, rounds) => {
      const { finished, last, problems } = drive(setup, rounds, null);
      assert.deepEqual(problems, []);
      if (setup.onAcceptance === "leave" && finished === "revise") return;
      assert.equal(finished, "converged");
      assert.equal(last, rounds.length + 1, "converged at the review with no counted issue");
    }),
    { numRuns: 200, seed: 243 },
  );
});

test("property: with answers given at random later boundaries, none is lost: no question holding an answer is closed, and no end leaves one unread", () => {
  fc.assert(
    fc.property(arbSetup, fc.array(arbRound, { minLength: 1, maxLength: 12 }), fc.array(arbAnswer, { maxLength: 12 }), (setup, rounds, answers) => {
      const { finished, trace, problems, delivered } = drive(setup, rounds, answers);
      assert.deepEqual(problems, []);
      // A dispute answer read at a boundary is acknowledged, unless the loop left it to the run (a revision, proceeding
      // or a halt), or another answer at the same boundary ended the loop first.
      const disputes = trace.flatMap((c) => (c.kind === "OpenBeside" && c.beside.question.kind === "dispute" ? [c.beside.key] : []));
      const acknowledged = new Set(trace.flatMap((c) => (c.kind === "AcknowledgeDisputes" ? c.keys : [])));
      const unacknowledged = disputes.filter((k) => delivered.has(k) && !acknowledged.has(k));
      if (unacknowledged.length > 0) assert.notEqual(finished, "converged", `answered disputes never acknowledged: ${unacknowledged}`);
    }),
    { numRuns: 200, seed: 2430 },
  );
});
