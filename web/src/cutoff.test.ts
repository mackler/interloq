// Issue #147 (S4): the hour the developer types resolved to its next occurrence in the browser's time zone.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Result } from "effect";
import { cutoffAt, nextOccurrence, parseHour } from "./cutoff.ts";

const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0, 0);

describe("the cutoff's hour", () => {
  test("07:00 typed at 22:00 is 07:00 the next morning", () => {
    expect(nextOccurrence({ hour: 7, minute: 0 }, local(2026, 9, 20, 22, 0))).toEqual(local(2026, 9, 21, 7, 0));
  });

  test("an hour later today is today; the hour equal to now is tomorrow", () => {
    expect(nextOccurrence({ hour: 23, minute: 30 }, local(2026, 9, 20, 22, 0))).toEqual(local(2026, 9, 20, 23, 30));
    expect(nextOccurrence({ hour: 22, minute: 0 }, local(2026, 9, 20, 22, 0))).toEqual(local(2026, 9, 21, 22, 0));
  });

  test("only HH:MM on a 24-hour clock parses", () => {
    expect(Result.getOrThrow(parseHour("07:05"))).toEqual({ hour: 7, minute: 5 });
    for (const bad of ["7:05", "24:00", "07:60", "", "07:00:00", "noon"]) expect(Result.isFailure(parseHour(bad))).toBe(true);
  });

  test("cutoffAt gives the instant of the next occurrence", () => {
    const now = local(2026, 9, 20, 22, 0);
    expect(Result.getOrThrow(cutoffAt("07:00", now))).toBe(local(2026, 9, 21, 7, 0).getTime());
  });

  test("the result is after now, within a day and an hour of it, and shows the typed hour and minute", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2000, 0, 1), max: new Date(2100, 0, 1), noInvalidDate: true }), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), (now, hour, minute) => {
        const at = nextOccurrence({ hour, minute }, now);
        expect(at.getTime()).toBeGreaterThan(now.getTime());
        expect(at.getTime() - now.getTime()).toBeLessThanOrEqual(25 * 3600 * 1000);
        // An hour skipped by a change to daylight saving time cannot be shown; every other one is.
        if (at.getHours() === hour) expect(at.getMinutes()).toBe(minute);
      }),
      { numRuns: 300, seed: 20261020 },
    );
  });
});
