// Issue #147, work review 3 (W3-R1-1): the frames a tab sent and the server has not acknowledged.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Result } from "effect";
import { chainSettingsOf, type ChainFrameSettings } from "../../src/protocol.ts";
import type { ChainSettings } from "../../src/chain.ts";
import { acknowledged, effective, matches, NO_IN_FLIGHT, sent, type InFlight } from "./chainPending.ts";

// The server's settings after it applied a frame: derived from the frame by the server's own decoding, one source.
const applied = (frame: ChainFrameSettings): ChainSettings => Result.getOrThrow(chainSettingsOf(frame));
const SERVER: ChainSettings = { enabled: true, limits: { runs: null, cutoff: null } };
const CUTOFF = "2026-10-21T07:00:00.000Z";

describe("frames not yet acknowledged", () => {
  const first = { ...effective(NO_IN_FLIGHT, SERVER), runs: 3 };
  const afterFirst = sent(NO_IN_FLIGHT, first);
  const second = { ...effective(afterFirst, SERVER), cutoff: CUTOFF };
  const both = sent(afterFirst, second);

  test("runs 3 then a cutoff, with no acknowledgment: the second frame carries both", () => {
    expect(second).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
    expect(effective(both, SERVER)).toEqual(second);
  });

  test("the first acknowledged alone leaves the second in flight, carrying both", () => {
    const left = acknowledged(both, applied(first));
    expect(left).toEqual([second]);
    expect(effective(left, applied(first))).toEqual({ enabled: true, runs: 3, cutoff: CUTOFF });
  });

  test("the second acknowledged empties the list, and acknowledges the first with it", () => {
    expect(acknowledged(both, applied(second))).toEqual([]);
    expect(acknowledged(acknowledged(both, applied(first)), applied(second))).toEqual([]);
  });

  test("settings that match no frame, another tab's, empty the list and are what the control shows", () => {
    const other: ChainSettings = applied({ enabled: true, runs: 7, cutoff: null });
    expect(acknowledged(both, other)).toEqual([]);
    expect(effective(acknowledged(both, other), other)).toEqual({ enabled: true, runs: 7, cutoff: null });
  });

  test("a cutoff matches as an instant, whatever the ISO text's form", () => {
    const frame: ChainFrameSettings = { enabled: true, runs: null, cutoff: "2026-10-21T09:00:00+02:00" };
    expect(acknowledged(sent(NO_IN_FLIGHT, frame), applied({ ...frame, cutoff: CUTOFF }))).toEqual([]);
  });

  test("two equal frames: the server's one change acknowledges both, since the second asks for what it holds", () => {
    const frame = { ...effective(NO_IN_FLIGHT, SERVER), runs: 4 };
    expect(acknowledged(sent(sent(NO_IN_FLIGHT, frame), frame), applied(frame))).toEqual([]);
  });

  test("a frame changed back: the first frame's acknowledgment leaves the later two, the last still shown", () => {
    const a = { ...effective(NO_IN_FLIGHT, SERVER), runs: 4 };
    const b = { ...a, runs: 5 };
    const left = acknowledged(sent(sent(sent(NO_IN_FLIGHT, a), b), a), applied(a));
    expect(left).toEqual([b, a]);
    expect(effective(acknowledged(left, applied(b)), applied(b))).toEqual(a);
  });

  test("property: effective is always the last frame sent, and once all are acknowledged it is the server's", () => {
    const change = fc.oneof(
      fc.boolean().map((enabled) => (f: ChainFrameSettings) => ({ ...f, enabled })),
      fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null }).map((runs) => (f: ChainFrameSettings) => ({ ...f, runs })),
      fc
        .option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: null })
        .map((ms) => (f: ChainFrameSettings) => ({ ...f, cutoff: ms === null ? null : new Date(ms).toISOString() })),
    );
    // The server applies the tab's frames in order; the control learns of an application only when the settings change,
    // since its reconciliation runs on a change of the limits or the switch alone.
    const apply = (inFlight: InFlight, server: ChainSettings, frame: ChainFrameSettings): [InFlight, ChainSettings] => {
      const next = applied(frame);
      const changed = next.enabled !== server.enabled || next.limits.runs !== server.limits.runs || next.limits.cutoff !== server.limits.cutoff;
      return [changed ? acknowledged(inFlight, next) : inFlight, next];
    };
    fc.assert(
      fc.property(fc.array(change, { minLength: 1, maxLength: 8 }), fc.nat(), (changes, cut) => {
        let inFlight: InFlight = NO_IN_FLIGHT;
        let server: ChainSettings = SERVER;
        const frames: ChainFrameSettings[] = [];
        for (const c of changes) {
          const frame = c(effective(inFlight, server));
          frames.push(frame);
          inFlight = sent(inFlight, frame);
          expect(effective(inFlight, server)).toEqual(frame);
        }
        const last = frames[frames.length - 1]!;
        const k = cut % (frames.length + 1);
        for (const frame of frames.slice(0, k)) [inFlight, server] = apply(inFlight, server, frame);
        expect(effective(inFlight, server)).toEqual(last);
        for (const frame of frames.slice(k)) [inFlight, server] = apply(inFlight, server, frame);
        expect(inFlight.every((frame) => matches(frame, server))).toBe(true);
        expect(effective(inFlight, server)).toEqual(effective(NO_IN_FLIGHT, applied(last)));
      }),
      { numRuns: 300 },
    );
  });
});
