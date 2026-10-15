// The reset of a Claude Code usage limit (issue #170): the time of day an error result's text names, resolved to an
// instant, and how long each refusal waits. Pure: no I/O, no Effect services. It imports nothing from src/retry.ts or
// src/claude.ts, so that src/transport.ts and src/errors.ts can import it.
import { type Brand, Result } from "effect";

/** A time zone Intl accepts: "UTC" or an IANA name, built by timeZoneOf alone. */
export type TimeZoneName = Brand.Branded<string, "TimeZoneName">;
/** Why a text is not a time zone: Intl does not know it. */
export type UnknownTimeZone = Readonly<{ _tag: "UnknownTimeZone"; text: string }>;

/**
 * The zone a text names, if Intl knows it. Intl.DateTimeFormat throws a RangeError for an unknown zone; this is the one
 * place that catches it, so nothing else throws.
 */
export const timeZoneOf = (text: string): Result.Result<TimeZoneName, UnknownTimeZone> =>
  text.trim() === ""
    ? Result.fail({ _tag: "UnknownTimeZone", text })
    : Result.try({
        try: (): TimeZoneName => {
          new Intl.DateTimeFormat("en-US", { timeZone: text });
          return text as TimeZoneName;
        },
        catch: (): UnknownTimeZone => ({ _tag: "UnknownTimeZone", text }),
      });

/** A wall-clock time on the 24-hour clock: hour 0–23, minute 0–59, built by clockTimeOf alone. */
export type ClockTime = Brand.Branded<Readonly<{ hour: number; minute: number }>, "ClockTime">;
/** Why a 12-hour time is not a time: an hour outside 1–12 or a minute outside 0–59. */
export type InvalidClockTime = Readonly<{ _tag: "InvalidClockTime"; hour12: number; minute: number }>;
export type Meridiem = "am" | "pm";

/** A 12-hour time on the 24-hour clock: 12am is hour 0, 12pm hour 12. */
export const clockTimeOf = (hour12: number, minute: number, meridiem: Meridiem): Result.Result<ClockTime, InvalidClockTime> =>
  Number.isInteger(hour12) && hour12 >= 1 && hour12 <= 12 && Number.isInteger(minute) && minute >= 0 && minute <= 59
    ? Result.succeed({ hour: (hour12 % 12) + (meridiem === "pm" ? 12 : 0), minute } as ClockTime)
    : Result.fail({ _tag: "InvalidClockTime", hour12, minute });

/** A time of day in a zone, as an error result's text names it. */
export type TimeOfDay = Readonly<{ time: ClockTime; zone: TimeZoneName }>;

/**
 * The reset of a usage limit as far as Interloq knows it: an instant a rate-limit event stated, a time of day read from
 * the error result's text, or none usable.
 */
export type LimitReset =
  | Readonly<{ kind: "instant"; atMs: number }>
  | Readonly<{ kind: "timeOfDay"; at: TimeOfDay }>
  | Readonly<{ kind: "unknown" }>;

/**
 * The one form of a reset in an error result's text that Interloq reads, the form seen on 15 Oct 2026:
 * `resets <h>:<mm>am|pm (<zone>)`, the meridiem in any case. A form with a date does not match, since a date stands
 * between "resets" and the time.
 */
export const RESET_TEXT_PATTERN = /\bresets (\d{1,2}):(\d{2})(am|pm) \(([^()\s]+)\)/i;

/** The time of day and zone an error result's text names as its reset, or null for any other text. */
export const timeOfDayIn = (text: string): TimeOfDay | null => {
  const m = RESET_TEXT_PATTERN.exec(text);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) return null;
  const time = clockTimeOf(Number(m[1]), Number(m[2]), m[3].toLowerCase() as Meridiem);
  const zone = timeZoneOf(m[4]);
  return Result.isSuccess(time) && Result.isSuccess(zone) ? { time: time.success, zone: zone.success } : null;
};

/** The wall-clock fields of an instant in a zone. */
const wallOf = (ms: number, zone: TimeZoneName): Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }> => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ms);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: field("year"), month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute"), second: field("second") };
};

/** The zone's offset from UTC at an instant, in milliseconds (wall time minus UTC), to the second. */
const offsetAt = (ms: number, zone: TimeZoneName): number => {
  const w = wallOf(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (ms - (((ms % 1000) + 1000) % 1000));
};

/**
 * The instant of a time of day on the calendar day, in its zone, that contains `dayOfMs`, or on the day after. The
 * wall time is taken as UTC and corrected twice by the zone's offset. A wall time that does not exist on a day the
 * clocks go forward lands within an hour of it.
 */
export const instantOn = (at: TimeOfDay, dayOfMs: number, dayOffset: 0 | 1): number => {
  const day = wallOf(dayOfMs, at.zone);
  const guess = Date.UTC(day.year, day.month - 1, day.day + dayOffset, at.time.hour, at.time.minute);
  const first = guess - offsetAt(guess, at.zone);
  return guess - offsetAt(first, at.zone);
};

/**
 * The margin added to a usage limit's stated reset (issue #68): the wait lasts until the reset plus this, and never less
 * than this, so that a reset stated in the past or a clock behind the server's cannot make the program call again at
 * once. Neither a threshold nor a setting.
 */
export const USAGE_LIMIT_MARGIN_SECONDS = 60;

/**
 * The wait before another try at a usage limit with no known end (issue #170, requirement Q2): a constant, not a
 * setting.
 */
export const USAGE_LIMIT_RETRY_SECONDS = 300;

/**
 * What a usage limit's wait rests on: a stated reset (from a rate-limit event or the error result's text); a time of
 * day the text named that was already past at the refusal, tried again one minute after it (requirement Q4); or no
 * usable reset, tried again every 5 minutes (requirement Q2), `attempt` counting the consecutive tries from 1.
 */
export type LimitWaitBasis =
  | Readonly<{ kind: "reset" }>
  | Readonly<{ kind: "pastReset"; namedMs: number }>
  | Readonly<{ kind: "noKnownEnd"; attempt: number }>;

/** What the waits of one call so far carry to the next refusal: a past reset tried once, the tries with no known end. */
export type LimitWaitState = Readonly<{ pastTried: boolean; unknownAttempts: number }>;
export const NO_LIMIT_WAIT: LimitWaitState = { pastTried: false, unknownAttempts: 0 };

/** One refusal's wait: its basis, its end, and the state the next refusal of the same call starts from. */
export type LimitWaitPlan = Readonly<{ basis: LimitWaitBasis; untilMs: number; next: LimitWaitState }>;

const MARGIN_MS = USAGE_LIMIT_MARGIN_SECONDS * 1000;
const RESET: LimitWaitBasis = { kind: "reset" };

/**
 * How long a refusal for a usage limit waits (issues #68 and #170). An instant is waited for plus the margin, and a past
 * instant for the margin alone. A time of day is that day's when it is not earlier than the refusal (requirement Q1);
 * an earlier one is tried once a minute after the refusal, and if the next refusal names a time still earlier than it,
 * that time is waited for on the next day (Q4). No usable reset is tried every 5 minutes with no limit (Q2).
 */
export const planLimitWait = (reset: LimitReset, refusedAtMs: number, state: LimitWaitState): LimitWaitPlan => {
  switch (reset.kind) {
    case "instant":
      return { basis: RESET, untilMs: Math.max(reset.atMs, refusedAtMs) + MARGIN_MS, next: NO_LIMIT_WAIT };
    case "timeOfDay": {
      const today = instantOn(reset.at, refusedAtMs, 0);
      if (today >= refusedAtMs) return { basis: RESET, untilMs: today + MARGIN_MS, next: NO_LIMIT_WAIT };
      if (!state.pastTried) return { basis: { kind: "pastReset", namedMs: today }, untilMs: refusedAtMs + MARGIN_MS, next: { pastTried: true, unknownAttempts: 0 } };
      return { basis: RESET, untilMs: instantOn(reset.at, refusedAtMs, 1) + MARGIN_MS, next: NO_LIMIT_WAIT };
    }
    case "unknown": {
      const attempt = state.unknownAttempts + 1;
      return { basis: { kind: "noKnownEnd", attempt }, untilMs: refusedAtMs + USAGE_LIMIT_RETRY_SECONDS * 1000, next: { pastTried: false, unknownAttempts: attempt } };
    }
  }
};
