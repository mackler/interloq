import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Result } from "effect";
import * as prompts from "../src/prompts.ts";
import type { PauseOrigin, QuestionOrigin } from "../src/question.ts";
import { itemIdOf } from "../src/tracker.ts";
import { itemTextOf } from "../src/refinement.ts";
import { bringUpToDate } from "../src/bringUpToDate.ts";
import { runTrackerEnv } from "../src/trackerRetry.ts";
import { Store } from "../src/services.ts";
import type * as S from "../src/schema.ts";
import { piecesText } from "../src/pieces.ts";
import { fakeTrackerOf, issue, respond, tempRepo, testLayer } from "./helpers.ts";

// Issue #216, work review 1 (W1-R1-2): every text the user reads of Codex's pass in Bring Up to Date says check.

const PATHS = /\S*\/\S*|\S+\.(json|md|jsonl|diff|log)\b/gu;
/** The prose of a text: its paths removed, and Interloq's opening sentence, which names Codex's role in every context. */
const prose = (t: string): string => t.split(prompts.INTERLOQ_SENTENCE).join("").replace(PATHS, "");
const noReview = (t: string): void => assert.doesNotMatch(prose(t), /\breview/iu, t);
/** The text with pass review is the text with pass check, its noun swapped (and the file "being checked" "under review"): nothing else differs. */
const asReview = (t: string): string => t.split(prompts.INTERLOQ_SENTENCE).map(swap).join(prompts.INTERLOQ_SENTENCE);
/** The swap outside Interloq's opening sentence, which says "checks" of Codex in every context. */
const swap = (t: string): string => t.replace(/the file being checked/gu, "the file under review").replace(/\b([Cc])heck(s|ed)?\b/gu, (_m, c: string, suffix: string | undefined) => `${c === "C" ? "R" : "r"}eview${suffix ?? ""}`);

const PAUSES: readonly PauseOrigin[] = [
  { pause: "idle", idle: 2 },
  { pause: "identical", fileLabel: "issue.json" },
  { pause: "reraised", id: "U-R1-1" },
];
const H = "Bring Up to Date";
const originsOf = (pass: prompts.PassNoun): readonly QuestionOrigin[] => [
  ...PAUSES.map((p): QuestionOrigin => ({ kind: "pause", heading: H, pass, ...p })),
  { kind: "limit", heading: H, pass, limit: 5 },
  { kind: "unchanged", heading: H, pass, fileLabel: "issue.json", accepted: ["U-R1-1"] },
];

test("originLine and fallbackContext of a pause, limit or unchanged origin say check for a check, and are otherwise unchanged", () => {
  const checks = originsOf("check");
  const reviews = originsOf("review");
  checks.forEach((o, i) => {
    for (const f of [(x: QuestionOrigin) => prompts.originLine(x, null), prompts.fallbackContext]) {
      noReview(f(o));
      assert.equal(f(reviews[i]!), asReview(f(o)));
    }
  });
});

test("the pause questions, the limit's facts and lines, and the unchanged pause's texts say check for a check", () => {
  const pairs: readonly ((pass: prompts.PassNoun) => string)[] = [
    ...PAUSES.map((p) => (pass: prompts.PassNoun) => prompts.pauseQuestion(p, pass)),
    (pass) => prompts.limitFacts(H, 5, [2, 1], pass),
    (pass) => prompts.unchangedFacts(H, "issue.json", ["U-R1-1"], pass),
    (pass) => prompts.unchangedOptionDescriptions(false, pass).proceed,
    (pass) => prompts.limitExtendedLine(H, "rounds", 5, true, pass),
    (pass) => prompts.limitExtendedLine(H, "idle", 3, false, pass),
  ];
  for (const f of pairs) {
    noReview(f("check"));
    assert.equal(f("review"), asReview(f("check")));
  }
});

test("the line of a check that raised nothing says check; a review's is unchanged", () => {
  noReview(prompts.noIssueLine("update"));
  assert.equal(prompts.noIssueLine({ plan: 1 }), "No issue: the review has converged.");
  assert.equal(prompts.noIssueLine("questions"), "No issue: the review has converged.");
});

test("the round limit of Bring Up to Date asks with the origin's pass from passNoun, and its line says check", async () => {
  const id = Result.getOrThrow(itemIdOf("7"));
  const before = Result.getOrThrow(itemTextOf("Bring the issue up to date", "The check is in src/old.ts."));
  const response = { ...respond([["U-R1-1", "rejected"]]), issue: { title: before.title, text: before.text }, outcome: { kind: "current" }, developer_passages: [] } as S.UpdateResponse;
  const tracker = fakeTrackerOf([{ id, title: before.title, body: before.text, state: "unrefined", open: true, url: Option.none() }]);
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: response }], updateChecks: [{ issues: [issue("U-R1-1", "src/old.ts no longer exists")] }], answers: ["p"], tracker, mode: "refinement", config: { maxRounds: 1 } });
  await Effect.runPromise(Effect.andThen(Effect.flatMap(Store, (store) => store.init("task")), Effect.flatMap(runTrackerEnv, (env) => bringUpToDate(id, before, env))).pipe(Effect.provide(layer)));
  const limit = probe.ui.notified.find((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "limit");
  assert.ok(limit !== undefined && limit._tag === "QuestionPresented" && limit.question.origin.kind === "limit");
  assert.equal(limit.question.origin.pass, prompts.passNoun("update"));
});

// Work review 4 of issue #216 (W1-R1-2): the transport question and the disputed pause's own labels say check too.
const TODAY_TRANSPORT = (heading: string): string => `the review in ${heading}`;
const TODAY_LABELS: Readonly<Record<prompts.DisputedPauseKind, prompts.PositionLabels>> = {
  reraised: { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution: "Make the change that meets both concerns" },
  repeatedUnderNewId: { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution: "Make the change that meets both concerns" },
  reversal: { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution: "Make the change that meets both concerns" },
  secondClarification: { reviewer: "Make the change the point asks for", planner: "Wait for the requested explanation before making a change", resolution: "Make the change that meets both concerns" },
  disputedSelfCorrection: { reviewer: "Keep the correction", planner: "Withdraw the correction", resolution: "Make the change that meets both concerns" },
  authorityResolution: { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution: "Make the change that meets both concerns" },
};

test("transportReviewWhat says check for a check, and is today's text for a review", () => {
  noReview(prompts.transportReviewWhat(H, "check"));
  assert.equal(prompts.transportReviewWhat(H, "check"), `the check in ${H}`);
  assert.equal(prompts.transportReviewWhat("Planning", "review"), TODAY_TRANSPORT("Planning"));
});

test("positionLabels says no review for a check, and is today's labels for a review", () => {
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) {
    const check = prompts.positionLabels(kind, "check");
    noReview(check.reviewer);
    noReview(check.planner);
    assert.deepEqual(prompts.positionLabels(kind, "review"), TODAY_LABELS[kind]);
  }
  assert.equal(prompts.positionLabels("reraised", "check").planner, "Keep the file being checked as it is now");
});

const ID = Result.getOrThrow(itemIdOf("7"));
const BEFORE = Result.getOrThrow(itemTextOf("Bring the issue up to date", "The check is in src/old.ts."));
const updateTracker = () => fakeTrackerOf([{ id: ID, title: BEFORE.title, body: BEFORE.text, state: "unrefined", open: true, url: Option.none() }]);
const runUpdate = (layer: ReturnType<typeof testLayer>["layer"]) =>
  Effect.runPromise(Effect.exit(Effect.andThen(Effect.flatMap(Store, (store) => store.init("task")), Effect.flatMap(runTrackerEnv, (env) => bringUpToDate(ID, BEFORE, env)))).pipe(Effect.provide(layer)));

test("the transport question of a Codex turn in Bring Up to Date names the check, from passNoun of the update subject", async () => {
  const fault = { issues: [], fault: "socket hang up" };
  const { layer, probe } = testLayer(tempRepo(), { updateChecks: [fault, fault], answers: ["s"], tracker: updateTracker(), mode: "refinement", config: { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 } });
  await runUpdate(layer);
  const asked = probe.ui.notified.find((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "transport");
  assert.ok(asked !== undefined && asked._tag === "QuestionPresented");
  const text = piecesText(asked.question.question);
  assert.ok(text.includes(prompts.transportReviewWhat(H, prompts.passNoun("update"))), text);
  noReview(text);
});

test("the program's own labels of a marked dispute raised again in Bring Up to Date say being checked", async () => {
  const marked = { ...respond([["U-R1-1", "rejected", true]]), issue: { title: BEFORE.title, text: BEFORE.text }, outcome: { kind: "current" }, developer_passages: [] } as S.UpdateResponse;
  const refused = { output: { nonsense: true } };
  const { layer, probe } = testLayer(tempRepo(), {
    // Issue #38: the marked dispute is asked after its investigation, at the third check.
    steps: [{ output: marked }, { output: marked }, { output: marked }],
    updateChecks: [{ issues: [issue("U-R1-1")] }, { issues: [issue("U-R1-1")] }, { issues: [issue("U-R1-1")] }],
    contexts: [refused, refused],
    answers: ["2"],
    tracker: updateTracker(),
    mode: "refinement",
    config: { maxIdleRounds: 5 },
  });
  await runUpdate(layer);
  const asked = probe.ui.notified.find((e) => e._tag === "QuestionPresented" && e.question.origin.kind === "pause");
  assert.ok(asked !== undefined && asked._tag === "QuestionPresented");
  assert.deepEqual(asked.question.options.map((o) => piecesText(o.label)), [prompts.positionLabels("reraised", "check").reviewer, "Keep the file being checked as it is now"]);
});
