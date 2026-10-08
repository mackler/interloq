// Issue #16: the edge that fires what decide (web/src/notify.ts) returned: a desktop notification, a chime, the icon.
// It decides nothing. Each function takes its browser objects as parameters with the real ones as defaults, so the
// component tests drive it with stubs; every failure of a browser API is absorbed here and nothing is logged.

import type { Permission } from "./notify.ts";
import type { FaviconColors } from "./favicon.ts";

/** The part of the Notification API the page uses. */
export type NotificationApi = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): { onclick: ((event: Event) => unknown) | null; close: () => void };
};
const browserNotification = (): NotificationApi | undefined =>
  typeof Notification === "undefined" ? undefined : (Notification as unknown as NotificationApi);

/** Closes a notification the page showed; a no-op where none was shown. */
export type Closer = () => void;
const NOTHING: Closer = () => undefined;

/** The browser's answer for desktop notifications; `unsupported` where the page has no Notification API. */
export const currentPermission = (api: NotificationApi | undefined = browserNotification()): Permission => (api === undefined ? "unsupported" : api.permission);

/** Asks the browser for permission. Called from a click on the page's control alone, never on load. */
export const requestDesktopPermission = async (api: NotificationApi | undefined = browserNotification()): Promise<Permission> => {
  if (api === undefined) return "unsupported";
  try {
    return await api.requestPermission();
  } catch {
    return currentPermission(api);
  }
};

/**
 * Shows a desktop notification. The tag is the reason's key, so that the operating system replaces rather than stacks
 * the notifications that several tabs of one run show for one reason. A click focuses the page's window.
 */
export const showDesktop = (title: string, body: string, tag: string, api: NotificationApi | undefined = browserNotification()): Closer => {
  if (api === undefined) return NOTHING;
  try {
    const shown = new api(title, { body, tag });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
    return () => shown.close();
  } catch {
    return NOTHING;
  }
};

/** What plays the chime. */
export type Player = () => void;
let audio: AudioContext | null = null;
/** A short two-tone chime synthesized with the Web Audio API: no asset, no dependency. */
const webAudioChime: Player = () => {
  if (typeof AudioContext === "undefined") return;
  audio ??= new AudioContext();
  const context = audio;
  void context.resume().catch(() => undefined);
  const tone = (frequency: number, start: number) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, context.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + 0.15);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + start);
    oscillator.stop(context.currentTime + start + 0.16);
  };
  tone(880, 0);
  tone(1320, 0.15);
};
/** Plays the chime; where the browser refuses audio, nothing sounds and nothing is logged. */
export const playChime = (player: Player = webAudioChime): void => {
  try {
    player();
  } catch {
    // A refused or unavailable audio output is not an error the user can act on.
  }
};

/** Sets the page's icon: the single `link[rel=icon]` of the document's head, created when absent. */
export const setFavicon = (href: string, doc: Document = document): void => {
  const existing = doc.head.querySelector<HTMLLinkElement>("link[rel=icon]");
  const link = existing ?? doc.createElement("link");
  if (existing === null) {
    link.rel = "icon";
    doc.head.append(link);
  }
  if (link.href !== href) link.href = href;
};

/**
 * Resolves a CSS color for the page's actual color scheme (W1-R1-1): a custom property's computed value is its
 * unresolved expression (`light-dark(…)`), which an SVG standing alone would evaluate in the light scheme. A hidden
 * probe takes the value as its color, and its computed color is the resolved one.
 */
export const resolveColor =
  (doc: Document = document) =>
  (cssValue: string): string => {
    const probe = doc.createElement("span");
    probe.style.color = cssValue;
    probe.style.display = "none";
    doc.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };

/** The scheme's colors for the icon, resolved: primary for the square, error for the waiting badge, tertiary for the end's. */
export const schemeColors = (doc: Document = document, resolve: (cssValue: string) => string = resolveColor(doc)): FaviconColors => {
  const read = (name: string, fallback: string): string => {
    const value = resolve(`var(${name})`).trim();
    return value === "" || /light-dark\(|var\(/.test(value) ? fallback : value;
  };
  return { base: read("--m3c-primary", "#4f5b92"), badge: read("--m3c-error", "#ba1a1a"), ended: read("--m3c-tertiary", "#715573") };
};
