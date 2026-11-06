// Issue #245 (the developer's instruction of 3 Nov 2026): the code review raises no point about how long a step's checks
// took, a time already spent that no answer can change. This restates W1-R1-1 of the implementation run of #41, where
// Codex raised `npm run check` reported at 137 s. The scripted reviewer returns what it is scripted to whatever its
// prompt says, so what this scenario establishes is that the run finishes after one code review with nothing left to
// correct, and that the work review's prompt shows Codex no duration to raise; the seconds stay in the recorded outcome.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import { STEP_CHECK_LIMIT_MS, WORK_CHECK_CRITERION } from "../src/prompts.ts";
import { fakeTrackerOf, finished, presentedQuestions, scriptedItem, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

test("issue #245: a step's check reported at 137 s, with nothing else wrong, leads to a code review that finds nothing to correct", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    tracker: fakeTrackerOf([scriptedItem]),
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ ...finished, checks: [{ step: "S1", command: "npm run check", seconds: 137, selection: false, counts: null }] }],
    // Issue #252: the step recorded done, so its own part of the code review judges its checks.
    execScripts: [{ reports: [["S1", "started"], ["S1", "done"]] }],
  });
  assert.equal(await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring))), 0);
  assert.equal(probe.ui.notified.filter((e) => e._tag === "PhaseBegan" && e.phase.kind === "planning").length, 1);
  assert.deepEqual(presentedQuestions(probe.ui), []);
  assert.equal(probe.reviewer.prompts.length, 2);
  assert.equal(probe.reviewer.partPrompts.length, 1, "issue #252: one request for the step S1");
  const workReview = probe.reviewer.partPrompts[0]!;
  assert.ok(workReview.includes(WORK_CHECK_CRITERION));
  assert.ok(workReview.includes("`npm run check`"));
  assert.ok(!workReview.includes("137"), workReview.slice(-800));
  assert.ok(!workReview.includes("seconds"));
  assert.ok(!workReview.includes(`${STEP_CHECK_LIMIT_MS / 60_000} minutes`));
  const log = JSON.parse(fs.readFileSync(path.join(probe.dir, "work-review-log.json"), "utf8"));
  assert.deepEqual(log.entries, []);
  const recorded = fs.readFileSync(path.join(probe.dir, "execution-1", "result.json"), "utf8");
  assert.ok(JSON.stringify(JSON.parse(recorded)).includes('"seconds":137'), "the recorded outcome keeps the check's seconds");
});
