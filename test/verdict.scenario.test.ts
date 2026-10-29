// Issue #186 (requirements Q1, Q2): the run's first planning call may reply, in place of a plan, the verdict that the
// item is not refined. Codex reviews it in planning phase 1: a verdict that stands sends the item back (its work parked,
// one dated comment, unrefined, no execution, exit 0); an objection Claude Code accepts, or the developer's answer
// adopting Codex's position, withdraws it, and Claude Code writes the plan, which is reviewed and carried out.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { parseComment } from "../src/itemComments.ts";
import { program } from "../src/program.ts";
import { RUNS_DIR, type RunRoot } from "../src/artifacts.ts";
import { NO_STEP_CHECKS } from "../src/schema.ts";
import { planAfterVerdictPrompt, verdictRepairPrompt } from "../src/prompts.ts";
import type { ItemState } from "../src/tracker.ts";
import { finished, issue, notRefined, presentedQuestions, respond, scriptedItem, scriptedStart, tempRepo, type TestOptions, testWiring, type WiringProbe } from "./helpers.ts";

const MISSING = "The requirements do not say how long a note is kept.";
const verdictResponse = (dispositions: Parameters<typeof respond>[0], missing = MISSING) => ({ ...respond(dispositions), missing });
const objection = { issues: [issue("V1-R1-1", "The requirements state 30 days.")] };

const runIt = async (options: TestOptions) => {
  const { wiring, probe } = testWiring(tempRepo(), options);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  return { code, probe };
};
const heldItem = async (probe: WiringProbe) => {
  const items = await Effect.runPromise(probe.tracker?.items ?? Effect.succeed([]));
  const found = items.find((i) => i.id === scriptedItem.id);
  assert.ok(found !== undefined);
  return found;
};
const stateOf = async (probe: WiringProbe): Promise<ItemState> => (await heldItem(probe)).state;
const sendBacks = async (probe: WiringProbe) => ((await heldItem(probe)).comments ?? []).filter((c) => parseComment(c.body)?._tag === "SentBack");
/** Whether a planning prompt is the plan written after verdict 1 was withdrawn: its first line, derived from the source. */
const afterVerdict = (probe: WiringProbe): boolean => {
  const root = `${RUNS_DIR}/${path.basename(probe.dir)}` as RunRoot;
  const opening = planAfterVerdictPrompt(root, "task", false, 1, { _tag: "FirstPlan" }, NO_STEP_CHECKS).split("\n")[0]!;
  return probe.planner.prompts.some((p) => p.split("\n")[0] === opening);
};

test("a verdict Codex raises nothing against sends the item back: parked, one comment, unrefined, no execution, exit 0", async () => {
  const { code, probe } = await runIt({ steps: [{ output: notRefined(MISSING) }], reviews: [{ issues: [] }] });
  assert.equal(code, 0);
  assert.equal(await stateOf(probe), "unrefined");
  const comments = await sendBacks(probe);
  assert.equal(comments.length, 1);
  assert.ok(comments[0]!.body.includes(MISSING));
  assert.deepEqual(probe.planner.execPrompts, []);
  assert.ok(fs.existsSync(path.join(probe.dir, "verdict-1", "verdict.json")));
  assert.ok(fs.existsSync(path.join(probe.dir, "parked.json")));
});

test("a verdict Codex objects to and Claude Code accepts leads to a plan, its review and the execution: implemented", async () => {
  const { code, probe } = await runIt({
    steps: [{ output: notRefined(MISSING) }, { output: verdictResponse([["V1-R1-1", "accepted"]], "") }, { output: {}, plan: "v1" }],
    reviews: [objection, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(code, 0);
  assert.equal(await stateOf(probe), "implemented");
  assert.equal((await sendBacks(probe)).length, 0);
  assert.equal(probe.planner.execPrompts.length, 1);
  assert.ok(afterVerdict(probe), probe.planner.prompts.map((p) => p.slice(0, 80)).join("\n"));
  assert.match(fs.readFileSync(path.join(probe.dir, "plan.json"), "utf8"), /v1/);
});

test("a disagreement that persists asks the developer, and his answer adopting Codex's position leads to a plan", async () => {
  const { code, probe } = await runIt({
    answers: ["1"],
    steps: [{ output: notRefined(MISSING) }, { output: verdictResponse([["V1-R1-1", "rejected"]]) }, { output: {}, plan: "v1" }],
    reviews: [objection, objection, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(presentedQuestions(probe.ui).length, 1);
  assert.equal(code, 0);
  assert.equal(await stateOf(probe), "implemented");
  assert.equal(probe.planner.execPrompts.length, 1);
  assert.ok(afterVerdict(probe));
});

test("a verdict with a blank account of what is missing gets one repair turn, and the repaired verdict stands", async () => {
  const { code, probe } = await runIt({ steps: [{ output: notRefined(" ") }, { output: notRefined(MISSING) }], reviews: [{ issues: [] }] });
  assert.equal(code, 0);
  assert.equal(probe.planner.prompts[1], verdictRepairPrompt("blankMissing"));
  assert.equal(await stateOf(probe), "unrefined");
  assert.equal((await sendBacks(probe)).length, 1);
});
