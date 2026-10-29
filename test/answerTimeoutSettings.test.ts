// Issue #185 (requirements Q4): a question of an implementation run in a chain waits a configured time for an answer,
// one setting in seconds, the same for every question.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeConfigText } from "../src/config.ts";
import { defaultConfig } from "../src/schema.ts";

test("the default is 120 seconds", () => {
  assert.equal(defaultConfig.answerTimeoutSeconds, 120);
});

test("a config file may set it", () => {
  const decoded = decodeConfigText("plan-review/config.json", JSON.stringify({ answerTimeoutSeconds: 30 }));
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { answerTimeoutSeconds: 30 });
});

test("a value that is not a positive integer of seconds is refused, naming the file and the key", () => {
  for (const value of [0, -1, 1.5, "120"]) {
    const decoded = decodeConfigText("plan-review/config.json", JSON.stringify({ answerTimeoutSeconds: value }));
    assert.ok(Result.isFailure(decoded), JSON.stringify(value));
    assert.equal(decoded.failure._tag, "ConfigInvalid");
    const text = JSON.stringify(decoded.failure);
    assert.match(text, /plan-review\/config\.json/);
    assert.match(text, /answerTimeoutSeconds/);
  }
});
