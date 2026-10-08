// Issue #89: a phase's time as the rail shows it. An ended phase's time is computed without the clock, so the rail's
// tick, which runs while any phase is active (issue #50), cannot reach it; a running phase's still advances with it.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { type PhaseTiming, phaseTiming, soFarText, tookText } from "./rail.ts";
import type { TimelineEntry, TimelineState } from "./state.ts";
import { elapsedMs } from "./time.ts";

/** The text the rail shows for a timing at the instant `at`, as TimelineRail.svelte renders it. */
const shown = (timing: PhaseTiming, at: number): string | null =>
  timing._tag === "Ended" ? tookText(timing.phase) : timing._tag === "Running" ? soFarText(timing.phase, at) : null;

const entryOf = (state: TimelineEntry["state"], began: string | null, ended: string | null): TimelineEntry => ({
  phase: { kind: "planning", n: 1 },
  label: "Planning",
  groups: [],
  steps: [],
  state,
  plan: null,
  began,
  ended,
  currentStep: null,
  lastStarted: null,
  acted: [],
  record: null,
});

const MIN = Date.parse("2026-01-01T00:00:00.000Z");
const MAX = Date.parse("2027-01-01T00:00:00.000Z");
const iso = fc.integer({ min: MIN, max: MAX }).map((ms) => new Date(ms).toISOString());
const instant = fc.integer({ min: MIN, max: MAX * 2 });
const state = fc.constantFrom<TimelineState>("done", "active", "stopped", "ahead", "notReached");

describe("a phase's time (issue #89)", () => {
  test("property: an ended phase's time is the same at every instant, and is how long it took", () => {
    fc.assert(
      fc.property(state, iso, iso, instant, instant, (st, began, ended, a, b) => {
        const timing = phaseTiming(entryOf(st, began, ended));
        expect(timing._tag).toBe("Ended");
        expect(shown(timing, a)).toBe(shown(timing, b));
        expect(shown(timing, a)).toBe(prompts.phaseTook(elapsedMs(began, Date.parse(ended))));
      }),
      { numRuns: 200 },
    );
  });

  test("a running phase's time advances with the clock", () => {
    const began = "2026-09-29T10:00:00.000Z";
    const timing = phaseTiming(entryOf("active", began, null));
    expect(timing._tag).toBe("Running");
    expect(shown(timing, Date.parse(began) + 660_000)).toBe(prompts.phaseElapsed(660_000));
    expect(shown(timing, Date.parse(began) + 665_000)).toBe(prompts.phaseElapsed(665_000));
  });

  test("a phase not begun, or stopped without an end, has no time", () => {
    expect(phaseTiming(entryOf("ahead", null, null))).toEqual({ _tag: "Untimed" });
    expect(phaseTiming(entryOf("stopped", "2026-09-29T10:00:00.000Z", null))).toEqual({ _tag: "Untimed" });
  });
});
