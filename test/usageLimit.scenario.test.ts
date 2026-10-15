import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect } from "effect";
import { program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { USAGE_LIMIT_MARGIN_SECONDS } from "../src/retry.ts";
import { finished, type PlanningStep, scriptedTask, scriptedStart, steppingClock, tempRepo, testWiring } from "./helpers.ts";
import { USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";
import type { ClaudeFailure } from "../src/transport.ts";

// Issue #68: a phase that hits a usage limit with a stated reset waits for it, resumes and finishes, asking nothing;
// since issue #170 a limit is waited for whatever is known of its reset.
const noQuestions = { questions_for_user: [] };
const START = Date.UTC(2026, 8, 30, 5, 32);
const RESET = START + 9_000_000;
const UNTIL = RESET + USAGE_LIMIT_MARGIN_SECONDS * 1000;

test("a plan write that hits a five-hour limit waits until it lifts, resumes, and the run finishes; the wait is recorded and printed", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ limit: { reset: { kind: "instant", atMs: RESET }, limitType: "five_hour" } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [UNTIL - START]);
  assert.equal(probe.planner.prompts.length, 2);
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  const waitLine = prompts.usageLimitWaitLine("claude", "five_hour", { kind: "reset" }, UNTIL);
  const liftedLine = prompts.usageLimitLiftedLine("claude", UNTIL - START);
  assert.ok(conversation.indexOf(waitLine) >= 0 && conversation.indexOf(waitLine) < conversation.indexOf(liftedLine), "the wait and its end are not in conversation.md in order");
  const waits = fs.readFileSync(path.join(probe.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");
  assert.deepEqual(waits.map((w) => w.outcome), ["lifted"]);
  assert.match(probe.ui.said.join("\n"), /Usage: .*Waited for Claude Code's usage limits: 1 time, 2:31:00 in all\./);
});

test("a genuine permanent failure of the call still halts, with no wait", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ callFailed: "billing error" }] });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 1);
  assert.deepEqual(sleeps, []);
  assert.match(probe.ui.said.join("\n"), /HALTED: .*billing error/);
  assert.ok(!probe.ui.notified.some((e) => e._tag === "UsageLimitWaiting"));
});

// Issue #170: a refusal whose reset is named only in the error result's text, as on 15 Oct 2026, classified by the
// adapter's own mapping (callFailure of src/claude.ts).
const REFUSED = Date.parse("2026-10-15T00:57:16Z");
const noFacts: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null, rejection: null, resultText: null, processEnd: null };
const refusal = (resultText: string | null): PlanningStep => ({
  failure: { message: `Claude Code returned an error result: ${resultText ?? "You've hit your session limit"}`, facts: { ...noFacts, assistantError: "rate_limit", terminalReason: "api_error", resultText } },
});
const runWith = async (steps: readonly PlanningStep[]) => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [...steps, { output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  const { clock, sleeps } = steppingClock(REFUSED);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  const read = (file: string) => fs.readFileSync(path.join(probe.dir, file), "utf8");
  const waits = read("usage.jsonl").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");
  return { code, probe, sleeps, conversation: read("conversation.md"), waits };
};

test("the regression of 15 Oct 2026: a reset named only in the error text is waited for until 23:11 UTC, and the run finishes", async () => {
  const { code, probe, sleeps, conversation, waits } = await runWith([refusal("You've hit your session limit · resets 11:10pm (UTC)")]);
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  const until = Date.parse("2026-10-15T23:11:00Z");
  assert.deepEqual(sleeps, [until - REFUSED]);
  const waitLine = prompts.usageLimitWaitLine("claude", null, { kind: "reset" }, until);
  const liftedLine = prompts.usageLimitLiftedLine("claude", until - REFUSED);
  assert.ok(conversation.indexOf(waitLine) >= 0 && conversation.indexOf(waitLine) < conversation.indexOf(liftedLine), "the wait and its end are not in conversation.md in order");
  assert.deepEqual(waits.map((w) => [w.basis, w.outcome]), [["reset", "lifted"]]);
});

test("Q4: a named time earlier than the refusal, twice: a minute's wait, then the next day's time, and the run finishes", async () => {
  const early = refusal("You've hit your session limit · resets 12:30am (UTC)");
  const { code, probe, sleeps, waits } = await runWith([early, early]);
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  const second = REFUSED + USAGE_LIMIT_MARGIN_SECONDS * 1000;
  assert.deepEqual(sleeps, [USAGE_LIMIT_MARGIN_SECONDS * 1000, Date.parse("2026-10-16T00:31:00Z") - second]);
  assert.deepEqual(waits.map((w) => [w.basis, w.outcome]), [["pastReset", "elapsed"], ["reset", "lifted"]]);
});

test("no known end: three refusals with no reset are tried every 5 minutes, each try said, nothing asked, and the run finishes", async () => {
  const { code, probe, sleeps, conversation, waits } = await runWith([refusal(null), refusal(null), refusal(null)]);
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [1, 2, 3].map(() => USAGE_LIMIT_RETRY_SECONDS * 1000));
  for (const [i, attempt] of [1, 2, 3].entries()) {
    const line = prompts.usageLimitWaitLine("claude", null, { kind: "noKnownEnd", attempt }, REFUSED + (i + 1) * USAGE_LIMIT_RETRY_SECONDS * 1000);
    assert.ok(conversation.includes(line) && probe.ui.said.includes(line), `try ${attempt} not said and recorded`);
  }
  assert.deepEqual(waits.map((w) => [w.basis, w.outcome]), [1, 2, 3].map(() => ["noKnownEnd", "elapsed"]));
});
