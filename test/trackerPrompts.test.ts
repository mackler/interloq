// Issue #171: the texts of the tracker retry, the origin of its exhaustion question, the halt's check of the item after
// the last write, and the seam between the question's options and the parser of its answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import { decodeRunError, haltMessage, TrackerStepFailed, type WriteCheck } from "../src/errors.ts";
import { parseTransportAnswer } from "../src/input.ts";
import { programContext, trackerOptions } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import { PresentedQuestionSchema } from "../src/protocol.ts";
import type { QuestionOrigin } from "../src/question.ts";
import { refinementOf } from "../src/refinement.ts";
import type { ItemId } from "../src/tracker.ts";

const ID = "98" as ItemId;

test("trackerOperationText names a read and each write with its item", () => {
  assert.equal(prompts.trackerOperationText({ kind: "read", item: ID }), "reading item 98");
  assert.equal(prompts.trackerOperationText({ kind: "writeRefinement", item: ID, refinement: Result.getOrThrow(refinementOf("r")) }), "writing the requirements to item 98");
  assert.equal(prompts.trackerOperationText({ kind: "setState", item: ID, state: "refined" }), "setting item 98 to refined");
});

test("the retry line names the tracker, the request, the count, the wait and the failure", () => {
  assert.equal(prompts.trackerRetryLine("GitHub", "reading item 155", 2, 5, 30, "no answer"), "GitHub: request failed while reading item 155, retry 2 of 5 in 30 s (no answer)");
  assert.match(prompts.trackerWriteLandedLine("GitLab", "setting item 98 to refined"), /GitLab.*setting item 98 to refined/u);
  assert.match(prompts.trackerRecoveredLine("GitHub"), /^GitHub: /u);
});

test("the exhaustion question names the tracker and the request, ends with a question mark, and points at the fault's heading", () => {
  const q = prompts.trackerExhaustedQuestion("GitHub", "reading item 155");
  assert.match(q, /GitHub/u);
  assert.match(q, /reading item 155/u);
  assert.ok(q.includes(prompts.attachedHeading("fault")));
  assert.ok(q.endsWith("?"));
});

test("the tracker origin has an origin line and the program's own context", () => {
  const origin: QuestionOrigin = { kind: "tracker", tracker: "GitHub", what: "reading item 155", attempts: 6, fault: "no answer" };
  assert.equal(prompts.originLine(origin, null), "Asked because the GitHub issue tracker could not be reached.");
  const context = prompts.fallbackContext(origin);
  for (const part of ["GitHub", "reading item 155", "6 attempts"]) assert.ok(context.includes(part), part);
  assert.equal(programContext(origin).by, "program");
  // The page decodes a question of this origin.
  const question = { number: 1, origin, context: programContext(origin), history: [], explanations: [], question: [], options: [], attached: null, decision: null };
  assert.deepEqual(Schema.decodeUnknownSync(PresentedQuestionSchema)(question).origin, origin);
});

test("the tracker question's options are read by parseTransportAnswer as their actions", () => {
  const options = trackerOptions();
  assert.deepEqual(options.map((o) => o.label), [prompts.TRANSPORT_RETRY_AGAIN, prompts.TRANSPORT_STOP]);
  const actions = ["retry", "stop"] as const;
  options.forEach((o, i) => {
    assert.ok("token" in o.answer);
    assert.equal(parseTransportAnswer(o.answer.token), actions[i]);
    assert.ok(o.matches(o.answer.token));
  });
  assert.match(prompts.trackerDecisionLine("retry", "GitHub", "reading item 155"), /retry again.*GitHub.*reading item 155/u);
});

const CHECKS: ReadonlyArray<[WriteCheck | null, RegExp | null]> = [
  [null, null],
  [{ kind: "unchecked" }, /Item 98 could not be checked after the last attempt\./u],
  [{ kind: "held", held: { kind: "noSection" } }, /After the last attempt, item 98 held no Refined using Interloq section\./u],
  [{ kind: "held", held: { kind: "otherSection" } }, /After the last attempt, item 98 held a Refined using Interloq section other than the run's requirements\./u],
  [{ kind: "held", held: { kind: "state", state: "implementing" } }, /After the last attempt, item 98 was in the state implementing\./u],
];

test("the halt of a tracker step says what the item held after the last write, or that it could not be checked", () => {
  for (const [check, said] of CHECKS) {
    const text = prompts.trackerStepFailedText("98", "setRefined", "the cause", null, check);
    if (said === null) assert.doesNotMatch(text, /last attempt/u);
    else assert.match(text, said);
  }
});

test("TrackerStepFailed with each check round-trips through decodeRunError and is rendered by haltMessage", () => {
  for (const [check, said] of CHECKS) {
    const error = new TrackerStepFailed({ item: "98", step: "writeRefinement", cause: "c", done: null, check });
    const plain = JSON.parse(JSON.stringify({ _tag: error._tag, item: error.item, step: error.step, cause: error.cause, done: error.done, check: error.check }));
    assert.equal(decodeRunError(error)?._tag, "TrackerStepFailed");
    assert.deepEqual(decodeRunError(plain), { _tag: "TrackerStepFailed", item: "98", step: "writeRefinement", cause: "c", done: null, check });
    if (said !== null) assert.match(haltMessage(error) ?? "", said);
  }
});
