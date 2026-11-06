// Issue #228: scenarios of the test-first rule over testWiring. The scripted reviewer returns what it is scripted to
// whatever its prompt says, so what these establish is the flow (a plan review's issue against a code step accepted and
// amended; a code review's issue located at a step leading to the next planning phase) and what each prompt gives the
// agents; they cannot show that a real agent obeys the rule.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { fakeTrackerOf, finished, issue, respond, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

test("issue #228: a plan whose code step leaves out its failing test is raised by the plan review and amended", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.ok(prompts.TEST_FIRST_REVIEW_CRITERION.length > 0);
  assert.ok(probe.reviewer.prompts[0]!.includes(prompts.TEST_FIRST_REVIEW_CRITERION), "the plan review's first round");
  assert.ok(probe.planner.prompts[0]!.includes(prompts.TEST_FIRST_RULE), "the plan writer's prompt");
  const log = JSON.parse(fs.readFileSync(path.join(probe.dir, "issue-log.json"), "utf8"));
  assert.equal(log.entries[0]?.id, "P1-R1-1");
  assert.equal(log.entries[0]?.action, "accepted");
  assert.match(fs.readFileSync(path.join(probe.dir, "plan.md"), "utf8"), /v2/);
});
