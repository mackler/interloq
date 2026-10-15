// Issue #170: properties of the reset an error result's text names (src/limitReset.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { instantOn, NO_LIMIT_WAIT, planLimitWait, timeOfDayIn, USAGE_LIMIT_MARGIN_SECONDS } from "../src/limitReset.ts";

const RUNS = { numRuns: 300, seed: 20261015 };
const ZONES = ["UTC", "Asia/Kolkata", "America/New_York", "Etc/GMT+5"] as const;
const DAY_MS = 24 * 3600 * 1000;

const arbTime = fc.record({
  hour12: fc.integer({ min: 1, max: 12 }),
  minute: fc.integer({ min: 0, max: 59 }),
  meridiem: fc.constantFrom("am", "pm", "AM", "PM"),
});
const textOf = (t: { hour12: number; minute: number; meridiem: string }, zone: string): string =>
  `You've hit your session limit · resets ${t.hour12}:${String(t.minute).padStart(2, "0")}${t.meridiem} (${zone})`;
const hour24 = (t: { hour12: number; meridiem: string }): number => (t.hour12 % 12) + (t.meridiem.toLowerCase() === "pm" ? 12 : 0);
const arbInstant = fc.integer({ min: Date.parse("2020-01-01T00:00:00Z"), max: Date.parse("2035-01-01T00:00:00Z") });

const wallIn = (ms: number, zone: string): { date: string; hour: number; minute: number } => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
};

test("a text in the recognized form reads back to its time and zone", () => {
  fc.assert(
    fc.property(arbTime, fc.constantFrom(...ZONES), (t, zone) => {
      const at = timeOfDayIn(textOf(t, zone));
      assert.ok(at !== null);
      assert.deepEqual({ hour: at.time.hour, minute: at.time.minute, zone: at.zone as string }, { hour: hour24(t), minute: t.minute, zone });
    }),
    RUNS,
  );
});

test("the recognized form followed by anything but whitespace or one final period is not read", () => {
  const arbSuffix = fc
    .tuple(fc.constantFrom(" ", ","), fc.string({ minLength: 1, maxLength: 20 }))
    .map(([lead, rest]) => lead + rest)
    .filter((s) => !/^\s*\.?\s*$/.test(s));
  fc.assert(
    fc.property(arbTime, fc.constantFrom(...ZONES), arbSuffix, (t, zone, suffix) => {
      assert.equal(timeOfDayIn(textOf(t, zone) + suffix), null);
    }),
    RUNS,
  );
});

test("a digit anywhere before the reset makes the text unread", () => {
  const arbPrefix = fc
    .tuple(fc.string({ maxLength: 15 }), fc.integer({ min: 0, max: 9 }), fc.string({ maxLength: 15 }))
    .map(([a, d, b]) => `${a}${d}${b} · `);
  fc.assert(
    fc.property(arbTime, fc.constantFrom(...ZONES), arbPrefix, (t, zone, prefix) => {
      assert.equal(timeOfDayIn(prefix + textOf(t, zone).replace("You've hit your session limit · ", "")), null);
    }),
    RUNS,
  );
});

test("in a zone without daylight saving, day 0 is that time on the refusal's day and day 1 exactly 24 hours later", () => {
  fc.assert(
    fc.property(arbTime, fc.constantFrom("UTC", "Asia/Kolkata"), arbInstant, (t, zone, refused) => {
      const at = timeOfDayIn(textOf(t, zone));
      assert.ok(at !== null);
      const day0 = instantOn(at, refused, 0);
      assert.deepEqual(wallIn(day0, zone), { date: wallIn(refused, zone).date, hour: hour24(t), minute: t.minute });
      assert.equal(instantOn(at, refused, 1), day0 + DAY_MS);
    }),
    RUNS,
  );
});

test("in America/New_York, day 0 lies within 25 hours of the start of the refusal's local day", () => {
  fc.assert(
    fc.property(arbTime, arbInstant, (t, refused) => {
      const at = timeOfDayIn(textOf(t, "America/New_York"));
      assert.ok(at !== null);
      const day0 = instantOn(at, refused, 0);
      const w = wallIn(refused, "America/New_York");
      const sinceMidnight = (w.hour * 60 + w.minute) * 60_000 + (refused % 60_000);
      const dayStart = refused - sinceMidnight;
      assert.ok(day0 >= dayStart - 3600_000 && day0 < dayStart + 25 * 3600_000, `${new Date(day0).toISOString()} vs ${new Date(refused).toISOString()}`);
    }),
    RUNS,
  );
});

// S2: planLimitWait over any refusal and time of day in UTC.
const MARGIN = USAGE_LIMIT_MARGIN_SECONDS * 1000;

test("from no earlier wait, a time of day is waited for within a day, or tried a minute after the refusal", () => {
  fc.assert(
    fc.property(arbTime, arbInstant, (t, refused) => {
      const at = timeOfDayIn(textOf(t, "UTC"));
      assert.ok(at !== null);
      const p = planLimitWait({ kind: "timeOfDay", at }, refused, NO_LIMIT_WAIT);
      const named = p.untilMs - MARGIN;
      if (p.basis.kind === "reset") assert.ok(named >= refused && named < refused + DAY_MS);
      else {
        assert.equal(p.basis.kind, "pastReset");
        assert.equal(named, refused);
      }
      assert.ok(p.untilMs > refused);
    }),
    RUNS,
  );
});

test("after a past reset was tried, a time of day is always waited for, within a day", () => {
  fc.assert(
    fc.property(arbTime, arbInstant, fc.nat({ max: 5 }), (t, refused, unknownAttempts) => {
      const at = timeOfDayIn(textOf(t, "UTC"));
      assert.ok(at !== null);
      const p = planLimitWait({ kind: "timeOfDay", at }, refused, { pastTried: true, unknownAttempts });
      assert.equal(p.basis.kind, "reset");
      const named = p.untilMs - MARGIN;
      assert.ok(named >= refused && named <= refused + DAY_MS);
      assert.ok(p.untilMs > refused);
    }),
    RUNS,
  );
});
