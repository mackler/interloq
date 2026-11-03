// Issue #16: the page's icon, with a badge while a prompt waits or after a watched run ended unseen (pure). An SVG
// written here as a data URL: no canvas, no file, no dependency. Issue #209: an end's badge carries its mark, ✓ for a
// finished run and ✕ for any other end; the waiting badge stays a plain dot.
// Issue #139: a halted run's badge is the alert, in the error color with ✕; a working or paused run's badge is in the
// working color with its glyph.
import { type Mark, markGlyph } from "./notify.ts";

export type FaviconColors = Readonly<{ base: string; badge: string; ended: string; working: string }>;

const badgeColor = (mark: Mark, colors: FaviconColors): string =>
  mark._tag === "Waiting" ? colors.badge : mark._tag === "Ended" ? (mark.code === 0 ? colors.ended : colors.badge) : colors.working;

/** The icon for a mark: a rounded square with the letter I, and for a mark a dot in its top right corner, an end's with its mark. */
export const faviconHref = (mark: Mark, colors: FaviconColors): string => {
  const shown = mark._tag === "Clear" || mark._tag === "Waiting" ? null : markGlyph(mark);
  const glyph = shown === null ? "" : `<text class="badge-mark" x="25" y="10.5" font-family="sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="white">${shown}</text>`;
  const badge = mark._tag === "Clear" ? "" : `<circle class="badge" cx="25" cy="7" r="7" fill="${badgeColor(mark, colors)}" stroke="white" stroke-width="1.5"/>${glyph}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="${colors.base}"/><text x="16" y="23" font-family="sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="white">I</text>${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
