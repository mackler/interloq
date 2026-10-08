// The page's remembered project directory (finding 3 of docs/gui-review.md): an edge over the browser's storage.
// Acquiring the storage, reading and writing may each throw (a SecurityError, a full quota, storage disabled);
// every such failure is a typed result, and remembering is never a prerequisite for starting a task.

import { defaultPreferences, type Preferences, type Toggle } from "./notify.ts";

/** The part of the browser's Storage this module uses. */
export type StorageLike = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
/** How the storage is acquired: the getter of `localStorage` itself may throw, so it runs inside the guard. */
export type AcquireStorage = () => StorageLike | undefined;
export type Stored<A> = { ok: true; value: A } | { ok: false };

const KEY = "interloq.project";
/** Issue #16: the alert preferences, a second key beside the remembered project. */
const ALERTS_KEY = "interloq.alerts";
export const browserStorage: AcquireStorage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The remembered project directory ("" when none was remembered). */
export const readRemembered = (acquire: AcquireStorage = browserStorage): Stored<string> => guarded(acquire, (s) => s.getItem(KEY) ?? "");
/** Remembers the project directory; `{ ok: false }` when it could not be remembered. */
export const remember = (path: string, acquire: AcquireStorage = browserStorage): Stored<void> => guarded(acquire, (s) => s.setItem(KEY, path));

/** The alert preferences (issue #16); defaults where nothing or something unreadable is stored. */
export const readPreferences = (acquire: AcquireStorage = browserStorage): Stored<Preferences> => guarded(acquire, (s) => decodePreferences(s.getItem(ALERTS_KEY)));
/** Remembers the alert preferences; `{ ok: false }` when they could not be remembered. */
export const writePreferences = (preferences: Preferences, acquire: AcquireStorage = browserStorage): Stored<void> =>
  guarded(acquire, (s) => s.setItem(ALERTS_KEY, JSON.stringify(preferences)));

const isToggle = (v: unknown): v is Toggle => v === "on" || v === "off";
/** The stored text as preferences: total, the defaults for nothing stored and for anything not of their shape. */
const decodePreferences = (text: string | null): Preferences => {
  if (text === null) return defaultPreferences;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultPreferences;
    const { desktop, sound } = value as Record<string, unknown>;
    return isToggle(desktop) && isToggle(sound) ? { desktop, sound } : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
};

/** The one place where the storage's exceptions are caught and become a typed failure. */
const guarded = <A>(acquire: AcquireStorage, use: (storage: StorageLike) => A): Stored<A> => {
  try {
    const storage = acquire();
    return storage === undefined ? { ok: false } : { ok: true, value: use(storage) };
  } catch {
    return { ok: false };
  }
};
