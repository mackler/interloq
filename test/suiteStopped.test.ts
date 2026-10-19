// Issue #181 (requirements Q1 and its defaults): a final suite stopped by its limit or unable to start is not the work's
// fault; after the one automatic repeat, the developer is asked to run it again or stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTransportAnswer } from "../src/input.ts";
import { suiteStoppedOptions } from "../src/offer.ts";
import { attachedHeading, originLine, fallbackContext, suiteStoppedDetails, suiteStoppedFacts, suiteStoppedHistory, SUITE_RUN_AGAIN, SUITE_STOP, suiteFailureText, suiteRepeatLine, suiteStoppedLine, suiteStoppedQuestion, suiteStoppedText, TRANSPORT_ANSWERS } from "../src/prompts.ts";
import type { QuestionOrigin } from "../src/question.ts";
import fc from "fast-check";
import { blocksText } from "../src/pieces.ts";
import type { OutsideStop, SuiteStop } from "../src/suite.ts";

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

// W1-R1-1: the question rests on every stop of its loop and on the stop after which the one automatic repeat was used;
// each is named with its reason and its log, and the history tells what led to the question.
const limit: OutsideStop = { kind: "timedOut", ms: 2_400_000 };
const shell: OutsideStop = { kind: "notStarted", message: "spawn /bin/sh ENOENT" };
const stop1: SuiteStop = { suite: 1, reason: limit, log: "plan-review/runs/x/suite-1.log" };
const stop2: SuiteStop = { suite: 2, reason: shell, log: "plan-review/runs/x/suite-2.log" };
const stop3: SuiteStop = { suite: 3, reason: limit, log: "plan-review/runs/x/suite-3.log" };
const textOf = (blocks: Parameters<typeof blocksText>[0]) => blocksText(blocks).join("\n");

test("two stops in a row, the first used the repeat: the facts and the details name both reasons and both logs, the history the first", () => {
  const facts = suiteStoppedFacts("npm test", [stop1, stop2], stop1);
  const details = textOf(suiteStoppedDetails([stop1, stop2], stop1));
  for (const text of [facts, details]) {
    for (const stop of [stop1, stop2]) {
      assert.ok(text.includes(suiteFailureText(stop.reason)), text);
      assert.ok(text.includes(stop.log), text);
    }
  }
  const history = textOf(suiteStoppedHistory([stop1, stop2], stop1));
  assert.match(history, /[Ss]uite run 1\b/u);
  assert.ok(history.includes(suiteFailureText(stop1.reason)), history);
  assert.ok(!history.includes(stop2.log), history);
});

test("a repeat used in an earlier iteration: the history names that suite run, and the details list its log before the stop asked about", () => {
  const history = textOf(suiteStoppedHistory([stop3], stop1));
  assert.match(history, /[Ss]uite run 1\b/u);
  assert.match(history, /automatic repeat/u);
  const details = textOf(suiteStoppedDetails([stop3], stop1));
  assert.ok(details.indexOf(stop1.log) >= 0 && details.indexOf(stop1.log) < details.indexOf(stop3.log), details);
});

test("every stop's log and the repeat's occur in the details and the facts (property)", () => {
  // A run's stops have distinct suite runs, each with its own log; the repeat is the first of the loop's stops, or an
  // earlier stop outside it.
  const reason = fc.oneof(fc.constant(limit), fc.constant(shell));
  const stopOf = (n: number, why: OutsideStop): SuiteStop => ({ suite: n, reason: why, log: `plan-review/runs/x/suite-${n}.log` });
  fc.assert(
    fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 6 }), fc.array(reason, { minLength: 6, maxLength: 6 }), fc.boolean(), (numbers, reasons, inside) => {
      const all = numbers.map((n, i) => stopOf(n, reasons[i]));
      const [first, ...rest] = all;
      const stops: readonly [...SuiteStop[], SuiteStop] = inside ? [...rest, first] : [...all.slice(1, -1), all[all.length - 1]];
      const repeated = inside ? stops[0] : first;
      const details = textOf(suiteStoppedDetails(stops, repeated));
      const facts = suiteStoppedFacts("npm test", stops, repeated);
      for (const stop of [...stops, repeated]) {
        assert.ok(details.includes(stop.log), details);
        assert.ok(facts.includes(stop.log), facts);
      }
    }),
    { numRuns: 200 },
  );
});
