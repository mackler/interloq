// Issue #170: the reset an error result's text names (src/limitReset.ts), examples.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { clockTimeOf, instantOn, type LimitWaitState, NO_LIMIT_WAIT, planLimitWait, timeOfDayIn, timeZoneOf, USAGE_LIMIT_MARGIN_SECONDS, USAGE_LIMIT_RETRY_SECONDS } from "../src/limitReset.ts";

const TEXT_15_OCT = "You've hit your session limit · resets 11:10pm (UTC)";
const REFUSED_15_OCT = Date.parse("2026-10-15T00:57:16Z");

const read = (text: string) => {
  const at = timeOfDayIn(text);
  return at === null ? null : { hour: at.time.hour, minute: at.time.minute, zone: at.zone as string };
};

test("the text of 15 Oct 2026 reads as 23:10 UTC, that day's", () => {
  assert.deepEqual(read(TEXT_15_OCT), { hour: 23, minute: 10, zone: "UTC" });
  const at = timeOfDayIn(TEXT_15_OCT);
  assert.ok(at !== null);
  assert.equal(new Date(instantOn(at, REFUSED_15_OCT, 0)).toISOString(), "2026-10-15T23:10:00.000Z");
  assert.equal(new Date(instantOn(at, REFUSED_15_OCT, 1)).toISOString(), "2026-10-16T23:10:00.000Z");
});

test("12am is hour 0 and 12pm hour 12; the meridiem in any case", () => {
  assert.deepEqual(read("resets 12:05am (UTC)"), { hour: 0, minute: 5, zone: "UTC" });
  assert.deepEqual(read("resets 12:30PM (UTC)"), { hour: 12, minute: 30, zone: "UTC" });
  assert.deepEqual(read("limit · resets 1:00Am (UTC)"), { hour: 1, minute: 0, zone: "UTC" });
});

test("an IANA zone is read and resolved in that zone", () => {
  assert.deepEqual(read("resets 9:15pm (America/New_York)"), { hour: 21, minute: 15, zone: "America/New_York" });
  const ny = timeOfDayIn("resets 9:15pm (America/New_York)");
  assert.ok(ny !== null);
  // 15 Oct 2026 in New York is daylight time, UTC-4.
  assert.equal(new Date(instantOn(ny, Date.parse("2026-10-15T12:00:00Z"), 0)).toISOString(), "2026-10-16T01:15:00.000Z");
  const kolkata = timeOfDayIn("resets 6:00am (Asia/Kolkata)");
  assert.ok(kolkata !== null);
  assert.equal(new Date(instantOn(kolkata, Date.parse("2026-10-15T12:00:00Z"), 0)).toISOString(), "2026-10-15T00:30:00.000Z");
});

test("any other form is not read", () => {
  for (const text of [
    "resets 11:10pm (Mars/Olympus)",
    "resets Oct 16, 11:10pm (UTC)",
    "resets 13:10pm (UTC)",
    "resets 0:10am (UTC)",
    "resets 11:60pm (UTC)",
    "resets 11pm (UTC)",
    "resets 11:10 (UTC)",
    "You've hit your session limit",
    "",
  ])
    assert.equal(timeOfDayIn(text), null, text);
});

test("a text with anything after the zone, a digit before the reset, or a date word is not read (W2-R1-1)", () => {
  for (const text of [
    "You've hit your session limit · resets 11:10pm (UTC) on Oct 16, 2026",
    "You've hit your session limit · resets 11:10pm (UTC), Oct 16",
    "You've hit your session limit · resets 11:10pm (UTC) tomorrow",
    "Oct 16 · resets 11:10pm (UTC)",
    "16 Oct · resets 11:10pm (UTC)",
    "03-04 · resets 11:10pm (UTC)",
    "2026-10-16: resets 11:10pm (UTC)",
    "10/16 resets 11:10pm (UTC)",
    "October · resets 11:10pm (UTC)",
    "Friday · resets 11:10pm (UTC)",
    "Tomorrow · resets 11:10pm (UTC)",
  ])
    assert.equal(timeOfDayIn(text), null, text);
});

test("the observed form is read with a final period or trailing whitespace, after prose, and with a zone carrying digits", () => {
  const utc = { hour: 23, minute: 10, zone: "UTC" };
  assert.deepEqual(read(`${TEXT_15_OCT}.`), utc);
  assert.deepEqual(read(`${TEXT_15_OCT}\n`), utc);
  assert.deepEqual(read(`${TEXT_15_OCT}   `), utc);
  assert.deepEqual(read("You may retry later · resets 11:10pm (UTC)"), utc);
  assert.deepEqual(read("You've hit your session limit · resets 11:10pm (Etc/GMT+5)"), { hour: 23, minute: 10, zone: "Etc/GMT+5" });
  assert.deepEqual(read("You've hit your session limit · resets 11:10pm (Etc/GMT-3)"), { hour: 23, minute: 10, zone: "Etc/GMT-3" });
});

test("timeZoneOf and clockTimeOf refuse what is not a zone or a time", () => {
  assert.ok(Result.isSuccess(timeZoneOf("UTC")));
  assert.ok(Result.isSuccess(timeZoneOf("Europe/Berlin")));
  assert.ok(Result.isFailure(timeZoneOf("Nowhere/Else")));
  assert.ok(Result.isFailure(timeZoneOf("")));
  assert.ok(Result.isFailure(clockTimeOf(0, 0, "am")));
  assert.ok(Result.isFailure(clockTimeOf(13, 0, "pm")));
  assert.ok(Result.isFailure(clockTimeOf(5, 60, "pm")));
  const t = clockTimeOf(12, 0, "am");
  assert.ok(Result.isSuccess(t) && t.success.hour === 0);
});

// S2: planLimitWait.
const MARGIN = USAGE_LIMIT_MARGIN_SECONDS * 1000;
const at = (text: string) => {
  const t = timeOfDayIn(text);
  assert.ok(t !== null);
  return { kind: "timeOfDay", at: t } as const;
};

test("an instant waits until it plus the margin, and a past instant one minute", () => {
  const p = planLimitWait({ kind: "instant", atMs: REFUSED_15_OCT + 3600_000 }, REFUSED_15_OCT, NO_LIMIT_WAIT);
  assert.deepEqual(p, { basis: { kind: "reset" }, untilMs: REFUSED_15_OCT + 3600_000 + MARGIN, next: NO_LIMIT_WAIT });
  const past = planLimitWait({ kind: "instant", atMs: REFUSED_15_OCT - 3600_000 }, REFUSED_15_OCT, NO_LIMIT_WAIT);
  assert.equal(past.untilMs, REFUSED_15_OCT + MARGIN);
});

test("the run of 15 Oct 2026 waits until 23:11 UTC", () => {
  const p = planLimitWait(at(TEXT_15_OCT), REFUSED_15_OCT, NO_LIMIT_WAIT);
  assert.deepEqual(p.basis, { kind: "reset" });
  assert.equal(new Date(p.untilMs).toISOString(), "2026-10-15T23:11:00.000Z");
  assert.deepEqual(p.next, NO_LIMIT_WAIT);
});

test("Q4: an earlier time is tried a minute later; earlier again waits for the next day", () => {
  const reset = at("resets 12:30am (UTC)");
  const first = planLimitWait(reset, REFUSED_15_OCT, NO_LIMIT_WAIT);
  assert.deepEqual(first.basis, { kind: "pastReset", namedMs: Date.parse("2026-10-15T00:30:00Z") });
  assert.equal(first.untilMs, REFUSED_15_OCT + MARGIN);
  assert.deepEqual(first.next, { pastTried: true, unknownAttempts: 0 });
  const again = first.untilMs + 2000;
  const second = planLimitWait(reset, again, first.next);
  assert.deepEqual(second.basis, { kind: "reset" });
  assert.equal(new Date(second.untilMs).toISOString(), "2026-10-16T00:31:00.000Z");
  assert.deepEqual(second.next, NO_LIMIT_WAIT);
});

test("Q4: an earlier time, then a later one, waits for the later one that day", () => {
  const first = planLimitWait(at("resets 12:30am (UTC)"), REFUSED_15_OCT, NO_LIMIT_WAIT);
  const second = planLimitWait(at("resets 5:00am (UTC)"), first.untilMs, first.next);
  assert.deepEqual(second.basis, { kind: "reset" });
  assert.equal(new Date(second.untilMs).toISOString(), "2026-10-15T05:01:00.000Z");
});

test("Q2: no known end tries every 5 minutes, counting the tries; it clears a past reset's try", () => {
  let state: LimitWaitState = { pastTried: true, unknownAttempts: 0 };
  let now = REFUSED_15_OCT;
  for (const attempt of [1, 2, 3]) {
    const p = planLimitWait({ kind: "unknown" }, now, state);
    assert.deepEqual(p.basis, { kind: "noKnownEnd", attempt });
    assert.equal(p.untilMs, now + USAGE_LIMIT_RETRY_SECONDS * 1000);
    assert.deepEqual(p.next, { pastTried: false, unknownAttempts: attempt });
    state = p.next;
    now = p.untilMs + 1000;
  }
});
