// Issue #233 (the developer's decision of 2 Nov 2026): a Codex turn refused with 429 Too Many Requests is waited out
// and tried again, with nothing asked, like a Claude Code limit with no known end; it never stops the run. Since issue
// #251 a 429 naming a usage limit waits too, as a usage limit. The scripted turns fail by the adapter's own mapping
// (turnFailure of src/codex.ts).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Clock, Effect, Fiber } from "effect";
import { CODEX_RATE_LIMIT_TYPE, CODEX_USAGE_LIMIT_TYPE, USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";
import { exitCodeOf, program } from "../src/program.ts";
import * as prompts from "../src/prompts.ts";
import { REVIEW_PURPOSE } from "../src/services.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { fakeTrackerOf, finished, heldClock, scriptedItem, scriptedStart, steppingClock, tempRepo, testWiring, type ReviewStep } from "./helpers.ts";

const START = Date.UTC(2026, 10, 2, 12, 39);
const RETRY_MS = USAGE_LIMIT_RETRY_SECONDS * 1000;
const M = "exceeded retry limit, last status: 429 Too Many Requests";
const refused: ReviewStep = { issues: [], failure: M };
const noQuestions = { questions_for_user: [] };
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const usageWaits = (dir: string) => read(dir, "usage.jsonl").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === "usage_limit_wait");
type Waiting = Extract<UiEvent, { _tag: "UsageLimitWaiting" }>;
const waitingOf = (notified: readonly UiEvent[]): Waiting[] => notified.filter((e): e is Waiting => e._tag === "UsageLimitWaiting");
const implementation = () =>
  testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [refused, refused, { issues: [] }, { issues: [] }], execs: [finished] });

test("an implementation run whose plan review is refused with 429 twice waits, tries again and ends 0, nothing asked", async () => {
  const { wiring, probe } = implementation();
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [RETRY_MS, RETRY_MS]);
  const conversation = read(probe.dir, "conversation.md");
  const refusal = prompts.limitRefusalLine("codex", M);
  const tryingAgain = prompts.usageLimitTryingAgainLine("codex", CODEX_RATE_LIMIT_TYPE);
  const waits = waitingOf(probe.ui.notified);
  assert.deepEqual(waits.map((w) => [w.agent, w.purpose, w.limitType, w.basis]), [
    ["codex", REVIEW_PURPOSE, CODEX_RATE_LIMIT_TYPE, { kind: "noKnownEnd", attempt: 1 }],
    ["codex", REVIEW_PURPOSE, CODEX_RATE_LIMIT_TYPE, { kind: "noKnownEnd", attempt: 2 }],
  ]);
  let from = 0;
  for (const w of waits) {
    const line = prompts.usageLimitWaitLine("codex", CODEX_RATE_LIMIT_TYPE, w.basis, w.untilMs);
    const at = conversation.indexOf(refusal, from);
    assert.ok(at >= 0 && at < conversation.indexOf(line, at), `the refusal does not precede wait ${JSON.stringify(w.basis)}`);
    from = conversation.indexOf(line, at) + line.length;
    for (const said of [refusal, line, tryingAgain]) assert.ok(probe.ui.said.includes(said), said);
  }
  assert.ok(conversation.includes(tryingAgain));
  assert.deepEqual(usageWaits(probe.dir).map((w) => [w.agent, w.limit_type, w.outcome]), [
    ["codex", CODEX_RATE_LIMIT_TYPE, "elapsed"],
    ["codex", CODEX_RATE_LIMIT_TYPE, "elapsed"],
  ]);
  assert.equal((JSON.parse(read(probe.dir, "checkpoint.json")) as Record<string, unknown>).waiting, null);
});

test("a refinement run whose question-list review is refused with 429 twice ends 0, nothing asked", async () => {
  const tracker = fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: { questions: [] } }], reviews: [refused, refused, { issues: [] }], tracker, mode: "refinement" });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [RETRY_MS, RETRY_MS]);
  assert.equal(waitingOf(probe.ui.notified).length, 2);
});

test("Stop task during the wait ends the run with 130 and records the wait interrupted", async () => {
  const { wiring, probe } = implementation();
  let reached: () => void = () => undefined;
  const waiting = new Promise<void>((r) => (reached = r));
  const { clock } = steppingClock(START, () => Effect.suspend(() => (reached(), Effect.never)));
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  const ended = Effect.runPromise(Fiber.await(fiber)).then(() => assert.fail("the run ended before the wait began"));
  await Promise.race([waiting, ended]);
  const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))));
  assert.equal(exitCodeOf(exit), 130);
  assert.deepEqual(usageWaits(probe.dir).map((w) => [w.agent, w.outcome]), [["codex", "interrupted"]]);
});

test("the developer ends the wait early: the review is made again at once and the run ends 0", { timeout: 120_000 }, async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [refused, { issues: [] }, { issues: [] }], execs: [finished] });
  const held = heldClock(START);
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, held.clock)));
  const done = Effect.runPromise(Fiber.await(fiber));
  let over = false;
  void done.finally(() => (over = true));
  const presses: string[] = [];
  while (!over && presses.length === 0) {
    const w = waitingOf(probe.ui.notified)[0];
    if (w !== undefined) presses.push(await Effect.runPromise(probe.ui.endWait(w.wait)));
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(exitCodeOf(await done), 0);
  assert.deepEqual(presses, ["ended"]);
  const line = prompts.waitEndedLine({ kind: "usageLimit", agent: "codex", limitType: CODEX_RATE_LIMIT_TYPE });
  assert.ok(read(probe.dir, "conversation.md").includes(line));
  assert.deepEqual(usageWaits(probe.dir).map((w) => w.outcome), ["ended"]);
});

test("a review refused with a 429 naming a usage limit waits as a usage limit and the run ends 0, nothing asked", async () => {
  const usage: ReviewStep = { issues: [], failure: "429 Too Many Requests: You've hit your usage limit" };
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [usage, { issues: [] }, { issues: [] }], execs: [finished] });
  const { clock, sleeps } = steppingClock(START);
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project), wiring)).pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(code, 0);
  assert.deepEqual(probe.ui.asked, []);
  assert.deepEqual(sleeps, [RETRY_MS]);
  assert.deepEqual(waitingOf(probe.ui.notified).map((w) => [w.limitType, w.basis]), [[CODEX_USAGE_LIMIT_TYPE, { kind: "noKnownEnd", attempt: 1 }]]);
});
