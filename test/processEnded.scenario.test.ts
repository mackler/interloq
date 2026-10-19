// Issue #157 (decision Q2 of its requirements): an execution call whose Claude Code process ended on every attempt takes
// the stop's path as aborted, and what is recorded state the steps recorded as done and those left unfinished, in place
// of the empty summary and remaining work the dead process left; since issue #181 the plan is revised from them without a question.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExecCallOutcome } from "../src/schema.ts";
import { finished, issue, respond, runTask, tempRepo, testLayer } from "./helpers.ts";

const threeSteps = {
  stages: [{ number: 1, title: "Parser", steps: [{ id: "S1", number: 1, label: "Write the parser", text: "t1" }, { id: "S2", number: 2, label: "Test the parser", text: "t2" }, { id: "S3", number: 3, label: "Document it", text: "t3" }] }],
};
const planWrite = { output: { questions_for_user: [], plan: threeSteps } };
const endedBy = (end: Extract<ExecCallOutcome, { status: "processEnded" }>["end"], fault: string): ExecCallOutcome => ({ status: "processEnded", end, attempts: 4, fault });
const reports = [["S1", "started"], ["S1", "done"], ["S2", "started"]] as const;

for (const [name, ending] of [
  ["a signal", endedBy({ kind: "signal", signal: "SIGBUS" }, "Claude Code process terminated by signal SIGBUS")],
  ["an exit code", endedBy({ kind: "exit", code: 1 }, "Claude Code process exited with code 1")],
] as const) {
  test(`an execution whose process ended by ${name} on every attempt is an aborted stop revised from the steps recorded, with no question`, async () => {
    const { layer, probe } = testLayer(tempRepo(), {
      steps: [planWrite, { output: respond([["W1-R1-1", "rejected"]]) }, planWrite],
      // Plan review 1; work review 1 raises an issue so that Claude Code's response, which carries the report, is made.
      reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
      execs: [ending, finished],
      execScripts: [{ reports }, {}],
    });
    assert.equal(await runTask(layer), 2);
    assert.deepEqual(probe.ui.asked, []);
    const result = JSON.parse(fs.readFileSync(path.join(probe.dir, "execution-1", "result.json"), "utf8"));
    const outcome = result.outcome ?? result;
    assert.equal(outcome.status, "aborted");
    assert.match(outcome.summary, /S1 \(Write the parser\)/);
    assert.match(outcome.remainingWork, /S2 \(Test the parser\)/);
    assert.doesNotMatch(outcome.summary, /S2/);
    assert.equal(probe.ui.notified.filter((e) => e._tag === "PhaseBegan" && e.phase.kind === "planning").length, 2);
    const workPrompts = [...probe.planner.history.values()].flat().filter((p) => p.includes("Remaining work:"));
    assert.ok(workPrompts.some((p) => p.includes("S1 (Write the parser)")), "the work response was not given the summary");
    // Issue #181 (Q6): the revision is written from the steps recorded done and left, as the outcome states them.
    const revision = [...probe.planner.history.values()].flat().find((p) => p.startsWith("Execution phase 1 has ended."));
    assert.ok(revision !== undefined, "no revision prompt");
    assert.ok(revision.includes(`Summary: ${outcome.summary}`));
    assert.ok(revision.includes(`Remaining work: ${outcome.remainingWork}`));
  });
}

// Issue #162 (W1-R1-1): a continued phase whose later call's process ended keeps the checks its earlier calls reported.
test("a continued phase whose process then ended gives the work review the checks of its earlier call", async () => {
  const continuing: ExecCallOutcome = { status: "continuing", summary: "half", remainingWork: "S2 and S3", checks: [{ step: "S1", command: "npm run test:unit", seconds: 30 }] };
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite, { output: respond([["W1-R1-1", "rejected"]]) }, planWrite],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [continuing, endedBy({ kind: "signal", signal: "SIGBUS" }, "Claude Code process terminated by signal SIGBUS"), finished],
    execScripts: [{ reports: [["S1", "started"], ["S1", "done"]] }, { reports: [["S2", "started"]] }, {}],
  });
  assert.equal(await runTask(layer), 2);
  const workReview = probe.reviewer.prompts[1];
  assert.ok(workReview.includes("`npm run test:unit` (30 seconds)"), "the work review was not given the earlier call's check");
  assert.ok(!workReview.includes("none reported"));
  assert.equal(probe.ui.notified.filter((e) => e._tag === "PhaseBegan" && e.phase.kind === "planning").length, 2);
});
