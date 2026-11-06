import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import * as prompts from "../src/prompts.ts";
import { reviewLoop, type ReviewPartPrompt, type Subject } from "../src/review.ts";
import { NO_STEP_CHECKS, type PlannerResponse } from "../src/schema.ts";
import { type Services, Store } from "../src/services.ts";
import { planSubject, workSubject } from "../src/subjects.ts";
import { issue, respond, scriptedRecordedPlan, type TestOptions, TEST_ROOT, tempRepo, testLayer, workExecution } from "./helpers.ts";

// Issue #252, S6 (requirements Q2): a cycle of a code review is one Codex request per part, all at once, each in its own
// thread kept across the cycles; their issues are merged into the cycle's one review.

const WHOLE: prompts.ReviewPart = { _tag: "Whole" };
const step = (id: string): prompts.ReviewPart => ({ _tag: "Step", id, label: `label ${id}`, text: `text ${id}` });
const partPrompt = (part: prompts.ReviewPart): ReviewPartPrompt => ({ part, prompt: (_root, round, thread) => `${prompts.reviewPartLine(part)}\nreview round ${round} in a ${thread} thread` });
const parts: readonly ReviewPartPrompt[] = [partPrompt(WHOLE), partPrompt(step("S1")), partPrompt(step("S2"))];
const subject = { ...workSubject("task", 1, false, workExecution, NO_STEP_CHECKS, null), reviewParts: Effect.succeed(parts) };

const loop = async <R extends PlannerResponse, D>(options: TestOptions, loopSubject: Subject<R, D>) => {
  const { layer, probe } = testLayer(tempRepo(), { config: { maxIdleRounds: 9 }, ...options });
  const end = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.init("task");
      yield* store.savePlan(scriptedRecordedPlan("v1"));
      return yield* reviewLoop(loopSubject);
    }).pipe(Effect.provide(layer as Layer.Layer<Services>)),
  );
  return { end, probe };
};
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const ids = (review: { issues: { id: string }[] }) => review.issues.map((i) => i.id);

test("S6: each cycle sends one request per part, merges their issues into one review, and keeps each part's thread", async () => {
  const later = { ...issue("W1-R1-1"), evidence: "the step's view" };
  const { end, probe } = await loop({
    steps: [{ output: respond([["W1-R1-1", "clarification_requested"], ["W1-R1-S1-1", "rejected"], ["W1-R1-S2-1", "rejected"]]) }, { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    partReviews: {
      // Cycle 1: a new id the whole part raised, repaired in this part's thread; cycle 2: a reply that is not JSON, repaired.
      "step-S1": [{ issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-S1-1")] }, { issues: [], raw: "not json" }, { issues: [] }, { issues: [] }],
      // Cycle 2: the earlier clarification raised again, merged; cycle 3: a duplicated id, repaired.
      "step-S2": [{ issues: [issue("W1-R1-S2-1")] }, { issues: [later] }, { issues: [issue("W1-R3-S2-1"), issue("W1-R3-S2-1")] }, { issues: [] }],
    },
  }, subject);
  assert.deepEqual(end, { result: "converged", round: 3 });
  assert.equal(probe.reviewer.prompts.length, 3, "one whole-work request per cycle");
  assert.equal(probe.reviewer.partPrompts.length, 9, "two step parts per cycle, and their three repair turns");
  assert.equal(probe.reviewer.phases, 3, "one thread per part, kept across the cycles");
  assert.deepEqual(ids(json(probe.dir, "work-review-1/review-1.json")), ["W1-R1-1", "W1-R1-S1-1", "W1-R1-S2-1"]);
  const second = json(probe.dir, "work-review-1/review-2.json");
  assert.deepEqual(ids(second), ["W1-R1-1"], "an id from the log raised by two parts is merged");
  assert.ok(second.issues[0].evidence.includes("Also raised by step-S2: the step's view"));
  assert.deepEqual(ids(json(probe.dir, "work-review-1/review-1-step-S1.json")), ["W1-R1-S1-1"]);
  assert.deepEqual(ids(json(probe.dir, "work-review-1/review-1-step-S2.json")), ["W1-R1-S2-1"]);
  assert.ok(probe.reviewer.partPrompts.some((p) => p.includes(prompts.partCollisionRepairPrompt(["W1-R1-1"], prompts.idForm("W1", 1, step("S1"))))), "the collision repair in the step's thread");
});

test("S6: a subject with no parts sends one request a cycle, its raw reply in review-<n>.json", async () => {
  const { end, probe } = await loop({ reviews: [{ issues: [] }] }, planSubject(TEST_ROOT, 1, false, null, NO_STEP_CHECKS));
  assert.deepEqual(end, { result: "converged", round: 1 });
  assert.equal(probe.reviewer.prompts.length, 1);
  assert.equal(probe.reviewer.phases, 1);
  assert.deepEqual(json(probe.dir, "planning-1/review-1.json"), { issues: [] });
});
