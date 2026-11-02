import { describe, expect, test } from "vitest";
import { defaultPreferences } from "./notify.ts";
import { readPanelLines, readPreferences, type StorageLike, writePanelLines, writePreferences } from "./storage.ts";
import { PANEL_LINES } from "./livePanel.ts";
import { panelLinesOf } from "./panelHeight.ts";
import { Result } from "effect";

// Finding 3 of docs/gui-review.md: the storage edge returns typed results; nothing it does can throw.
const memory = (): StorageLike & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
};
const securityError = () => new DOMException("access denied", "SecurityError");

describe("storage", () => {
  test("a throwing acquisition, getItem or setItem, and absent storage, are failures, not exceptions", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    expect(readPreferences(throwingGetter)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, throwingGetter)).toEqual({ ok: false });
    expect(readPreferences(() => undefined)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, () => undefined)).toEqual({ ok: false });
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    expect(readPreferences(() => broken)).toEqual({ ok: false });
    expect(writePreferences({ desktop: "on", sound: "on" }, () => broken)).toEqual({ ok: false });
  });

  // Issue #16: the alert preferences, under a key of their own.
  test("the preferences: defaults when nothing or something unreadable is stored, and a written value read back", () => {
    const store = memory();
    expect(readPreferences(() => store)).toEqual({ ok: true, value: defaultPreferences });
    expect(writePreferences({ desktop: "on", sound: "off" }, () => store)).toEqual({ ok: true, value: undefined });
    expect(readPreferences(() => store)).toEqual({ ok: true, value: { desktop: "on", sound: "off" } });
    for (const unreadable of ["not json", "null", "[]", '{"desktop":"yes","sound":"off"}', '{"desktop":"on"}']) {
      store.items.set("interloq.alerts", unreadable);
      expect(readPreferences(() => store)).toEqual({ ok: true, value: defaultPreferences });
    }
  });

  test("a throwing or absent storage is a failure for the preferences too, not an exception", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    for (const acquire of [throwingGetter, () => undefined, () => broken]) {
      expect(readPreferences(acquire)).toEqual({ ok: false });
      expect(writePreferences(defaultPreferences, acquire)).toEqual({ ok: false });
    }
  });
});

// Issue #221: the live panel's dragged height, remembered per browser.
describe("the panel's remembered height", () => {
  const lines = (n: number) => Result.getOrThrow(panelLinesOf(n));
  test("a height written is read back, under its own key", () => {
    const m = memory();
    expect(writePanelLines(lines(20), () => m)).toEqual({ ok: true, value: undefined });
    expect(m.items.get("interloq.livePanel")).toBe(JSON.stringify({ lines: 20 }));
    expect(readPanelLines(() => m)).toEqual({ ok: true, value: 20 });
  });

  test("nothing stored, garbage and a height out of range read as the default", () => {
    const m = memory();
    expect(readPanelLines(() => m)).toEqual({ ok: true, value: PANEL_LINES });
    for (const text of ["{", "[]", "null", JSON.stringify({ lines: 100 }), JSON.stringify({ lines: "12" }), JSON.stringify({ lines: 2.5 })]) {
      m.items.set("interloq.livePanel", text);
      expect(readPanelLines(() => m)).toEqual({ ok: true, value: PANEL_LINES });
    }
  });

  test("a throwing storage is a failure, not an exception", () => {
    const throwing = () => {
      throw securityError();
    };
    expect(readPanelLines(throwing)).toEqual({ ok: false });
    expect(writePanelLines(lines(12), throwing)).toEqual({ ok: false });
  });
});
