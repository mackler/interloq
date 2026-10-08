// Issue #16: the page's icon, with a badge while a prompt waits or after a watched run ended unseen (pure). An SVG
// written here as a data URL: no canvas, no file, no dependency.
import type { Mark } from "./notify.ts";

export type FaviconColors = Readonly<{ base: string; badge: string; ended: string }>;

export const faviconHref = (_mark: Mark, _colors: FaviconColors): string => "";
