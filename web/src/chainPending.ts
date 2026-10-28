// Issue #147, work review 3 (W3-R1-1): the chain frames a tab has sent and the server has not yet acknowledged, oldest
// first (pure). The server replaces the whole settings with each frame, so the control composes every frame from the
// last frame not yet acknowledged, never from the server's settings alone: two changes made before the server answers
// never undo each other.
import type { ChainSettings } from "../../src/chain.ts";
import type { ChainFrameSettings } from "../../src/protocol.ts";

/** The frames sent and not yet acknowledged, oldest first. */
export type InFlight = ReadonlyArray<ChainFrameSettings>;
export const NO_IN_FLIGHT: InFlight = [];

/** Whether the server's settings are what the frame asked for: the cutoff compared as an instant. */
export const matches = (frame: ChainFrameSettings, settings: ChainSettings): boolean =>
  frame.enabled === settings.enabled &&
  frame.runs === settings.limits.runs &&
  (frame.cutoff === null ? settings.limits.cutoff === null : settings.limits.cutoff !== null && Date.parse(frame.cutoff) === settings.limits.cutoff);

/** The frame appended. */
export const sent = (inFlight: InFlight, frame: ChainFrameSettings): InFlight => [...inFlight, frame];

/**
 * Applied when the server's settings change: a frame they match is acknowledged with every frame before it, since the
 * server applies a tab's frames in the order sent; settings that match none came from elsewhere (another tab, a
 * restart), and the list is emptied, so another tab's change replaces this tab's drafts. The frames right after the one
 * acknowledged that ask for what the server now holds are dropped with it, since the server's change for them has
 * already come.
 */
export const acknowledged = (inFlight: InFlight, settings: ChainSettings): InFlight => {
  const first = inFlight.findIndex((frame) => matches(frame, settings));
  if (first === -1) return NO_IN_FLIGHT;
  const rest = inFlight.slice(first + 1);
  const pending = rest.findIndex((frame) => !matches(frame, settings));
  return pending === -1 ? NO_IN_FLIGHT : rest.slice(pending);
};

/** The settings the control shows and composes from: the last frame not yet acknowledged, else the server's. */
export const effective = (inFlight: InFlight, settings: ChainSettings): ChainFrameSettings =>
  inFlight.at(-1) ?? {
    enabled: settings.enabled,
    runs: settings.limits.runs,
    cutoff: settings.limits.cutoff === null ? null : new Date(settings.limits.cutoff).toISOString(),
  };

/** A field of the chain's control that holds a draft (issue #147, the page's list of frames). */
export type ChainField = "runs" | "cutoff";

/** Whether two settings are equal: enabled, the run limit and the cutoff. */
export const sameSettings = (a: ChainSettings, b: ChainSettings): boolean =>
  a.enabled === b.enabled && a.limits.runs === b.limits.runs && a.limits.cutoff === b.limits.cutoff;

/** Whether two frames are equal field by field. */
export const sameFrame = (a: ChainFrameSettings, b: ChainFrameSettings): boolean => a.enabled === b.enabled && a.runs === b.runs && a.cutoff === b.cutoff;

/** The list without the first frame equal to `frame` field by field; unchanged where none is. */
export const withdrawn = (inFlight: InFlight, frame: ChainFrameSettings): InFlight => {
  const at = inFlight.findIndex((f) => sameFrame(f, frame));
  return at === -1 ? inFlight : [...inFlight.slice(0, at), ...inFlight.slice(at + 1)];
};

/** The fields on which two frames differ: the run limit as a number or null, the cutoff as an instant. */
const instantOf = (cutoff: string | null): number | null => (cutoff === null ? null : Date.parse(cutoff));
export const differingFields = (a: ChainFrameSettings, b: ChainFrameSettings): readonly ChainField[] => [
  ...(a.runs === b.runs ? [] : (["runs"] as const)),
  ...(instantOf(a.cutoff) === instantOf(b.cutoff) ? [] : (["cutoff"] as const)),
];
