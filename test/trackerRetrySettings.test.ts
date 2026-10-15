// Issue #171 (requirements Q1): the tracker's repeats have settings of their own, apart from the agents'.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeConfigText } from "../src/config.ts";
import { defaultConfig } from "../src/schema.ts";

test("the defaults are five repeats and a first wait of 15 seconds", () => {
  assert.equal(defaultConfig.maxTrackerRetries, 5);
  assert.equal(defaultConfig.trackerRetryDelaySeconds, 15);
});

test("a config file may set both", () => {
  const decoded = decodeConfigText("c.json", JSON.stringify({ maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.5 }));
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { maxTrackerRetries: 2, trackerRetryDelaySeconds: 0.5 });
});

test("a value that is not a positive integer of repeats or a positive wait is refused", () => {
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { maxTrackerRetries: 0 },
    { maxTrackerRetries: -1 },
    { maxTrackerRetries: 1.5 },
    { maxTrackerRetries: "5" },
    { trackerRetryDelaySeconds: 0 },
    { trackerRetryDelaySeconds: -3 },
    { trackerRetryDelaySeconds: "15" },
  ];
  for (const value of cases) {
    const decoded = decodeConfigText("c.json", JSON.stringify(value));
    assert.ok(Result.isFailure(decoded), JSON.stringify(value));
    assert.equal(decoded.failure._tag, "ConfigInvalid");
  }
});
