// Which earlier implementation run of an item gives the new run its plan (issue #180; pure). The earlier run's own
// records decide, never the new run's configuration: a plan review ended in agreement where a round of a planning subject was
// recorded without a response and the run's conversation.md holds the block its loop writes when Codex raises no counted issue, and only
// then (a round left without a response is also what an interrupted round leaves, and whether a review counted toward
// agreement depended on that run's countMinor, which no record keeps). G-R1-1: the plan taken is plan.json as the
// earlier run left it; Q3: a step it left running is begun and not finished; F1: without that run's baseline the plan
// is set aside.
import type { RunRoot } from "./artifacts.ts";
import { endExecution } from "./plan.ts";
import { PLAN_FILE_LABEL, reviewConvergedMarkdown } from "./prompts.ts";
import type { Baseline, RoundRecord } from "./records.ts";
import { subjectHeading } from "./render.ts";
import type { RecordedPlan } from "./schema.ts";

/** What the store read of one earlier run: its conversation.md ("" when missing), the decodable rounds of its planning-<k>/ with k, its plan.json and baseline.json (null when missing or undecodable). */
export type EarlierRunRecords = Readonly<{
  root: RunRoot;
  conversation: string;
  rounds: readonly Readonly<{ phase: number; record: RoundRecord }>[];
  plan: RecordedPlan | null;
  baseline: Baseline | null;
}>;

/** The plan a new implementation run starts from: none, an earlier run's (statuses carried), or one set aside because its baseline is gone. */
export type EarlierPlan =
  | Readonly<{ _tag: "NoEarlierPlan" }>
  | Readonly<{ _tag: "EarlierPlanTaken"; root: RunRoot; plan: RecordedPlan; baseline: Baseline }>
  | Readonly<{ _tag: "EarlierPlanSetAside"; root: RunRoot }>;

/** Whether some plan review of the run ended in agreement, as its records show. */
export const planReviewConverged = (records: EarlierRunRecords): boolean =>
  records.rounds.some(({ phase, record }) => record.kind === "no_response" && records.conversation.includes(reviewConvergedMarkdown(subjectHeading({ plan: phase }), record.round, PLAN_FILE_LABEL)));

/** The first run of the list (newest first) whose plan review ended in agreement and that has a plan. */
export const latestQualifying = (runs: readonly EarlierRunRecords[]): (EarlierRunRecords & Readonly<{ plan: RecordedPlan }>) | null => {
  const found = runs.find((run) => run.plan !== null && planReviewConverged(run));
  return found === undefined || found.plan === null ? null : { ...found, plan: found.plan };
};

/** The taken plan's statuses: done stays done, a step left running is begun and not finished (Q3). */
export const carriedPlan = (plan: RecordedPlan): RecordedPlan => endExecution(plan);
