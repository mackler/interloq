import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import fc from "fast-check";
import { type RunRoot, runRootOf } from "../src/artifacts.ts";
import { carriedPlan, type EarlierRunRecords, latestQualifying, planReviewConverged } from "../src/earlierPlan.ts";
import { PLAN_FILE_LABEL, reviewConvergedMarkdown } from "../src/prompts.ts";
import { type RoundRecord, RoundFile, Baseline } from "../src/records.ts";
import { subjectHeading } from "../src/render.ts";
import { readRefinement } from "../src/refinement.ts";
import { implementationRun } from "../src/run.ts";
import { type IssueId, NO_STEP_CHECKS, PlanFile, type RecordedPlan, type StepStatus } from "../src/schema.ts";
import { fakeTrackerOf, finished, issue, respond, scriptedItem, type TestOptions, tempRepo, testLayer } from "./helpers.ts";

// Issue #180 (S2): an earlier run qualifies when one of its plan reviews ended in agreement as its own records show (G-R1-1):
// a planning round recorded without a response and the agreement block its loop writes to conversation.md.

const RUNS = { numRuns: 200, seed: 20261019 };
const ROOT = runRootOf("implementation", "80", "2026-10-16T09:00:00.000Z");
const arbStatus = fc.constantFrom<StepStatus>("pending", "started", "done", "unfinished");
const arbPlan: fc.Arbitrary<RecordedPlan> = fc
  .array(fc.array(fc.tuple(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), arbStatus), { maxLength: 4 }), { maxLength: 3 })
  .map((stages) => ({ stages: stages.map((steps, i) => ({ number: i + 1, title: `T${i}`, steps: steps.map(([label, text, status], j) => ({ id: `S${i}-${j}`, number: j + 1, label, text, status })) })) }));
const minor = { id: "P1-R1-1" as IssueId, severity: "minor" as const, location: "l", problem: "p", evidence: "e", workEffect: null };
const noResponse = (phase: number, round: number, issues: readonly (typeof minor)[] = []): Readonly<{ phase: number; record: RoundRecord }> => ({
  phase,
  record: { kind: "no_response", subject: `planning-${phase}`, phase, round, reconstructed: false, review: { issues } },
});
const validated = (phase: number, round: number): Readonly<{ phase: number; record: RoundRecord }> => ({
  phase,
  record: { kind: "validated", subject: `planning-${phase}`, phase, round, reconstructed: false, review: { issues: [] }, response: { dispositions: [], selfCorrections: [], reviewerFeedback: "", questionsForUser: [] }, notes: [] },
});
const agreed = (phase: number, round: number): string => reviewConvergedMarkdown(subjectHeading({ plan: phase }), round, PLAN_FILE_LABEL);
const PLAN: RecordedPlan = { stages: [{ number: 1, title: "T", steps: [{ id: "S1", number: 1, label: "l", text: "t", status: "done" }] }] };
const BASELINE: Baseline = { version: 2, tree: "abc", uncommitted: [], start_commit: null, time: "2026-10-16T09:00:00.000Z" };
const run = (root: RunRoot, conversation: string, rounds: EarlierRunRecords["rounds"], plan: RecordedPlan | null = PLAN): EarlierRunRecords => ({ root, conversation, rounds, plan, baseline: BASELINE });

test("carriedPlan keeps every id, label and text and every status but started, which becomes unfinished", () => {
  fc.assert(
    fc.property(arbPlan, (plan) => {
      const carried = carriedPlan(plan);
      assert.equal(carried.stages.length, plan.stages.length);
      plan.stages.forEach((stage, i) =>
        stage.steps.forEach((step, j) => {
          const got = carried.stages[i].steps[j];
          assert.deepEqual({ ...got, status: null }, { ...step, status: null });
          assert.equal(got.status, step.status === "started" ? "unfinished" : step.status);
        }),
      );
    }),
    RUNS,
  );
});

test("planReviewConverged is true iff a no_response planning round has its agreement block", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 12 }), fc.boolean(), fc.boolean(), (phase, round, responded, block) => {
      const rounds = [responded ? validated(phase, round) : noResponse(phase, round)];
      const conversation = `# Conversation\n\n${block ? agreed(phase, round) : ""}`;
      assert.equal(planReviewConverged(run(ROOT, conversation, rounds)), !responded && block);
    }),
    RUNS,
  );
  // The block of another round or phase does not count.
  assert.equal(planReviewConverged(run(ROOT, agreed(1, 2), [noResponse(1, 1)])), false);
  assert.equal(planReviewConverged(run(ROOT, agreed(2, 1), [noResponse(1, 1)])), false);
});

test("latestQualifying takes the first qualifying run of the list whatever qualifying runs follow, and null when none qualifies", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("agreed", "unagreed", "noPlan"), { maxLength: 6 }), (kinds) => {
      const runs = kinds.map((kind, i) => run(runRootOf("implementation", "80", new Date(Date.UTC(2026, 9, 16 - i)).toISOString()), kind === "unagreed" ? "" : agreed(1, 1), [noResponse(1, 1)], kind === "noPlan" ? null : PLAN));
      const first = kinds.indexOf("agreed");
      const got = latestQualifying(runs);
      assert.equal(got?.root ?? null, first < 0 ? null : runs[first].root);
    }),
    RUNS,
  );
});

test("examples of review P1-R1-1: minor issues without the block do not qualify, with it they do; a later phase without agreement does not unmake an earlier agreement", () => {
  assert.equal(planReviewConverged(run(ROOT, "", [noResponse(1, 1, [minor])])), false);
  assert.equal(planReviewConverged(run(ROOT, agreed(1, 1), [noResponse(1, 1, [minor])])), true);
  const later: RecordedPlan = { stages: [{ ...PLAN.stages[0], steps: [...PLAN.stages[0].steps, { id: "S2", number: 2, label: "later", text: "t", status: "pending" }] }] };
  const both = run(ROOT, agreed(1, 3), [validated(1, 1), noResponse(1, 3), validated(2, 1), noResponse(2, 2, [minor])], later);
  assert.equal(planReviewConverged(both), true);
  assert.deepEqual(latestQualifying([both])?.plan, later);
});

// The seam: what a review loop writes, run over testLayer, is what planReviewConverged reads.
const readRecords = (dir: string, root: RunRoot): EarlierRunRecords => {
  const planning = fs.readdirSync(dir).flatMap((d) => (/^planning-(\d+)$/.exec(d) === null ? [] : [{ d, phase: Number(/^planning-(\d+)$/.exec(d)![1]) }]));
  const rounds = planning.flatMap(({ d, phase }) =>
    fs.readdirSync(path.join(dir, d)).flatMap((f) => {
      if (!/^round-\d+\.json$/.test(f)) return [];
      const decoded = Schema.decodeUnknownResult(RoundFile)(JSON.parse(fs.readFileSync(path.join(dir, d, f), "utf8")));
      if (Result.isFailure(decoded)) return [];
      const { version: _, ...record } = decoded.success;
      return [{ phase, record: record as RoundRecord }];
    }),
  );
  const plan = Schema.decodeUnknownSync(PlanFile)(JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"))).plan;
  return { root, conversation: fs.readFileSync(path.join(dir, "conversation.md"), "utf8"), rounds, plan, baseline: Schema.decodeUnknownSync(Baseline)(JSON.parse(fs.readFileSync(path.join(dir, "baseline.json"), "utf8"))) };
};
const implement = async (options: TestOptions) => {
  const tracker = fakeTrackerOf([scriptedItem]);
  const { layer, probe } = testLayer(tempRepo(), { ...options, tracker });
  const section = Option.getOrNull(Result.getOrThrow(readRefinement(scriptedItem.body)));
  const exit = await Effect.runPromiseExit(implementationRun(`${scriptedItem.title}\n\n${scriptedItem.body}`, scriptedItem.id, section, NO_STEP_CHECKS).pipe(Effect.provide(layer)));
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  return probe;
};
const noQuestions = { questions_for_user: [] };

test("seam: a plan review run until Codex raises no counted issue qualifies, one left by Proceed at the round limit does not", async () => {
  const agreedRun = await implement({ steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(planReviewConverged(readRecords(agreedRun.dir, ROOT)), true);

  const proceeded = await implement({
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(planReviewConverged(readRecords(proceeded.dir, ROOT)), false);
});
