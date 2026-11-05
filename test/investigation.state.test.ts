// Issue #38 (requirements Q1): the investigation before a disagreement is put to the developer, in the pure state
// machine of src/reviewState.ts: one investigation per dispute's own id, a re-raise asked after it, disputes rebuilt by
// kind, and resolutions agreed or put to the developer.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { advance as advanceState, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, roundCheckOf, settles, type Transition } from "../src/reviewState.ts";
import { validateReview, type ValidatedRound } from "../src/round.ts";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";
import { reviewEntry, selfEntry } from "./resolutionFixtures.ts";

const setupOf = (extra: Partial<ReviewSetup> = {}): ReviewSetup => ({ subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.json", dirName: "planning-1", phase: 1, idNumber: 1, proceed: "proceed", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, onUnchanged: null, disputesSettledBy: "user", maxRounds: 9, maxIdleRounds: 9, countMinor: true, ...extra });
type TestEvent =
  | Exclude<ReviewEvent, Readonly<{ kind: "ReviewDecoded" | "ResponseDecoded" | "CorrectionDecoded" | "InvestigationDecoded" }>>
  | Readonly<{ kind: "ReviewDecoded"; review: S.Review }>
  | Readonly<{ kind: "ResponseDecoded" | "CorrectionDecoded" | "InvestigationDecoded"; response: S.PlannerResponse; resultText: string; costUsd: number | null }>;
const complete = (s: ReviewState, e: TestEvent): ReviewEvent => {
  switch (e.kind) {
    case "ReviewDecoded":
      return { ...e, validated: Result.getOrThrow(validateReview(e.review)) };
    case "ResponseDecoded":
    case "CorrectionDecoded":
    case "InvestigationDecoded":
      return { ...e, round: s.current.validatedReview === null ? (null as unknown as ValidatedRound) : Result.getOrThrow(roundCheckOf(s)(e.response)) };
    default:
      return e;
  }
};
const advance = (s: ReviewState, e: TestEvent): Transition => advanceState(s, complete(s, e));
const run = (first: Transition, ...events: TestEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const begin = (log: readonly S.LogEntry[] = [], extra: Partial<ReviewSetup> = {}): Transition =>
  advance(initialState(setupOf(extra), { maxRounds: 9, maxIdleRounds: 9, countMinor: true }), { kind: "Begin", hash: "h0", text: "", log });
const reviewed = (...ids: string[]): TestEvent => ({ kind: "ReviewDecoded", review: { issues: ids.map((i) => issue(i)) } });
const responded = (r: S.PlannerResponse, kind: "ResponseDecoded" | "CorrectionDecoded" | "InvestigationDecoded" = "ResponseDecoded"): TestEvent => ({ kind, response: r, resultText: "", costUsd: 0.1 });
const observed = (hash: string): TestEvent => ({ kind: "FileObserved", hash, text: hash });
const last = (t: Transition): ReviewCommand => t.commands[t.commands.length - 1];
const asks = (t: Transition) => t.commands.flatMap((c) => (c.kind === "AskDecision" && c.asks.kind === "pause" ? [c] : []));
const says = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Say" ? [c.text] : [])).join("\n");
const text = (s: string) => s as S.PositionText;
const resolutionReply = (t: string, changes: string[] = []): S.ResolutionReply => ({ text: t, changes });
const withDisposition = (r: S.PlannerResponse, id: string, extra: Partial<S.Disposition>): S.PlannerResponse => ({ ...r, dispositions: r.dispositions.map((d) => (d.id === id ? { ...d, ...extra } : d)) });
/** One full round from its review to the next review's start: the response, then the observation of a changed file. */
const round = (t: Transition, ids: string[], r: S.PlannerResponse, hash: string): Transition => run(t, reviewed(...ids), responded(r), observed(hash));

test("a point raised again is not asked at its first re-raise: its response carries the id, and the next re-raise asks it", () => {
  const first = round(begin(), ["A"], respond([["A", "rejected"]]), "h1");
  const reraised = run(first, reviewed("A"));
  assert.deepEqual(asks(reraised), []);
  assert.deepEqual(last(reraised), { kind: "CallPlanner", round: 2, investigating: ["A"] });
  assert.match(says(reraised), new RegExp(prompts.INVESTIGATION_HEADING));
  const second = run(reraised, responded(withDisposition(respond([["A", "rejected"]]), "A", { resolution: resolutionReply("keep both steps") })), observed("h2"));
  const logged = second.state.log.filter((e) => e.id === "A" && !e.superseded).at(-1)!;
  assert.ok(logged.source === "review");
  assert.deepEqual(logged.investigations, [{ pause: "reraised", other: null }]);
  const asked = run(second, reviewed("A"));
  const [question] = asks(asked);
  assert.ok(question !== undefined, "asked at the review after the investigation");
  assert.equal(question.asks.kind === "pause" ? question.asks.facts.pause : "", "reraised");
  assert.deepEqual(question.options.map((o) => o.label), [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION, prompts.RESOLUTION_POSITION]);
});

test("in a noWorkEffect subject a re-raise both agents state changes nothing is settled after its investigation, asking nothing", () => {
  const none = { kind: "none" } as const;
  const noEffect = (id: string) => ({ ...issue(id), work_effect: none }) as S.Review["issues"][number];
  const t0 = begin([], { disputesSettledBy: "noWorkEffect" });
  const r = (action: S.Action) => ({ ...respond([["A", action]]), dispositions: respond([["A", action]]).dispositions.map((d) => ({ ...d, work_effect: none })) }) as S.PlannerResponse;
  const t1 = run(t0, { kind: "ReviewDecoded", review: { issues: [noEffect("A")] } }, responded(r("rejected")), observed("h1"));
  const t2 = run(t1, { kind: "ReviewDecoded", review: { issues: [noEffect("A")] } });
  assert.deepEqual(asks(t2), []);
  assert.match(says(t2), new RegExp(prompts.NO_WORK_EFFECT_HEADING));
});

test("a dispute that changes kind is rebuilt as what it became: a re-raise turned into a reversal is asked as one", () => {
  const t1 = round(begin(), ["A"], respond([["A", "accepted"]]), "h1");
  const t2 = round(t1, ["B"], respond([["B", "rejected"]]), "h2");
  const t3 = run(t2, reviewed("B"));
  assert.deepEqual(last(t3), { kind: "CallPlanner", round: 3, investigating: ["B"] });
  const t4 = run(t3, responded(withDisposition(respond([["B", "accepted"]]), "B", { reverses: "A" })), observed("h3"));
  const b = t4.state.log.filter((e) => e.id === "B" && !e.superseded).at(-1)!;
  assert.ok(b.source === "review");
  assert.deepEqual(b.investigations, [{ pause: "reversal", other: "A" }]);
  const [question] = asks(run(t4, reviewed("B")));
  assert.equal(question?.asks.kind === "pause" ? question.asks.facts.pause : "", "reversal");
});

test("a reversal whose investigation drops reverses and keeps the issue rejected is asked as a re-raise when raised again", () => {
  const t1 = round(begin(), ["A"], respond([["A", "accepted"]]), "h1");
  const t2 = run(t1, reviewed("B"), responded(withDisposition(respond([["B", "rejected"]]), "B", { reverses: "A" })));
  assert.equal(last(t2).kind, "CallInvestigation");
  const t3 = run(t2, responded(respond([["B", "rejected"]]), "InvestigationDecoded"), observed("h2"));
  const b = t3.state.log.filter((e) => e.id === "B" && !e.superseded).at(-1)!;
  assert.ok(b.source === "review");
  assert.deepEqual(b.investigations, [{ pause: "reraised", other: null }]);
  const [question] = asks(run(t3, reviewed("B")));
  assert.equal(question?.asks.kind === "pause" ? question.asks.facts.pause : "", "reraised");
  // With the record left stale, the ordinary re-raise rule still asks it.
  const stale = [reviewEntry("A", "accepted"), reviewEntry("B", "rejected", { round: 2, investigations: [{ pause: "reversal", other: "A" as S.IssueId }] })];
  const [fallback] = asks(run(begin(stale), reviewed("B")));
  assert.equal(fallback?.asks.kind === "pause" ? fallback.asks.facts.pause : "", "reraised");
});

test("a disputed self-correction gets its investigation turn, and is asked at the next review though Codex does not raise its id", () => {
  const disputing = { ...respond([["A", "accepted"]]), self_corrections: [{ id: "X", new_action: "rejected" as const, explanation: "wrong", concern: "c", remedy: "m", resolution: resolutionReply("both", ["requirement 2"]) }] };
  const t1 = run(begin([reviewEntry("X", "accepted")], { disputesSettledBy: "noWorkEffect" }), reviewed("A"), responded(disputing));
  assert.deepEqual(asks(t1), []);
  assert.deepEqual(last(t1), { kind: "CallInvestigation", round: 1, ids: ["X"], attempt: 1 });
  const t2 = run(t1, responded(disputing, "InvestigationDecoded"), observed("h1"));
  const [question] = asks(run(t2, reviewed("A")));
  assert.equal(question?.asks.kind === "pause" ? question.asks.facts.pause : "", "disputedSelfCorrection");
  assert.deepEqual(question?.options.map((o) => o.label), [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION, prompts.RESOLUTION_POSITION]);
  // Withdrawn by the investigation, it is not asked; turned accepted with a resolution, it is said agreed.
  const withdrawn = run(t1, responded(respond([["A", "accepted"]]), "InvestigationDecoded"), observed("h1"));
  assert.deepEqual(asks(run(withdrawn, reviewed("A"))), []);
  const agreed = run(t1, responded({ ...disputing, self_corrections: [{ ...disputing.self_corrections[0], new_action: "accepted", resolution: resolutionReply("both") }] }, "InvestigationDecoded"), observed("h1"));
  const next = run(agreed, reviewed("A"));
  assert.deepEqual(asks(next), []);
  assert.match(says(next), new RegExp(prompts.RESOLUTION_AGREED_HEADING));
});

test("a reversal deferred with an accepted disposition still naming reverses is asked when the next review raises it", () => {
  const log = [reviewEntry("A", "accepted"), reviewEntry("B", "accepted", { round: 2, reverses: "A" as S.IssueId, investigations: [{ pause: "reversal", other: "A" as S.IssueId }] })];
  const [question] = asks(run(begin(log), reviewed("B")));
  assert.equal(question?.asks.kind === "pause" ? question.asks.facts.pause : "", "reversal");
});

test("a new reversal B of an investigated, accepted A gets its own investigation turn before any question", () => {
  const log = [reviewEntry("A", "accepted", { investigations: [{ pause: "reraised", other: null }] })];
  const t = run(begin(log), reviewed("B"), responded(withDisposition(respond([["B", "rejected"]]), "B", { reverses: "A" })));
  assert.deepEqual(asks(t), []);
  assert.deepEqual(last(t), { kind: "CallInvestigation", round: 1, ids: ["B"], attempt: 1 });
});

test("a deferred repetition and a deferred second clarification are rebuilt with their own facts", () => {
  const repeat = [reviewEntry("A", "rejected"), reviewEntry("B", "accepted", { round: 2, duplicate_of: "A" as S.IssueId, investigations: [{ pause: "repeatedUnderNewId", other: "A" as S.IssueId }] })];
  const [r] = asks(run(begin(repeat), reviewed("B")));
  assert.ok(r?.asks.kind === "pause" && r.asks.facts.pause === "repeatedUnderNewId" && r.asks.facts.repeats === "A");
  const clarification = [reviewEntry("A", "clarification_requested", { investigations: [{ pause: "secondClarification", other: null }] })];
  const [c] = asks(run(begin(clarification), reviewed("A")));
  assert.equal(c?.asks.kind === "pause" ? c.asks.facts.pause : "", "secondClarification");
});

test("a dispute first arising in a corrective reply gets its own investigation turn", () => {
  const t1 = run(begin([], { onUnchanged: "corrective" }), reviewed("A"), responded(respond([["A", "accepted"]])), observed("h0"));
  assert.equal(last(t1).kind, "CallCorrective");
  const t2 = run(t1, responded({ ...respond([["A", "accepted"]]), self_corrections: [] }, "CorrectionDecoded"));
  void t2;
  const log = [reviewEntry("X", "accepted")];
  const c1 = run(begin(log, { onUnchanged: "corrective" }), reviewed("A"), responded(respond([["A", "accepted"]])), observed("h0"));
  const disputed = { ...respond([["A", "accepted"]]), self_corrections: [{ id: "X", new_action: "rejected" as const, explanation: "wrong", concern: "c", remedy: "m", resolution: null }] };
  const c2 = run(c1, responded(disputed, "CorrectionDecoded"));
  assert.deepEqual(last(c2), { kind: "CallInvestigation", round: 1, ids: ["X"], attempt: 1 });
});

test("an agreed resolution is said and asks nothing; one only the developer may authorize is asked with three options, also on a review with no counted issue", () => {
  const resolved = (changes: string[]) => [reviewEntry("A", "partially_accepted", { phase: 0, resolution: { text: text("both"), changes: changes.map(text) } })];
  const agreed = run(begin(resolved([])), reviewed("B"));
  assert.match(says(agreed), new RegExp(prompts.RESOLUTION_AGREED_HEADING));
  assert.deepEqual(asks(agreed), []);
  const authority = run(begin(resolved(["requirement 2"])), { kind: "ReviewDecoded", review: { issues: [] } });
  const [question] = asks(authority);
  assert.equal(question?.asks.kind === "pause" ? question.asks.facts.pause : "", "authorityResolution");
  assert.equal(question?.options.length, 3);
  assert.ok(question?.options[2].description.includes("requirement 2"));
  const kept = advance(authority.state, { kind: "DecisionGiven", text: prompts.PLANNER_POSITION });
  assert.deepEqual(last(kept), { kind: "Finish", result: "converged" });
  const chosen = advance(authority.state, { kind: "DecisionGiven", text: prompts.RESOLUTION_POSITION });
  assert.equal(last(chosen).kind, "CallPlanner");
});

test("the investigated disputes are seeded from the log at Begin, and settles is false for an authority resolution", () => {
  const t = begin([reviewEntry("A", "rejected", { investigations: [{ pause: "reraised", other: null }] })]);
  assert.ok(t.state.investigated.has("A"));
  const [question] = asks(run(t, reviewed("A")));
  assert.ok(question !== undefined);
  const authority = { asks: { kind: "pause" as const, facts: { pause: "authorityResolution" as const, id: "A", history: [], resolution: { text: text("t"), changes: [text("c")] }, taskDispute: false as const, effects: { reviewer: { kind: "none" as const }, planner: { kind: "none" as const } } } }, id: "A" as S.IssueId };
  for (const policy of ["user", "agents", "noWorkEffect"] as const) assert.equal(settles(policy, authority), false);
});

test("an unmarked question-list dispute is still settled by the agents, with no investigation", () => {
  const t1 = round(begin([], { subject: "questions", disputesSettledBy: "agents" }), ["Q-R1-1"], respond([["Q-R1-1", "rejected"]]), "h1");
  const t2 = run(t1, reviewed("Q-R1-1"));
  assert.deepEqual(asks(t2), []);
  assert.doesNotMatch(says(t2), new RegExp(prompts.INVESTIGATION_HEADING));
  assert.ok(t2.commands.some((c) => c.kind === "Converse" && c.markdown.includes(prompts.WORDING_DISPUTE_HEADING)));
});

test("property: a re-raised point is asked only after its investigation and a review that followed it, and never dropped", () => {
  const ACTIONS = ["accepted", "rejected", "partially_accepted", "no_change_needed"] as const;
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...ACTIONS), { minLength: 1, maxLength: 5 }), (actions) => {
      let t = begin();
      let investigatedAt: number | null = null;
      for (let k = 0; k < actions.length; k++) {
        t = run(t, reviewed("A"));
        const asked = asks(t).length > 0;
        const entry = t.state.log.filter((e) => e.id === "A" && !e.superseded).at(-1);
        const open = entry !== undefined && entry.source === "review" && entry.action !== "accepted";
        if (asked) assert.ok(investigatedAt !== null && investigatedAt < k, `asked at review ${k} without an earlier investigation`);
        if (open && !asked) {
          assert.equal(investigatedAt, null, `review ${k}: an investigated open point was dropped`);
          investigatedAt = k;
        }
        if (asked) t = advance(t.state, { kind: "DecisionGiven", text: "" });
        t = run(t, responded(respond([["A", actions[k]]])), observed(`h${k + 1}`));
      }
    }),
  );
});

test("a marked dispute whose review entry an earlier self-correction superseded keeps its mark: investigated, then asked, never settled (W1-R1-1)", () => {
  const log = [reviewEntry("Q-R1-1", "partially_accepted", { task_dispute: true, superseded: true }), selfEntry("Q-R1-1", "accepted", { round: 1 })];
  const disputing = { ...respond([["Q-R1-2", "accepted"]]), self_corrections: [{ id: "Q-R1-1", new_action: "rejected" as const, explanation: "wrong", concern: "c", remedy: "m", resolution: null }] };
  const t1 = run(begin(log, { subject: "questions", disputesSettledBy: "agents" }), reviewed("Q-R1-2"), responded(disputing));
  assert.deepEqual(last(t1), { kind: "CallInvestigation", round: 1, ids: ["Q-R1-1"], attempt: 1 });
  assert.ok(!t1.commands.some((c) => c.kind === "Converse" && c.markdown.includes(prompts.WORDING_DISPUTE_HEADING)));
  const t2 = run(t1, responded(disputing, "InvestigationDecoded"), observed("h1"));
  for (const raising of [[], ["Q-R1-1"]]) {
    const t3 = run(t2, reviewed(...raising));
    const [question] = asks(t3);
    assert.ok(question?.asks.kind === "pause" && question.asks.facts.pause === "disputedSelfCorrection", `asked, raising [${raising}]`);
    assert.equal(question.asks.facts.taskDispute, true);
    assert.ok(!t3.commands.some((c) => c.kind === "Converse" && c.markdown.includes(prompts.WORDING_DISPUTE_HEADING)));
  }
});

const savedLogs = (t: Transition) => t.commands.flatMap((c) => (c.kind === "SaveLog" ? [c.log] : []));
const kinds = (t: Transition) => t.commands.map((c) => c.kind);
const noIssues: TestEvent = { kind: "ReviewDecoded", review: { issues: [] } };

test("a decision on a review with no counted issue is logged before the loop converges, so the next loop does not ask it again (W1-R1-2)", () => {
  // (a) an authority resolution kept with Claude Code's position.
  const resolved = [reviewEntry("A", "partially_accepted", { phase: 0, resolution: { text: text("both"), changes: [text("requirement 2")] } })];
  const kept = advance(run(begin(resolved), noIssues).state, { kind: "DecisionGiven", text: prompts.PLANNER_POSITION });
  const k = kinds(kept);
  assert.ok(k.indexOf("RecordDecision") >= 0 && k.indexOf("SaveLog") > k.indexOf("RecordDecision") && k.indexOf("SaveLog") < k.indexOf("Finish"), k.join(","));
  const [logged] = savedLogs(kept);
  assert.ok(logged?.some((e) => e.id === "A" && e.source === "user"));
  const next = run(begin(logged!, { phase: 2 }), noIssues);
  assert.deepEqual(asks(next), []);
  assert.deepEqual(last(next), { kind: "Finish", result: "converged" });
  // (b) a standing disputed self-correction kept with Claude Code's position.
  const disputing = { ...respond([["A", "accepted"]]), self_corrections: [{ id: "X", new_action: "rejected" as const, explanation: "wrong", concern: "c", remedy: "m", resolution: null }] };
  const t1 = run(begin([reviewEntry("X", "accepted")]), reviewed("A"), responded(disputing), responded(disputing, "InvestigationDecoded"), observed("h1"));
  const standing = run(t1, noIssues);
  const [selfAsk] = asks(standing);
  assert.equal(selfAsk?.asks.kind === "pause" ? selfAsk.asks.facts.pause : "", "disputedSelfCorrection");
  const keptSelf = advance(standing.state, { kind: "DecisionGiven", text: prompts.PLANNER_POSITION });
  const [loggedSelf] = savedLogs(keptSelf);
  assert.ok(loggedSelf?.some((e) => e.id === "X" && e.source === "user"), kinds(keptSelf).join(","));
  assert.deepEqual(asks(run(begin(loggedSelf!, { phase: 2 }), noIssues)), []);
  // (c) an empty answer records nothing and saves no log.
  const empty = advance(run(begin(resolved), noIssues).state, { kind: "DecisionGiven", text: "" });
  assert.deepEqual(savedLogs(empty), []);
  assert.ok(!kinds(empty).includes("RecordDecision"));
});

// The second property of S6 (W1-R1-4): over generated rounds, a raised id whose current review entry is not accepted in
// full and that was investigated in an earlier round is, at that review, asked or settled, never absent from both.
const ownIdOf = (c: ReviewCommand): string | null => (c.kind === "AskDecision" && c.asks.kind === "pause" && "id" in c.asks.facts ? c.asks.facts.id : null);
test("property: an investigated open point raised again is asked or settled at that review, never absent from both", () => {
  const IDS = ["A", "B"] as const;
  const ACTIONS = ["accepted", "rejected", "partially_accepted", "no_change_needed", "clarification_requested"] as const;
  const roundArb = fc.record({
    raised: fc.subarray([...IDS], { minLength: 1 }),
    actions: fc.tuple(fc.constantFrom(...ACTIONS), fc.constantFrom(...ACTIONS)),
    reverses: fc.boolean(),
    selfCorrection: fc.option(fc.record({ id: fc.constantFrom(...IDS), action: fc.constantFrom("accepted" as const, "rejected" as const) }), { nil: null }),
  });
  fc.assert(
    fc.property(fc.array(roundArb, { minLength: 1, maxLength: 5 }), fc.constantFrom("user" as const, "agents" as const), (rounds, policy) => {
      let t = begin([], { disputesSettledBy: policy, subject: policy === "agents" ? "questions" : { plan: 1 } });
      let hash = 0;
      for (const r of rounds) {
        if (last(t).kind !== "CallReviewer") return;
        const current = (id: string) => t.state.log.filter((e) => e.id === id && !e.superseded).at(-1);
        const due = r.raised.filter((id) => {
          const e = current(id);
          // Not accepted in full as behavior 7 counts it (NOT_ACCEPTED_IN_FULL of src/issueLog.ts): a first clarification request is no dispute.
          return e !== undefined && e.source === "review" && ["rejected", "partially_accepted", "no_change_needed"].includes(e.action) && t.state.investigated.has(id);
        });
        t = run(t, reviewed(...r.raised));
        const asked = new Set<string>();
        const settledText: string[] = [];
        const collect = (x: Transition) => {
          for (const c of x.commands) if (c.kind === "Converse") settledText.push(c.markdown);
          const id = ownIdOf(last(x));
          if (id !== null) asked.add(id);
        };
        collect(t);
        while (last(t).kind === "AskDecision") {
          t = advance(t.state, { kind: "DecisionGiven", text: "" });
          collect(t);
        }
        for (const id of due) assert.ok(asked.has(id) || settledText.some((m) => m.includes(id)), `review raising [${r.raised}]: ${id} neither asked nor settled`);
        if (last(t).kind !== "CallPlanner") return;
        const plain = respond(r.raised.map((id, i) => [id, r.actions[i]!] as [string, S.Action]));
        const withExtras: S.PlannerResponse = {
          ...plain,
          dispositions: plain.dispositions.map((d) => (r.reverses && d.action !== "accepted" ? { ...d, reverses: IDS.find((o) => o !== d.id && current(o)?.action === "accepted") ?? "" } : d)),
          self_corrections: r.selfCorrection === null || current(r.selfCorrection.id) === undefined || r.raised.includes(r.selfCorrection.id) ? [] : [{ id: r.selfCorrection.id, new_action: r.selfCorrection.action, explanation: "x", concern: "c", remedy: "m", resolution: null }],
        };
        const response = Result.isSuccess(roundCheckOf(t.state)(withExtras)) ? withExtras : plain;
        t = advance(t.state, { kind: "ResponseDecoded", response, resultText: "", costUsd: 0.1 });
        for (let guard = 0; guard < 20 && !["CallReviewer", "Finish", "Halt", "AskLimit", "AskUnchanged"].includes(last(t).kind); guard++) {
          const k = last(t).kind;
          if (k === "ObserveFile") t = advance(t.state, observed(`g${++hash}`));
          else if (k === "CallInvestigation") t = advance(t.state, responded(response, "InvestigationDecoded"));
          else if (k === "CallCorrective") t = advance(t.state, responded(response, "CorrectionDecoded"));
          else if (k === "AskDecision") t = advance(t.state, { kind: "DecisionGiven", text: "" });
          else return;
        }
      }
    }),
    { numRuns: 200 },
  );
});
