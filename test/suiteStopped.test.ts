// Issue #181 (requirements Q1 and its defaults): a final suite stopped by its limit or unable to start is not the work's
// fault; after the one automatic repeat, the developer is asked to run it again or stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTransportAnswer } from "../src/input.ts";
import { suiteStoppedOptions } from "../src/offer.ts";
import { attachedHeading, originLine, fallbackContext, SUITE_RUN_AGAIN, SUITE_STOP, suiteFailureText, suiteRepeatLine, suiteStoppedLine, suiteStoppedQuestion, suiteStoppedText, TRANSPORT_ANSWERS } from "../src/prompts.ts";
import type { QuestionOrigin } from "../src/question.ts";
import type { OutsideStop } from "../src/suite.ts";

test("each option of the suite's question is chosen by its own answer token, as parseTransportAnswer reads it", () => {
  const options = suiteStoppedOptions();
  assert.deepEqual(options.map((o) => o.label), [SUITE_RUN_AGAIN, SUITE_STOP]);
  const meanings = ["retry", "stop"] as const;
  options.forEach((option, i) => {
    const token = TRANSPORT_ANSWERS[meanings[i]];
    assert.deepEqual(option.answer, { token });
    assert.equal(parseTransportAnswer(token), meanings[i]);
    assert.ok(option.matches(token));
    assert.ok(!option.matches(TRANSPORT_ANSWERS[meanings[1 - i]]));
  });
});

test("the stop's line names the reason as suiteFailureText words it, and that the plan is not revised", () => {
  const reasons: readonly OutsideStop[] = [{ kind: "timedOut", ms: 2_400_000 }, { kind: "notStarted", message: "spawn ENOENT" }];
  for (const reason of reasons) {
    const line = suiteStoppedLine("Full test suite", "npm test", reason, "plan-review/runs/x/suite-1.log");
    assert.ok(line.includes(suiteFailureText(reason)), line);
    assert.ok(line.includes("plan-review/runs/x/suite-1.log"));
    assert.match(line, /not revised/u);
  }
  assert.match(suiteRepeatLine("Full test suite", "npm test"), /again once/u);
});

test("the question, the origin's line, the program's context and the halt name the suite", () => {
  const origin: QuestionOrigin = { kind: "suiteStopped", command: "npm test", suite: 2, stops: 2, reason: "it could not be started (x)" };
  assert.match(suiteStoppedQuestion("Full test suite 2", "npm test"), /\?$/u);
  assert.match(originLine(origin, null), /suite/u);
  assert.ok(fallbackContext(origin).includes("npm test"));
  assert.ok(suiteStoppedText("npm test", 2, 2, "it could not be started (x)").includes("it could not be started (x)"));
});

test("the question names the suite's own heading, never the heading of an agent that could not be reached (W1-R1-2)", () => {
  const question = suiteStoppedQuestion("Full test suite 2", "npm test");
  assert.ok(question.includes(attachedHeading("suiteStop")), question);
  assert.ok(!question.includes(attachedHeading("fault")), question);
});
