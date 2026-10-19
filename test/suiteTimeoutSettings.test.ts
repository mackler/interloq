// Issue #181 (requirements Q3, Q4): the final suite has a time limit of its own, a setting in minutes, apart from the
// 20-minute ceiling of one shell command a step runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeConfigText } from "../src/config.ts";
import { defaultConfig, SUITE_TIMEOUT_MAX_MINUTES } from "../src/schema.ts";

test("the default is 40 minutes", () => {
  assert.equal(defaultConfig.suiteTimeoutMinutes, 40);
});

test("a config file may set it, up to the largest whole number of minutes Node's timer accepts", () => {
  for (const minutes of [90, SUITE_TIMEOUT_MAX_MINUTES]) {
    const decoded = decodeConfigText("c.json", JSON.stringify({ suiteTimeoutMinutes: minutes }));
    assert.ok(Result.isSuccess(decoded), String(minutes));
    assert.deepEqual(decoded.success, { suiteTimeoutMinutes: minutes });
  }
});

test("a value that is not a positive integer of minutes within the bound is refused", () => {
  for (const value of [0, -1, 1.5, "40", SUITE_TIMEOUT_MAX_MINUTES + 1]) {
    const decoded = decodeConfigText("c.json", JSON.stringify({ suiteTimeoutMinutes: value }));
    assert.ok(Result.isFailure(decoded), JSON.stringify(value));
    assert.equal(decoded.failure._tag, "ConfigInvalid");
  }
});

test("the bound is the largest whole number of minutes within Node's largest timer delay", () => {
  const largestDelay = 2 ** 31 - 1;
  assert.ok(SUITE_TIMEOUT_MAX_MINUTES * 60_000 <= largestDelay);
  assert.ok((SUITE_TIMEOUT_MAX_MINUTES + 1) * 60_000 > largestDelay);
});
