// The chain's cutoff as the developer types it (issue #147, requirements G-R1-1): an hour alone, resolved to its next
// occurrence on the browser's clock, in the browser's time zone, at the moment he sets the field. Pure: `now` is a
// parameter. The server keeps the resolved instant, never the hour.
import { Result } from "effect";
import { type Cutoff, cutoffOf } from "../../src/chain.ts";

export type Hour = Readonly<{ hour: number; minute: number }>;

/** `HH:MM` on a 24-hour clock, the value of an `<input type="time">`. */
export const parseHour = (text: string): Result.Result<Hour, string> => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(text.trim());
  return m === null ? Result.fail(text) : Result.succeed({ hour: Number(m[1]), minute: Number(m[2]) });
};

/** The next moment strictly after `now` at that hour and minute, local time; the browser handles daylight saving. */
export const nextOccurrence = ({ hour, minute }: Hour, now: Date): Date => {
  const on = (daysAhead: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, hour, minute, 0, 0);
  const today = on(0);
  return today.getTime() > now.getTime() ? today : on(1);
};

/** The typed hour resolved at `now`, as the instant the server keeps. */
export const cutoffAt = (text: string, now: Date): Result.Result<Cutoff, string> =>
  Result.flatMap(parseHour(text), (hour) => Result.mapError(cutoffOf(nextOccurrence(hour, now).toISOString()), () => text));
