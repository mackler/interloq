// Issue #16: the page's icon, with a badge while a prompt waits or after a watched run ended unseen (pure). An SVG
// written here as a data URL: no canvas, no file, no dependency.
import type { Mark } from "./notify.ts";

export type FaviconColors = Readonly<{ base: string; badge: string; ended: string }>;

/** The icon for a mark: a rounded square with the letter I, and for a mark a dot in its top right corner. */
export const faviconHref = (mark: Mark, colors: FaviconColors): string => {
  const badge = mark._tag === "Clear" ? "" : `<circle class="badge" cx="25" cy="7" r="7" fill="${mark._tag === "Waiting" ? colors.badge : colors.ended}" stroke="white" stroke-width="1.5"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="${colors.base}"/><text x="16" y="23" font-family="sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="white">I</text>${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
