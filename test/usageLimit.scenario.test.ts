import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect } from "effect";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { USAGE_LIMIT_MARGIN_SECONDS } from "../src/retry.ts";
import { finished, scriptedTask, steppingClock, tempRepo, testWiring } from "./helpers.ts";

// Issue #68: a phase that hits a usage limit with a stated reset waits for it, resumes and finishes, asking nothing;
// a limit without a reset halts as before.
const noQuestions = { questions_for_user: [] };
const START = Date.UTC(2026, 8, 30, 5, 32);
const RESET = START + 9_000_000;
const UNTIL = RESET + USAGE_LIMIT_MARGIN_SECONDS * 1000;

test("a plan write that hits a five-hour limit waits until it lifts, resumes, and the run finishes; the wait is recorded and printed", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ limit: { resetsAtMs: RESET, limitType: "five_hour" } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program({ task: scriptedTask, project: probe.project }, wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [UNTIL - START]);
  assert.equal(probe.planner.prompts.length, 2);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const waitLine = prompts.usageLimitWaitLine("claude", "five_hour", UNTIL);
  const liftedLine = prompts.usageLimitLiftedLine("claude", UNTIL - START);
  assert.ok(conversation.indexOf(waitLine) >= 0 && conversation.indexOf(waitLine) < conversation.indexOf(liftedLine), "the wait and its end are not in conversation.md in order");
  const waits = fs.readFileSync(path.join(probe.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");
  assert.deepEqual(waits.map((w) => w.outcome), ["lifted"]);
  assert.match(probe.ui.said.join("\n"), /Usage: .*Waited for Claude Code's usage limits: 1 time, 2:31:00 in all\./);
});

test("a limit without a stated reset on the same call halts as before, with no wait", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ callFailed: "You've hit your session limit" }] });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program({ task: scriptedTask, project: probe.project }, wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 1);
  assert.deepEqual(sleeps, []);
  assert.match(probe.ui.said.join("\n"), /HALTED: .*session limit/);
  assert.ok(!probe.ui.notified.some((e) => e._tag === "UsageLimitWaiting"));
});
