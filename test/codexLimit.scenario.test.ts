// Issue #251 (the developer's instruction of 3 Nov 2026): a Codex turn refused for a limit a later attempt can succeed
// past (a model at capacity, a usage limit, a quota) is waited out with a countdown as Claude Code's limits are, and the
// run continues by itself, nothing asked; a refused credential still halts. The scripted turns fail by the adapter's own
// mapping (turnFailure of src/codex.ts), a session file's reset given as `failureReset`.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Fiber } from "effect";
import { CODEX_CAPACITY_TYPE, CODEX_QUOTA_TYPE, CODEX_USAGE_LIMIT_TYPE, USAGE_LIMIT_MARGIN_SECONDS, USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { REVIEW_PURPOSE } from "../src/services.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { fakeTrackerOf, finished, scriptedItem, scriptedStart, steppingClock, tempRepo, testWiring, type ReviewStep } from "./helpers.ts";

const START = Date.UTC(2026, 10, 3, 19, 13);
const RETRY_MS = USAGE_LIMIT_RETRY_SECONDS * 1000;
const CAPACITY = "Selected model is at capacity. Please try a different model. (Codex Exec exited with code 1: Reading prompt from stdin...)";
const atCapacity: ReviewStep = { issues: [], failure: CAPACITY };
const noQuestions = { questions_for_user: [] };
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const usageWaits = (dir: string) => read(dir, "usage.jsonl").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");
type Waiting = Extract<UiEvent, { _tag: "UsageLimitWaiting" }>;
const waitingOf = (notified: readonly UiEvent[]): Waiting[] => notified.filter((e): e is Waiting => e._tag === "UsageLimitWaiting");
const implementation = (refusals: readonly ReviewStep[]) =>
  testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [...refusals, { issues: [] }, { issues: [] }], execs: [finished] });
const runIt = async (refusals: readonly ReviewStep[]) => {
  const { wiring, probe } = implementation(refusals);
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  return { code, probe, sleeps };
};

test("(1) a plan review refused at capacity twice and then answered waits, tries again and ends 0, nothing asked", async () => {
  const { code, probe, sleeps } = await runIt([atCapacity, atCapacity]);
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [RETRY_MS, RETRY_MS]);
  const waits = waitingOf(probe.ui.notified);
  assert.deepEqual(waits.map((w) => [w.agent, w.purpose, w.limitType, w.basis]), [
    ["codex", REVIEW_PURPOSE, CODEX_CAPACITY_TYPE, { kind: "noKnownEnd", attempt: 1 }],
    ["codex", REVIEW_PURPOSE, CODEX_CAPACITY_TYPE, { kind: "noKnownEnd", attempt: 2 }],
  ]);
  const conversation = read(probe.dir, "conversation.md");
  const refusal = prompts.limitRefusalLine("codex", CAPACITY);
  const tryingAgain = prompts.usageLimitTryingAgainLine("codex", CODEX_CAPACITY_TYPE);
  for (const w of waits) {
    const line = prompts.usageLimitWaitLine("codex", CODEX_CAPACITY_TYPE, w.basis, w.untilMs);
    for (const said of [refusal, line, tryingAgain]) {
      assert.ok(probe.ui.said.includes(said), said);
      assert.ok(conversation.includes(said), said);
    }
  }
  assert.deepEqual(usageWaits(probe.dir).map((w) => [w.agent, w.limit_type, w.outcome]), [
    ["codex", CODEX_CAPACITY_TYPE, "elapsed"],
    ["codex", CODEX_CAPACITY_TYPE, "elapsed"],
  ]);
  assert.equal((JSON.parse(read(probe.dir, "checkpoint.json")) as Record<string, unknown>).waiting, null);
});

test("(2) the incident of 3 Nov 2026: a refinement whose Bring Up to Date check is refused at capacity twice ends 0, nothing asked", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], updateChecks: [atCapacity, atCapacity], reviews: [{ issues: [] }], tracker, mode: "refinement" });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [RETRY_MS, RETRY_MS]);
  assert.deepEqual(waitingOf(probe.ui.notified).map((w) => w.limitType), [CODEX_CAPACITY_TYPE, CODEX_CAPACITY_TYPE]);
});

test("(3) a usage limit with a recorded reset waits until it plus the margin, is said to lift, and the run ends 0", async () => {
  const reset = START + 3_600_000;
  const { code, probe, sleeps } = await runIt([{ issues: [], failure: "You've hit your usage limit. Try again later.", failureReset: { kind: "instant", atMs: reset } }]);
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  const until = reset + USAGE_LIMIT_MARGIN_SECONDS * 1000;
  assert.deepEqual(sleeps, [until - START]);
  assert.deepEqual(waitingOf(probe.ui.notified).map((w) => [w.limitType, w.basis, w.untilMs]), [[CODEX_USAGE_LIMIT_TYPE, { kind: "reset" }, until]]);
  assert.ok(probe.ui.notified.some((e) => e._tag === "UsageLimitLifted" && e.agent === "codex" && e.limitType === CODEX_USAGE_LIMIT_TYPE));
  const lifted = prompts.usageLimitLiftedLine("codex", CODEX_USAGE_LIMIT_TYPE, until - START);
  assert.ok(probe.ui.said.includes(lifted), lifted);
  assert.ok(read(probe.dir, "conversation.md").includes(lifted));
  assert.deepEqual(usageWaits(probe.dir).map((w) => [w.agent, w.limit_type, w.outcome]), [["codex", CODEX_USAGE_LIMIT_TYPE, "lifted"]]);
});

test("(4) a quota with no reset is tried every 5 minutes, then the run ends 0", async () => {
  const quota: ReviewStep = { issues: [], failure: "Quota exceeded. Check your plan and billing details." };
  const { code, probe, sleeps } = await runIt([quota, quota]);
  assert.equal(code, 0);
  assert.deepEqual(sleeps, [RETRY_MS, RETRY_MS]);
  assert.deepEqual(waitingOf(probe.ui.notified).map((w) => [w.limitType, w.basis.kind]), [[CODEX_QUOTA_TYPE, "noKnownEnd"], [CODEX_QUOTA_TYPE, "noKnownEnd"]]);
});

test("(5) Stop task during a capacity wait ends the run with 130 and records the wait interrupted", async () => {
  const { wiring, probe } = implementation([atCapacity]);
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((r) => (reached = r));
  const { clock } = steppingClock(START, () => Effect.suspend(() => (reached(), Effect.never)));
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  const ended = Effect.runPromise(Fiber.await(fiber)).then(() => assert.fail("the run ended before the wait began"));
  await Promise.race([waiting, ended]);
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.equal(exitCodeOf(exit), 130);
  assert.deepEqual(usageWaits(probe.dir).map((w) => [w.agent, w.limit_type, w.outcome]), [["codex", CODEX_CAPACITY_TYPE, "interrupted"]]);
});

test("(6) a review refused with a 401 halts with 1 and waits for nothing", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], failure: "unexpected status 401 Unauthorized" }] });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 1);
  assert.deepEqual(sleeps, []);
});
