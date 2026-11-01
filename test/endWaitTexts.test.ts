// Issue #215: the control's text and the line said and written when the developer ends a wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { END_WAIT_LABEL, notSentNotice, WAIT_ALREADY_ENDED_TEXT, WAIT_NOT_WAITING_TEXT, waitEndedLine, type WaitSubject } from "../src/prompts.ts";

const agent = fc.constantFrom("claude" as const, "codex" as const);
const subject: fc.Arbitrary<WaitSubject> = fc.oneof(
  fc.record({ kind: fc.constant("usageLimit" as const), agent }),
  fc.record({ kind: fc.constant("retry" as const), agent }),
  fc.record({ kind: fc.constant("network" as const), agent }),
  fc.record({ kind: fc.constant("tracker" as const), tracker: fc.constantFrom("GitHub", "GitLab"), what: fc.string({ minLength: 1, maxLength: 20 }) }),
);

test("the line of an ended wait names the developer and claims no lifted limit or restored connection", () => {
  fc.assert(
    fc.property(subject, (s) => {
      const line = waitEndedLine(s);
      assert.match(line, /^You ended the wait/);
      assert.match(line, /again now/);
      assert.doesNotMatch(line, /lifted|\bback\b/i);
    }),
  );
});

test("the control reads Try again now, and the refusals and the unsent notice have their texts", () => {
  assert.equal(END_WAIT_LABEL, "Try again now");
  assert.equal(WAIT_NOT_WAITING_TEXT, "That run is not waiting.");
  assert.equal(WAIT_ALREADY_ENDED_TEXT, "That wait has already ended.");
  assert.match(notSentNotice("endWait", "ended"), /^The request to end the wait was not sent/);
});
