import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { reviewLoop } from "../src/review.ts";
import { type Services, Store } from "../src/services.ts";
import { verdictSubject } from "../src/subjects.ts";
import { issue, presentedQuestions, respond, type ReviewStep, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

// Issue #186 (requirements Q2): Codex reviews Claude Code's verdict that the item is not refined, in rounds; an objection
// Claude Code accepts withdraws it (revise), a review with no counted issue lets it stand (converged), and a disagreement
// that persists reaches the developer.
const VERDICT = { missing: "The retention period of a note.", phase: { kind: "planning" as const, n: 1 }, origin: "firstPlan" as const };
const loop = async (options: TestOptions) => {
  const { layer, probe } = testLayer(tempRepo(), options);
  const end = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.init("task");
      yield* store.saveVerdict(1, VERDICT);
      return yield* reviewLoop(verdictSubject(1, 1, VERDICT.phase, { _tag: "FirstPlan" }, false));
    }).pipe(Effect.provide(layer as Layer.Layer<Services>)),
  );
  return { end, probe };
};
const verdictResponse = (dispositions: Parameters<typeof respond>[0], missing = VERDICT.missing) => ({ ...respond(dispositions), missing });
const raised = (id: string): ReviewStep => ({ issues: [issue(id, "The requirements state 30 days.")] });

test("a review with no issue lets the verdict stand", async () => {
  const { end, probe } = await loop({ reviews: [{ issues: [] }] });
  assert.equal(end.result, "converged");
  assert.ok(probe.reviewer.prompts[0]!.includes("V1-R1-1"));
});

test("an objection Claude Code accepts withdraws the verdict, the round's records written", async () => {
  const { end, probe } = await loop({ reviews: [raised("V1-R1-1")], steps: [{ output: verdictResponse([["V1-R1-1", "accepted"]], "") }] });
  assert.equal(end.result, "revise");
  assert.ok(fs.existsSync(path.join(probe.dir, "verdict-1", "round-1.json")));
  const log = JSON.parse(fs.readFileSync(path.join(probe.dir, "verdict-log.json"), "utf8"));
  assert.deepEqual(log.entries.map((e: { id: string }) => e.id), ["V1-R1-1"]);
});

test("a rejection Codex raises again is put to the developer: Codex's position withdraws the verdict", async () => {
  const { end, probe } = await loop({ answers: ["1"], reviews: [raised("V1-R1-1"), raised("V1-R1-1")], steps: [{ output: verdictResponse([["V1-R1-1", "rejected"]]) }] });
  assert.equal(presentedQuestions(probe.ui).length, 1);
  assert.equal(end.result, "revise");
});

test("a rejection Codex raises again, answered with Claude Code's position, is recorded and the review goes on until it converges", async () => {
  const { end, probe } = await loop({
    answers: ["2"],
    config: { maxIdleRounds: 3 },
    reviews: [raised("V1-R1-1"), raised("V1-R1-1"), { issues: [] }],
    steps: [{ output: verdictResponse([["V1-R1-1", "rejected"]]) }, { output: verdictResponse([["V1-R1-1", "rejected"]]) }],
  });
  assert.equal(presentedQuestions(probe.ui).length, 1);
  assert.equal(end.result, "converged");
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /V1-R1-1/);
});

test("a response that accepts no objection and leaves the verdict blank is refused and repaired", async () => {
  const { end, probe } = await loop({ reviews: [raised("V1-R1-1"), { issues: [] }], steps: [{ output: verdictResponse([["V1-R1-1", "rejected"]], " ") }, { output: verdictResponse([["V1-R1-1", "rejected"]]) }] });
  assert.equal(end.result, "converged");
  assert.ok(probe.planner.prompts.some((p) => p.includes("'missing'") && p.includes("cannot accept")));
});

test("a response's revised verdict is written to verdict.json", async () => {
  // A changed verdict with no accepted issue is an unexplained change (behavior 7), answered by continuing.
  const { probe } = await loop({ answers: [""], config: { maxIdleRounds: 3 }, reviews: [raised("V1-R1-1"), { issues: [] }], steps: [{ output: verdictResponse([["V1-R1-1", "rejected"]], "Only the retention period.") }] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(probe.dir, "verdict-1", "verdict.json"), "utf8")).verdict.missing, "Only the retention period.");
});
