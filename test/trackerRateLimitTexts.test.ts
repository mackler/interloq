// Issue #219: the line and the activity of a tracker's rate-limit wait, derived from one value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, type UiEvent } from "../src/uiEvents.ts";
import { trackerRateLimitActivity, trackerRateLimitLine } from "../src/prompts.ts";
import { TRACKER_RATE_LIMIT_FALLBACK_SECONDS } from "../src/trackerRateLimit.ts";

const until = Date.UTC(2026, 10, 5, 13, 0, 1);
const event = (stated: boolean): UiEvent => ({ _tag: "TrackerRateLimitWaiting", tracker: "GitLab", what: "reading item 130", stated, fromMs: until - 31_000, untilMs: until, wait: 3 });

test("a stated reset names the time it is tried again; an unstated one the fallback's seconds", () => {
  const stated = trackerRateLimitLine("GitLab", "reading item 130", until, true);
  assert.match(stated, /GitLab/u);
  assert.match(stated, /reading item 130/u);
  assert.match(stated, /13:00:01 UTC/u);
  const unstated = trackerRateLimitLine("GitLab", "reading item 130", until, false);
  assert.match(unstated, new RegExp(`${TRACKER_RATE_LIMIT_FALLBACK_SECONDS} seconds`, "u"));
  assert.doesNotMatch(unstated, /13:00:01/u);
  for (const text of [stated, unstated, trackerRateLimitActivity(true), trackerRateLimitActivity(false)]) assert.doesNotMatch(text, /lifted/u);
});

test("the event's description is the line", () => {
  for (const stated of [true, false]) assert.equal(describeEvent(event(stated)), trackerRateLimitLine("GitLab", "reading item 130", until, stated));
  assert.notEqual(trackerRateLimitActivity(true), trackerRateLimitActivity(false));
  assert.match(trackerRateLimitActivity(false), new RegExp(`${TRACKER_RATE_LIMIT_FALLBACK_SECONDS} s`, "u"));
});
