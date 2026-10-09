import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { type Artifact, recordPath, runRootOf } from "../src/artifacts.ts";
import { platformLayer } from "../src/platform.ts";
import * as prompts from "../src/prompts.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo, workExecution } from "./helpers.ts";

// Issue #120, S4: two runs may be in progress at once, each with its own records directory, so every prompt that names
// a record names the run's own. The seam: the root is derived once, the store's paths and the prompts from it, and every
// record a prompt names is a path the store writes.

const root = runRootOf("implementation", "120", "2026-10-09T10:15:00.000Z");
const store = await Effect.runPromise(makeStore(tempRepo(), root, []).pipe(Effect.provide(platformLayer)));
/** The run's records directory as the store has it, relative to the project: what every prompt must name. */
const runDir = path.relative(store.project, store.dir).split(path.sep).join("/");
const onDisk = (artifact: Artifact): string => path.join(store.project, recordPath(store.root, artifact));

const question = { phase: { kind: "planning" as const, n: 1 }, label: "Planning", question: "Which?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
const context = { review: { issues: [] }, log: [], changes: "" };
/** Every prompt that names a record, with the records it must name. */
const cases: ReadonlyArray<readonly [string, string, readonly Artifact[]]> = [
  ["questionReviewPrompt", prompts.questionReviewPrompt(store.root, 1), [{ kind: "questions" }, { kind: "log", subject: "questions" }, { kind: "decisions" }, { kind: "feedback" }]],
  ["questionReviewPrompt, a later round", prompts.questionReviewPrompt(store.root, 2), [{ kind: "questions" }, { kind: "log", subject: "questions" }]],
  ["questionRespondPrompt", prompts.questionRespondPrompt(store.root, 3), [{ kind: "review", subject: "questions", round: 3 }, { kind: "questions" }, { kind: "decisions" }]],
  ["questionApplyDecisionsPrompt", prompts.questionApplyDecisionsPrompt(store.root), [{ kind: "decisions" }, { kind: "questions" }]],
  ["termsPrompt", prompts.termsPrompt(store.root, "t"), [{ kind: "questions" }]],
  ["termsReviewPrompt", prompts.termsReviewPrompt(store.root, 1), [{ kind: "terms" }, { kind: "questions" }, { kind: "log", subject: "terms" }]],
  ["termsRespondPrompt", prompts.termsRespondPrompt(store.root, 2), [{ kind: "review", subject: "terms", round: 2 }, { kind: "terms" }]],
  ["termsApplyDecisionsPrompt", prompts.termsApplyDecisionsPrompt(store.root), [{ kind: "decisions" }, { kind: "terms" }]],
  ["interviewOpenPrompt", prompts.interviewOpenPrompt(store.root), [{ kind: "questions" }]],
  ["interviewGapsPrompt", prompts.interviewGapsPrompt(store.root, recordPath(store.root, { kind: "review", subject: "requirements", round: 1 }), ["G-R1-1"]), [{ kind: "requirements" }, { kind: "review", subject: "requirements", round: 1 }]],
  ["requirementsReviewPrompt", prompts.requirementsReviewPrompt(store.root, 1), [{ kind: "requirements" }, { kind: "questions" }, { kind: "log", subject: "requirements" }]],
  ["requirementsRespondPrompt", prompts.requirementsRespondPrompt(store.root, 1), [{ kind: "review", subject: "requirements", round: 1 }, { kind: "requirements" }]],
  ["requirementsApplyDecisionsPrompt", prompts.requirementsApplyDecisionsPrompt(store.root), [{ kind: "decisions" }, { kind: "requirements" }]],
  ["initialPlanPrompt", prompts.initialPlanPrompt(store.root, "t", true), [{ kind: "requirements" }, { kind: "decisions" }, { kind: "planFile" }, { kind: "plan" }]],
  ["revisePlanPrompt", prompts.revisePlanPrompt(store.root), [{ kind: "decisions" }, { kind: "planFile" }]],
  ["planApplyDecisionsPrompt", prompts.planApplyDecisionsPrompt(store.root), [{ kind: "decisions" }, { kind: "planFile" }]],
  ["planReviewPrompt", prompts.planReviewPrompt(store.root, 2, 1, true), [{ kind: "planFile" }, { kind: "requirements" }, { kind: "log", subject: { plan: 2 } }]],
  ["planRespondPrompt", prompts.planRespondPrompt(store.root, 2, 1), [{ kind: "review", subject: { plan: 2 }, round: 1 }, { kind: "planFile" }]],
  ["planRepairPrompt", prompts.planRepairPrompt(store.root, { duplicateIds: ["S1"], emptyIds: 0, removedDone: [], changedDone: [] }), [{ kind: "planFile" }]],
  ["executePrompt", prompts.executePrompt(store.root, "t", true), [{ kind: "requirements" }, { kind: "decisions" }, { kind: "planFile" }, { kind: "plan" }]],
  ["correctivePrompt", prompts.correctivePrompt(store.root, "plan.json", 1, ["P1-R1-1"]), [{ kind: "planFile" }]],
  ["workReviewPrompt", prompts.workReviewPrompt(store.root, 1, 1, true), [{ kind: "changes", phase: 1 }, { kind: "planFile" }, { kind: "requirements" }, { kind: "log", subject: { work: 1 } }]],
  ["workReviewPrompt, a later round", prompts.workReviewPrompt(store.root, 1, 2, true), [{ kind: "changes", phase: 1 }, { kind: "log", subject: { work: 1 } }]],
  ["workRespondPrompt", prompts.workRespondPrompt(store.root, 1, 1, context, workExecution), [{ kind: "review", subject: { work: 1 }, round: 1 }, { kind: "changes", phase: 1 }, { kind: "plan" }]],
  ["revisePlanAfterExecutionPrompt", prompts.revisePlanAfterExecutionPrompt(store.root, 1, { stopped: true, workReview: { revisedInRound: 2 } }), [{ kind: "decisions" }, { kind: "round", subject: { work: 1 }, round: 2 }, { kind: "planFile" }]],
  ["decisionAnalysisPrompt", prompts.decisionAnalysisPrompt(store.root, "format", question, { task: "t", requirements: null, plan: null }), [{ kind: "requirements" }, { kind: "plan" }]],
  ["decisionReviewPrompt", prompts.decisionReviewPrompt(store.root, "format", 3, 1), [{ kind: "analysis", decision: 3 }, { kind: "decisionQuestion", decision: 3 }, { kind: "log", subject: { decision: 3 } }]],
  ["decisionRespondPrompt", prompts.decisionRespondPrompt(store.root, 3, 1), [{ kind: "review", subject: { decision: 3 }, round: 1 }, { kind: "analysis", decision: 3 }]],
  ["decisionApplyDecisionsPrompt", prompts.decisionApplyDecisionsPrompt(store.root, 3), [{ kind: "decisions" }, { kind: "analysis", decision: 3 }]],
  ["relayedFacts", prompts.relayedFacts(store.root, null), [{ kind: "plan" }]],
  ["planFilesDenied", prompts.planFilesDenied(store.root), [{ kind: "planFile" }, { kind: "plan" }]],
  ["stopRecordedText", prompts.stopRecordedText(store.root), [{ kind: "decisions" }]],
  ["mainSessionLine", prompts.mainSessionLine(store.root, "s"), [{ kind: "usage" }]],
];

test("every prompt that names a record names it in the run's own records directory, as the store writes it", () => {
  assert.equal(runDir, `plan-review/${root}`);
  for (const [name, text, artifacts] of cases) {
    for (const artifact of artifacts) {
      const named = recordPath(store.root, artifact);
      assert.ok(text.includes(named), `${name} does not name ${named}`);
      assert.equal(path.dirname(onDisk(artifact)).startsWith(store.dir), true, `${name}: ${named} is outside the store's directory`);
    }
    // No record of another directory: every mention of plan-review/ is the run's own directory.
    for (const m of text.matchAll(/plan-review\/[^\s'"`),;:]*/g)) assert.ok(m[0].startsWith(`${runDir}/`), `${name} names ${m[0]}, outside ${runDir}/`);
  }
  // The store's own path fields are the paths the prompts name.
  assert.equal(onDisk({ kind: "plan" }), store.plan);
  assert.equal(onDisk({ kind: "requirements" }), store.requirements);
  assert.equal(onDisk({ kind: "questions" }), store.questions);
});

test("the planning hook's denials name the run's own records directory", () => {
  for (const text of [prompts.planningEditDenied(store.root), prompts.planningToolDenied(store.root)]) assert.ok(text.includes(`${runDir}/`));
});
