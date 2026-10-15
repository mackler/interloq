// Issue #170: the reset an error result's text names (src/limitReset.ts), examples.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { clockTimeOf, instantOn, timeOfDayIn, timeZoneOf } from "../src/limitReset.ts";

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
